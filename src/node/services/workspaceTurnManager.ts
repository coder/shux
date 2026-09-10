import { DesktopInputCoordinator } from "@/node/services/desktop/DesktopInputCoordinator";
import assert from "node:assert/strict";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { type Config } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import type { StreamManager } from "@/node/services/streamManager";
import {
  areArchiveUntrackedPathListsEqual,
  formatSubagentFailureUserMessage,
  formatSubagentReportUserMessage,
  getIsoNow,
  resolveTaskAgentIdForResume,
  terminalAttentionOutcome,
  type BackgroundableForegroundWaiter,
  type QueueCutAttributionSnapshot,
  type ResolvedWorkspaceAiSettings,
  type TaskCreateArgs,
  type WorkspaceHost,
  type WorkspaceLifecycleResult,
  type WorkspaceTurnManagerHost,
} from "@/node/services/taskWorkspaceSeam";
import type { HistoryService } from "@/node/services/historyService";
import type { HistoryControlRow } from "@/node/services/historyScanner";
import { isPlainObject } from "@/common/utils/isPlainObject";
import type { InitStateManager } from "@/node/services/initStateManager";
import {
  SUBAGENT_FAILURE_ENVELOPE_TAG,
  parseSubagentReportEnvelope,
} from "@/common/utils/subagentReportEnvelope";
import { WORKSPACE_TURN_TASK_TAGS } from "@/constants/workspaceTags";
import {
  AGENT_REPORT_PROGRESS_SUPERSEDED_REASON,
  agentReportProgressDedupePrefix,
} from "@/constants/agentMessaging";
import { log } from "@/node/services/log";
import {
  readAgentDefinition,
  resolveAgentFrontmatter,
} from "@/node/services/agentDefinitions/agentDefinitionsService";
import { resolveAgentInheritanceChain } from "@/node/services/agentDefinitions/resolveAgentInheritanceChain";
import { isAgentEffectivelyDisabled } from "@/node/services/agentDefinitions/agentEnablement";
import { resolveAgentVisibility } from "@/node/services/agentDefinitions/agentVisibility";
import { createRuntimeContextForWorkspace } from "@/node/runtime/runtimeHelpers";
import type { Runtime } from "@/node/runtime/Runtime";
import {
  coerceNonEmptyString,
  tryReadGitBranchMatchesOrigin,
  tryReadGitCurrentBranch,
  tryReadGitPathsClean,
  findWorkspaceEntry,
} from "@/node/services/taskUtils";
import { listProjectMetadataRelativePaths } from "@/common/compat/legacyMux";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";
import { Ok, Err, type Result } from "@/common/types/result";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import {
  resolveBackgroundWorkAttentionPolicy,
  type BackgroundWorkAttentionPolicy,
} from "@/common/types/backgroundWorkAttention";
import {
  createMuxMessage,
  isSameWorkspaceTurnTaskCorrelation,
  parseWorkspaceTurnTaskCorrelation,
  type MuxMessage,
  type MuxMessageMetadata,
} from "@/common/types/message";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import { TASK_TERMINATION_STOP_STREAM_TIMEOUT_MS } from "@/constants/terminationTimeouts";
import {
  createTaskFailureMessageId,
  createTaskReportMessageId,
} from "@/node/services/utils/messageIds";
import { defaultModel } from "@/common/utils/ai/models";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { RUNTIME_MODE, type RuntimeConfig } from "@/common/types/runtime";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { AgentIdSchema } from "@/common/orpc/schemas";
import type { AgentDefinitionScope } from "@/common/types/agentDefinition";
import { normalizeAgentId } from "@/common/utils/agentIds";
import {
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
import { formatSendMessageError } from "@/node/services/utils/sendMessageError";
import { getErrorMessage } from "@/common/utils/errors";
import { isNonRetryableStreamError } from "@/common/utils/messages/retryEligibility";
import type { StreamErrorType } from "@/common/types/errors";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR } from "@/common/config/worktreeArchiveBehavior";
import { DEFAULT_CODER_ARCHIVE_BEHAVIOR } from "@/common/config/coderArchiveBehavior";
import { isSSHRuntime, isWorktreeRuntime } from "@/common/types/runtime";
import {
  TaskHandleStore,
  WORKSPACE_TURN_TASK_ID_PREFIX,
  isActiveWorkspaceTurnTaskStatus,
  isWorkspaceTurnTaskId,
  type WorkspaceTurnFinalMessageRef,
  type WorkspaceTurnTaskHandleRecord,
  type WorkspaceTurnTaskStatus,
} from "@/node/services/taskHandleStore";
import {
  TerminalAttentionStore,
  type TerminalAttentionOutcome,
} from "@/node/services/terminalAttentionStore";

// Only the reversible verbs are restored; task_remove stays the sole irreversible verb
// (delete_worktree/remove remain in the result schema for historical-transcript parsing only).
type WorkspaceLifecycleAction = "archive" | "unarchive";

// Internal evidence only: future terminal transitions must name and justify their cause.
// An arbitrary synthetic stream-end is not completion; unknown history retains the existing
// conservative interruption policy rather than pretending that a manual input was observed.
type WorkspaceTurnSettlementCause =
  | {
      kind:
        | "creation-admission-failure"
        | "creation-validation-failure"
        | "launch-canceled"
        | "send-failure"
        | "stale-history-recovery"
        | "stale-restart"
        | "correlated-stream-end"
        | "user-stream-abort"
        | "continuation-failure"
        | "terminal-stream-error"
        | "recovery-admission-failure"
        | "explicit-interrupt";
    }
  | { kind: "manual-supersession"; messageId: string }
  | {
      kind: "uncorrelated-conservative-fallback";
      reason:
        | "history-read-failed"
        | "missing-stream-end"
        | "missing-turn-anchor"
        | "invalid-manual-input-id";
    };

const WORKSPACE_TURN_SETTLEMENT_CAUSES: Record<WorkspaceTurnSettlementCause["kind"], true> = {
  "creation-admission-failure": true,
  "creation-validation-failure": true,
  "launch-canceled": true,
  "send-failure": true,
  "stale-history-recovery": true,
  "stale-restart": true,
  "correlated-stream-end": true,
  "user-stream-abort": true,
  "continuation-failure": true,
  "terminal-stream-error": true,
  "recovery-admission-failure": true,
  "explicit-interrupt": true,
  "manual-supersession": true,
  "uncorrelated-conservative-fallback": true,
};

interface WorkspaceLifecycleTarget {
  taskId?: string;
  workspaceId?: string;
}

interface WorkspaceLifecycleOptions {
  interruptActive?: boolean;
  acknowledgedUntrackedPaths?: string[];
  acknowledgedUntrackedPathsByWorkspaceId?: Record<string, string[]>;
}

interface ResolvedWorkspaceLifecycleTarget {
  action: WorkspaceLifecycleAction;
  taskId?: string;
  taskTitle?: string;
  workspaceId: string;
  metadata: WorkspaceMetadata | null;
}

function parseTerminalSubagentExecutionVersion(content: string): string | null {
  const report = parseSubagentReportEnvelope(content);
  if (report?.executionVersion != null) return report.executionVersion;
  if (!content.startsWith(SUBAGENT_FAILURE_ENVELOPE_TAG)) return null;
  return /<execution_version>([^\n<]+)<\/execution_version>/.exec(content)?.[1] ?? null;
}

type WorkspaceTurnQueueDispatchMode = "tool-end" | "turn-end";

/**
 * Project-relative paths that contribute agent definitions to discovery
 * (project agent roots, project plugin containers). Owner-side vouching for a
 * freshly created checkout requires these to be clean in the owner: the child is
 * created from committed branch state, so uncommitted changes here make
 * owner-side agent resolution diverge from what the target will see.
 */
const AGENT_DEFINITION_PROJECT_PATHSPECS: readonly string[] = [
  ...listProjectMetadataRelativePaths("agents"),
  ...listProjectMetadataRelativePaths("plugins"),
  ".agents/plugins",
];

/** Provenance of one hop of a validated agent's base chain (strict-send pinning). */
interface WorkspaceTurnAgentChainEntry {
  id: string;
  scope: AgentDefinitionScope;
  source?: string;
}

/** Agent-discovery context for a workspace involved in a workspace turn. */
interface WorkspaceTurnAgentContext {
  runtime: Runtime;
  workspacePath: string;
  includeAgentPlugins: boolean;
  /** Source config, kept so owner/target contexts can be compared for host identity. */
  runtimeConfig: RuntimeConfig;
}

/**
 * Whether agent discovery for both runtime configs reads the same host filesystem,
 * i.e. the owner's global/plugin agent roots are literally the target's roots.
 * Local-family runtimes (local/worktree) share the local machine. Plain SSH shares
 * the remote home only for an identical host/port with no Coder indirection —
 * CoderSSHRuntime.finalizeConfig derives a distinct per-workspace host, so a Coder
 * owner's ~/.xum/agents says nothing about the child's. Docker/devcontainer get
 * per-workspace containers and never share.
 */
function runtimeConfigsShareAgentHost(a: RuntimeConfig, b: RuntimeConfig): boolean {
  const isLocalFamily = (rc: RuntimeConfig): boolean =>
    rc.type === RUNTIME_MODE.LOCAL || rc.type === RUNTIME_MODE.WORKTREE;
  if (isLocalFamily(a) && isLocalFamily(b)) {
    return true;
  }
  if (a.type === RUNTIME_MODE.SSH && b.type === RUNTIME_MODE.SSH) {
    return (
      a.coder == null && b.coder == null && a.host === b.host && (a.port ?? 22) === (b.port ?? 22)
    );
  }
  return false;
}

export interface WorkspaceTurnCreateArgs {
  ownerWorkspaceId: string;
  prompt: string;
  title: string;
  /**
   * Agent mode for the launched turn (e.g. "plan"). Defaults to exec for new
   * workspaces and to the resumed identity for existing descendant agent
   * workspaces. For a new workspace the requested agent becomes its default;
   * on an existing normal workspace it is a per-turn override dispatched with
   * AI-settings persistence disabled, so the target's saved agent/settings are
   * untouched. Rejected for descendant agent workspaces, whose persisted
   * identity always wins at stream time.
   */
  agentId?: string;
  modelString?: string;
  thinkingLevel?: ParsedThinkingInput;
  parentRuntimeAiSettings?: { modelString?: string; thinkingLevel?: ThinkingLevel };
  workspace?: {
    mode?: "new" | "fork" | "existing";
    workspaceId?: string;
    branchName?: string;
    trunkBranch?: string;
    queueDispatchMode?: WorkspaceTurnQueueDispatchMode;
    disposable?: boolean;
  };
  experiments?: TaskCreateArgs["experiments"];
  /**
   * How the owner's stream-end treats this workspace turn while active. Derived
   * from `run_in_background`: background -> "notify_on_terminal"; foreground/default
   * -> "blocking_until_terminal". Defaults to blocking when omitted.
   */
  /** Internal-only: allow a persistent descendant agent workspace as an existing target. */
  allowAgentWorkspace?: boolean;
  attentionPolicy?: BackgroundWorkAttentionPolicy;
}

export interface WorkspaceTurnCreateResult {
  taskId: string;
  kind: "workspace_turn";
  status: "queued" | "starting" | "running";
  workspaceId: string;
  /**
   * Active same-owner handle on the target that this tool-end follow-up may
   * supersede at the target's next tool boundary (that handle then settles
   * interrupted quietly). In-memory result only, never persisted.
   */
  maySupersedeTaskId?: string;
}

export interface WorkspaceTurnWaitResult {
  taskId: string;
  workspaceId: string;
  updatedAt: string;
  reportMarkdown: string;
  title?: string;
  messageId?: string;
  finalMessageRef?: WorkspaceTurnFinalMessageRef;
}

type WorkspaceTurnMuxMetadata = Extract<MuxMessageMetadata, { type: "workspace-turn-task" }>;

interface WorkspaceTurnWaiter extends BackgroundableForegroundWaiter {
  handleId: string;
  resolve: (result: WorkspaceTurnWaitResult) => void;
}

/** Maximum consecutive auto-resumes before stopping. Prevents infinite loops when descendants are stuck. */

/**
 * Stream errors classified non-retryable by RetryManager that nevertheless have
 * in-session recovery paths for workspace turns (queued continuation after a
 * soft abort, compaction retry on context overflow). All auto-retryable errors
 * (e.g. stream_truncated, network, server_error) are additionally treated as
 * recoverable by isWorkspaceTurnRecoverableStreamError below, because the child
 * session schedules an in-session auto-retry for them.
 */
const WORKSPACE_TURN_RECOVERABLE_STREAM_ERRORS: ReadonlySet<StreamErrorType> = new Set([
  "aborted",
  "context_exceeded",
]);

/** Marker persisted by settleStaleWorkspaceTurn when restart recovery interrupts a handle. */
const WORKSPACE_TURN_STALE_RESTART_ERROR = "Workspace turn interrupted after restart";

/**
 * Reason persisted when other queued input (a manual user message, /compact)
 * cut a delegated turn at a tool boundary and superseded it. The target
 * workspace continues under the new input, so the owner sees an interruption
 * with this explanation rather than a task failure.
 */
const WORKSPACE_TURN_SUPERSEDED_BY_NEW_INPUT_ERROR =
  "Workspace turn superseded by new input in the target workspace; the workspace continues under that input and this delegated turn will not report";

/** A human-authored child input that redirects the delegated turn. */
function isManualChildWorkspaceInput(message: HistoryControlRow): boolean {
  if (message.role !== "user") {
    return false;
  }
  if (message.metadata?.synthetic !== true) {
    return true;
  }
  const muxMetadata = message.metadata.muxMetadata;
  if (
    !isPlainObject(muxMetadata) ||
    muxMetadata.type !== "compaction-request" ||
    muxMetadata.source !== "auto-compaction"
  )
    return false;
  // Control rows need not be valid MuxMessages. Read only the guarded dispatch
  // source, including the legacy continuation field, instead of casting payloads.
  const parsed = isPlainObject(muxMetadata.parsed) ? muxMetadata.parsed : undefined;
  const followUp = parsed?.followUpContent ?? parsed?.continueMessage;
  return !(
    isPlainObject(followUp) &&
    isPlainObject(followUp.dispatchOptions) &&
    followUp.dispatchOptions.source === "internal-resume"
  );
}

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
const WORKSPACE_TURN_SUPERSEDED_BY_OWNER_FOLLOW_UP_ERROR_PREFIX =
  "Workspace turn superseded by follow-up turn ";

function buildOwnerFollowUpSupersededError(successorHandleId: string): string {
  return (
    `${WORKSPACE_TURN_SUPERSEDED_BY_OWNER_FOLLOW_UP_ERROR_PREFIX}${successorHandleId} from the ` +
    "same owner workspace; the workspace continues under that turn and will report there. " +
    "This supersede is the expected consequence of that follow-up."
  );
}

/**
 * The error string is the durable flavor marker (no schema field): prefix
 * matching keeps old records parseable on downgrade while letting suppression
 * decisions derive purely from the persisted record.
 */
function isOwnerFollowUpSupersededWorkspaceTurnInterrupt(
  record: Pick<WorkspaceTurnTaskHandleRecord, "status" | "error">
): boolean {
  return (
    record.status === "interrupted" &&
    record.error?.startsWith(WORKSPACE_TURN_SUPERSEDED_BY_OWNER_FOLLOW_UP_ERROR_PREFIX) === true
  );
}

/**
 * Distinguishes queue-cut supersede interrupts (both flavors: generic new
 * input and owner follow-up) from explicit cancellations (user Esc,
 * task_stop): supersedes still deliver a terminal continuation to a
 * persistent child's direct parent, while explicit cancels stay silent because
 * the canceller already knows the outcome. Only notification decisions consult
 * the owner-follow-up sub-flavor.
 */
function isSupersededWorkspaceTurnInterrupt(
  record: Pick<WorkspaceTurnTaskHandleRecord, "status" | "error">
): boolean {
  return (
    (record.status === "interrupted" &&
      record.error === WORKSPACE_TURN_SUPERSEDED_BY_NEW_INPUT_ERROR) ||
    isOwnerFollowUpSupersededWorkspaceTurnInterrupt(record)
  );
}

/**
 * Terminal settlements whose owner terminal-attention wake is suppressed. A
 * pure function of the settled record so live settlement, startup recovery,
 * and resettle agree — restarts must not resurrect a suppressed wake.
 * Deliberately NOT recorded via terminalAttentionNotifiedAt (which means "a
 * notification was delivered"): deriving from the record keeps the audit trail
 * clean and stays downgrade-safe with no schema change.
 */
export function workspaceTurnTerminalAttentionSuppressed(
  record: Pick<WorkspaceTurnTaskHandleRecord, "status" | "error">
): boolean {
  return isOwnerFollowUpSupersededWorkspaceTurnInterrupt(record);
}

/**
 * True when the direct parent initiated the superseding follow-up and needs no
 * failure envelope: the outcome is the expected consequence of its own
 * follow-up (announced in that follow-up's task tool result). When parent ≠
 * owner (descendant-agent case: an ancestor-owned handle on a persistent
 * child), delivery proceeds — the direct parent did not cause the cut.
 */
function ownerFollowUpSupersedeSkipsDirectParent(
  record: Pick<WorkspaceTurnTaskHandleRecord, "status" | "error" | "ownerWorkspaceId">,
  directParentWorkspaceId: string | null | undefined
): boolean {
  return (
    isOwnerFollowUpSupersededWorkspaceTurnInterrupt(record) &&
    directParentWorkspaceId === record.ownerWorkspaceId
  );
}

/**
 * Attribution of the queued/engaged input that cut a delegated turn at a tool
 * boundary. Replaces a boolean so settlement can distinguish the owner's own
 * follow-up (settles quietly) from other input (notifies as today). `null`
 * means no live cut evidence (the tool-calls finish falls through to the
 * truncation branch). "preserved" carries a persisted supersede classification
 * verbatim through the repair path (never invents or downgrades a flavor).
 */
type QueueCutSupersedeEvidence =
  | { kind: "same_owner_follow_up"; successorHandleId: string }
  | { kind: "other_input" }
  | { kind: "preserved"; error: string }
  | null;

/**
 * Settled workspace-turn records eligible for self-heal correction (resettle from a
 * correlated stream-end, or read-time repair/revive): transient stream-error settlements
 * (status "error"), stale restart-recovery interrupts, and queue-cut supersedes (late
 * correlated evidence of the same turn proves it actually continued). Explicit interrupts —
 * user Esc, task_terminate, cancel reasons — must stay terminal even if a late correlated
 * stream-end or same-turn retry evidence arrives, so canceled work never resurfaces as
 * completed.
 */
function isSelfHealEligibleSettledWorkspaceTurn(
  record: Pick<WorkspaceTurnTaskHandleRecord, "status" | "error">
): boolean {
  if (record.status === "error") {
    return true;
  }
  return (
    (record.status === "interrupted" && record.error === WORKSPACE_TURN_STALE_RESTART_ERROR) ||
    // Both supersede flavors (generic new input and owner follow-up) stay
    // self-heal eligible: late correlated evidence proves the turn continued.
    isSupersededWorkspaceTurnInterrupt(record)
  );
}

/**
 * A workspace-turn stream error may resolve without parent intervention when
 * the child can still make progress on its own. The caller must still confirm
 * a retry/continuation is actually in flight
 * (hasRecoverableWorkspaceTurnRetryInFlight) before leaving the handle running;
 * exhausted or user-disabled auto-retry settles the handle terminally.
 *
 * Gating on isNonRetryableStreamError (instead of a narrow allowlist) keeps
 * this aligned with RetryManager: previously a transient provider drop
 * (stream_truncated) terminally settled the handle and falsely reported the
 * turn as failed to the parent, even though the child auto-retried and
 * continued the same turn seconds later.
 */
function isWorkspaceTurnRecoverableStreamError(errorType: StreamErrorType): boolean {
  return (
    WORKSPACE_TURN_RECOVERABLE_STREAM_ERRORS.has(errorType) ||
    !isNonRetryableStreamError({ type: errorType })
  );
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

function isContextBudgetFlushMetadata(muxMetadata: unknown): boolean {
  return (
    typeof muxMetadata === "object" &&
    muxMetadata !== null &&
    (muxMetadata as { contextBudgetFlush?: unknown }).contextBudgetFlush === true
  );
}

export class WorkspaceTurnManager {
  private readonly workspaceTurnSettlementLocks = new MutexMap<string>();
  private readonly workspaceLifecycleLocks = new MutexMap<string>();
  private readonly pendingWorkspaceTurnWaitersByHandleId = new Map<string, WorkspaceTurnWaiter[]>();
  private readonly activeWorkspaceTurnHandleByWorkspaceId = new Map<
    string,
    { handleId: string; ownerWorkspaceId: string; accepted: boolean }
  >();
  private lastWorkspaceTurnCreatedAtMs = 0;
  private readonly taskHandleStore: TaskHandleStore;

  constructor(
    private readonly config: Config,
    private readonly historyService: HistoryService,
    private readonly aiService: AIService,
    private readonly workspaceService: WorkspaceHost,
    private readonly initStateManager: InitStateManager,
    private readonly taskHost: WorkspaceTurnManagerHost,
    private readonly terminalAttentionStore: TerminalAttentionStore,
    private readonly streamManager?: StreamManager,
    private readonly desktopInputCoordinator = new DesktopInputCoordinator(config)
  ) {
    this.taskHandleStore = new TaskHandleStore(config);
  }

  /**
   * Strictly increasing createdAt for workspace-turn handles issued by this
   * process: listAllWorkspaceTurns() orders records by createdAt, and the
   * immediate-predecessor announcement in createWorkspaceTurn (newest-first
   * scan in findActiveWorkspaceTurnForWorkspace) must be deterministic even
   * when two follow-ups are created within the same millisecond — an equal
   * ISO timestamp would otherwise fall back to filesystem readdir order.
   */

  getLiveWorkspaceTurnRegistration(
    workspaceId: string
  ): { handleId: string; ownerWorkspaceId: string; accepted: boolean } | undefined {
    return this.activeWorkspaceTurnHandleByWorkspaceId.get(workspaceId);
  }

  async markWorkspaceTurnBackgroundWorkNotifyOnTerminal(
    taskId: string,
    ownerWorkspaceId: string
  ): Promise<void> {
    if (ownerWorkspaceId == null) return;
    const pendingNotification = await this.workspaceTurnSettlementLocks.withLock(
      taskId,
      async (): Promise<{
        handleId: string;
        generationId: string;
        terminalOutcome: TerminalAttentionOutcome;
      } | null> => {
        const current = await this.taskHandleStore.getWorkspaceTurn(ownerWorkspaceId, taskId);
        if (current == null) return null;

        const updatedRecord: WorkspaceTurnTaskHandleRecord =
          current.attentionPolicy === "notify_on_terminal"
            ? current
            : {
                ...current,
                attentionPolicy: "notify_on_terminal",
                // Policy-only writes after settlement must not mint a new terminal outcome
                // generation or invalidate direct-parent delivery keyed by status + updatedAt.
                ...(this.isTerminalWorkspaceTurnStatus(current.status)
                  ? {}
                  : { updatedAt: getIsoNow() }),
              };
        if (updatedRecord !== current) {
          await this.taskHandleStore.upsertWorkspaceTurn(updatedRecord);
        }

        // A queued-message/timeout detach can race with child stream-end settlement: the waiter is
        // gone before notify_on_terminal is durably persisted, so settleWorkspaceTurn may have seen a
        // blocking policy and skipped the terminal wake-up. If the handle is already terminal here,
        // enqueue the missing wake-up after releasing the settlement lock.
        if (
          this.isTerminalWorkspaceTurnStatus(updatedRecord.status) &&
          updatedRecord.terminalAttentionNotifiedAt == null
        ) {
          return {
            handleId: updatedRecord.handleId,
            generationId: this.workspaceTurnTerminalAttentionGenerationId(updatedRecord),
            terminalOutcome: terminalAttentionOutcome(updatedRecord.status),
          };
        }
        return null;
      }
    );
    if (pendingNotification != null) {
      await this.taskHost.enqueueTerminalAttention({
        ownerWorkspaceId,
        sourceKind: "workspace_turn",
        sourceId: pendingNotification.handleId,
        generationId: pendingNotification.generationId,
        terminalOutcome: pendingNotification.terminalOutcome,
      });
      await this.workspaceTurnSettlementLocks.withLock(taskId, async () => {
        const terminal = await this.taskHandleStore.getWorkspaceTurn(ownerWorkspaceId, taskId);
        if (terminal != null && terminal.terminalAttentionNotifiedAt == null) {
          await this.taskHandleStore.upsertWorkspaceTurn({
            ...terminal,
            terminalAttentionNotifiedAt: getIsoNow(),
          });
        }
      });
    }
  }

  async listAllWorkspaceTurns(options?: {
    statuses?: WorkspaceTurnTaskStatus[];
  }): Promise<WorkspaceTurnTaskHandleRecord[]> {
    return await this.taskHandleStore.listAllWorkspaceTurns(options);
  }

  async getWorkspaceTurnRecord(
    ownerWorkspaceId: string,
    handleId: string
  ): Promise<WorkspaceTurnTaskHandleRecord | null> {
    return await this.taskHandleStore.getWorkspaceTurn(ownerWorkspaceId, handleId);
  }

  private nextWorkspaceTurnCreatedAt(): string {
    const nowMs = Math.max(Date.now(), this.lastWorkspaceTurnCreatedAtMs + 1);
    this.lastWorkspaceTurnCreatedAtMs = nowMs;
    return new Date(nowMs).toISOString();
  }

  /**
   * Agent-discovery context for a workspace involved in a workspace turn. Uses
   * createRuntimeContextForWorkspace — the same helper the stream uses in
   * aiService — so validation resolves agents from the exact discovery path that
   * will stream (Docker container-side paths, subproject directories included).
   */
  private buildWorkspaceTurnAgentContext(params: {
    runtimeConfig: RuntimeConfig;
    projectPath: string;
    workspaceName: string;
    persistedWorkspacePath?: string;
    subProjectPath?: string;
  }): WorkspaceTurnAgentContext {
    const context = createRuntimeContextForWorkspace({
      runtimeConfig: params.runtimeConfig,
      projectPath: params.projectPath,
      name: params.workspaceName,
      namedWorkspacePath: coerceNonEmptyString(params.persistedWorkspacePath),
      subProjectPath: coerceNonEmptyString(params.subProjectPath),
    });
    return {
      ...context,
      includeAgentPlugins: this.workspaceService.isExperimentEnabled(EXPERIMENT_IDS.AGENT_PLUGINS),
      runtimeConfig: params.runtimeConfig,
    };
  }

  /**
   * Fail-fast eligibility check for an explicit workspace-turn agentId.
   * resolveAgentForStream silently falls back to exec for top-level workspaces,
   * which would hide a caller's mistake — so unknown, internal (ui.hidden), and
   * disabled agents are rejected here before any turn is dispatched. Mirrors
   * the UI agent picker rule set (including Agent Plugins roots when that
   * experiment is enabled), so custom user-visible agents pass without a
   * hardcoded allowlist.
   */
  private async validateWorkspaceTurnAgentId(params: {
    cfg: ReturnType<Config["loadConfigOrDefault"]>;
    agentId: string;
    /** Workspace the validation is for (log correlation in chain resolution). */
    workspaceId: string;
    /** Discovery context of the workspace whose turn will run (or the owner pre-create). */
    runtime: Runtime;
    workspacePath: string;
    includeAgentPlugins: boolean;
  }): Promise<
    Result<
      {
        scope: AgentDefinitionScope;
        source?: string;
        chain: WorkspaceTurnAgentChainEntry[];
      },
      string
    >
  > {
    assert(params.agentId.length > 0, "validateWorkspaceTurnAgentId: agentId must be non-empty");
    const parsedAgentId = AgentIdSchema.safeParse(params.agentId);
    if (!parsedAgentId.success) {
      return Err(`Task.createWorkspaceTurn: invalid agentId (${params.agentId})`);
    }
    // The winning definition's provenance (scope + exact source) AND the resolved
    // base chain's provenance are captured so the dispatched turn can pin them at
    // stream time (strictAgentResolution): a validated definition or base shadow
    // vanishing must not let a different candidate with the same id run under a
    // strict send.
    let scope: AgentDefinitionScope;
    let source: string | undefined;
    let chain: WorkspaceTurnAgentChainEntry[];
    try {
      const definition = await readAgentDefinition(
        params.runtime,
        params.workspacePath,
        parsedAgentId.data,
        { includeAgentPlugins: params.includeAgentPlugins }
      );
      scope = definition.scope;
      source = definition.source;
      const resolvedChain = await resolveAgentInheritanceChain({
        runtime: params.runtime,
        workspacePath: params.workspacePath,
        agentId: parsedAgentId.data,
        agentDefinition: definition,
        workspaceId: params.workspaceId,
        includeAgentPlugins: params.includeAgentPlugins,
      });
      chain = resolvedChain.map((entry) => ({
        id: entry.id,
        scope: entry.scope,
        ...(entry.source != null ? { source: entry.source } : {}),
      }));
    } catch {
      return Err(`Task.createWorkspaceTurn: unknown agentId (${params.agentId})`);
    }
    let frontmatter: Awaited<ReturnType<typeof resolveAgentFrontmatter>>;
    try {
      frontmatter = await resolveAgentFrontmatter(
        params.runtime,
        params.workspacePath,
        params.agentId,
        { includeAgentPlugins: params.includeAgentPlugins }
      );
    } catch {
      return Err(`Task.createWorkspaceTurn: unknown agentId (${params.agentId})`);
    }
    if (!resolveAgentVisibility(frontmatter.ui).selectable) {
      return Err(
        `Task.createWorkspaceTurn: agentId is not selectable for workspace turns (${params.agentId})`
      );
    }
    if (
      isAgentEffectivelyDisabled({
        cfg: params.cfg,
        agentId: params.agentId,
        resolvedFrontmatter: frontmatter,
      })
    ) {
      return Err(`Task.createWorkspaceTurn: agentId is disabled (${params.agentId})`);
    }
    return Ok({ scope, ...(source != null ? { source } : {}), chain });
  }

  /**
   * Validate an explicit agentId against the TARGET workspace's checkout, tolerating
   * targets that are not reachable yet (deferred provisioning, stopped containers)
   * without permitting a silent exec fallback later:
   * - reachable checkout: strict validation against the target. If that fails while
   *   the target's init hook is still running, the verdict is not trustworthy (the
   *   hook may still be installing/rewriting agent definitions), so the launch fails
   *   with an explicitly transient error instead of a definitive "unknown agentId";
   * - unreachable checkout: resolve the definition via the OWNER's context, but only
   *   when the owner and target run agent discovery on the same host filesystem
   *   (runtimeConfigsShareAgentHost) — cross-host (Coder per-workspace hosts, per-
   *   workspace containers), the owner's global roots say nothing about the target's,
   *   and even a built-in could be shadowed by a target-host global definition, so
   *   everything fails closed. Same-host, project shadows and global roots are
   *   visible through the owner: a checkout-dependent (project-scope) winner still
   *   fails with a reachability error — it cannot be verified in the target and
   *   dispatching anyway would let resolveAgentForStream silently fall back to exec
   *   (wrong prompt/tool policy) — while host-side definitions (built-in, global,
   *   plugin) are validated against the owner context and the launch proceeds.
   * Waiting for provisioning/init here is not an option: createWorkspaceTurn holds
   * the service-wide task mutex for its whole body. Failures in these windows settle
   * as retryable errors (mode="existing" once the target is ready) rather than
   * dispatching an unverified id.
   */
  private async validateWorkspaceTurnAgentIdForTarget(params: {
    cfg: ReturnType<Config["loadConfigOrDefault"]>;
    agentId: string;
    /** Target workspace id (log correlation in chain resolution). */
    workspaceId: string;
    target: WorkspaceTurnAgentContext;
    owner: WorkspaceTurnAgentContext;
    /** Whether the target workspace's init hook is still running (see doc above). */
    targetInitPending: boolean;
    /**
     * Whether the owner's checkout is a sound predictor of the target's agent
     * definitions. Only true for workspaces this call just created from the branch
     * verified (via git) to be checked out in the owner right now. False for existing
     * targets (their checkout has unknown provenance — any branch, uncommitted shadows)
     * and for new workspaces whose base branch differs from or cannot be proven equal
     * to the owner's. When false, unreachable targets fail closed instead of trusting
     * owner-side resolution.
     */
    ownerResolutionPredictsTarget: boolean;
  }): Promise<
    Result<
      {
        validatedContext: WorkspaceTurnAgentContext;
        scope: AgentDefinitionScope;
        source?: string;
        chain: WorkspaceTurnAgentChainEntry[];
      },
      string
    >
  > {
    const reachable = await runtimePathExists(params.target.runtime, params.target.workspacePath);
    if (reachable) {
      const validation = await this.validateWorkspaceTurnAgentId({
        cfg: params.cfg,
        agentId: params.agentId,
        workspaceId: params.workspaceId,
        ...params.target,
      });
      if (validation.success) {
        return Ok({ validatedContext: params.target, ...validation.data });
      }
      if (params.targetInitPending) {
        return Err(
          `Task.createWorkspaceTurn: the target workspace is still initializing, so agentId (${params.agentId}) could not be verified yet (${validation.error})`
        );
      }
      return validation;
    }
    if (!params.ownerResolutionPredictsTarget) {
      return Err(
        `Task.createWorkspaceTurn: target checkout is not reachable (provisioning, stopped runtime, or unknown checkout state), so agentId (${params.agentId}) cannot be verified there`
      );
    }
    if (!runtimeConfigsShareAgentHost(params.owner.runtimeConfig, params.target.runtimeConfig)) {
      return Err(
        `Task.createWorkspaceTurn: target checkout is not reachable and runs on a different host than the owner, so agentId (${params.agentId}) cannot be verified there`
      );
    }
    const parsedAgentId = AgentIdSchema.safeParse(params.agentId);
    if (!parsedAgentId.success) {
      return Err(`Task.createWorkspaceTurn: invalid agentId (${params.agentId})`);
    }
    let resolvedScope: AgentDefinitionScope;
    try {
      const definition = await readAgentDefinition(
        params.owner.runtime,
        params.owner.workspacePath,
        parsedAgentId.data,
        { includeAgentPlugins: params.owner.includeAgentPlugins }
      );
      resolvedScope = definition.scope;
    } catch {
      return Err(`Task.createWorkspaceTurn: unknown agentId (${params.agentId})`);
    }
    if (resolvedScope === "project") {
      return Err(
        `Task.createWorkspaceTurn: target checkout is not reachable yet (provisioning or stopped runtime), so project-local agentId (${params.agentId}) cannot be verified there`
      );
    }
    const validation = await this.validateWorkspaceTurnAgentId({
      cfg: params.cfg,
      agentId: params.agentId,
      workspaceId: params.workspaceId,
      ...params.owner,
    });
    return validation.success
      ? Ok({ validatedContext: params.owner, ...validation.data })
      : validation;
  }

  async createWorkspaceTurn(
    args: WorkspaceTurnCreateArgs
  ): Promise<Result<WorkspaceTurnCreateResult, string>> {
    const ownerWorkspaceId = coerceNonEmptyString(args.ownerWorkspaceId);
    if (!ownerWorkspaceId) {
      return Err("Task.createWorkspaceTurn: ownerWorkspaceId is required");
    }
    const prompt = coerceNonEmptyString(args.prompt);
    if (!prompt) {
      return Err("Task.createWorkspaceTurn: prompt is required");
    }
    const title = coerceNonEmptyString(args.title) ?? "Workspace task";
    const mode = args.workspace?.mode ?? "new";
    if (mode !== "new" && mode !== "fork" && mode !== "existing") {
      return Err("Task.createWorkspaceTurn: unsupported workspace mode");
    }
    const queueDispatchMode = args.workspace?.queueDispatchMode ?? "tool-end";
    if (queueDispatchMode !== "tool-end" && queueDispatchMode !== "turn-end") {
      return Err("Task.createWorkspaceTurn: unsupported queueDispatchMode");
    }
    // Explicit agent override: validate syntax up front; eligibility (existence,
    // selectability, enablement) is checked below against the workspace whose turn will run.
    let requestedAgentId: string | undefined;
    const rawAgentId = coerceNonEmptyString(args.agentId);
    if (rawAgentId != null) {
      const parsedAgentId = AgentIdSchema.safeParse(normalizeAgentId(rawAgentId, ""));
      if (!parsedAgentId.success) {
        return Err(`Task.createWorkspaceTurn: invalid agentId (${rawAgentId})`);
      }
      requestedAgentId = parsedAgentId.data;
    }

    await using _lock = await this.taskHost.acquireTaskCreationLock();

    const parentMetaResult = await this.aiService.getWorkspaceMetadata(ownerWorkspaceId);
    if (!parentMetaResult.success) {
      return Err(`Task.createWorkspaceTurn: owner workspace not found (${parentMetaResult.error})`);
    }
    const parentMeta = parentMetaResult.data;
    const cfg = this.config.loadConfigOrDefault();
    const taskSettings = cfg.taskSettings ?? DEFAULT_TASK_SETTINGS;
    const parentEntry = findWorkspaceEntry(cfg, ownerWorkspaceId);
    if (parentEntry?.workspace.kind === "scratch") {
      return Err("Task.createWorkspaceTurn: scratch workspace turns are not supported yet");
    }
    const taskProjectConfig = cfg.projects.get(stripTrailingSlashes(parentMeta.projectPath));
    if ((parentMeta.projects?.length ?? 0) > 1) {
      // The host's create() only materializes one project checkout; fail loudly instead of
      // silently dropping secondary repos from a multi-project caller's task context.
      return Err("Task.createWorkspaceTurn: multi-project workspace turns are not supported yet");
    }
    if (!taskProjectConfig?.trusted) {
      return Err(
        "This project must be trusted before creating workspaces. Trust the project in Settings → Security, or create a workspace from the project page."
      );
    }

    const allWorkspaceTurns = await this.taskHandleStore.listAllWorkspaceTurns();
    const ownerWorkspaceTurns = allWorkspaceTurns.filter(
      (record) => record.ownerWorkspaceId === ownerWorkspaceId
    );
    const activeAgentCount = this.taskHost.countActiveAgentTasks(cfg);
    const ensureParallelSlot = async (): Promise<Result<void, string>> => {
      const activeWorkspaceTurnCount = await this.countActiveWorkspaceTurns(allWorkspaceTurns);
      const activeCount = activeAgentCount + activeWorkspaceTurnCount;
      if (activeCount >= taskSettings.maxParallelAgentTasks) {
        return Err(
          `Task.createWorkspaceTurn: maxParallelAgentTasks exceeded (active=${activeCount}, max=${taskSettings.maxParallelAgentTasks})`
        );
      }
      return Ok(undefined);
    };

    const handleId = `${WORKSPACE_TURN_TASK_ID_PREFIX}${this.config.generateStableId()}`;
    const turnId = this.config.generateStableId();
    const createdAt = this.nextWorkspaceTurnCreatedAt();
    // New workspace turns use exec. Follow-ups in a persistent agent-task workspace preserve that
    // child's original agent identity and task-level model settings. An explicit args.agentId
    // (validated above/below) overrides either default for this turn only.
    let workspaceTurnAgentId = "exec";
    // Definition context of the checkout the explicit agent was validated against, so
    // agent-authored frontmatter `ai` defaults participate in AI-settings resolution
    // (mirrors the sub-agent creation path). Left unset for default exec/resume turns.
    let agentDefinitionContext: NodeAgentDefinitionContext | undefined;
    // Provenance (scope + exact source + base chain) of the definition that
    // authorized the dispatch; pinned at stream time via strictAgentResolution so a
    // vanished definition or base shadow cannot silently hand any hop to a
    // different candidate.
    let validatedAgentProvenance:
      | { scope: AgentDefinitionScope; source?: string; chain: WorkspaceTurnAgentChainEntry[] }
      | undefined;
    // Post-create target validation failure. Deferred (not returned immediately) so the
    // workspace-turn record is still written first: the record marks the created workspace
    // as owner-owned and retryable via mode="existing", and the failure settles through the
    // normal handle machinery instead of stranding an unowned workspace.
    let agentValidationError: string | undefined;
    let targetWorkspaceId: string;
    let targetAiSettings: ResolvedWorkspaceAiSettings | undefined;
    let targetTaskModelString: string | undefined;
    let targetTaskThinkingLevel: ThinkingLevel | undefined;
    let targetTaskExperiments: TaskCreateArgs["experiments"];
    let targetIsAgentWorkspace = false;
    let createdWorkspace = false;
    let queuedForExistingWorkspace = false;
    let maySupersedeTaskId: string | undefined;

    if (mode === "fork") {
      return Err('Task.createWorkspaceTurn: workspace.mode="fork" is not supported yet');
    }

    if (mode === "existing") {
      const existingWorkspaceId = coerceNonEmptyString(args.workspace?.workspaceId);
      if (!existingWorkspaceId) {
        return Err("Task.createWorkspaceTurn: workspace.workspaceId is required for existing mode");
      }
      const targetEntry = findWorkspaceEntry(cfg, existingWorkspaceId);

      const ownsExistingWorkspaceTurn = ownerWorkspaceTurns.some(
        (record) => record.createdWorkspace && record.workspaceId === existingWorkspaceId
      );
      const ownsDescendantAgentWorkspace =
        args.allowAgentWorkspace === true &&
        targetEntry?.workspace.parentWorkspaceId != null &&
        this.taskHost.isDescendantAgentTaskInConfig(cfg, ownerWorkspaceId, existingWorkspaceId);
      if (!ownsExistingWorkspaceTurn && !ownsDescendantAgentWorkspace) {
        return Err("Task.createWorkspaceTurn: invalid_scope for existing workspace");
      }
      if (
        targetEntry != null &&
        isWorkspaceArchived(targetEntry.workspace.archivedAt, targetEntry.workspace.unarchivedAt)
      ) {
        return Err("Task.createWorkspaceTurn: existing workspace is archived");
      }
      targetWorkspaceId = existingWorkspaceId;
      if (ownsDescendantAgentWorkspace && targetEntry != null) {
        targetIsAgentWorkspace = true;
        workspaceTurnAgentId = resolveTaskAgentIdForResume(targetEntry.workspace);
        targetTaskModelString = coerceNonEmptyString(targetEntry.workspace.taskModelString);
        targetTaskThinkingLevel = targetEntry.workspace.taskThinkingLevel;
        targetTaskExperiments = targetEntry.workspace.taskExperiments;
      }
      if (requestedAgentId != null) {
        // Persistent agent-task children are pinned to their persisted identity:
        // resolveAgentForStream ignores the per-send agentId whenever metadata has
        // parentWorkspaceId, so an override could never actually run — reject instead of
        // resolving settings for an agent that will not stream.
        if (targetIsAgentWorkspace) {
          return Err(
            `Task.createWorkspaceTurn: explicit agentId is not supported for descendant agent workspaces (${targetWorkspaceId} keeps its persisted agent identity)`
          );
        }
        // Per-turn override for a normal owner-created workspace: wins for this turn but
        // never mutates the target workspace's saved agent/settings (the dispatch below
        // skips AI-settings persistence). Validate against the TARGET workspace's checkout
        // (project-local agent definitions can diverge across branches).
        const ownerContext = this.buildWorkspaceTurnAgentContext({
          runtimeConfig: parentMeta.runtimeConfig,
          projectPath: parentMeta.projectPath,
          workspaceName: parentMeta.name,
          persistedWorkspacePath: parentEntry?.workspace.path,
          subProjectPath: parentMeta.subProjectPath,
        });
        const targetContext =
          targetEntry != null
            ? this.buildWorkspaceTurnAgentContext({
                runtimeConfig: targetEntry.workspace.runtimeConfig ?? parentMeta.runtimeConfig,
                projectPath: targetEntry.projectPath,
                // Entries created by workspaceService.create always carry a name; the fallback
                // only satisfies the optional persisted-config type.
                workspaceName: coerceNonEmptyString(targetEntry.workspace.name) ?? parentMeta.name,
                persistedWorkspacePath: targetEntry.workspace.path,
                subProjectPath: targetEntry.workspace.subProjectPath,
              })
            : ownerContext;
        const validation = await this.validateWorkspaceTurnAgentIdForTarget({
          cfg,
          agentId: requestedAgentId,
          workspaceId: existingWorkspaceId,
          target: targetContext,
          owner: ownerContext,
          targetInitPending:
            this.initStateManager.getInitState(existingWorkspaceId)?.status === "running",
          // Existing targets have unknown checkout provenance (any branch, uncommitted
          // shadows), so an unreachable checkout fails closed rather than trusting the
          // owner's resolution. Omitting agentId still works (default identity).
          ownerResolutionPredictsTarget: false,
        });
        if (!validation.success) return Err(validation.error);
        workspaceTurnAgentId = requestedAgentId;
        validatedAgentProvenance = {
          scope: validation.data.scope,
          ...(validation.data.source != null ? { source: validation.data.source } : {}),
          chain: validation.data.chain,
        };
        agentDefinitionContext = {
          ...validation.data.validatedContext,
          workspaceId: targetWorkspaceId,
        };
      }
      // Follow-up sends continue the target workspace's own last-used settings
      // (persisted on every send, or manually changed by the user in that
      // workspace) instead of re-inheriting the owner's live settings on each
      // message — the owner changing its model/thinking must not drag
      // already-created children along.
      targetAiSettings = targetEntry
        ? this.taskHost.resolveWorkspaceAISettings(targetEntry.workspace, workspaceTurnAgentId)
        : undefined;
      queuedForExistingWorkspace = this.workspaceService.isBusyForMessage(existingWorkspaceId);
      const activeWorkspaceTurn = await this.findActiveWorkspaceTurnForWorkspace(
        allWorkspaceTurns,
        existingWorkspaceId
      );
      if (!queuedForExistingWorkspace || activeWorkspaceTurn == null) {
        const slot = await ensureParallelSlot();
        if (!slot.success) return Err(slot.error);
      }
      // Announce the probable quiet supersession in the creation result: with
      // tool-end dispatch this follow-up cuts the caller's own immediately
      // preceding delegated turn (the newest live handle — the queue tail, not
      // necessarily the currently streaming one) at that turn's next tool
      // boundary, and that handle then settles interrupted without a separate
      // wake (see buildOwnerFollowUpSupersededError). Only the caller's own
      // handle qualifies — a different owner's turn keeps its notify behavior.
      if (
        queuedForExistingWorkspace &&
        activeWorkspaceTurn?.ownerWorkspaceId === ownerWorkspaceId &&
        queueDispatchMode === "tool-end"
      ) {
        maySupersedeTaskId = activeWorkspaceTurn.handleId;
      }
    } else {
      let ownerContext: WorkspaceTurnAgentContext | undefined;
      // Owner-side vouching for the created checkout's agent definitions requires proof
      // that the target's base IS the branch actually checked out in the owner. The
      // workspace name cannot prove it: branch→name sanitization is not injective
      // (feature/foo and feature-foo both map to feature-foo) in BOTH directions — a
      // request naming the owner's workspace name may be a distinct colliding branch, and
      // the omitted-arg default (parentMeta.name, passed as trunkBranch to create below)
      // may itself differ from a slash-branch owner's real branch. A different/unproven
      // base means agents may exist only on the target branch (owner-side misses must not
      // fail-fast) and the target branch may shadow ANY id (unreachable targets fail
      // closed in validateWorkspaceTurnAgentIdForTarget).
      const requestedTrunkBranch = coerceNonEmptyString(args.workspace?.trunkBranch);
      let ownerVouchesForTargetBase = false;
      if (requestedAgentId != null) {
        ownerContext = this.buildWorkspaceTurnAgentContext({
          runtimeConfig: parentMeta.runtimeConfig,
          projectPath: parentMeta.projectPath,
          workspaceName: parentMeta.name,
          persistedWorkspacePath: parentEntry?.workspace.path,
          subProjectPath: parentMeta.subProjectPath,
        });
        const effectiveTrunkBranch = requestedTrunkBranch ?? parentMeta.name;
        const ownerBranch = await tryReadGitCurrentBranch(
          ownerContext.runtime,
          ownerContext.workspacePath
        );
        const ownerBranchMatchesTargetBase =
          ownerBranch != null && ownerBranch === effectiveTrunkBranch;
        // Branch equality is not checkout equality: the child is created from COMMITTED
        // branch state, so uncommitted agent-definition changes in the owner (a shadow
        // added or removed) make owner-side resolution diverge from what the target will
        // actually see. Vouching therefore also requires the agent-definition paths to
        // be clean; unknown cleanliness (no git output) fails the vouch.
        const ownerAgentDirsClean = ownerBranchMatchesTargetBase
          ? await tryReadGitPathsClean(
              ownerContext.runtime,
              ownerContext.workspacePath,
              AGENT_DEFINITION_PROJECT_PATHSPECS
            )
          : undefined;
        // Nor is the owner's HEAD necessarily the target's base COMMIT: worktree
        // creation may branch from origin/<trunkBranch> when the local branch can
        // fast-forward, so a stale (or diverged) owner cannot vouch for definitions
        // added or removed in the newer remote commit.
        const ownerCommitMatchesOrigin =
          ownerBranchMatchesTargetBase && ownerAgentDirsClean === true
            ? await tryReadGitBranchMatchesOrigin(
                ownerContext.runtime,
                ownerContext.workspacePath,
                effectiveTrunkBranch
              )
            : undefined;
        // An explicit branchName can attach the worktree to an EXISTING branch of that
        // name (WorktreeManager detects and reuses it), making the trunk comparison
        // above meaningless for the actual base — never vouch in that case.
        const requestedBranchName = coerceNonEmptyString(args.workspace?.branchName);
        ownerVouchesForTargetBase =
          requestedBranchName == null &&
          ownerBranchMatchesTargetBase &&
          ownerAgentDirsClean === true &&
          ownerCommitMatchesOrigin === true;
        // Pre-create stage: catch obviously bad ids (unknown/hidden/disabled) against the
        // OWNER's checkout before creating any workspace. Fatal only when the owner's
        // checked-out branch provably IS the target's base (an omitted trunkBranch still
        // resolves to parentMeta.name, which may be a DIFFERENT branch than a slash-branch
        // owner's — that distinct branch could carry target-only agents); otherwise the
        // miss is advisory and the target checkout is authoritative post-create.
        const validation = await this.validateWorkspaceTurnAgentId({
          cfg,
          agentId: requestedAgentId,
          workspaceId: ownerWorkspaceId,
          ...ownerContext,
        });
        if (!validation.success) {
          // Owner-side misses are ALWAYS advisory: the created checkout is the only
          // authoritative source of the target's agent definitions. No owner-side
          // equivalence proof is sound here — worktree creation may fetch a newer
          // origin commit, attach to an existing branchName, initialize submodules the
          // owner never materialized, or run a committed init hook that installs the
          // requested agent — so a pre-create rejection could deny a launch the real
          // target would accept. Post-create validation (and, for anything it cannot
          // see, the stream-time strict provenance pin) fails loudly instead.
          log.debug(
            "Task.createWorkspaceTurn: owner-side agent validation failed; deferring to the target checkout",
            { agentId: requestedAgentId, error: validation.error }
          );
        } else {
          agentDefinitionContext = { ...ownerContext, workspaceId: ownerWorkspaceId };
        }
      }
      const slot = await ensureParallelSlot();
      if (!slot.success) return Err(slot.error);
      const tags = {
        [WORKSPACE_TURN_TASK_TAGS.handle]: handleId,
        [WORKSPACE_TURN_TASK_TAGS.ownerWorkspaceId]: ownerWorkspaceId,
        [WORKSPACE_TURN_TASK_TAGS.turn]: turnId,
      };
      const createResult = await this.workspaceService.create(
        parentMeta.projectPath,
        args.workspace?.branchName,
        args.workspace?.trunkBranch ?? parentMeta.name,
        title,
        parentMeta.runtimeConfig,
        parentMeta.subProjectPath,
        false,
        tags
      );
      if (!createResult.success) {
        return Err(`Task.createWorkspaceTurn: workspace create failed (${createResult.error})`);
      }
      targetWorkspaceId = createResult.data.metadata.id;
      createdWorkspace = true;
      if (requestedAgentId != null && ownerContext != null) {
        // Post-create stage: re-validate against the TARGET checkout — project-local agent
        // definitions can diverge across branches/worktrees, so owner-path resolution is not
        // an invariant. On failure, do NOT return before the workspace-turn record exists:
        // the record marks the created workspace as owner-owned, so a mode="existing" retry
        // (once the checkout is ready or with a valid agent) passes the ownership check
        // instead of hitting invalid_scope. The failure settles through the normal handle
        // machinery below.
        const createdMeta = createResult.data.metadata;
        const targetContext = this.buildWorkspaceTurnAgentContext({
          runtimeConfig: createdMeta.runtimeConfig,
          projectPath: createdMeta.projectPath,
          workspaceName: createdMeta.name,
          persistedWorkspacePath: createdMeta.namedWorkspacePath,
          subProjectPath: createdMeta.subProjectPath,
        });
        const validation = await this.validateWorkspaceTurnAgentIdForTarget({
          cfg,
          agentId: requestedAgentId,
          workspaceId: targetWorkspaceId,
          target: targetContext,
          owner: ownerContext,
          // create() starts runBackgroundInit asynchronously; a reachable checkout whose
          // init hook is still running may not have its final agent definitions yet.
          targetInitPending:
            this.initStateManager.getInitState(targetWorkspaceId)?.status === "running",
          ownerResolutionPredictsTarget: ownerVouchesForTargetBase,
        });
        if (!validation.success) {
          // Disposable workspaces are removed by the settlement's disposable cleanup.
          // That cleanup is best-effort (failures are logged and swallowed), so the
          // wording must not assert completed removal; if cleanup fails the workspace
          // stays owner-owned and a mode="existing" retry still passes ownership.
          agentValidationError =
            args.workspace?.disposable === true
              ? `${validation.error} — no turn was dispatched; automatic cleanup of the disposable workspace (${targetWorkspaceId}) was scheduled (if cleanup fails, it remains owned by this caller and retryable via workspace.mode="existing")`
              : `${validation.error} — no turn was dispatched; the created workspace (${targetWorkspaceId}) is owned by this caller and can be retried via workspace.mode="existing" once ready`;
        } else {
          validatedAgentProvenance = {
            scope: validation.data.scope,
            ...(validation.data.source != null ? { source: validation.data.source } : {}),
            chain: validation.data.chain,
          };
          agentDefinitionContext = {
            ...validation.data.validatedContext,
            workspaceId: targetWorkspaceId,
          };
        }
      }
      workspaceTurnAgentId = requestedAgentId ?? workspaceTurnAgentId;
    }

    // Unified per-field precedence (see resolveAgentAiSettings): explicit
    // per-launch override → target workspace's own persisted settings
    // (mode="existing" follow-ups, plus task-frozen settings for resumed agent
    // workspaces) → configured agent defaults → owner's live runtime settings
    // → owner's persisted settings → app default.
    const targetLayer: AgentAiSettingsLayerValues | undefined =
      targetAiSettings != null
        ? {
            ...targetWorkspaceBucketToLayer(targetAiSettings),
            // Resumed agent workspaces prefer the bucket, then task-frozen settings.
            model: coerceNonEmptyString(targetAiSettings.model) ?? targetTaskModelString,
            thinkingLevel: targetAiSettings.thinkingLevel ?? targetTaskThinkingLevel,
          }
        : targetTaskModelString != null || targetTaskThinkingLevel != null
          ? { model: targetTaskModelString, thinkingLevel: targetTaskThinkingLevel }
          : undefined;
    let model: string;
    let thinkingLevel: ThinkingLevel;
    let reasoningMode: OpenAIReasoningMode | undefined;
    try {
      const resolved = await resolveNodeAgentAiSettings({
        agentId: workspaceTurnAgentId,
        profile: "interactive",
        cfg,
        providersConfig: this.aiService.getProvidersConfig(),
        explicit: {
          model: coerceNonEmptyString(args.modelString) ?? undefined,
          thinkingLevel: args.thinkingLevel ?? undefined,
        },
        targetWorkspaceSettings: targetLayer,
        parentRuntime: args.parentRuntimeAiSettings
          ? {
              model: coerceNonEmptyString(args.parentRuntimeAiSettings.modelString) ?? undefined,
              thinkingLevel: args.parentRuntimeAiSettings.thinkingLevel,
            }
          : undefined,
        fallbacks: this.taskHost.buildParentAiSettingsFallbacks(parentMeta, workspaceTurnAgentId),
        // Explicit agent overrides resolve the agent's own frontmatter `ai` defaults from the
        // checkout they were validated against (mirrors resolveTaskAISettings' definitionContext).
        // Known tradeoff: these launch AI defaults are a snapshot — an init hook that later
        // rewrites the agent's `ai` frontmatter does not retroactively change the model/thinking
        // already selected here (waiting for init is not an option under the service-wide mutex).
        // This is bounded to convenience defaults: callers wanting determinism pass explicit
        // model/thinking, the send path re-clamps thinking and re-gates reasoning per model at
        // request time, and the authoritative prompt/tool policy is always resolved at stream
        // time (after init) with strictAgentResolution guarding agent identity.
        ...(agentDefinitionContext != null ? { definitionContext: agentDefinitionContext } : {}),
      });
      // Selected (not effective) values: sendMessage persists what it
      // receives, and the send path re-clamps thinking and re-gates reasoning
      // per model/route at request time.
      model = resolved.selected.model;
      thinkingLevel = resolved.selected.thinkingLevel;
      reasoningMode = resolved.selected.reasoningMode;
    } catch (error) {
      if (error instanceof InvalidExplicitAiSettingError) {
        return Err(`Task.createWorkspaceTurn: ${error.message}`);
      }
      throw error;
    }

    const record: WorkspaceTurnTaskHandleRecord = {
      kind: "workspace_turn",
      handleId,
      ownerWorkspaceId,
      workspaceId: targetWorkspaceId,
      turnId,
      status: queuedForExistingWorkspace ? "queued" : "running",
      createdAt,
      updatedAt: createdAt,
      createdWorkspace,
      disposableWorkspace: createdWorkspace && args.workspace?.disposable === true,
      title,
      prompt,
      modelString: model,
      ...(thinkingLevel != null ? { thinkingLevel } : {}),
      // Synchronous validation failure below returns the error directly to the caller, so
      // never persist notify_on_terminal for it: settleWorkspaceTurn derives the terminal
      // wake from the PERSISTED record's attentionPolicy, which would enqueue a duplicate
      // notification on top of the synchronous Err.
      ...(args.attentionPolicy != null && agentValidationError == null
        ? { attentionPolicy: args.attentionPolicy }
        : {}),
    };
    // Serialize handle persistence with owned-workspace lifecycle mutations: archive holds the
    // same per-workspace locks for its active-turn check + archive call, so either this handle
    // is visible to that check (archive refuses/interrupts explicitly) or the archive completed
    // first and the re-checks below refuse this turn. Both the TARGET (a follow-up racing the
    // target's archive would be silently stream-stopped) and the OWNER (a nested turn racing
    // the owner's archive would orphan its eventual result) must be covered. This is the
    // mutex → lifecycle edge of the global lock order (task-tree → this.mutex →
    // workspaceLifecycleLocks; see the workspaceLifecycleLocks declaration), with sorted keys
    // preventing lifecycle-key cycles between concurrent owner/target pairs.
    const isArchivedInConfig = (workspaceId: string): boolean => {
      const entry = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId);
      return (
        entry != null &&
        isWorkspaceArchived(entry.workspace.archivedAt, entry.workspace.unarchivedAt)
      );
    };
    const lifecycleLockKeys =
      ownerWorkspaceId === targetWorkspaceId
        ? [targetWorkspaceId]
        : [ownerWorkspaceId, targetWorkspaceId].sort();
    let persistedHandle = false;
    const persisted = await this.withWorkspaceLifecycleLockKeys(
      lifecycleLockKeys,
      async (): Promise<"persisted" | "target_archived" | "owner_archived"> => {
        if (isArchivedInConfig(targetWorkspaceId)) return "target_archived";
        if (isArchivedInConfig(ownerWorkspaceId)) return "owner_archived";
        return await this.desktopInputCoordinator.withAdmission(targetWorkspaceId, async () => {
          await this.taskHandleStore.upsertWorkspaceTurn(record);
          persistedHandle = true;
          if (record.status !== "queued") {
            this.activeWorkspaceTurnHandleByWorkspaceId.set(targetWorkspaceId, {
              handleId,
              ownerWorkspaceId,
              // Reservation only: the sendMessage below may still fail requireIdle or be canceled
              // pre-admission. Peer-send admission must not treat this entry as live until
              // markWorkspaceTurnAccepted flips it.
              accepted: false,
            });
          }
          if (targetIsAgentWorkspace) {
            await this.persistAgentTaskExecutionState(
              targetWorkspaceId,
              handleId,
              record.status,
              true
            );
          }
          return "persisted" as const;
        });
      }
    ).catch((error: unknown) => ({ error: getErrorMessage(error) }));
    if (typeof persisted === "object") {
      if (persistedHandle) {
        await this.settleWorkspaceTurn({
          cause: { kind: "creation-admission-failure" },
          record,
          next: { ...record, status: "error", updatedAt: getIsoNow(), error: persisted.error },
          waiterSettlement: { status: "error", error: new Error(persisted.error) },
        });
      }
      return Err(persisted.error);
    }
    if (persisted === "target_archived") {
      return Err("Task.createWorkspaceTurn: target workspace was archived during turn creation");
    }
    if (persisted === "owner_archived") {
      // A workspace created in this call has no persisted ownership handle yet, so refusing
      // here would leak an unmanageable checkout + config entry (the archived owner can never
      // reach it through the lifecycle API). It was materialized moments ago and its turn never
      // started, so force-removing it is lossless. Bypass the task-tree lifecycle lock: we hold
      // this.mutex and the established order is tree lock → this.mutex (createMany), so
      // acquiring the tree lock here would invert it; removeUnlocked stays safe regardless via
      // its own idempotency guard and fail-closed descendant check.
      if (createdWorkspace) {
        const cleanup = await this.workspaceService.removeWhileTaskTreeLocked(
          targetWorkspaceId,
          true
        );
        if (!cleanup.success) {
          log.error("createWorkspaceTurn: failed to clean up workspace after owner archive", {
            ownerWorkspaceId,
            targetWorkspaceId,
            error: cleanup.error,
          });
        }
      }
      return Err("Task.createWorkspaceTurn: owner workspace was archived during turn creation");
    }
    if (agentValidationError != null) {
      // Deferred post-create validation failure: the record above keeps the created
      // workspace owner-owned (retryable via mode="existing"); settle the handle as a
      // normal error instead of dispatching the turn. The record was persisted without
      // attentionPolicy (see above), so settlement cannot enqueue a terminal wake on
      // top of the synchronous Err returned below.
      const next: WorkspaceTurnTaskHandleRecord = {
        ...record,
        status: "error",
        updatedAt: getIsoNow(),
        error: agentValidationError,
      };
      await this.settleWorkspaceTurn({
        cause: { kind: "creation-validation-failure" },
        record,
        next,
        waiterSettlement: { status: "error", error: new Error(agentValidationError) },
      });
      return Err(agentValidationError);
    }

    const markWorkspaceTurnAccepted = async () => {
      await this.workspaceTurnSettlementLocks.withLock(handleId, async () => {
        const current = await this.taskHandleStore.getWorkspaceTurn(ownerWorkspaceId, handleId);
        if (current?.workspaceId !== targetWorkspaceId) {
          throw new Error("Workspace turn was canceled before stream start");
        }
        if (current.turnId !== turnId) {
          throw new Error("Workspace turn correlation changed before stream start");
        }
        if (this.isTerminalWorkspaceTurnStatus(current.status)) {
          throw new Error(current.error ?? "Workspace turn was canceled before stream start");
        }
        if (targetIsAgentWorkspace) {
          const claimed = await this.desktopInputCoordinator.withAdmission(targetWorkspaceId, () =>
            this.persistAgentTaskExecutionState(targetWorkspaceId, handleId, "running", true)
          );
          if (!claimed) throw new Error("Workspace turn was superseded before stream start");
        }
        if (current.status !== "running") {
          await this.taskHandleStore.upsertWorkspaceTurn({
            ...current,
            status: "running",
            updatedAt: getIsoNow(),
          });
        }
        if (targetIsAgentWorkspace) {
          // A stopped queued child keeps its only copy of the initial brief in taskPrompt. Once the
          // continuation accepts the replayed prompt, history owns that brief and the config copy can go.
          await this.taskHost.editWorkspaceEntry(
            targetWorkspaceId,
            (workspace) => {
              delete workspace.taskPrompt;
            },
            { allowMissing: true }
          );
        }
        this.activeWorkspaceTurnHandleByWorkspaceId.set(targetWorkspaceId, {
          handleId,
          ownerWorkspaceId,
          accepted: true,
        });
      });
    };

    const sendResult = await this.workspaceService.sendMessage(
      targetWorkspaceId,
      prompt,
      {
        model,
        agentId: workspaceTurnAgentId,
        ...(thinkingLevel != null ? { thinkingLevel } : {}),
        ...(reasoningMode != null ? { reasoningMode } : {}),
        muxMetadata: this.buildWorkspaceTurnMuxMetadata(record),
        experiments: args.experiments ?? targetTaskExperiments,
        ...(mode === "existing" ? { queueDispatchMode } : {}),
        // A per-turn agent override on an existing workspace must not overwrite the target's
        // saved agent/settings (maybePersistAISettingsFromOptions persists them on every
        // ordinary send). New workspaces still persist: the requested agent IS their default.
        ...(mode === "existing" && requestedAgentId != null
          ? { skipAiSettingsPersistence: true }
          : {}),
        // Explicit overrides were validated pre-dispatch, but that validation races init
        // hooks and later edits; stream-time resolution runs after initialization and must
        // fail loudly rather than silently swap in exec — and, when the validated scope is
        // known, must not run a different-provenance definition for the same id (see
        // strictAgentResolution docs).
        ...(requestedAgentId != null
          ? {
              strictAgentResolution:
                validatedAgentProvenance != null
                  ? {
                      expectedScope: validatedAgentProvenance.scope,
                      ...(validatedAgentProvenance.source != null
                        ? { expectedSource: validatedAgentProvenance.source }
                        : {}),
                      expectedChain: validatedAgentProvenance.chain,
                    }
                  : true,
            }
          : {}),
      },
      {
        startStreamInBackground: true,
        requireIdle: !queuedForExistingWorkspace,
        onCanceled: async (reason) => {
          const current = await this.taskHandleStore.getWorkspaceTurn(ownerWorkspaceId, handleId);
          if (
            current == null ||
            (current.status !== "queued" &&
              current.status !== "starting" &&
              current.status !== "running")
          ) {
            return;
          }
          const next: WorkspaceTurnTaskHandleRecord = {
            ...current,
            status: "interrupted",
            updatedAt: getIsoNow(),
            error: reason,
          };
          await this.settleWorkspaceTurn({
            cause: { kind: "launch-canceled" },
            record: current,
            next,
            waiterSettlement: { status: "error", error: new Error(reason) },
          });
        },
        onAccepted: markWorkspaceTurnAccepted,
        onAcceptedPreStreamFailure: async (sendError) => {
          const error = formatSendMessageError(sendError).message;
          const current = await this.taskHandleStore.getWorkspaceTurn(ownerWorkspaceId, handleId);
          if (
            current == null ||
            (current.status !== "queued" &&
              current.status !== "starting" &&
              current.status !== "running")
          ) {
            return;
          }
          const next: WorkspaceTurnTaskHandleRecord = {
            ...current,
            status: "error",
            updatedAt: getIsoNow(),
            error,
          };
          await this.settleWorkspaceTurn({
            cause: { kind: "send-failure" },
            record: current,
            next,
            waiterSettlement: { status: "error", error: new Error(error) },
          });
        },
        agentInitiated: true,
      }
    );

    if (!sendResult.success) {
      const error = formatSendMessageError(sendResult.error).message;
      const next: WorkspaceTurnTaskHandleRecord = {
        ...record,
        status: "error",
        updatedAt: getIsoNow(),
        error,
      };
      await this.settleWorkspaceTurn({
        cause: { kind: "send-failure" },
        record,
        next,
        waiterSettlement: { status: "error", error: new Error(error) },
      });
      return Err(`Task.createWorkspaceTurn: send failed (${error})`);
    }

    const acceptedRecord = await this.taskHandleStore.getWorkspaceTurn(ownerWorkspaceId, handleId);
    const acceptedStatus = acceptedRecord?.status === "running" ? "running" : record.status;
    return Ok({
      taskId: handleId,
      kind: "workspace_turn",
      status: acceptedStatus === "queued" ? "queued" : "running",
      workspaceId: targetWorkspaceId,
      ...(maySupersedeTaskId != null ? { maySupersedeTaskId } : {}),
    });
  }

  async recoverTerminalWorkspaceTurnAttentionNotifications(): Promise<number> {
    const terminalRecords = await this.taskHandleStore.listAllWorkspaceTurns({
      statuses: ["completed", "interrupted", "error"],
    });
    let recoveredCount = 0;
    for (const record of terminalRecords) {
      if (
        record.directParentResultDeliveryRequiredAt != null &&
        record.directParentResultDeliveredAt == null
      ) {
        try {
          await this.deliverPersistentChildWorkspaceTurnResult(record, new Set());
        } catch (error: unknown) {
          // Startup recovery is best-effort: one read-only/corrupt session must not block the app.
          log.warn("Failed to recover direct-parent continuation delivery", {
            ownerWorkspaceId: record.ownerWorkspaceId,
            workspaceId: record.workspaceId,
            handleId: record.handleId,
            error: getErrorMessage(error),
          });
        }
      }
      if (
        resolveBackgroundWorkAttentionPolicy(record.attentionPolicy) !== "notify_on_terminal" ||
        record.terminalAttentionNotifiedAt != null ||
        // Owner-follow-up supersedes never notified in the first place; a
        // restart must not resurrect the suppressed wake.
        workspaceTurnTerminalAttentionSuppressed(record)
      ) {
        continue;
      }
      try {
        const outcome = terminalAttentionOutcome(record.status);
        const legacyAttention = await this.terminalAttentionStore.get(
          record.ownerWorkspaceId,
          TerminalAttentionStore.notificationId("workspace_turn", record.handleId)
        );
        const legacyCreatedAt =
          legacyAttention != null ? Date.parse(legacyAttention.createdAt) : Number.NaN;
        const recordUpdatedAt = Date.parse(record.updatedAt);
        const legacyRepresentsCurrentOutcome =
          legacyAttention?.terminalOutcome === outcome &&
          Number.isFinite(legacyCreatedAt) &&
          Number.isFinite(recordUpdatedAt) &&
          legacyCreatedAt >= recordUpdatedAt;
        if (!legacyRepresentsCurrentOutcome) {
          // Corrected outcomes must bypass a stale legacy tombstone. New settlements use this same
          // versioned ID, while the timestamp check preserves old ordinary-settlement dedupe.
          await this.taskHost.enqueueTerminalAttention({
            ownerWorkspaceId: record.ownerWorkspaceId,
            sourceKind: "workspace_turn",
            terminalOutcome: outcome,
            sourceId: record.handleId,
            generationId: this.workspaceTurnTerminalAttentionGenerationId(record),
          });
        }
        await this.workspaceTurnSettlementLocks.withLock(record.handleId, async () => {
          const current = await this.taskHandleStore.getWorkspaceTurn(
            record.ownerWorkspaceId,
            record.handleId
          );
          if (
            current != null &&
            current.status === record.status &&
            current.updatedAt === record.updatedAt &&
            resolveBackgroundWorkAttentionPolicy(current.attentionPolicy) ===
              "notify_on_terminal" &&
            current.terminalAttentionNotifiedAt == null
          ) {
            await this.taskHandleStore.upsertWorkspaceTurn({
              ...current,
              terminalAttentionNotifiedAt: getIsoNow(),
            });
          }
        });
        recoveredCount += 1;
      } catch (error: unknown) {
        // Startup recovery is best-effort: one read-only/corrupt owner session must not block the app.
        log.warn("Failed to recover workspace-turn terminal attention", {
          ownerWorkspaceId: record.ownerWorkspaceId,
          workspaceId: record.workspaceId,
          handleId: record.handleId,
          error: getErrorMessage(error),
        });
      }
    }
    return recoveredCount;
  }

  async markWorkspaceTurnTerminalAttentionConsumed(params: {
    ownerWorkspaceId: string;
    consumingWorkspaceId: string;
    handleId: string;
    status: WorkspaceTurnTaskStatus;
    updatedAt: string;
  }): Promise<void> {
    assert(
      params.ownerWorkspaceId.length > 0,
      "markWorkspaceTurnTerminalAttentionConsumed requires ownerWorkspaceId"
    );
    assert(
      params.handleId.length > 0,
      "markWorkspaceTurnTerminalAttentionConsumed requires handleId"
    );
    assert(
      params.consumingWorkspaceId.length > 0,
      "markWorkspaceTurnTerminalAttentionConsumed requires consumingWorkspaceId"
    );
    assert(
      params.updatedAt.length > 0,
      "markWorkspaceTurnTerminalAttentionConsumed requires updatedAt"
    );
    // A nested continuation's owner and direct parent can differ. Returning the result to the
    // direct parent must not consume the owner-scoped workspace-turn wake for the ancestor that
    // initiated the continuation.
    if (
      params.consumingWorkspaceId !== params.ownerWorkspaceId ||
      !this.isTerminalWorkspaceTurnStatus(params.status)
    ) {
      return;
    }
    await this.workspaceTurnSettlementLocks.withLock(params.handleId, async () => {
      const current = await this.taskHandleStore.getWorkspaceTurn(
        params.ownerWorkspaceId,
        params.handleId
      );
      if (
        current == null ||
        current.status !== params.status ||
        current.updatedAt !== params.updatedAt
      ) {
        return;
      }
      await this.markWorkspaceTurnTerminalAttentionConsumedUnlocked(current);
    });
  }

  private buildWorkspaceTurnWaitResult(
    record: WorkspaceTurnTaskHandleRecord
  ): WorkspaceTurnWaitResult {
    assert(record.handleId.length > 0, "workspace turn record requires handleId");
    assert(record.workspaceId.length > 0, "workspace turn record requires workspaceId");
    return {
      taskId: record.handleId,
      workspaceId: record.workspaceId,
      updatedAt: record.updatedAt,
      reportMarkdown:
        record.reportMarkdown ?? "Workspace turn completed without final text output.",
      title: record.title,
      messageId: record.messageId,
      finalMessageRef: record.finalMessageRef,
    };
  }

  /** Settle pending workspace-turn waiters and return the workspaces that consumed the result. */
  private settleWorkspaceTurnWaiters(
    handleId: string,
    settlement:
      | { status: "completed"; result: WorkspaceTurnWaitResult }
      | { status: "error"; error: Error }
  ): Set<string> {
    assert(handleId.length > 0, "settleWorkspaceTurnWaiters requires handleId");
    const waiters = this.pendingWorkspaceTurnWaitersByHandleId.get(handleId) ?? [];
    this.pendingWorkspaceTurnWaitersByHandleId.delete(handleId);
    const requestingWorkspaceIds = new Set<string>();
    for (const waiter of waiters) {
      if (waiter.requestingWorkspaceId != null) {
        requestingWorkspaceIds.add(waiter.requestingWorkspaceId);
      }
      if (settlement.status === "completed") {
        waiter.resolve(settlement.result);
      } else {
        waiter.reject(settlement.error);
      }
    }
    return requestingWorkspaceIds;
  }

  /**
   * Move disposable-workspace ownership from a quietly superseded handle to
   * its successor. Returns false when the successor is missing, targets a
   * different workspace, or already settled terminally (its own cleanup
   * chance is gone) — the caller then keeps disposable ownership on the old
   * record. Holds the successor's settlement lock so its own settlement
   * cannot interleave with the ownership flip.
   */
  private async transferDisposableWorkspaceToSuccessor(
    record: WorkspaceTurnTaskHandleRecord,
    successorHandleId: string
  ): Promise<boolean> {
    return await this.workspaceTurnSettlementLocks.withLock(successorHandleId, async () => {
      const successor = await this.taskHandleStore.getWorkspaceTurn(
        record.ownerWorkspaceId,
        successorHandleId
      );
      if (
        successor == null ||
        successor.workspaceId !== record.workspaceId ||
        this.isTerminalWorkspaceTurnStatus(successor.status)
      ) {
        return false;
      }
      if (!successor.disposableWorkspace) {
        // Metadata-only flip: updatedAt stays unchanged so terminal-attention
        // generation ids and settlement staleness comparisons are unaffected.
        await this.taskHandleStore.upsertWorkspaceTurn({
          ...successor,
          disposableWorkspace: true,
        });
      }
      return true;
    });
  }

  /**
   * Forward disposable-workspace ownership from a terminally settled handle to
   * the oldest live same-owner turn still targeting the same workspace, if
   * any. Covers settlement paths with no queue-cut attribution (cancellation,
   * accepted pre-stream failures, stale-handle recovery) and three-handle
   * chains where the announced successor itself failed while another follow-up
   * remains queued. Returns true when ownership moved.
   */
  private async forwardDisposableOwnershipToLiveSuccessor(
    record: WorkspaceTurnTaskHandleRecord
  ): Promise<boolean> {
    // createdAt-ascending: prefer the next turn in line; if it settles too,
    // its own cleanup forwards again, so the cascade always terminates at a
    // live successor or actual removal.
    const candidates = await this.taskHandleStore.listWorkspaceTurns(record.ownerWorkspaceId);
    for (const candidate of candidates) {
      if (
        candidate.handleId === record.handleId ||
        candidate.workspaceId !== record.workspaceId ||
        !isActiveWorkspaceTurnTaskStatus(candidate.status)
      ) {
        continue;
      }
      if (await this.transferDisposableWorkspaceToSuccessor(record, candidate.handleId)) {
        return true;
      }
    }
    return false;
  }

  private async cleanupDisposableWorkspaceTurn(
    record: WorkspaceTurnTaskHandleRecord
  ): Promise<void> {
    if (!record.disposableWorkspace) return;
    // Forward instead of deleting while another live same-owner turn still
    // targets this workspace. Every caller invokes cleanup only after
    // persisting this record's terminal status, which makes the candidate
    // scan deadlock-free: a concurrently settling candidate scanning back at
    // this record sees it terminal on disk and skips it (and transfer
    // re-validates the successor under its settlement lock), so two
    // settlements can never wait on each other's locks.
    if (await this.forwardDisposableOwnershipToLiveSuccessor(record)) {
      // Metadata-only flip off a fresh read (updatedAt unchanged), mirroring
      // transferDisposableWorkspaceToSuccessor, so terminal-attention
      // generation ids and staleness comparisons are unaffected.
      const current = await this.taskHandleStore.getWorkspaceTurn(
        record.ownerWorkspaceId,
        record.handleId
      );
      await this.taskHandleStore.upsertWorkspaceTurn({
        ...(current ?? record),
        disposableWorkspace: false,
      });
      return;
    }
    try {
      const removeResult = await this.workspaceService.remove(record.workspaceId, true);
      if (!removeResult.success) {
        log.error("Workspace turn cleanup: failed to remove disposable workspace", {
          handleId: record.handleId,
          workspaceId: record.workspaceId,
          error: removeResult.error,
        });
      }
    } catch (error: unknown) {
      log.error("Workspace turn cleanup: workspaceService.remove threw", {
        handleId: record.handleId,
        workspaceId: record.workspaceId,
        error: getErrorMessage(error),
      });
    }
  }

  isTerminalWorkspaceTurnStatus(status: WorkspaceTurnTaskStatus): boolean {
    return status === "completed" || status === "interrupted" || status === "error";
  }

  private workspaceTurnRequiresDirectParentDelivery(
    record: WorkspaceTurnTaskHandleRecord
  ): boolean {
    // Queue-cut supersedes count as terminal outcomes the direct parent must
    // learn about (the old error settlement delivered them); explicit
    // cancellations stay silent.
    if (
      record.status !== "completed" &&
      record.status !== "error" &&
      !isSupersededWorkspaceTurnInterrupt(record)
    ) {
      return false;
    }
    const childEntry = findWorkspaceEntry(this.config.loadConfigOrDefault(), record.workspaceId);
    if (ownerFollowUpSupersedeSkipsDirectParent(record, childEntry?.workspace.parentWorkspaceId)) {
      return false;
    }
    return (
      childEntry?.workspace.parentWorkspaceId != null && childEntry.workspace.workflowTask == null
    );
  }

  workspaceTurnTerminalAttentionGenerationId(
    record: Pick<WorkspaceTurnTaskHandleRecord, "handleId" | "status" | "updatedAt">
  ): string {
    // A handle can self-heal from an error into a corrected completion. Include the exact terminal
    // outcome version so an in-flight stale drain cannot transition the replacement notification.
    return `${record.handleId}:${record.status}:${record.updatedAt}`;
  }

  private workspaceTurnTerminalAttentionIds(
    record: Pick<WorkspaceTurnTaskHandleRecord, "handleId" | "status" | "updatedAt">
  ): [legacyId: string, versionedId: string] {
    return [
      TerminalAttentionStore.notificationId("workspace_turn", record.handleId),
      TerminalAttentionStore.notificationId(
        "workspace_turn",
        record.handleId,
        this.workspaceTurnTerminalAttentionGenerationId(record)
      ),
    ];
  }

  private async deleteWorkspaceTurnTerminalAttention(
    record: Pick<
      WorkspaceTurnTaskHandleRecord,
      "ownerWorkspaceId" | "handleId" | "status" | "updatedAt"
    >
  ): Promise<void> {
    for (const id of this.workspaceTurnTerminalAttentionIds(record)) {
      await this.terminalAttentionStore.delete(record.ownerWorkspaceId, id);
    }
  }

  /** Caller must hold workspaceTurnSettlementLocks for this handle. */
  private async markWorkspaceTurnTerminalAttentionConsumedUnlocked(
    record: WorkspaceTurnTaskHandleRecord
  ): Promise<WorkspaceTurnTaskHandleRecord> {
    if (
      !this.isTerminalWorkspaceTurnStatus(record.status) ||
      resolveBackgroundWorkAttentionPolicy(record.attentionPolicy) !== "notify_on_terminal"
    ) {
      return record;
    }

    const generationId = this.workspaceTurnTerminalAttentionGenerationId(record);
    await this.terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: record.ownerWorkspaceId,
      sourceKind: "workspace_turn",
      sourceId: record.handleId,
      terminalOutcome: terminalAttentionOutcome(record.status),
    });
    await this.terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: record.ownerWorkspaceId,
      sourceKind: "workspace_turn",
      sourceId: record.handleId,
      generationId,
      terminalOutcome: terminalAttentionOutcome(record.status),
    });
    for (const id of this.workspaceTurnTerminalAttentionIds(record)) {
      await this.terminalAttentionStore.markDelivered(record.ownerWorkspaceId, id);
    }

    const consumedAt = getIsoNow();
    const consumed = {
      ...record,
      terminalAttentionNotifiedAt: record.terminalAttentionNotifiedAt ?? consumedAt,
    };
    await this.taskHandleStore.upsertWorkspaceTurn(consumed);
    return consumed;
  }

  private async deletePersistentChildWorkspaceTurnAttention(
    record: WorkspaceTurnTaskHandleRecord
  ): Promise<void> {
    const childEntry = findWorkspaceEntry(this.config.loadConfigOrDefault(), record.workspaceId);
    if (childEntry == null || childEntry.workspace.workflowTask != null) {
      return;
    }
    const directParentWorkspaceId = childEntry.workspace.parentWorkspaceId;
    if (directParentWorkspaceId == null) {
      return;
    }
    await this.terminalAttentionStore.delete(
      directParentWorkspaceId,
      TerminalAttentionStore.notificationId(
        "agent_task",
        record.workspaceId,
        this.workspaceTurnTerminalAttentionGenerationId(record)
      )
    );
  }

  private async deliverPersistentChildWorkspaceTurnResult(
    record: WorkspaceTurnTaskHandleRecord,
    foregroundWaiterWorkspaceIds: ReadonlySet<string>
  ): Promise<void> {
    await this.workspaceTurnSettlementLocks.withLock(record.handleId, async () => {
      const current = await this.taskHandleStore.getWorkspaceTurn(
        record.ownerWorkspaceId,
        record.handleId
      );
      if (
        current == null ||
        current.status !== record.status ||
        current.updatedAt !== record.updatedAt
      ) {
        return;
      }
      await this.deliverPersistentChildWorkspaceTurnResultUnlocked(
        current,
        foregroundWaiterWorkspaceIds
      );
    });
  }

  private async deliverPersistentChildWorkspaceTurnResultUnlocked(
    record: WorkspaceTurnTaskHandleRecord,
    foregroundWaiterWorkspaceIds: ReadonlySet<string>
  ): Promise<void> {
    if (
      record.status !== "completed" &&
      record.status !== "error" &&
      !isSupersededWorkspaceTurnInterrupt(record)
    ) {
      return;
    }

    if (
      record.directParentResultDeliveryRequiredAt == null ||
      record.directParentResultDeliveredAt != null
    ) {
      return;
    }
    const childEntry = findWorkspaceEntry(this.config.loadConfigOrDefault(), record.workspaceId);
    if (childEntry == null || childEntry.workspace.workflowTask != null) {
      return;
    }
    const directParentWorkspaceId = childEntry.workspace.parentWorkspaceId;
    if (directParentWorkspaceId == null) {
      return;
    }
    // Consulted here as well as in workspaceTurnRequiresDirectParentDelivery so
    // live delivery AND startup recovery agree (delivery-required markers from
    // older settlements must not resurrect a skipped envelope).
    if (ownerFollowUpSupersedeSkipsDirectParent(record, directParentWorkspaceId)) {
      return;
    }
    const markDirectParentResultDelivered = async () => {
      record.directParentResultDeliveredAt = record.directParentResultDeliveredAt ?? getIsoNow();
      await this.taskHandleStore.upsertWorkspaceTurn(record);
    };
    if (foregroundWaiterWorkspaceIds.has(directParentWorkspaceId)) {
      await markDirectParentResultDelivered();
      // The direct parent's in-flight tool result already carries this output.
      return;
    }

    const deliveryVersion = this.workspaceTurnTerminalAttentionGenerationId(record);
    const historyResult =
      await this.historyService.getHistoryFromLatestBoundary(directParentWorkspaceId);
    const alreadyDelivered =
      historyResult.success &&
      historyResult.data.some((message) => {
        if (message.role !== "user" || message.metadata?.synthetic !== true) {
          return false;
        }
        const content = message.parts
          .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        return parseTerminalSubagentExecutionVersion(content) === deliveryVersion;
      });

    const agentType = coerceNonEmptyString(childEntry.workspace.agentType) ?? "agent";
    const content =
      record.status === "completed"
        ? formatSubagentReportUserMessage({
            executionVersion: deliveryVersion,
            executionId: record.handleId,
            childWorkspaceId: record.workspaceId,
            agentType,
            title:
              coerceNonEmptyString(childEntry.workspace.title) ??
              coerceNonEmptyString(childEntry.workspace.name) ??
              record.title ??
              "Subagent report",
            reportMarkdown:
              record.reportMarkdown ?? "Workspace turn completed without final text output.",
            status: "completed",
            ...(record.modelString != null ? { model: record.modelString } : {}),
            ...(childEntry.workspace.taskThinkingLevel != null
              ? { thinkingLevel: childEntry.workspace.taskThinkingLevel }
              : {}),
          })
        : formatSubagentFailureUserMessage({
            childWorkspaceId: record.workspaceId,
            agentType,
            executionVersion: deliveryVersion,
            executionId: record.handleId,
            errorType: isSupersededWorkspaceTurnInterrupt(record)
              ? "workspace_turn_superseded"
              : record.finalMessage?.metadata?.finishReason === "tool-calls"
                ? "workspace_turn_incomplete"
                : "workspace_turn_error",
            errorMessage: record.error ?? "Workspace turn failed",
          });
    if (!alreadyDelivered) {
      const message = createMuxMessage(
        record.status === "completed" ? createTaskReportMessageId() : createTaskFailureMessageId(),
        "user",
        content,
        { timestamp: Date.now(), synthetic: true, uiVisible: true }
      );
      const appendResult = await this.historyService.appendToHistory(
        directParentWorkspaceId,
        message
      );
      if (!appendResult.success) {
        log.error("Failed to append persistent child continuation result to direct parent", {
          directParentWorkspaceId,
          childWorkspaceId: record.workspaceId,
          handleId: record.handleId,
          error: appendResult.error,
        });
        return;
      }
      this.workspaceService.emitChatEvent(directParentWorkspaceId, { ...message, type: "message" });
    }
    await this.taskHost.enqueueTerminalAttention({
      ownerWorkspaceId: directParentWorkspaceId,
      sourceKind: "agent_task",
      sourceId: record.workspaceId,
      generationId: this.workspaceTurnTerminalAttentionGenerationId(record),
      terminalOutcome: terminalAttentionOutcome(record.status),
    });
    await markDirectParentResultDelivered();
  }

  private assertWorkspaceTurnSettlementCause(cause: WorkspaceTurnSettlementCause): void {
    assert(
      cause != null &&
        typeof cause.kind === "string" &&
        Object.hasOwn(WORKSPACE_TURN_SETTLEMENT_CAUSES, cause.kind),
      "Workspace turn settlement requires a recognized cause"
    );
    if (cause.kind === "manual-supersession") {
      assert(
        typeof cause.messageId === "string" && cause.messageId.trim().length > 0,
        "Manual supersession requires the superseding input messageId"
      );
    } else if (cause.kind === "uncorrelated-conservative-fallback") {
      assert(
        cause.reason === "history-read-failed" ||
          cause.reason === "missing-stream-end" ||
          cause.reason === "missing-turn-anchor" ||
          cause.reason === "invalid-manual-input-id",
        "Uncorrelated conservative fallback requires a recognized reason"
      );
    }
  }

  private async settleWorkspaceTurn(params: {
    cause: WorkspaceTurnSettlementCause;
    record: WorkspaceTurnTaskHandleRecord;
    next: WorkspaceTurnTaskHandleRecord;
    waiterSettlement:
      | { status: "completed"; result: WorkspaceTurnWaitResult }
      | { status: "error"; error: Error };
    /**
     * Allow replacing an already-settled interrupted/error record (never completed).
     * Only the strictly turn-correlated stream-end path may set this: a handle that
     * settled from a transient failure can self-heal when the child auto-retries the
     * same turn, and the correlated stream-end proves the turn's real outcome.
     */
    allowTerminalResettle?: boolean;
    /**
     * Only the settlement that itself moved disposable ownership to a
     * successor (transferDisposableWorkspaceToSuccessor) may clear
     * disposableWorkspace. Every other settlement may hold a snapshot read
     * before a concurrent transfer flipped the bit on disk, so the
     * lock-reloaded record's ownership is merged back in by default — dropping
     * it would leak the disposable checkout with no owner left to clean it up.
     */
    disposableOwnershipTransferred?: boolean;
  }): Promise<void> {
    assert(
      params.next.handleId === params.record.handleId,
      "settleWorkspaceTurn requires stable handleId"
    );
    assert(
      params.next.workspaceId === params.record.workspaceId,
      "settleWorkspaceTurn requires stable workspaceId"
    );

    // The settlement lock persists the handle and its stable-child status mirror, then resolves
    // waiters. The terminal wake-up is enqueued AFTER release (no sendMessage/notifier work here).
    const settlementResult = await this.workspaceTurnSettlementLocks.withLock(
      params.record.handleId,
      async (): Promise<{
        pendingNotify:
          | {
              kind: "notify";
              resettled: boolean;
              staleAttentionRecord?: WorkspaceTurnTaskHandleRecord;
            }
          | { kind: "drain_pending" }
          | null;
        winningStatus: WorkspaceTurnTaskStatus;
        settledRecord?: WorkspaceTurnTaskHandleRecord;
        foregroundWaiterWorkspaceIds?: Set<string>;
      } | null> => {
        this.assertWorkspaceTurnSettlementCause(params.cause);
        const current = await this.taskHandleStore.getWorkspaceTurn(
          params.record.ownerWorkspaceId,
          params.record.handleId
        );
        if (current == null) {
          return null;
        }
        assert(
          current.workspaceId === params.record.workspaceId,
          "settleWorkspaceTurn requires current record to match workspaceId"
        );

        // A completed record is immutable; a self-heal-eligible settled record (transient
        // error / stale restart interrupt — never an explicit user interrupt) may be
        // corrected once by an explicitly allowed resettle, but only when the new settlement
        // actually changes the outcome (duplicate stream-end replays must stay idempotent).
        const resettleStaleTerminal =
          params.allowTerminalResettle === true &&
          (params.next.finalMessage?.metadata?.finishReason !== "tool-calls" ||
            (current.status === params.record.status &&
              current.messageId === params.record.messageId &&
              current.updatedAt === params.record.updatedAt)) &&
          this.isTerminalWorkspaceTurnStatus(current.status) &&
          current.status !== "completed" &&
          isSelfHealEligibleSettledWorkspaceTurn(current) &&
          (params.next.status !== current.status || params.next.messageId !== current.messageId);
        if (this.isTerminalWorkspaceTurnStatus(current.status) && !resettleStaleTerminal) {
          const active = this.activeWorkspaceTurnHandleByWorkspaceId.get(params.record.workspaceId);
          if (
            active?.handleId === params.record.handleId &&
            active.ownerWorkspaceId === params.record.ownerWorkspaceId
          ) {
            this.activeWorkspaceTurnHandleByWorkspaceId.delete(params.record.workspaceId);
          }
          this.settleWorkspaceTurnWaiters(
            current.handleId,
            current.status === "completed"
              ? { status: "completed", result: this.buildWorkspaceTurnWaitResult(current) }
              : {
                  status: "error",
                  error: new Error(
                    current.error ??
                      (current.status === "interrupted"
                        ? "Workspace turn interrupted"
                        : "Workspace turn failed")
                  ),
                }
          );
          await this.updateAgentTaskExecutionState(
            current.workspaceId,
            current.handleId,
            current.status
          );
          this.taskHost.markTaskForegroundRelevant(current.handleId);
          return { pendingNotify: null, winningStatus: current.status };
        }

        // Decide the terminal wake-up using persisted policy + the restart-safe dedupe marker.
        // A resettle corrects a previously reported outcome, so it re-arms the wake-up even if
        // the stale settlement was already notified/consumed. Owner-follow-up supersedes settle
        // quietly (a pure function of the settled record, so startup recovery agrees); a later
        // self-heal resettle to completed is non-suppressed and re-arms the corrected wake.
        const policy = resolveBackgroundWorkAttentionPolicy(current.attentionPolicy);
        const suppressedQuietSettlement = workspaceTurnTerminalAttentionSuppressed(params.next);
        const shouldNotify =
          policy === "notify_on_terminal" &&
          (current.terminalAttentionNotifiedAt == null || resettleStaleTerminal) &&
          !suppressedQuietSettlement;
        // A stale pending wake enqueued by the superseded settlement (error or
        // generic supersede) must not outlive a quiet resettle: the terminal
        // attention drain does not generation-check workspace-turn
        // notifications, so delete the prior generation here just as the
        // corrected-notification path does for non-suppressed resettles. Safe
        // under this settlement lock, which direct-parent consumption shares.
        if (resettleStaleTerminal && suppressedQuietSettlement) {
          await this.deleteWorkspaceTurnTerminalAttention(current);
          // When the direct parent is the owner, the quiet flavor also skips
          // the direct-parent envelope, so the requiresDirectParentDelivery
          // block below never runs for it — the stale direct-parent generation
          // enqueued by the superseded settlement must be invalidated here
          // too, or the parent retains and wakes on the corrected-away
          // failure. (Idempotent with the non-skip resettle path's delete.)
          await this.deletePersistentChildWorkspaceTurnAttention(current);
        }

        const nextRecord = { ...params.next };
        if (
          current.disposableWorkspace &&
          !nextRecord.disposableWorkspace &&
          params.disposableOwnershipTransferred !== true
        ) {
          // See disposableOwnershipTransferred: a transfer that landed while
          // this settlement's snapshot was waiting on the lock is
          // authoritative for ownership.
          nextRecord.disposableWorkspace = true;
        }
        if (resettleStaleTerminal) {
          log.debug("Workspace turn resettled from stale terminal status", {
            handleId: current.handleId,
            workspaceId: current.workspaceId,
            staleStatus: current.status,
            nextStatus: nextRecord.status,
          });
          delete nextRecord.terminalAttentionNotifiedAt;
        }
        if (suppressedQuietSettlement) {
          // Downgrade-compatible suppression marker (upgrade↔downgrade rule):
          // older builds' startup recovery knows only terminalAttentionNotifiedAt,
          // not the quiet error prefix, and would otherwise resurrect exactly
          // the wake this flavor suppresses. Nothing was actually delivered —
          // on this build the pure suppression predicate governs the
          // settle/recovery/drain paths, and a self-heal resettle deletes the
          // marker above to re-arm the corrected wake.
          nextRecord.terminalAttentionNotifiedAt ??= getIsoNow();
        }
        const requiresDirectParentDelivery =
          this.workspaceTurnRequiresDirectParentDelivery(nextRecord);
        if (requiresDirectParentDelivery) {
          nextRecord.directParentResultDeliveryRequiredAt = getIsoNow();
          if (resettleStaleTerminal) {
            await this.deletePersistentChildWorkspaceTurnAttention(current);
          }
          if (resettleStaleTerminal) {
            delete nextRecord.directParentResultDeliveredAt;
          }
        }
        if (requiresDirectParentDelivery && nextRecord.status === "completed") {
          // Persistent exec children reuse one stable task ID. Refresh their artifact before the
          // continuation becomes inactive so task_remove cannot race the background format-patch.
          await this.taskHost.maybeStartPatchGenerationForReportedTask(nextRecord.workspaceId, {
            refreshForContinuation: true,
          });
        }
        await this.taskHandleStore.upsertWorkspaceTurn(nextRecord);
        await this.updateAgentTaskExecutionState(
          nextRecord.workspaceId,
          nextRecord.handleId,
          nextRecord.status
        );
        const active = this.activeWorkspaceTurnHandleByWorkspaceId.get(params.record.workspaceId);
        if (
          active?.handleId === params.record.handleId &&
          active.ownerWorkspaceId === params.record.ownerWorkspaceId
        ) {
          this.activeWorkspaceTurnHandleByWorkspaceId.delete(params.record.workspaceId);
        }
        // Incremental agent_report updates from this execution were queued behind the owner's
        // busy turn (reportAgentProgress routes them to the continuation owner). This terminal
        // outcome supersedes them; left queued, each would later dispatch as a stale "in
        // progress" turn. Drop them before waiters resolve so an owner whose task_await just
        // returned cannot be cut at its next step boundary by an update it already outran.
        // skipCancelCallbacks: when the owner itself runs as a delegated turn, each queued report
        // carries continuation callbacks that would settle that live turn as interrupted.
        const queuedProgressRemoval = this.workspaceService.removeQueuedMessagesByDedupeKeyPrefix(
          params.record.ownerWorkspaceId,
          agentReportProgressDedupePrefix(params.record.workspaceId, params.record.handleId),
          { cancelReason: AGENT_REPORT_PROGRESS_SUPERSEDED_REASON, skipCancelCallbacks: true }
        );
        if (!queuedProgressRemoval.success) {
          log.warn("Failed to remove queued incremental sub-agent reports at settlement", {
            ownerWorkspaceId: params.record.ownerWorkspaceId,
            childWorkspaceId: params.record.workspaceId,
            handleId: params.record.handleId,
            error: queuedProgressRemoval.error,
          });
        }
        const foregroundWaiterWorkspaceIds = this.settleWorkspaceTurnWaiters(
          params.record.handleId,
          params.waiterSettlement
        );
        const ownerHadForegroundWaiter = foregroundWaiterWorkspaceIds.has(
          params.record.ownerWorkspaceId
        );
        this.taskHost.markTaskForegroundRelevant(params.record.handleId);
        // A preparation/queue failure callback still owns the target session's physical
        // lease. Removing that session here would join this very callback under the lock.
        if (params.cause.kind !== "continuation-failure") {
          await this.cleanupDisposableWorkspaceTurn(nextRecord);
        }
        this.taskHost.scheduleMaybeStartQueuedTasks();

        // Suppress the owner-scoped wake only when the owner itself received this terminal result.
        // Another workspace (for example the persistent child's direct parent) can await the same
        // handle without consuming the continuation owner's notification.
        if (ownerHadForegroundWaiter) {
          return {
            pendingNotify: { kind: "drain_pending" },
            winningStatus: nextRecord.status,
            settledRecord: nextRecord,
            foregroundWaiterWorkspaceIds,
          };
        }
        if (!shouldNotify) {
          return {
            pendingNotify: null,
            winningStatus: nextRecord.status,
            settledRecord: nextRecord,
            foregroundWaiterWorkspaceIds,
          };
        }
        return {
          pendingNotify: {
            kind: "notify",
            resettled: resettleStaleTerminal,
            ...(resettleStaleTerminal ? { staleAttentionRecord: current } : {}),
          },
          winningStatus: nextRecord.status,
          settledRecord: nextRecord,
          foregroundWaiterWorkspaceIds,
        };
      }
    );

    if (settlementResult == null) {
      return;
    }
    const {
      pendingNotify,
      settledRecord,
      foregroundWaiterWorkspaceIds = new Set<string>(),
    } = settlementResult;
    try {
      if (settledRecord != null) {
        await this.deliverPersistentChildWorkspaceTurnResult(
          settledRecord,
          foregroundWaiterWorkspaceIds
        );
      }
      if (pendingNotify == null) {
        return;
      }
      if (pendingNotify.kind === "drain_pending") {
        this.taskHost.scheduleTerminalAttentionDrain(params.record.ownerWorkspaceId);
        return;
      }

      // Enqueue the terminal wake-up outside the lock. The persisted notification is the restart-safe
      // record of intent; only after it is accepted do we set terminalAttentionNotifiedAt on the
      // handle so a duplicate settlement / stale recovery cannot double-wake.
      if (pendingNotify.resettled) {
        const shouldEnqueueCorrectedAttention =
          settledRecord != null &&
          (await this.workspaceTurnSettlementLocks.withLock(params.record.handleId, async () => {
            const current = await this.taskHandleStore.getWorkspaceTurn(
              params.record.ownerWorkspaceId,
              params.record.handleId
            );
            if (
              current == null ||
              current.status !== settledRecord.status ||
              current.updatedAt !== settledRecord.updatedAt ||
              current.terminalAttentionNotifiedAt != null
            ) {
              return false;
            }
            // Delete the stale generation while holding the same lock used by direct-parent
            // consumption. If consumption wins next, it installs a delivered tombstone before this
            // method's enqueueIfAbsent; if it already won, the marker above prevents this deletion.
            if (pendingNotify.staleAttentionRecord != null) {
              await this.deleteWorkspaceTurnTerminalAttention(pendingNotify.staleAttentionRecord);
            }
            return true;
          }));
        if (!shouldEnqueueCorrectedAttention) {
          return;
        }
      }
      await this.taskHost.enqueueTerminalAttention({
        ownerWorkspaceId: params.record.ownerWorkspaceId,
        sourceKind: "workspace_turn",
        terminalOutcome: terminalAttentionOutcome(settlementResult.winningStatus),
        sourceId: params.record.handleId,
        ...(settledRecord != null
          ? { generationId: this.workspaceTurnTerminalAttentionGenerationId(settledRecord) }
          : {}),
      });
      await this.workspaceTurnSettlementLocks.withLock(params.record.handleId, async () => {
        const terminal = await this.taskHandleStore.getWorkspaceTurn(
          params.record.ownerWorkspaceId,
          params.record.handleId
        );
        if (
          terminal != null &&
          (settledRecord == null ||
            (terminal.status === settledRecord.status &&
              terminal.updatedAt === settledRecord.updatedAt)) &&
          terminal.terminalAttentionNotifiedAt == null
        ) {
          await this.taskHandleStore.upsertWorkspaceTurn({
            ...terminal,
            terminalAttentionNotifiedAt: getIsoNow(),
          });
        }
      });
    } finally {
      // Register after lock release even when notification bookkeeping throws. The service
      // owns the original job independently; cleanup rechecks live successor ownership.
      if (params.cause.kind === "continuation-failure" && settledRecord?.disposableWorkspace) {
        this.workspaceService.deferWorkspaceCleanup(() =>
          this.cleanupDisposableWorkspaceTurn(settledRecord)
        );
      }
    }
  }

  async waitForWorkspaceTurn(
    handleId: string,
    options: {
      timeoutMs?: number;
      abortSignal?: AbortSignal;
      requestingWorkspaceId: string;
      ownerWorkspaceId?: string;
      backgroundOnMessageQueued?: boolean;
    }
  ): Promise<WorkspaceTurnWaitResult> {
    assert(handleId.length > 0, "waitForWorkspaceTurn: handleId must be non-empty");
    assert(
      options.requestingWorkspaceId.length > 0,
      "waitForWorkspaceTurn: requestingWorkspaceId must be non-empty"
    );
    const timeoutMs = options.timeoutMs ?? 120_000;
    assert(Number.isFinite(timeoutMs) && timeoutMs > 0, "waitForWorkspaceTurn: timeoutMs invalid");
    const ownerWorkspaceId = options.ownerWorkspaceId ?? options.requestingWorkspaceId;
    assert(ownerWorkspaceId.length > 0, "waitForWorkspaceTurn: ownerWorkspaceId must be non-empty");

    this.taskHost.markTaskForegroundRelevant(handleId);

    return await new Promise<WorkspaceTurnWaitResult>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let abortListener: (() => void) | null = null;
      let stopBlockingRequester: (() => void) | null = this.taskHost.startForegroundAwait(
        options.requestingWorkspaceId
      );
      const shouldBackgroundOnQueuedMessage = options.backgroundOnMessageQueued ?? true;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (abortListener) {
          options.abortSignal?.removeEventListener("abort", abortListener);
          abortListener = null;
        }
        if (waiterEntry.backgroundOnMessageQueued && waiterEntry.requestingWorkspaceId) {
          this.taskHost.unregisterBackgroundableForegroundWaiter(
            waiterEntry.requestingWorkspaceId,
            waiterEntry
          );
        }
        const waiters = this.pendingWorkspaceTurnWaitersByHandleId.get(handleId) ?? [];
        const nextWaiters = waiters.filter((waiter) => waiter !== waiterEntry);
        if (nextWaiters.length === 0) {
          this.pendingWorkspaceTurnWaitersByHandleId.delete(handleId);
        } else {
          this.pendingWorkspaceTurnWaitersByHandleId.set(handleId, nextWaiters);
        }
        if (stopBlockingRequester) {
          try {
            stopBlockingRequester();
          } finally {
            stopBlockingRequester = null;
          }
        }
      };
      const waiterEntry: WorkspaceTurnWaiter = {
        taskId: handleId,
        handleId,
        requestingWorkspaceId: options.requestingWorkspaceId,
        backgroundOnMessageQueued: shouldBackgroundOnQueuedMessage,
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        cleanup,
      };

      const waiters = this.pendingWorkspaceTurnWaitersByHandleId.get(handleId) ?? [];
      waiters.push(waiterEntry);
      this.pendingWorkspaceTurnWaitersByHandleId.set(handleId, waiters);
      if (shouldBackgroundOnQueuedMessage) {
        this.taskHost.registerBackgroundableForegroundWaiter(
          options.requestingWorkspaceId,
          waiterEntry
        );
      }

      if (options.abortSignal?.aborted) {
        waiterEntry.reject(new Error("Interrupted"));
        return;
      }
      abortListener = () => waiterEntry.reject(new Error("Interrupted"));
      options.abortSignal?.addEventListener("abort", abortListener, { once: true });
      timer = setTimeout(
        () => waiterEntry.reject(new Error("Timed out waiting for workspace turn")),
        timeoutMs
      );

      this.taskHost.backgroundForegroundWaitIfQueued(
        shouldBackgroundOnQueuedMessage,
        options.requestingWorkspaceId
      );

      void (async () => {
        const record = await this.taskHandleStore.getWorkspaceTurn(ownerWorkspaceId, handleId);
        if (settled) return;
        if (record == null) {
          waiterEntry.reject(new Error("Workspace turn not found or out of scope"));
          return;
        }
        if (record.status === "completed") {
          waiterEntry.resolve(this.buildWorkspaceTurnWaitResult(record));
          return;
        }
        if (record.status === "error") {
          waiterEntry.reject(new Error(record.error ?? "Workspace turn failed"));
          return;
        }
        if (record.status === "interrupted") {
          // Preserve the persisted reason like the live settlement path does:
          // a handle that settled quietly before this waiter's initial read
          // must still surface the successor handle id to the awaiting caller.
          waiterEntry.reject(new Error(record.error ?? "Workspace turn interrupted"));
        }
      })().catch((error: unknown) => {
        waiterEntry.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async normalizeWorkspaceTurnRecord(
    record: WorkspaceTurnTaskHandleRecord,
    options: {
      /**
       * Also reconcile settled interrupted/error records against the child's durable
       * history (one history read per record). Enabled for single-handle snapshot reads
       * (task_await) but not for list paths, which would pay that read for every
       * historical terminal handle on each call.
       */
      repairSettledTurnsFromHistory?: boolean;
      /** Direct parent whose task_await will return this snapshot, if any. */
      consumingWorkspaceId?: string;
    } = {}
  ): Promise<WorkspaceTurnTaskHandleRecord | null> {
    assert(record.ownerWorkspaceId.length > 0, "normalizeWorkspaceTurnRecord requires owner id");
    assert(record.handleId.length > 0, "normalizeWorkspaceTurnRecord requires handle id");

    // Older recovery skipped deferred stream-end history and could mark a completed workspace turn
    // interrupted. Re-check the durable child history anywhere handles are observed so task_list and
    // task_await agree on the self-healed terminal status.
    if (
      record.status === "interrupted" &&
      record.error === WORKSPACE_TURN_STALE_RESTART_ERROR &&
      (record.deferredMessageIds?.length ?? 0) > 0
    ) {
      const recovered = await this.recoverTerminalWorkspaceTurnFromHistory(record);
      if (recovered != null) {
        await this.taskHandleStore.upsertWorkspaceTurn(recovered);
        await this.cleanupDisposableWorkspaceTurn(recovered);
        const active = this.activeWorkspaceTurnHandleByWorkspaceId.get(record.workspaceId);
        if (
          active?.handleId === record.handleId &&
          active.ownerWorkspaceId === record.ownerWorkspaceId
        ) {
          this.activeWorkspaceTurnHandleByWorkspaceId.delete(record.workspaceId);
        }
        return await this.taskHandleStore.getWorkspaceTurn(
          record.ownerWorkspaceId,
          record.handleId
        );
      }
    }

    if (
      isActiveWorkspaceTurnTaskStatus(record.status) &&
      !(await this.isLiveWorkspaceTurn(record))
    ) {
      await this.settleStaleWorkspaceTurn(record);
      return await this.taskHandleStore.getWorkspaceTurn(record.ownerWorkspaceId, record.handleId);
    }

    if (
      (record.status === "interrupted" || record.status === "error") &&
      isSelfHealEligibleSettledWorkspaceTurn(record)
    ) {
      return await this.reconcileSettledWorkspaceTurn(record, {
        repairFromHistory: options.repairSettledTurnsFromHistory === true,
        consumingWorkspaceId: options.consumingWorkspaceId,
      });
    }

    return record;
  }

  /**
   * Settled interrupted/error handles can go stale: a stream error or restart can settle
   * the handle even though the child workspace self-heals by auto-retrying the same turn
   * (retries replay the turn's synthetic prompt, so their output still correlates via
   * muxMetadata). Reconcile against the child's live state at read time so task_await and
   * task_list report reality instead of the stale settlement.
   */
  private async reconcileSettledWorkspaceTurn(
    record: WorkspaceTurnTaskHandleRecord,
    options: { repairFromHistory: boolean; consumingWorkspaceId?: string }
  ): Promise<WorkspaceTurnTaskHandleRecord | null> {
    assert(
      record.status === "interrupted" || record.status === "error",
      "reconcileSettledWorkspaceTurn requires a settled interrupted/error record"
    );
    // Lazily computed and cached: whether the child still has active descendant/workflow/
    // nested-turn work. A settled record cannot accumulate deferredMessageIds (the deferral
    // path skips inactive handles), so the repair/deferred decisions below must consult
    // these blockers — otherwise a retried turn could be reported completed while its
    // background work is still running.
    let blockersActive: boolean | null = null;
    const deferredBlockersActive = async (): Promise<boolean> => {
      blockersActive ??= await this.hasActiveWorkspaceTurnDeferredBlockers(record);
      return blockersActive;
    };
    // Evidence the turn is still live. All checks are in-memory so historical terminal
    // handles stay cheap on list/blocker-scan paths (no history reads). Queued/preparing
    // turns are deliberately excluded: ordinary queued manual input is not yet in history,
    // so it would defeat the newest-correlated-prompt guard below and revive unrelated
    // work. The synthetic background-await continuation between retry streams is instead
    // covered by the descendant hint — it is only queued while such blockers are active.
    const turnLive =
      this.aiService.isStreaming(record.workspaceId) ||
      this.workspaceService.hasPendingAutoRetry(record.workspaceId) ||
      this.taskHost.hasActiveDescendantAgentTasks(
        this.config.loadConfigOrDefault(),
        record.workspaceId
      );
    if (!turnLive && !options.repairFromHistory) {
      return record;
    }

    const historyResult = await this.historyService.getHistoryFromLatestBoundary(
      record.workspaceId
    );
    if (!historyResult.success) {
      return record;
    }
    // Auto-retry replays the newest accepted user message, so live child activity belongs
    // to this turn only while its prompt is still that newest message. Any newer user
    // message disables the revive — but only the revive: a correlated final assistant
    // message older than that unrelated prompt still proves the turn completed, so the
    // durable-history repair scan must continue past it.
    let reviveAllowed = turnLive;
    for (const message of historyResult.data.toReversed()) {
      if (
        this.isDeferredWorkspaceTurnMessage(record, message.id) &&
        (await deferredBlockersActive())
      ) {
        continue;
      }
      const event = this.buildWorkspaceTurnStreamEndEventFromHistory(record, message);
      if (event != null) {
        // The turn produced a correlated final assistant message after settlement, so the
        // child self-healed. While its background work is still running, revive the handle
        // with the final recorded as deferred: the parent stays blocked, and the standard
        // deferred-recovery machinery settles the true outcome once blockers finish.
        if (reviveAllowed && (await deferredBlockersActive())) {
          return await this.reviveRetryingWorkspaceTurn(record, {
            deferredMessageIds: [event.messageId],
          });
        }
        const recovered = this.buildTerminalWorkspaceTurnRecordFromEvent(record, event, {
          // Repair preserves — never invents — a supersede classification.
          // History order is not causal queue-dispatch evidence (an unrelated
          // later user message must not upgrade an error settlement), while the
          // persisted supersede stays authoritative when rebuilding from the
          // SAME correlated final that settled it: the superseding queued input
          // may not have appended its user message yet, and that absence must
          // not downgrade the supersede to a truncation error. Only a different
          // correlated final (contradictory same-turn evidence) may resettle.
          // "preserved" keeps whichever flavor (generic or owner follow-up) was
          // persisted verbatim, so repair cannot downgrade the quiet flavor.
          supersedeEvidence:
            isSupersededWorkspaceTurnInterrupt(record) &&
            event.messageId === record.messageId &&
            record.error != null
              ? { kind: "preserved", error: record.error }
              : null,
        });
        if (
          !options.repairFromHistory ||
          (recovered.status === record.status && recovered.messageId === record.messageId)
        ) {
          return record;
        }
        if (await deferredBlockersActive()) {
          return record;
        }
        return await this.persistRepairedSettledWorkspaceTurn(record, recovered, {
          consumingWorkspaceId: options.consumingWorkspaceId,
        });
      }
      if (message.role !== "user") {
        continue;
      }
      const metadata = this.getWorkspaceTurnMetadataFromValue(message.metadata?.muxMetadata);
      const correlatedPrompt =
        metadata != null &&
        metadata.taskHandleId === record.handleId &&
        metadata.ownerWorkspaceId === record.ownerWorkspaceId &&
        metadata.turnId === record.turnId;
      if (correlatedPrompt) {
        if (reviveAllowed) {
          return await this.reviveRetryingWorkspaceTurn(record);
        }
        // A correlated final must be newer than the prompt; nothing older can repair.
        return record;
      }
      reviveAllowed = false;
      if (!options.repairFromHistory) {
        return record;
      }
    }
    return record;
  }

  /**
   * Record that a terminal snapshot is being returned directly to the persistent child's parent.
   * Caller must hold workspaceTurnSettlementLocks for the handle so post-settlement delivery cannot
   * append the same outcome between this marker write and the consuming task_await snapshot.
   */
  private async markDirectParentWorkspaceTurnResultConsumedUnlocked(
    record: WorkspaceTurnTaskHandleRecord | null,
    consumingWorkspaceId: string | undefined
  ): Promise<WorkspaceTurnTaskHandleRecord | null> {
    if (
      record == null ||
      consumingWorkspaceId == null ||
      record.directParentResultDeliveryRequiredAt == null ||
      !this.workspaceTurnRequiresDirectParentDelivery(record)
    ) {
      return record;
    }

    const childEntry = findWorkspaceEntry(this.config.loadConfigOrDefault(), record.workspaceId);
    if (childEntry?.workspace.parentWorkspaceId !== consumingWorkspaceId) {
      return record;
    }

    const consumed = {
      ...record,
      directParentResultDeliveredAt: record.directParentResultDeliveredAt ?? getIsoNow(),
    };
    if (
      consumingWorkspaceId === record.ownerWorkspaceId &&
      resolveBackgroundWorkAttentionPolicy(record.attentionPolicy) === "notify_on_terminal"
    ) {
      return await this.markWorkspaceTurnTerminalAttentionConsumedUnlocked(consumed);
    }
    await this.taskHandleStore.upsertWorkspaceTurn(consumed);
    return consumed;
  }

  private async persistRepairedSettledWorkspaceTurn(
    record: WorkspaceTurnTaskHandleRecord,
    recovered: WorkspaceTurnTaskHandleRecord,
    options: { consumingWorkspaceId?: string } = {}
  ): Promise<WorkspaceTurnTaskHandleRecord | null> {
    const next = await this.workspaceTurnSettlementLocks.withLock(record.handleId, async () => {
      const current = await this.taskHandleStore.getWorkspaceTurn(
        record.ownerWorkspaceId,
        record.handleId
      );
      // A concurrent settlement/repair wins; only replace the exact record we reconciled.
      // Comparing updatedAt (not just status) matters: a concurrent settlement can produce
      // a NEWER record with the same status that must not be clobbered by our stale read.
      if (
        current == null ||
        current.status !== record.status ||
        current.updatedAt !== record.updatedAt
      ) {
        // If this direct parent's task_await will return that concurrent terminal winner,
        // consume it here so its post-lock delivery cannot append the same outcome too.
        return await this.markDirectParentWorkspaceTurnResultConsumedUnlocked(
          current,
          options.consumingWorkspaceId
        );
      }
      if (this.workspaceTurnRequiresDirectParentDelivery(recovered)) {
        await this.deletePersistentChildWorkspaceTurnAttention(current);
        recovered.directParentResultDeliveryRequiredAt = getIsoNow();
        const childEntry = findWorkspaceEntry(
          this.config.loadConfigOrDefault(),
          recovered.workspaceId
        );
        if (childEntry?.workspace.parentWorkspaceId === options.consumingWorkspaceId) {
          // History repair discovered the corrected result for this direct parent's task_await.
          // Mark that corrected generation consumed before post-lock replay can append it too.
          recovered.directParentResultDeliveredAt = getIsoNow();
        } else {
          delete recovered.directParentResultDeliveredAt;
        }
      }
      if (
        recovered.status === "completed" &&
        this.workspaceTurnRequiresDirectParentDelivery(recovered)
      ) {
        // History repair can be the only terminal path after a crash/restart. Refresh the stable
        // child's patch before persisting the recovered inactive handle, matching normal settlement.
        await this.taskHost.maybeStartPatchGenerationForReportedTask(recovered.workspaceId, {
          refreshForContinuation: true,
        });
      }
      log.debug("Workspace turn repaired from self-healed child history", {
        handleId: record.handleId,
        workspaceId: record.workspaceId,
        staleStatus: record.status,
        nextStatus: recovered.status,
      });
      await this.taskHandleStore.upsertWorkspaceTurn(recovered);
      return recovered;
    });
    if (next === recovered) {
      await this.deliverPersistentChildWorkspaceTurnResult(recovered, new Set());
      await this.cleanupDisposableWorkspaceTurn(recovered);
      const active = this.activeWorkspaceTurnHandleByWorkspaceId.get(record.workspaceId);
      if (
        active?.handleId === record.handleId &&
        active.ownerWorkspaceId === record.ownerWorkspaceId
      ) {
        this.activeWorkspaceTurnHandleByWorkspaceId.delete(record.workspaceId);
      }
    }
    return next;
  }

  private async reviveRetryingWorkspaceTurn(
    record: WorkspaceTurnTaskHandleRecord,
    options: { deferredMessageIds?: string[] } = {}
  ): Promise<WorkspaceTurnTaskHandleRecord | null> {
    return await this.workspaceTurnSettlementLocks.withLock(record.handleId, async () => {
      const current = await this.taskHandleStore.getWorkspaceTurn(
        record.ownerWorkspaceId,
        record.handleId
      );
      // A concurrent transition wins; only revive the exact record we reconciled against.
      // Comparing updatedAt (not just status) matters: the live retry itself can fail and
      // settle a NEWER record with the same status (e.g. error → error) between our read
      // and this lock — reviving that fresh terminal failure would strand task_await.
      if (
        current == null ||
        current.status !== record.status ||
        current.updatedAt !== record.updatedAt
      ) {
        return current;
      }
      // Another turn already owns the child workspace; the activity is not this turn's retry.
      const active = this.activeWorkspaceTurnHandleByWorkspaceId.get(record.workspaceId);
      if (
        active != null &&
        (active.handleId !== record.handleId || active.ownerWorkspaceId !== record.ownerWorkspaceId)
      ) {
        return current;
      }
      const next: WorkspaceTurnTaskHandleRecord = {
        ...current,
        status: "running",
        updatedAt: getIsoNow(),
        // An already-observed correlated final (blocked on child background work) rides
        // along as deferred so standard deferred recovery settles it once blockers finish.
        ...(options.deferredMessageIds != null
          ? { deferredMessageIds: options.deferredMessageIds }
          : {}),
      };
      // Re-admission can fail if another child now controls this desktop. Do not revive the
      // handle, erase terminal attention, or register it live until its durable mirror reserves it.
      const taskEntry = findWorkspaceEntry(this.config.loadConfigOrDefault(), record.workspaceId);
      if (taskEntry?.workspace.parentWorkspaceId != null) {
        const claimed = await this.desktopInputCoordinator.withAdmission(record.workspaceId, () =>
          this.persistAgentTaskExecutionState(record.workspaceId, record.handleId, "running", true)
        );
        if (!claimed) return current;
      }
      delete next.error;
      // The revived turn's next terminal transition is a new outcome; re-arm its wake-up.
      // The notification tombstone must go too: enqueueIfAbsent would otherwise treat the
      // stale settlement's delivered wake-up as "already notified" and swallow the new one.
      delete next.directParentResultDeliveryRequiredAt;
      delete next.directParentResultDeliveredAt;
      delete next.terminalAttentionNotifiedAt;
      await this.deleteWorkspaceTurnTerminalAttention(record);
      await this.deletePersistentChildWorkspaceTurnAttention(current);
      await this.taskHandleStore.upsertWorkspaceTurn(next);
      // Re-register so stream-end/abort/error settlement paths own the handle again. The
      // revived turn is a retry of an already-admitted turn, so the registration is accepted.
      this.activeWorkspaceTurnHandleByWorkspaceId.set(record.workspaceId, {
        handleId: record.handleId,
        ownerWorkspaceId: record.ownerWorkspaceId,
        accepted: true,
      });
      log.debug("Workspace turn revived: child is retrying the same turn", {
        handleId: record.handleId,
        workspaceId: record.workspaceId,
        staleStatus: record.status,
      });
      return next;
    });
  }

  async getWorkspaceTurnSnapshot(
    ownerWorkspaceId: string,
    handleId: string,
    options: { consumingWorkspaceId?: string } = {}
  ): Promise<WorkspaceTurnTaskHandleRecord | null> {
    if (!isWorkspaceTurnTaskId(handleId)) {
      return null;
    }
    const record = await this.workspaceTurnSettlementLocks.withLock(handleId, async () => {
      const current = await this.taskHandleStore.getWorkspaceTurn(ownerWorkspaceId, handleId);
      // A terminal task_await by the direct parent owns this result. Persist that fact while
      // holding the same lock as continuation delivery, before returning the snapshot, so a
      // late await cannot race the post-settlement history append and receive the output twice.
      return await this.markDirectParentWorkspaceTurnResultConsumedUnlocked(
        current,
        options.consumingWorkspaceId
      );
    });
    if (record == null) {
      return null;
    }
    // Snapshot reads back task_await, which must report the child's live state even when
    // a stale settlement (interrupted/error) was later corrected by a self-healed retry.
    return await this.normalizeWorkspaceTurnRecord(record, {
      repairSettledTurnsFromHistory: true,
      consumingWorkspaceId: options.consumingWorkspaceId,
    });
  }

  async listWorkspaceTurnTasks(
    ownerWorkspaceId: string,
    options: { statuses?: readonly WorkspaceTurnTaskStatus[] } = {}
  ): Promise<WorkspaceTurnTaskHandleRecord[]> {
    const records = await this.taskHandleStore.listWorkspaceTurns(ownerWorkspaceId);
    const statuses = options.statuses != null ? new Set(options.statuses) : null;
    const result: WorkspaceTurnTaskHandleRecord[] = [];
    for (const record of records) {
      const latest = await this.normalizeWorkspaceTurnRecord(record);
      if (latest != null && (statuses == null || statuses.has(latest.status))) {
        result.push(latest);
      }
    }
    return result;
  }

  async interruptWorkspaceTurn(
    ownerWorkspaceId: string,
    handleId: string,
    options?: {
      /** Task-tree stops drain once after the complete batch, not once per handle. */
      scheduleQueueDrain?: boolean;
      /**
       * Skip the disposable-workspace removal that normally follows interruption. The archive
       * lifecycle path sets this: it interrupts turns in order to ARCHIVE (retain) the target,
       * so the default cleanup would irreversibly delete the checkout out from under the
       * subsequent archive call.
       */
      suppressDisposableCleanup?: boolean;
    }
  ): Promise<Result<{ workspaceId: string }, string>> {
    let workspaceId: string | undefined;
    let shouldClearQueuedPrompt = false;
    let shouldStopStream = false;
    let interruptedRecord: WorkspaceTurnTaskHandleRecord | undefined;
    let releaseStopLatch: (() => void) | undefined;

    try {
      const result = await this.workspaceTurnSettlementLocks.withLock(handleId, async () => {
        const record = await this.taskHandleStore.getWorkspaceTurn(ownerWorkspaceId, handleId);
        if (record == null) {
          return Err("Workspace turn not found or out of scope");
        }
        if (record.status === "completed" || record.status === "error") {
          return Err(`Workspace turn is already ${record.status} and cannot be interrupted.`);
        }
        // Already-settled interrupts (explicit stop, restart recovery, queue-cut
        // supersede) have nothing left to stop: proceeding would stopStream the
        // target workspace's *current* stream — e.g. the manual message or
        // /compact that superseded the delegated turn. Idempotent no-op instead.
        if (record.status === "interrupted") {
          return Ok({ workspaceId: record.workspaceId });
        }

        workspaceId = record.workspaceId;
        shouldClearQueuedPrompt =
          record.status === "queued" &&
          this.workspaceService.hasQueuedWorkspaceTurn(record.workspaceId, record.handleId);
        shouldStopStream = record.status !== "queued";

        const next: WorkspaceTurnTaskHandleRecord = {
          ...record,
          status: "interrupted",
          updatedAt: getIsoNow(),
        };
        // Keep explicit stop's latch/mirror ordering in this lock, not the central helper.
        this.assertWorkspaceTurnSettlementCause({ kind: "explicit-interrupt" });
        await this.taskHandleStore.upsertWorkspaceTurn(next);
        interruptedRecord = next;
        // Latch the stop synchronously inside the settlement boundary: in-flight peer-send
        // admission observes this generation immediately, without waiting for the async config
        // mirror below to persist. The level latch covers sends ENTERING after the bump — those
        // would otherwise capture the bumped generation as their clean baseline. Held through the
        // stopStream await below (released in the method-level finally), not just mirror
        // persistence: ROOT targets have no task lifecycle status to refuse on, so a send
        // admitted during the wind-down would queue behind the dying stream and auto-dispatch
        // when it ends, defeating the stop.
        this.taskHost.bumpWorkspaceStopEpoch(record.workspaceId);
        releaseStopLatch = this.taskHost.latchWorkspaceStopsInProgress([record.workspaceId]);
        // Persist the execution mirror terminal within the same settlement boundary as the
        // handle transition, so config readers (peer admission, task_list) never observe an
        // interrupted handle with a still-running mirror.
        await this.updateAgentTaskExecutionState(
          record.workspaceId,
          record.handleId,
          "interrupted"
        );

        const active = this.activeWorkspaceTurnHandleByWorkspaceId.get(record.workspaceId);
        if (
          active?.handleId === record.handleId &&
          active.ownerWorkspaceId === record.ownerWorkspaceId
        ) {
          this.activeWorkspaceTurnHandleByWorkspaceId.delete(record.workspaceId);
        }
        this.settleWorkspaceTurnWaiters(record.handleId, {
          status: "error",
          error: new Error("Workspace turn interrupted"),
        });
        this.taskHost.markTaskForegroundRelevant(record.handleId);
        return Ok({ workspaceId: record.workspaceId });
      });

      if (!result.success) {
        return result;
      }

      if (shouldClearQueuedPrompt && workspaceId != null) {
        // Targeted removal: the queue can hold unrelated user messages before/behind
        // this turn's entry, so clearing the whole queue would drop real input.
        const removeResult = this.workspaceService.removeQueuedWorkspaceTurn(
          workspaceId,
          handleId,
          {
            cancelReason: "Workspace turn interrupted",
          }
        );
        if (!removeResult.success) {
          return Err(`Failed to clear queued workspace turn: ${removeResult.error}`);
        }
      }
      if (shouldStopStream && workspaceId != null) {
        try {
          await this.aiService.stopStream(workspaceId, { abandonPartial: false });
        } catch (error: unknown) {
          log.debug("interruptWorkspaceTurn: stopStream threw", { handleId, error });
        }
      }
      if (interruptedRecord != null && options?.suppressDisposableCleanup !== true) {
        await this.cleanupDisposableWorkspaceTurn(interruptedRecord);
      }
      if (options?.scheduleQueueDrain !== false) this.taskHost.scheduleMaybeStartQueuedTasks();
      return result;
    } finally {
      releaseStopLatch?.();
    }
  }

  async archiveOwnedWorkspaceTurnWorkspace(
    ownerWorkspaceId: string,
    target: WorkspaceLifecycleTarget,
    options: WorkspaceLifecycleOptions = {}
  ): Promise<Result<WorkspaceLifecycleResult, string>> {
    assert(ownerWorkspaceId.trim().length > 0, "archive lifecycle requires ownerWorkspaceId");
    const resolved = await this.resolveOwnedWorkspaceLifecycleTarget(
      ownerWorkspaceId,
      "archive",
      target
    );
    if ("status" in resolved) return Ok(resolved);

    // Global lock order: task-tree → task-creation mutex → workspace lifecycle (see the
    // workspaceLifecycleLocks declaration). Pre-acquire the target's task-tree lock here and
    // call the *WhileTaskTreeLocked archive sink so no path holds a lifecycle lock while
    // acquiring a tree lock — that edge closed a three-way cycle with createMany
    // (tree → mutex) and createWorkspaceTurn's persist section (mutex → lifecycle).
    const lifecycleResult: Result<WorkspaceLifecycleResult, string> =
      await this.taskHost.withTaskTreeLifecycleLock(resolved.workspaceId, async () =>
        this.withWorkspaceLifecycleLock(resolved, async (resolved) => {
          if (resolved.metadata == null) {
            return Ok({
              status: "not_found",
              action: "archive",
              ...this.lifecycleTargetFields(resolved),
              note: "Owned workspace metadata is already absent.",
            });
          }
          if (isWorkspaceArchived(resolved.metadata.archivedAt, resolved.metadata.unarchivedAt)) {
            return Ok({
              status: "already_archived",
              action: "archive",
              ...this.lifecycleTargetFields(resolved),
            });
          }

          // Model-facing safety: with the "delete" worktree archive behavior, archiving runs
          // `git worktree remove --force` with no snapshot and no user confirmation, so an
          // agent-driven archive could erase uncommitted work. Fail closed and route that
          // policy through user-mediated archive instead. This early check gives a friendly
          // refusal before any turn interruption; workspaceService.archive re-enforces it at
          // the sink (forbidWorktreeCheckoutDeletion) against the same read that drives the
          // snapshot/deletion decisions, closing the settings-flip race.
          // This single read is pinned through the whole operation: it drives the delete refusal,
          // the mutation-sensitivity check, the preflight, and (via worktreeArchiveBehaviorOverride)
          // every snapshot/deletion decision at the sink, so a concurrent settings flip cannot
          // change archive eligibility after turns were interrupted.
          const worktreeArchiveBehavior =
            this.config.loadConfigOrDefault().worktreeArchiveBehavior ??
            DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR;
          // The delete policy can only destroy work when the archive would actually run
          // managed-worktree deletion: non-worktree runtimes (SSH/Coder, Docker, project-dir
          // local) and isolation:none tasks (which point at an ancestor's checkout) are skipped
          // by the worktree archive hook, so an unrelated global worktree setting must not make
          // reversible archive unavailable for those targets. Mirrored at the sink.
          const runsManagedWorktreeDeletion =
            isWorktreeRuntime(resolved.metadata.runtimeConfig) &&
            resolved.metadata.taskIsolation !== "none";
          if (worktreeArchiveBehavior === "delete" && runsManagedWorktreeDeletion) {
            return Ok({
              status: "error",
              action: "archive",
              ...this.lifecycleTargetFields(resolved),
              error:
                'Worktree archive behavior is set to "Delete checkout", which would irreversibly delete the workspace checkout without user confirmation. Ask the user to archive this workspace manually or switch the archive behavior to "Keep" or "Snapshot".',
            });
          }

          // Same fail-closed rule for the Coder policy: under "delete", the before-archive hook
          // permanently deletes a dedicated (mux-created) remote Coder workspace and unarchive
          // cannot recreate it, so a nominally reversible agent-driven archive must refuse.
          // Re-enforced at the sink (forbidCoderWorkspaceDeletion) against the same read passed
          // to the hook, closing the settings-flip race.
          const targetRuntimeConfig = resolved.metadata.runtimeConfig;
          const coderArchiveBehavior =
            this.config.loadConfigOrDefault().coderWorkspaceArchiveBehavior ??
            DEFAULT_CODER_ARCHIVE_BEHAVIOR;
          const isDedicatedCoderWorkspace =
            isSSHRuntime(targetRuntimeConfig) &&
            targetRuntimeConfig.coder != null &&
            targetRuntimeConfig.coder.existingWorkspace !== true &&
            (targetRuntimeConfig.coder.workspaceName?.trim() ?? "") !== "";
          if (isDedicatedCoderWorkspace && coderArchiveBehavior === "delete") {
            return Ok({
              status: "error",
              action: "archive",
              ...this.lifecycleTargetFields(resolved),
              error:
                'Coder workspace archive behavior is set to "Delete", which would permanently delete the dedicated remote Coder workspace without user confirmation (unarchive cannot recreate it). Ask the user to archive this workspace manually or change the Coder archive behavior to "Keep" or "Stop".',
            });
          }

          // Native terminals and external editors spawn detached apps that never register
          // session activity and whose lifetime cannot be tracked (they daemonize or are deep
          // links, so process exit is meaningless). When the snapshot policy would remove this
          // managed worktree's checkout — or the pinned Coder policy would stop the dedicated
          // remote workspace the user's shell/editor may still be connected to ("delete" is
          // refused above, so non-"keep" here means stop) — archiving could pull the
          // environment out from under the user's live app — fail closed and route through
          // user-mediated archive. Sticky (durable markers) because closure is undetectable.
          // Re-enforced at the sink.
          const untrackableAppArchiveHazard =
            this.workspaceService.isSnapshotArchiveEligibilityMutationSensitive(
              resolved.workspaceId,
              worktreeArchiveBehavior,
              resolved.metadata
            ) ||
            (isDedicatedCoderWorkspace && coderArchiveBehavior !== "keep");
          if (
            untrackableAppArchiveHazard &&
            (await this.workspaceService.hasUntrackableExternalAppOpen(resolved.workspaceId))
          ) {
            return Ok({
              status: "error",
              action: "archive",
              ...this.lifecycleTargetFields(resolved),
              error:
                "A native terminal or external editor was opened for this workspace and its lifetime cannot be tracked; the archive policy would remove the checkout or stop the dedicated remote Coder workspace under it. Ask the user to archive this workspace manually.",
            });
          }

          const acknowledgedUntrackedPaths =
            options.acknowledgedUntrackedPaths ??
            options.acknowledgedUntrackedPathsByWorkspaceId?.[resolved.workspaceId];

          const activeTurns = await this.collectActiveWorkspaceLifecycleTurns(
            ownerWorkspaceId,
            resolved
          );

          // An active top-level workflow run owned by the target is active owned work even when
          // no descendant agent or workspace turn is running at this instant (workflows idle
          // between steps): archiving would break its next step and mark its terminal
          // notification superseded. Refuse regardless of interrupt_active — workflows are not
          // interruptible through this API. Strict scan: an unreadable run store cannot prove
          // the absence of active runs, so scan failures refuse instead of reading as none.
          let activeWorkflowRunIds: string[];
          try {
            activeWorkflowRunIds = await this.taskHost.listActiveWorkflowRunIdsForWorkspaceStrict(
              resolved.workspaceId
            );
          } catch (error: unknown) {
            return Ok({
              status: "error",
              action: "archive",
              ...this.lifecycleTargetFields(resolved),
              error: `Could not verify that this workspace has no active workflow runs (${getErrorMessage(error)}); refusing to archive. Ask the user to archive this workspace manually.`,
            });
          }
          if (activeWorkflowRunIds.length > 0) {
            return Ok({
              status: "active",
              action: "archive",
              ...this.lifecycleTargetFields(resolved),
              activeTaskIds: [...activeTurns.map((turn) => turn.handleId), ...activeWorkflowRunIds],
              note: `Workspace owns active workflow runs (${activeWorkflowRunIds.join(
                ", "
              )}). interrupt_active does not apply to workflow runs; wait for them to finish or stop them first.`,
            });
          }

          // Live activity with no delegated workspace-turn handle (a user-initiated stream,
          // queued messages, terminal PTYs, or an attached desktop viewer/popout) is user work:
          // the archive path would silently terminate it, so refuse — interrupt_active covers
          // delegated turns only. An idle desktop process with nobody attached is not user
          // work; the sink closes it like the user-driven archive does.
          const liveActivity = this.workspaceService.listLiveWorkspaceActivity(
            resolved.workspaceId
          );
          const targetTurns = activeTurns.filter(
            (turn) => turn.workspaceId === resolved.workspaceId
          );
          const hasRunningDelegatedStream = targetTurns.some((turn) => turn.status === "running");
          // A queued delegated follow-up also surfaces as a queued message, and so does a
          // delegated turn whose send is still PREPARING (its handle already reads running);
          // only unexplained queue entries are treated as user work. The PREPARING exemption
          // is bound to the exact correlation of a collected non-queued turn, so a user send
          // preparing behind an ended delegated turn stays user work. Mixed queues (user +
          // delegated entries) conservatively fail closed at the sink's admission-hold
          // recheck instead.
          const hasQueuedDelegatedTurn = targetTurns.some((turn) => turn.status === "queued");
          const preparingTurn = this.workspaceService.getStoppablePreparingWorkspaceTurn(
            resolved.workspaceId
          );
          const hasPreparingDelegatedTurn =
            preparingTurn != null &&
            targetTurns.some(
              (turn) =>
                turn.status !== "queued" &&
                isSameWorkspaceTurnTaskCorrelation(
                  {
                    taskHandleId: turn.handleId,
                    ownerWorkspaceId: turn.ownerWorkspaceId,
                    turnId: turn.turnId,
                  },
                  preparingTurn
                )
            );
          const nonTurnActivity: string[] = [];
          if (liveActivity.streaming && !hasRunningDelegatedStream) {
            nonTurnActivity.push("an active stream");
          }
          if (
            liveActivity.queuedMessages &&
            !hasQueuedDelegatedTurn &&
            !hasPreparingDelegatedTurn
          ) {
            nonTurnActivity.push("queued messages");
          }
          // Detached background bash outlives its spawning turn: interruption does not stop it,
          // and a snapshot archive could remove the worktree under a process still writing.
          // Fresh check (refreshes exit statuses) so a long-exited process cannot hold the
          // refusal open; the sink's synchronous snapshot covers races after this gate.
          if (await this.workspaceService.hasRunningBackgroundBashProcesses(resolved.workspaceId)) {
            nonTurnActivity.push("running background bash processes");
          }
          if (liveActivity.terminalSessions) nonTurnActivity.push("open terminal sessions");
          if (liveActivity.desktopViewers) nonTurnActivity.push("an open desktop viewer or popout");
          if (nonTurnActivity.length > 0) {
            return Ok({
              status: "active",
              action: "archive",
              ...this.lifecycleTargetFields(resolved),
              ...(activeTurns.length > 0
                ? { activeTaskIds: activeTurns.map((turn) => turn.handleId) }
                : {}),
              note: `Workspace has live activity outside delegated workspace turns (${nonTurnActivity.join(
                ", "
              )}). interrupt_active does not apply to user activity; ask the user to close it or archive manually.`,
            });
          }

          // Held (when interrupting) from before the first turn interruption through the
          // archive sink so user activity cannot be admitted between turn destruction and
          // the sink's refuseLiveUserActivity gate (see acquirePreInterruptionArchiveHold).
          let preInterruptionHold: Disposable | undefined;
          try {
            if (activeTurns.length > 0) {
              if (options.interruptActive !== true) {
                return Ok({
                  status: "active",
                  action: "archive",
                  ...this.lifecycleTargetFields(resolved),
                  activeTaskIds: activeTurns.map((turn) => turn.handleId),
                });
              }
              // interrupt_active does not cascade into turns running in OTHER workspaces
              // (the target's own nested workspace turns): interrupting one triggers the
              // nested disposable workspace's force-removal, which would terminate any user
              // terminals/editors/queued work there and delete its checkout without the
              // activity checks and admission holds the target itself gets. Refuse instead;
              // the caller stops those turns explicitly (task_stop), which is the same
              // user-visible cleanup path as normal turn settlement.
              const nestedTurnWorkspaceIds = [
                ...new Set(
                  activeTurns
                    .filter((turn) => turn.workspaceId !== resolved.workspaceId)
                    .map((turn) => turn.workspaceId)
                ),
              ];
              if (nestedTurnWorkspaceIds.length > 0) {
                return Ok({
                  status: "active",
                  action: "archive",
                  ...this.lifecycleTargetFields(resolved),
                  activeTaskIds: activeTurns.map((turn) => turn.handleId),
                  note: `interrupt_active was not honored: some active turns run in nested workspaces (${nestedTurnWorkspaceIds.join(
                    ", "
                  )}) whose cleanup cannot be safely combined with this archive. Stop the listed turns (task_stop) or wait for them to finish, then archive again.`,
                });
              }
              // Snapshot-behavior archives are eligibility-mutation-sensitive: the running turns
              // being interrupted can create/remove untracked files between any preflight scan and
              // the sink's exact-acknowledgement recheck, so interruption could destroy in-flight
              // work and STILL bounce with requires_confirmation, stranding the workspace
              // interrupted-but-unarchived. No worktree-freeze mechanism exists, so refuse to
              // interrupt here: the caller stops the listed turns explicitly (task_stop / await),
              // after which the untracked set is stable and any confirmation round-trip is
              // deterministic.
              if (
                this.workspaceService.isSnapshotArchiveEligibilityMutationSensitive(
                  resolved.workspaceId,
                  worktreeArchiveBehavior,
                  resolved.metadata
                )
              ) {
                return Ok({
                  status: "active",
                  action: "archive",
                  ...this.lifecycleTargetFields(resolved),
                  activeTaskIds: activeTurns.map((turn) => turn.handleId),
                  note:
                    "interrupt_active was not honored: the snapshot archive behavior requires an exact untracked-file acknowledgement, which active turns can invalidate mid-interruption. " +
                    "Stop the listed turns (task_stop) or wait for them to finish, then archive again.",
                });
              }
              // Same interrupted-but-unarchived hazard from a different source: for a dedicated
              // Coder workspace under the "stop" policy, the sink's before-archive hook stops the
              // remote workspace and can fail or time out AFTER turns were already destroyed —
              // preflightArchive cannot exercise that hook without side effects, and interrupted
              // streams cannot be restored. Refuse to interrupt; the caller stops the turns
              // explicitly, after which a failed archive is retryable without further loss.
              if (isDedicatedCoderWorkspace && coderArchiveBehavior !== "keep") {
                return Ok({
                  status: "active",
                  action: "archive",
                  ...this.lifecycleTargetFields(resolved),
                  activeTaskIds: activeTurns.map((turn) => turn.handleId),
                  note:
                    "interrupt_active was not honored: archiving this dedicated Coder workspace runs a fallible remote stop step after interruption, which could destroy the turns and still fail the archive. " +
                    "Stop the listed turns (task_stop) or wait for them to finish, then archive again.",
                });
              }
              // Interruption destroys in-flight work, so surface every archive blocker BEFORE
              // stopping anything: a refused lossy-untracked-files confirmation, changed paths since
              // a prior acknowledgement, or archive-blocking errors (e.g. active descendant
              // sub-agents) must all leave the active turns running.
              const preflight = await this.workspaceService.preflightArchive(resolved.workspaceId, {
                worktreeArchiveBehaviorOverride: worktreeArchiveBehavior,
              });
              if (!preflight.success) {
                return Ok({
                  status: "error",
                  action: "archive",
                  ...this.lifecycleTargetFields(resolved),
                  error: preflight.error,
                });
              }
              if (preflight.data.kind === "confirm-lossy-untracked-files") {
                // The archive sink requires exact normalized equality between the acknowledged and
                // current path lists (a subset check would accept a stale acknowledgement whose extra
                // paths no longer exist, interrupt the turns, and then still bounce with
                // requires_confirmation). Mirror the sink's check so interruption only happens when
                // the acknowledgement would actually be accepted.
                if (
                  acknowledgedUntrackedPaths == null ||
                  !areArchiveUntrackedPathListsEqual(
                    acknowledgedUntrackedPaths,
                    preflight.data.paths
                  )
                ) {
                  return Ok({
                    status: "requires_confirmation",
                    action: "archive",
                    ...this.lifecycleTargetFields(resolved),
                    paths: preflight.data.paths,
                  });
                }
              }
              // Arm the sink's admission gate BEFORE destroying anything: in-flight user
              // activity the earlier snapshot cannot see (admission counters, workflow
              // admissions, user queue entries beyond the delegated turns) must refuse the
              // archive while the turns are still running, and the armed gate keeps new
              // activity out until the sink completes.
              const holdResult = this.workspaceService.acquirePreInterruptionArchiveHold(
                resolved.workspaceId,
                {
                  queuedDelegatedTurnCount: activeTurns.filter(
                    (turn) => turn.workspaceId === resolved.workspaceId && turn.status === "queued"
                  ).length,
                  // The workspace's one active stream is expected (and interruptible) only
                  // when it correlates to a collected delegated turn active on the target
                  // itself; any other stream (e.g. a user stream that replaced an ended
                  // delegated stream since collection) is user work the hold must refuse on.
                  expectedDelegatedTurnCorrelations: activeTurns
                    .filter(
                      (turn) =>
                        turn.workspaceId === resolved.workspaceId && turn.status !== "queued"
                    )
                    .map((turn) => ({
                      taskHandleId: turn.handleId,
                      ownerWorkspaceId: turn.ownerWorkspaceId,
                      turnId: turn.turnId,
                    })),
                }
              );
              if (!holdResult.success) {
                return Ok({
                  status: "active",
                  action: "archive",
                  ...this.lifecycleTargetFields(resolved),
                  activeTaskIds: activeTurns.map((turn) => turn.handleId),
                  note: `interrupt_active was not honored: ${holdResult.error}`,
                });
              }
              preInterruptionHold = holdResult.data;
              const interruptFailure = await this.interruptActiveWorkspaceLifecycleTurns(
                resolved,
                activeTurns
              );
              if (interruptFailure != null) return Ok(interruptFailure);
              // stopStream resolves once the engine has aborted, but the target session's turn
              // unwinds asynchronously: a canceled PREPARING send still reads PREPARING until
              // its aborted handle reaches turn policy, and the sink's synchronous live-activity
              // gate would refuse on that residue with the turns already destroyed. Wait for the
              // session to settle first; the hold keeps admission frozen meanwhile, so nothing
              // new can claim the session. The bound is a hang guard for a turn whose abort
              // never lands, not a grace period.
              const settled = await raceWithAbortAndTimeout(
                this.workspaceService.waitForIdle(resolved.workspaceId),
                { timeoutMs: TASK_TERMINATION_STOP_STREAM_TIMEOUT_MS }
              );
              if (settled.kind !== "ok") {
                return Ok({
                  status: "error",
                  action: "archive",
                  ...this.lifecycleTargetFields(resolved),
                  activeTaskIds: activeTurns.map((turn) => turn.handleId),
                  error:
                    "The interrupted turns did not settle in time, so the workspace was not archived. Wait for them to stop, then archive again.",
                });
              }
            }

            // WhileTaskTreeLocked: the tree lock is already held for the whole lifecycle operation
            // (see the lock-order comment above), so the plain archive() wrapper would self-deadlock.
            const result = await this.workspaceService.archiveWhileTaskTreeLocked(
              resolved.workspaceId,
              acknowledgedUntrackedPaths,
              // Enforced at the sink: forbidWorktreeCheckoutDeletion / forbidCoderWorkspaceDeletion
              // close the settings-flip races the early behavior checks above cannot cover,
              // refuseLiveUserActivity fails closed (and holds turn admission) if user activity was
              // admitted after the earlier live-activity snapshot, and the behavior override pins
              // every sink decision to the same read that drove interruption eligibility.
              {
                forbidWorktreeCheckoutDeletion: true,
                forbidCoderWorkspaceDeletion: true,
                refuseLiveUserActivity: true,
                worktreeArchiveBehaviorOverride: worktreeArchiveBehavior,
                coderWorkspaceArchiveBehaviorOverride: coderArchiveBehavior,
              }
            );
            if (!result.success) {
              return Ok({
                status: "error",
                action: "archive",
                ...this.lifecycleTargetFields(resolved),
                error: result.error,
              });
            }
            if (result.data.kind === "confirm-lossy-untracked-files") {
              return Ok({
                status: "requires_confirmation",
                action: "archive",
                ...this.lifecycleTargetFields(resolved),
                paths: result.data.paths,
              });
            }
            return Ok({
              status: "archived",
              action: "archive",
              ...this.lifecycleTargetFields(resolved),
            });
          } finally {
            preInterruptionHold?.[Symbol.dispose]();
          }
        })
      );
    return lifecycleResult;
  }

  async unarchiveOwnedWorkspaceTurnWorkspace(
    ownerWorkspaceId: string,
    target: WorkspaceLifecycleTarget
  ): Promise<Result<WorkspaceLifecycleResult, string>> {
    assert(ownerWorkspaceId.trim().length > 0, "unarchive lifecycle requires ownerWorkspaceId");
    const resolved = await this.resolveOwnedWorkspaceLifecycleTarget(
      ownerWorkspaceId,
      "unarchive",
      target
    );
    if ("status" in resolved) return Ok(resolved);

    // Same lock order as archive (task-tree → workspace lifecycle): unarchive shares the
    // task-tree lock with archive so it cannot interleave with an archive's post-persist
    // cleanup, and pre-acquiring it before the lifecycle lock preserves the global order.
    return await this.taskHost.withTaskTreeLifecycleLock(resolved.workspaceId, async () =>
      this.withWorkspaceLifecycleLock(resolved, async (resolved) => {
        if (resolved.metadata == null) {
          return Ok({
            status: "not_found",
            action: "unarchive",
            ...this.lifecycleTargetFields(resolved),
            note: "Owned workspace metadata is already absent.",
          });
        }
        if (!isWorkspaceArchived(resolved.metadata.archivedAt, resolved.metadata.unarchivedAt)) {
          return Ok({
            status: "already_unarchived",
            action: "unarchive",
            ...this.lifecycleTargetFields(resolved),
          });
        }

        // Defense-in-depth: an archived workspace should never have active turns (archive refuses
        // while active; createWorkspaceTurn refuses archived targets). If a race/corruption
        // surfaces one anyway, report it — never interrupt on unarchive, regardless of caller
        // options (interruptActive intentionally not supported here).
        const activeTurns = await this.collectActiveWorkspaceLifecycleTurns(
          ownerWorkspaceId,
          resolved
        );
        if (activeTurns.length > 0) {
          return Ok({
            status: "active",
            action: "unarchive",
            ...this.lifecycleTargetFields(resolved),
            activeTaskIds: activeTurns.map((turn) => turn.handleId),
          });
        }

        // WhileTaskTreeLocked: the tree lock is already held for this lifecycle operation, so the
        // plain unarchive() wrapper would self-deadlock.
        const result = await this.workspaceService.unarchiveWhileTaskTreeLocked(
          resolved.workspaceId
        );
        if (!result.success) {
          return Ok({
            status: "error",
            action: "unarchive",
            ...this.lifecycleTargetFields(resolved),
            error: result.error,
          });
        }
        return Ok({
          status: "unarchived",
          action: "unarchive",
          ...this.lifecycleTargetFields(resolved),
        });
      })
    );
  }

  /** Acquire workspace lifecycle locks for multiple keys; callers must pass sorted keys. */
  private async withWorkspaceLifecycleLockKeys<T>(
    keys: readonly string[],
    operation: () => Promise<T>
  ): Promise<T> {
    if (keys.length === 0) {
      return await operation();
    }
    return await this.workspaceLifecycleLocks.withLock(keys[0], () =>
      this.withWorkspaceLifecycleLockKeys(keys.slice(1), operation)
    );
  }

  private async withWorkspaceLifecycleLock<T>(
    resolved: ResolvedWorkspaceLifecycleTarget,
    operation: (lockedResolved: ResolvedWorkspaceLifecycleTarget) => Promise<T>
  ): Promise<T> {
    return await this.workspaceLifecycleLocks.withLock(resolved.workspaceId, async () => {
      // Re-read metadata under the lock: a concurrent lifecycle mutation may have archived or
      // unarchived the target between resolution and lock acquisition.
      const lockedResolved = {
        ...resolved,
        metadata: await this.findWorkspaceLifecycleMetadata(resolved.workspaceId),
      };
      return await operation(lockedResolved);
    });
  }

  private async resolveOwnedWorkspaceLifecycleTarget(
    ownerWorkspaceId: string,
    action: WorkspaceLifecycleAction,
    target: WorkspaceLifecycleTarget
  ): Promise<ResolvedWorkspaceLifecycleTarget | WorkspaceLifecycleResult> {
    assert(
      ownerWorkspaceId.trim().length > 0,
      "workspace lifecycle target resolution requires owner"
    );
    const hasTaskId = target.taskId != null && target.taskId.trim().length > 0;
    const hasWorkspaceId = target.workspaceId != null && target.workspaceId.trim().length > 0;
    assert(hasTaskId !== hasWorkspaceId, "workspace lifecycle target must have exactly one ID");

    let taskId: string | undefined;
    let taskTitle: string | undefined;
    let workspaceId: string;
    if (hasTaskId) {
      taskId = target.taskId;
      assert(taskId != null, "workspace lifecycle taskId must be resolved");
      if (!isWorkspaceTurnTaskId(taskId)) {
        return { status: "invalid_scope", action, taskId };
      }
      const record = await this.taskHandleStore.getWorkspaceTurn(ownerWorkspaceId, taskId);
      if (record == null) {
        return { status: "invalid_scope", action, taskId };
      }
      taskTitle = record.title;
      workspaceId = record.workspaceId;
    } else {
      assert(target.workspaceId != null, "workspace lifecycle workspaceId must be resolved");
      workspaceId = target.workspaceId;
    }

    // Authorization uses durable workspace-turn ownership records (createdWorkspace flags in the
    // owner's session dir) as the sole source of truth; workspace config tags are hints only.
    const owned = await this.taskHandleStore.isWorkspaceOwnedBy(ownerWorkspaceId, workspaceId);
    if (!owned) {
      return {
        status: "invalid_scope",
        action,
        ...(taskId != null ? { taskId } : {}),
        workspaceId,
      };
    }

    const metadata = await this.findWorkspaceLifecycleMetadata(workspaceId);
    return {
      action,
      ...(taskId != null ? { taskId } : {}),
      ...(taskTitle != null ? { taskTitle } : {}),
      workspaceId,
      metadata,
    };
  }

  /**
   * Active workspace turns that block a lifecycle mutation of the resolved target:
   * - turns owned by the caller that target the workspace (in-flight delegated work), and
   * - turns the target workspace itself owns (nested delegation): archiving the owner would
   *   orphan those results, because terminal attention draining supersedes handles whose
   *   owner is archived.
   */
  private lifecycleTargetFields(resolved: ResolvedWorkspaceLifecycleTarget): {
    taskId?: string;
    workspaceId: string;
    displayName?: string;
  } {
    // Match the sidebar label so completed lifecycle tool rows remain understandable after
    // archive hides the child workspace from the active list.
    const displayName =
      coerceNonEmptyString(resolved.metadata?.title) ??
      coerceNonEmptyString(resolved.metadata?.name) ??
      coerceNonEmptyString(resolved.taskTitle);
    return {
      ...(resolved.taskId != null ? { taskId: resolved.taskId } : {}),
      workspaceId: resolved.workspaceId,
      ...(displayName != null ? { displayName } : {}),
    };
  }

  private async findWorkspaceLifecycleMetadata(
    workspaceId: string
  ): Promise<WorkspaceMetadata | null> {
    assert(
      workspaceId.trim().length > 0,
      "workspace lifecycle metadata lookup requires workspaceId"
    );
    try {
      const allMetadata = await this.config.getAllWorkspaceMetadata();
      return allMetadata.find((metadata) => metadata.id === workspaceId) ?? null;
    } catch (error: unknown) {
      log.debug("Failed to load workspace metadata for workspace lifecycle", {
        workspaceId,
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  private async collectActiveWorkspaceLifecycleTurns(
    ownerWorkspaceId: string,
    resolved: ResolvedWorkspaceLifecycleTarget
  ): Promise<
    Array<{
      ownerWorkspaceId: string;
      handleId: string;
      workspaceId: string;
      turnId: string;
      status: WorkspaceTurnTaskStatus;
    }>
  > {
    const statuses = ["queued", "starting", "running"] as const;
    const callerOwned = (await this.listWorkspaceTurnTasks(ownerWorkspaceId, { statuses })).filter(
      (record) => record.workspaceId === resolved.workspaceId
    );
    const targetOwned = await this.listWorkspaceTurnTasks(resolved.workspaceId, { statuses });
    return [...callerOwned, ...targetOwned].map((record) => ({
      ownerWorkspaceId: record.ownerWorkspaceId,
      handleId: record.handleId,
      workspaceId: record.workspaceId,
      turnId: record.turnId,
      status: record.status,
    }));
  }

  private async interruptActiveWorkspaceLifecycleTurns(
    resolved: ResolvedWorkspaceLifecycleTarget,
    activeTurns: ReadonlyArray<{ ownerWorkspaceId: string; handleId: string; workspaceId: string }>
  ): Promise<WorkspaceLifecycleResult | null> {
    for (const turn of activeTurns) {
      // Every turn reaching this loop targets the archived workspace itself (nested turn
      // workspaces refuse interrupt_active earlier), so suppressDisposableCleanup only has
      // to protect the target's checkout: the disposable auto-removal that normally follows
      // interruption must not delete the checkout the archive is about to keep.
      assert(
        turn.workspaceId === resolved.workspaceId,
        "interruptActiveWorkspaceLifecycleTurns requires turns targeting the archived workspace"
      );
      const interruptResult = await this.interruptWorkspaceTurn(
        turn.ownerWorkspaceId,
        turn.handleId,
        { suppressDisposableCleanup: true }
      );
      if (!interruptResult.success) {
        // Turns can settle between collection and interruption (e.g. during the archive
        // preflight). A now-terminal handle needs no interruption and must not abort the
        // remaining set mid-way, leaving work partially interrupted but unarchived.
        const current = await this.taskHandleStore.getWorkspaceTurn(
          turn.ownerWorkspaceId,
          turn.handleId
        );
        if (current == null || this.isTerminalWorkspaceTurnStatus(current.status)) {
          continue;
        }
        return {
          status: "error",
          action: resolved.action,
          ...this.lifecycleTargetFields(resolved),
          activeTaskIds: activeTurns.map((entry) => entry.handleId),
          error: interruptResult.error,
        };
      }
    }
    return null;
  }

  private isActiveWorkspaceTurn(record: WorkspaceTurnTaskHandleRecord): boolean {
    if (record.status === "running" && this.taskHost.isForegroundAwaiting(record.workspaceId)) {
      return false;
    }
    return isActiveWorkspaceTurnTaskStatus(record.status);
  }

  private async findActiveWorkspaceTurnForWorkspace(
    records: readonly WorkspaceTurnTaskHandleRecord[],
    workspaceId: string
  ): Promise<WorkspaceTurnTaskHandleRecord | undefined> {
    assert(workspaceId.length > 0, "findActiveWorkspaceTurnForWorkspace requires workspaceId");
    // Newest-first (records arrive createdAt-ascending): the supersede
    // announcement in createWorkspaceTurn must name the IMMEDIATE predecessor.
    // With A active and same-owner follow-ups B and C queued, C supersedes B
    // (not A) at B's first boundary — and B's own settlement wake is
    // suppressed, so naming A for both B and C would leave B's interruption
    // unreported anywhere. Existence checks are order-independent.
    for (const record of [...records].reverse()) {
      if (record.workspaceId !== workspaceId || !this.isActiveWorkspaceTurn(record)) {
        continue;
      }
      if (!(await this.isLiveWorkspaceTurn(record))) {
        await this.settleStaleWorkspaceTurn(record);
        continue;
      }
      return record;
    }
    return undefined;
  }

  private async hasActiveWorkspaceTurnDeferredBlockers(
    record: WorkspaceTurnTaskHandleRecord
  ): Promise<boolean> {
    if (
      this.taskHost.hasActiveDescendantAgentTasks(
        this.config.loadConfigOrDefault(),
        record.workspaceId
      )
    ) {
      return true;
    }

    const referencedWorkflowRunIds = await this.taskHost.listAgentReferencedWorkflowRunIds(
      record.workspaceId,
      []
    );
    if (
      (
        await this.taskHost.listActiveBackgroundWorkflowRunIds(
          record.workspaceId,
          referencedWorkflowRunIds
        )
      ).length > 0
    ) {
      return true;
    }

    return (await this.listActiveWorkspaceTurnTaskIdsForOwner(record.workspaceId)).length > 0;
  }

  private async isLiveWorkspaceTurn(record: WorkspaceTurnTaskHandleRecord): Promise<boolean> {
    const active = this.activeWorkspaceTurnHandleByWorkspaceId.get(record.workspaceId);
    const hasRuntimeActivity =
      this.aiService.isStreaming(record.workspaceId) ||
      this.workspaceService.hasPendingQueuedOrPreparingTurn(record.workspaceId) ||
      this.workspaceService.hasPendingBashMonitorWakeContinuation(record.workspaceId) ||
      this.hasSameTurnContinuation(
        {
          workspaceId: record.workspaceId,
          messageId: record.deferredMessageIds?.at(-1) ?? record.messageId ?? "",
        },
        {
          taskHandleId: record.handleId,
          ownerWorkspaceId: record.ownerWorkspaceId,
          turnId: record.turnId,
        }
      );
    if (hasRuntimeActivity) {
      return true;
    }

    const isActiveHandle =
      active?.handleId === record.handleId && active.ownerWorkspaceId === record.ownerWorkspaceId;
    if (!isActiveHandle) {
      return false;
    }

    if ((record.deferredMessageIds?.length ?? 0) === 0) {
      return true;
    }

    // A deferred workspace-turn stream-end was waiting for background work. Once there is no
    // live stream/queued retry and no active descendant/workflow/nested turn left, the in-memory
    // handle is stale and should be recovered from the deferred history instead of blocking forever.
    return await this.hasActiveWorkspaceTurnDeferredBlockers(record);
  }

  private async settleStaleWorkspaceTurn(record: WorkspaceTurnTaskHandleRecord): Promise<void> {
    if (!isActiveWorkspaceTurnTaskStatus(record.status)) {
      return;
    }
    const recovered = await this.recoverTerminalWorkspaceTurnFromHistory(record);
    if (recovered != null) {
      await this.settleWorkspaceTurn({
        cause: { kind: "stale-history-recovery" },
        record,
        next: recovered,
        waiterSettlement:
          recovered.status === "completed"
            ? { status: "completed", result: this.buildWorkspaceTurnWaitResult(recovered) }
            : { status: "error", error: new Error(recovered.error ?? "Workspace turn failed") },
      });
      return;
    }

    // Recovery reads can overlap a continuation start. Check live work again before the fallback.
    if (await this.isLiveWorkspaceTurn(record)) return;
    // No runtime work remains. A missing history row must not keep a deferred handle active forever.
    const next: WorkspaceTurnTaskHandleRecord = {
      ...record,
      status: "interrupted",
      updatedAt: getIsoNow(),
      error: WORKSPACE_TURN_STALE_RESTART_ERROR,
    };
    await this.settleWorkspaceTurn({
      cause: { kind: "stale-restart" },
      record,
      next,
      waiterSettlement: {
        status: "error",
        error: new Error(WORKSPACE_TURN_STALE_RESTART_ERROR),
      },
    });
  }

  async countActiveWorkspaceTurns(
    records?: readonly WorkspaceTurnTaskHandleRecord[]
  ): Promise<number> {
    const candidateWorkspaceTurns =
      records ??
      (await this.taskHandleStore.listAllWorkspaceTurns({
        statuses: ["queued", "starting", "running"],
      }));
    let count = 0;
    const countedWorkspaceIds = new Set<string>();
    const queuedRecords: WorkspaceTurnTaskHandleRecord[] = [];
    for (const record of candidateWorkspaceTurns) {
      if (!this.isActiveWorkspaceTurn(record)) {
        continue;
      }
      if (!(await this.isLiveWorkspaceTurn(record))) {
        await this.settleStaleWorkspaceTurn(record);
        continue;
      }
      if (record.status === "queued") {
        queuedRecords.push(record);
        continue;
      }
      count += 1;
      countedWorkspaceIds.add(record.workspaceId);
    }
    for (const record of queuedRecords) {
      if (countedWorkspaceIds.has(record.workspaceId)) {
        continue;
      }
      count += 1;
      countedWorkspaceIds.add(record.workspaceId);
    }
    return count;
  }

  async listActiveWorkspaceTurnTaskIdsForOwner(ownerWorkspaceId: string): Promise<string[]> {
    const records = await this.taskHandleStore.listWorkspaceTurns(ownerWorkspaceId);
    const taskIds: string[] = [];
    for (const record of records) {
      if (isActiveWorkspaceTurnTaskStatus(record.status)) {
        if (!(await this.isLiveWorkspaceTurn(record))) {
          await this.settleStaleWorkspaceTurn(record);
          continue;
        }
        taskIds.push(record.handleId);
        continue;
      }
      // A stale settled handle whose child is actively retrying the same turn is live
      // delegated work: revive it here too, so the parent's turn-end blocker scan cannot
      // finish while the child is still running. Cheap for historical handles — reconcile
      // short-circuits on in-memory runtime checks before touching history.
      if (
        (record.status === "interrupted" || record.status === "error") &&
        isSelfHealEligibleSettledWorkspaceTurn(record)
      ) {
        const latest = await this.reconcileSettledWorkspaceTurn(record, {
          repairFromHistory: false,
        });
        if (latest != null && isActiveWorkspaceTurnTaskStatus(latest.status)) {
          taskIds.push(latest.handleId);
        }
      }
    }
    return taskIds;
  }

  /**
   * Filter active workspace-turn handle IDs down to those whose persisted
   * attention policy still blocks the owner's turn-end. `notify_on_terminal`
   * handles are non-blocking; their terminal output is delivered via wake-up.
   */
  async listBlockingWorkspaceTurnTaskIds(
    ownerWorkspaceId: string,
    handleIds: string[]
  ): Promise<string[]> {
    if (handleIds.length === 0) {
      return [];
    }
    const blocking: string[] = [];
    for (const handleId of handleIds) {
      const record = await this.taskHandleStore.getWorkspaceTurn(ownerWorkspaceId, handleId);
      if (resolveBackgroundWorkAttentionPolicy(record?.attentionPolicy) !== "notify_on_terminal") {
        blocking.push(handleId);
      }
    }
    return blocking;
  }

  private buildWorkspaceTurnMuxMetadata(
    record: Pick<WorkspaceTurnTaskHandleRecord, "handleId" | "ownerWorkspaceId" | "turnId">
  ): WorkspaceTurnMuxMetadata {
    return {
      type: "workspace-turn-task",
      taskHandleId: record.handleId,
      ownerWorkspaceId: record.ownerWorkspaceId,
      turnId: record.turnId,
    };
  }

  getWorkspaceTurnMetadataFromValue(
    muxMetadata: unknown
  ): { taskHandleId: string; ownerWorkspaceId: string; turnId: string } | null {
    return parseWorkspaceTurnTaskCorrelation(muxMetadata);
  }

  private getWorkspaceTurnMetadata(
    event: StreamEndEvent
  ): { taskHandleId: string; ownerWorkspaceId: string; turnId: string } | null {
    return this.getWorkspaceTurnMetadataFromValue(event.metadata.muxMetadata);
  }

  private buildWorkspaceTurnReportMarkdown(event: StreamEndEvent): string {
    const textRuns: string[] = [];
    let currentTextRun: string[] = [];
    const flushTextRun = () => {
      const text = currentTextRun.join("");
      if (text.length > 0) {
        textRuns.push(text);
      }
      currentTextRun = [];
    };

    for (const part of event.parts) {
      if (part.type === "text") {
        // Adjacent text parts are provider stream deltas; concatenate them exactly so token
        // boundaries do not become arbitrary Markdown line breaks.
        currentTextRun.push(part.text);
      } else {
        // A tool or reasoning part separates rendered text blocks. Preserve that boundary when
        // projecting the turn into one report body instead of running the blocks together.
        flushTextRun();
      }
    }
    flushTextRun();

    const text = textRuns.join("\n\n").trim();
    return text.length > 0 ? text : "Workspace turn completed without final text output.";
  }

  private buildWorkspaceTurnFinalMessageRef(event: StreamEndEvent): WorkspaceTurnFinalMessageRef {
    const textCharCount = event.parts
      .filter(
        (part): part is Extract<(typeof event.parts)[number], { type: "text" }> =>
          part.type === "text"
      )
      .reduce((sum, part) => sum + part.text.length, 0);
    const usage = event.metadata.usage;
    return {
      messageId: event.messageId,
      model: event.metadata.model,
      agentId: event.metadata.agentId,
      finishReason: event.metadata.finishReason,
      ...(usage != null
        ? {
            usageSummary: {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.totalTokens,
            },
          }
        : {}),
      partCount: event.parts.length,
      textCharCount,
    };
  }

  private buildWorkspaceTurnStreamEndEventFromHistory(
    record: WorkspaceTurnTaskHandleRecord,
    message: MuxMessage
  ): StreamEndEvent | null {
    if (message.role !== "assistant" || message.metadata?.partial === true) {
      return null;
    }
    const metadata = this.getWorkspaceTurnMetadataFromValue(message.metadata?.muxMetadata);
    if (
      metadata == null ||
      metadata.taskHandleId !== record.handleId ||
      metadata.ownerWorkspaceId !== record.ownerWorkspaceId ||
      metadata.turnId !== record.turnId
    ) {
      return null;
    }
    return {
      type: "stream-end",
      workspaceId: record.workspaceId,
      messageId: message.id,
      metadata: {
        ...message.metadata,
        model: coerceNonEmptyString(message.metadata?.model) ?? record.modelString ?? defaultModel,
      },
      parts: message.parts as StreamEndEvent["parts"],
    };
  }

  private buildTerminalWorkspaceTurnRecordFromEvent(
    record: WorkspaceTurnTaskHandleRecord,
    event: StreamEndEvent,
    options: { supersedeEvidence: QueueCutSupersedeEvidence }
  ): WorkspaceTurnTaskHandleRecord {
    const baseRecord = { ...record };
    delete baseRecord.error;
    delete baseRecord.deferredMessageIds;
    // Persisted queue decisions remain authoritative after the cutter leaves the queue.
    if (event.metadata.finishReason === "tool-calls" && options.supersedeEvidence != null) {
      const evidence = options.supersedeEvidence;
      const error =
        evidence.kind === "same_owner_follow_up"
          ? buildOwnerFollowUpSupersededError(evidence.successorHandleId)
          : evidence.kind === "preserved"
            ? evidence.error
            : WORKSPACE_TURN_SUPERSEDED_BY_NEW_INPUT_ERROR;
      return {
        ...baseRecord,
        status: "interrupted",
        updatedAt: getIsoNow(),
        messageId: event.messageId,
        error,
        finalMessageRef: this.buildWorkspaceTurnFinalMessageRef(event),
        finalMessage: {
          messageId: event.messageId,
          metadata: event.metadata,
        },
      };
    }
    // Truncated/non-stop provider finishes are partial output, not a completed delegated turn.
    if (
      event.metadata.finishReason != null &&
      event.metadata.finishReason !== "stop" &&
      event.metadata.stopCause?.kind !== "required-tool"
    ) {
      return {
        ...baseRecord,
        status: "error",
        updatedAt: getIsoNow(),
        messageId: event.messageId,
        error:
          event.metadata.finishReason === "tool-calls"
            ? this.describeIncompleteToolStop(event)
            : `Workspace turn ended before completion (finishReason: ${event.metadata.finishReason})`,
        finalMessageRef: this.buildWorkspaceTurnFinalMessageRef(event),
        finalMessage: {
          messageId: event.messageId,
          metadata: event.metadata,
        },
      };
    }
    return {
      ...baseRecord,
      status: "completed",
      updatedAt: getIsoNow(),
      messageId: event.messageId,
      reportMarkdown: this.buildWorkspaceTurnReportMarkdown(event),
      finalMessageRef: this.buildWorkspaceTurnFinalMessageRef(event),
      finalMessage: {
        messageId: event.messageId,
        metadata: event.metadata,
      },
    };
  }

  private describeIncompleteToolStop(event: StreamEndEvent): string {
    const cause = event.metadata.stopCause;
    if (cause == null) {
      log.warn("Workspace turn tool-calls stop has unknown cause", {
        workspaceId: event.workspaceId,
        messageId: event.messageId,
        muxMetadata: event.metadata.muxMetadata,
      });
      return "Workspace turn incomplete: unknown stop cause; no correlated continuation found.";
    }
    if (cause.kind === "queued-input") {
      return `Workspace turn continuation unavailable after queue stop (entryId: ${cause.entryId}).`;
    }
    if (cause.kind === "context-budget") {
      return `Workspace turn incomplete: context budget ${cause.decision}; no continuation remains.`;
    }
    return "Workspace turn incomplete: step limit reached.";
  }

  private isDeferredWorkspaceTurnMessage(
    record: WorkspaceTurnTaskHandleRecord,
    messageId: string
  ): boolean {
    assert(messageId.length > 0, "isDeferredWorkspaceTurnMessage requires messageId");
    return record.deferredMessageIds?.includes(messageId) === true;
  }

  private async recoverTerminalWorkspaceTurnFromHistory(
    record: WorkspaceTurnTaskHandleRecord
  ): Promise<WorkspaceTurnTaskHandleRecord | null> {
    const historyResult = await this.historyService.getHistoryFromLatestBoundary(
      record.workspaceId
    );
    if (!historyResult.success) {
      log.warn("Workspace turn stale recovery could not read history", {
        handleId: record.handleId,
        workspaceId: record.workspaceId,
        error: historyResult.error,
      });
      return null;
    }

    const allowDeferredMessages = !(await this.hasActiveWorkspaceTurnDeferredBlockers(record));
    for (const message of historyResult.data.toReversed()) {
      if (this.isDeferredWorkspaceTurnMessage(record, message.id) && !allowDeferredMessages) {
        continue;
      }
      const event = this.buildWorkspaceTurnStreamEndEventFromHistory(record, message);
      if (event != null) {
        const supersedeEvidence = this.getQueueCutSupersedeEvidence(event, record, {
          activeStream: undefined,
          cutter: undefined,
          hasPendingQueuedOrPreparingTurn: false,
        });
        const correlation = this.getWorkspaceTurnMetadata(event);
        if (
          supersedeEvidence == null &&
          correlation != null &&
          this.hasSameTurnContinuation(event, correlation)
        )
          return null;
        return this.buildTerminalWorkspaceTurnRecordFromEvent(record, event, { supersedeEvidence });
      }
    }
    return null;
  }

  async markWorkspaceTurnStreamEndDeferred(event: StreamEndEvent): Promise<void> {
    const metadata = this.getWorkspaceTurnMetadata(event);
    if (metadata == null) {
      return;
    }
    await this.workspaceTurnSettlementLocks.withLock(metadata.taskHandleId, async () => {
      const record = await this.taskHandleStore.getWorkspaceTurn(
        metadata.ownerWorkspaceId,
        metadata.taskHandleId
      );
      if (
        record == null ||
        record.workspaceId !== event.workspaceId ||
        record.turnId !== metadata.turnId ||
        !this.isActiveWorkspaceTurn(record) ||
        this.isDeferredWorkspaceTurnMessage(record, event.messageId)
      ) {
        return;
      }
      await this.taskHandleStore.upsertWorkspaceTurn({
        ...record,
        updatedAt: getIsoNow(),
        deferredMessageIds: [...(record.deferredMessageIds ?? []), event.messageId],
      });
    });
  }

  resolveWorkspaceTurnMuxMetadataForStreamEnd(
    event: StreamEndEvent
  ): WorkspaceTurnMuxMetadata | undefined {
    const metadata = this.getWorkspaceTurnMetadata(event);
    if (metadata == null) {
      return undefined;
    }
    return {
      type: "workspace-turn-task",
      ...metadata,
    };
  }

  private isWorkspaceTurnAnchorForRecord(
    record: WorkspaceTurnTaskHandleRecord,
    message: HistoryControlRow
  ): boolean {
    const muxMetadata = message.metadata?.muxMetadata;
    if (!isPlainObject(muxMetadata)) return false;
    if (muxMetadata.type === "workspace-turn-task") {
      return (
        muxMetadata.taskHandleId === record.handleId &&
        muxMetadata.ownerWorkspaceId === record.ownerWorkspaceId &&
        muxMetadata.turnId === record.turnId
      );
    }
    if (muxMetadata.type === "compaction-summary" && isPlainObject(muxMetadata.pendingFollowUp)) {
      const preserved = muxMetadata.pendingFollowUp?.workspaceTurnMetadata;
      return (
        isPlainObject(preserved) &&
        preserved.taskHandleId === record.handleId &&
        preserved.ownerWorkspaceId === record.ownerWorkspaceId &&
        preserved.turnId === record.turnId
      );
    }
    return false;
  }

  private async interruptWorkspaceTurnFromUncorrelatedStreamEnd(
    event: StreamEndEvent
  ): Promise<boolean> {
    const active = this.activeWorkspaceTurnHandleByWorkspaceId.get(event.workspaceId);
    if (active == null) {
      return false;
    }
    const record = await this.taskHandleStore.getWorkspaceTurn(
      active.ownerWorkspaceId,
      active.handleId
    );
    if (record == null) {
      this.activeWorkspaceTurnHandleByWorkspaceId.delete(event.workspaceId);
      log.warn("Ignoring missing uncorrelated workspace turn stream-end handle", {
        workspaceId: event.workspaceId,
        taskHandleId: active.handleId,
      });
      return true;
    }
    if (record.workspaceId !== event.workspaceId) {
      log.warn("Ignoring out-of-scope uncorrelated workspace turn stream-end", {
        workspaceId: event.workspaceId,
        taskHandleId: record.handleId,
      });
      return false;
    }
    if (record.status !== "starting" && record.status !== "running") {
      this.activeWorkspaceTurnHandleByWorkspaceId.delete(event.workspaceId);
      return true;
    }

    const historyResult = await this.historyService.getControlEvidenceFromLatestBoundary(
      event.workspaceId
    );
    if (!historyResult.success) {
      log.warn("Could not compare uncorrelated stream-end history for workspace turn", {
        workspaceId: event.workspaceId,
        handleId: record.handleId,
        error: historyResult.error,
      });
      await this.settleWorkspaceTurnSupersededFromUncorrelatedStreamEnd(record, event, {
        kind: "uncorrelated-conservative-fallback",
        reason: "history-read-failed",
      });
      return true;
    }

    let streamEndIndex = -1;
    let turnAnchorIndex = -1;
    for (const [index, message] of historyResult.data.entries()) {
      if (message.id === event.messageId) {
        streamEndIndex = index;
      }
      if (this.isWorkspaceTurnAnchorForRecord(record, message)) {
        turnAnchorIndex = index;
      }
    }

    if (streamEndIndex === -1 || turnAnchorIndex === -1) {
      await this.settleWorkspaceTurnSupersededFromUncorrelatedStreamEnd(record, event, {
        kind: "uncorrelated-conservative-fallback",
        reason: streamEndIndex === -1 ? "missing-stream-end" : "missing-turn-anchor",
      });
      return true;
    }
    if (streamEndIndex < turnAnchorIndex) {
      log.debug("Ignoring stale uncorrelated stream-end before queued workspace turn prompt", {
        workspaceId: event.workspaceId,
        taskHandleId: record.handleId,
        streamEndMessageId: event.messageId,
      });
      return true;
    }

    const manualSupersessionInput = historyResult.data
      .slice(turnAnchorIndex + 1, streamEndIndex)
      .find(isManualChildWorkspaceInput);
    if (manualSupersessionInput) {
      // Readable JSON can still contain a malformed message ID. Preserve conservative
      // interruption without inventing manual evidence or letting corrupt history strand waiters.
      const messageId = manualSupersessionInput.id;
      await this.settleWorkspaceTurnSupersededFromUncorrelatedStreamEnd(
        record,
        event,
        typeof messageId === "string" && coerceNonEmptyString(messageId) != null
          ? { kind: "manual-supersession", messageId }
          : { kind: "uncorrelated-conservative-fallback", reason: "invalid-manual-input-id" }
      );
    }
    return true;
  }

  private async settleWorkspaceTurnSupersededFromUncorrelatedStreamEnd(
    record: WorkspaceTurnTaskHandleRecord,
    event: StreamEndEvent,
    cause: Extract<
      WorkspaceTurnSettlementCause,
      { kind: "manual-supersession" | "uncorrelated-conservative-fallback" }
    >
  ): Promise<void> {
    const error = "Workspace turn superseded by an uncorrelated workspace stream-end";
    const next: WorkspaceTurnTaskHandleRecord = {
      ...record,
      status: "interrupted",
      updatedAt: getIsoNow(),
      messageId: event.messageId,
      error,
    };
    delete next.deferredMessageIds;
    await this.settleWorkspaceTurn({
      cause,
      record,
      next,
      waiterSettlement: { status: "error", error: new Error(error) },
    });
  }

  private matchesWorkspaceTurnRecord(
    record: WorkspaceTurnTaskHandleRecord,
    value: unknown
  ): boolean {
    const correlation = this.getWorkspaceTurnMetadataFromValue(value);
    return (
      correlation?.taskHandleId === record.handleId &&
      correlation.ownerWorkspaceId === record.ownerWorkspaceId &&
      correlation.turnId === record.turnId
    );
  }

  /**
   * Whether a continuation of this exact delegated turn is pending or streaming.
   * Pending entries must carry the same correlation metadata as the ended stream.
   */
  private hasSameTurnContinuation(
    event: Pick<StreamEndEvent, "workspaceId" | "messageId">,
    correlation: { taskHandleId: string; ownerWorkspaceId: string; turnId: string }
  ): boolean {
    if (
      this.workspaceService.hasPendingWorkspaceTurnContinuation(event.workspaceId, {
        type: "workspace-turn-task",
        ...correlation,
      })
    ) {
      return true;
    }
    const activeStream = this.streamManager?.getStreamInfo(event.workspaceId, true);
    if (activeStream == null || activeStream.messageId === event.messageId) {
      return false;
    }
    const activeCorrelation = this.getWorkspaceTurnMetadataFromValue(activeStream.muxMetadata);
    return (
      activeCorrelation != null &&
      activeCorrelation.taskHandleId === correlation.taskHandleId &&
      activeCorrelation.ownerWorkspaceId === correlation.ownerWorkspaceId &&
      activeCorrelation.turnId === correlation.turnId
    );
  }

  /**
   * Attribution of the superseding queued input that cut this stream, when it
   * is still visible live: queued/preparing/dispatching/auto-retrying in the
   * child session, or already streaming as a different (uncorrelated) message.
   * Same-turn continuations were ruled out by the caller via
   * hasSameTurnContinuation.
   *
   * Fail toward notify: only a positively identified, causally engaged (or
   * tool-end queue-head) same-owner follow-up classifies as
   * "same_owner_follow_up"; every ambiguous source (no metadata, cross-owner
   * ancestor cutter, same-handle metadata, post-restart with in-memory queue
   * state gone) classifies as "other_input" and keeps today's notify behavior.
   *
   * Attribution reads come from a QueueCutAttributionSnapshot captured
   * synchronously with the stream-end event (see
   * captureQueueCutAttributionSnapshot) so inputs engaging during
   * handleStreamEnd's awaits cannot steal attribution from the real cutter.
   */
  captureQueueCutAttributionSnapshot(workspaceId: string): QueueCutAttributionSnapshot {
    const activeStream = this.streamManager?.getStreamInfo(workspaceId);
    return {
      activeStream:
        activeStream != null
          ? { messageId: activeStream.messageId, muxMetadata: activeStream.muxMetadata }
          : undefined,
      cutter: this.workspaceService.getQueueCutCutter(workspaceId),
      hasPendingQueuedOrPreparingTurn:
        this.workspaceService.hasPendingQueuedOrPreparingTurn(workspaceId),
    };
  }

  private getQueueCutSupersedeEvidence(
    event: StreamEndEvent,
    record: WorkspaceTurnTaskHandleRecord,
    snapshot: QueueCutAttributionSnapshot
  ): QueueCutSupersedeEvidence {
    const classifyMetadata = (muxMetadata: unknown): QueueCutSupersedeEvidence => {
      const successorHandleId = this.sameOwnerFollowUpHandleIdFromMetadata(record, muxMetadata);
      return successorHandleId != null
        ? { kind: "same_owner_follow_up", successorHandleId }
        : { kind: "other_input" };
    };
    const cause = event.metadata.stopCause;
    if (cause != null) {
      if (cause.kind !== "queued-input") return null;
      if (this.matchesWorkspaceTurnRecord(record, cause.muxMetadata)) return null;
      return classifyMetadata(cause.muxMetadata);
    }
    // Already streaming at the cut: the uncorrelated active stream is the
    // engaged cutter.
    const { activeStream, cutter } = snapshot;
    if (activeStream != null && activeStream.messageId !== event.messageId) {
      return classifyMetadata(activeStream.muxMetadata);
    }
    if (cutter?.stage === "preparing" || cutter?.stage === "dispatching") {
      // Engaged stages report even with undefined metadata (manual message) so
      // a same-owner follow-up queued BEHIND the engaged cutter cannot be
      // misattributed as the cause of this cut.
      return classifyMetadata(cutter.muxMetadata);
    }
    if (cutter?.stage === "queued") {
      // Only tool-end dispatch is the documented "cut the active turn now"
      // choice; a turn-end head did not cause this cut, so it stays generic.
      return cutter.dispatchMode === "tool-end"
        ? classifyMetadata(cutter.muxMetadata)
        : { kind: "other_input" };
    }
    // Residual legacy positives (e.g. hasPendingAutoRetry with an empty queue)
    // stay generic supersede evidence.
    return snapshot.hasPendingQueuedOrPreparingTurn ? { kind: "other_input" } : null;
  }

  /** Successor handle id when metadata correlates to a DIFFERENT handle of the same owner. */
  private sameOwnerFollowUpHandleIdFromMetadata(
    record: WorkspaceTurnTaskHandleRecord,
    muxMetadata: unknown
  ): string | undefined {
    const correlation = parseWorkspaceTurnTaskCorrelation(muxMetadata);
    return correlation != null &&
      correlation.ownerWorkspaceId === record.ownerWorkspaceId &&
      correlation.taskHandleId !== record.handleId
      ? correlation.taskHandleId
      : undefined;
  }

  /**
   * Same-owner follow-up that continues on this workspace at this stream end,
   * for disposable-ownership transfer. Unlike cut attribution
   * (getQueueCutSupersedeEvidence), dispatch mode is irrelevant here: a
   * turn-end follow-up never cuts, but it still dispatches once the
   * predecessor's stream ends naturally, so a completed predecessor's cleanup
   * would otherwise delete the workspace out from under it.
   */
  private findSameOwnerFollowUpForDisposableTransfer(
    event: StreamEndEvent,
    record: WorkspaceTurnTaskHandleRecord,
    snapshot: QueueCutAttributionSnapshot
  ): string | undefined {
    const { activeStream, cutter } = snapshot;
    if (activeStream != null && activeStream.messageId !== event.messageId) {
      return this.sameOwnerFollowUpHandleIdFromMetadata(record, activeStream.muxMetadata);
    }
    return cutter != null
      ? this.sameOwnerFollowUpHandleIdFromMetadata(record, cutter.muxMetadata)
      : undefined;
  }

  async finalizeWorkspaceTurnFromStreamEnd(
    event: StreamEndEvent,
    queueCutSnapshot: QueueCutAttributionSnapshot
  ): Promise<boolean> {
    const metadata = this.getWorkspaceTurnMetadata(event);
    if (metadata == null) {
      if (event.metadata.muxMetadata != null) {
        return false;
      }
      // Compaction turns are mechanical context operations, not new delegated
      // or user work: on-send compaction can consume a monitor-wake
      // continuation mid-turn, and its uncorrelated stream-end must not
      // supersede the still-running workspace turn (the wake continuation
      // re-inherits the correlation from the compaction summary afterwards).
      if (event.metadata.agentId === "compact") {
        return false;
      }
      return await this.interruptWorkspaceTurnFromUncorrelatedStreamEnd(event);
    }
    const record = await this.taskHandleStore.getWorkspaceTurn(
      metadata.ownerWorkspaceId,
      metadata.taskHandleId
    );
    if (record == null) {
      log.warn("Ignoring missing workspace turn stream-end handle", {
        workspaceId: event.workspaceId,
        taskHandleId: metadata.taskHandleId,
      });
      return true;
    }
    if (record.workspaceId !== event.workspaceId || record.turnId !== metadata.turnId) {
      log.warn("Ignoring out-of-scope workspace turn stream-end", {
        workspaceId: event.workspaceId,
        taskHandleId: metadata.taskHandleId,
      });
      return true;
    }
    if (this.isDeferredWorkspaceTurnMessage(record, event.messageId)) {
      return true;
    }
    // A context-budget final flush is housekeeping inside the delegated turn, never its outcome:
    // defer regardless of whether its paired continuation is still queued (a cleared queue must
    // not turn the notes-only finish into the task's completion; the next stream settles it).
    if (isContextBudgetFlushMetadata(event.metadata.muxMetadata)) {
      await this.markWorkspaceTurnStreamEndDeferred(event);
      return true;
    }

    // Check runtime state before history. A finishing successor commits history before it disappears.
    // Parent guidance and report wake-ups continue the exact delegated turn. This includes
    // turn-end guidance: don't publish an early report before the queued guidance runs.
    // Uncorrelated bash-monitor wakes inherit only an open tool-boundary continuation;
    // manual messages and /compact still supersede the old outcome.
    if (
      (event.metadata.finishReason === "tool-calls" ||
        event.metadata.finishReason === "stop" ||
        event.metadata.finishReason == null) &&
      (event.metadata.stopCause == null ||
        this.getQueueCutSupersedeEvidence(event, record, queueCutSnapshot) == null) &&
      (this.hasSameTurnContinuation(event, metadata) ||
        (event.metadata.finishReason === "tool-calls" &&
          this.workspaceService.hasPendingBashMonitorWakeContinuation(event.workspaceId)))
    ) {
      await this.markWorkspaceTurnStreamEndDeferred(event);
      return true;
    }

    if (
      event.metadata.finishReason === "tool-calls" &&
      (event.metadata.stopCause == null ||
        this.getQueueCutSupersedeEvidence(event, record, queueCutSnapshot) == null)
    ) {
      const history = await this.historyService.getHistoryFromLatestBoundary(event.workspaceId);
      if (history.success) {
        const index = history.data.findIndex((message) => message.id === event.messageId);
        if (index >= 0) {
          const successor = history.data
            .slice(index + 1)
            .findLast(
              (message) =>
                message.role === "assistant" &&
                this.matchesWorkspaceTurnRecord(record, message.metadata?.muxMetadata)
            );
          if (successor != null) {
            const successorEvent = this.buildWorkspaceTurnStreamEndEventFromHistory(
              record,
              successor
            );
            if (successorEvent != null) {
              return this.finalizeWorkspaceTurnFromStreamEnd(successorEvent, queueCutSnapshot);
            }
            await this.markWorkspaceTurnStreamEndDeferred(event);
            return true;
          }
        }
      }
    }

    const supersedeEvidence = this.getQueueCutSupersedeEvidence(event, record, queueCutSnapshot);
    const next = this.buildTerminalWorkspaceTurnRecordFromEvent(record, event, {
      supersedeEvidence,
    });
    // A same-owner follow-up continues on this workspace after this stream
    // end: transfer disposable ownership to the successor handle, so the
    // workspace is removed when the successor itself settles terminally. This
    // covers the quiet supersede (evidence-classified cut) AND a natural
    // completion with a follow-up queued in any dispatch mode — a turn-end
    // follow-up never cuts (deliberately not supersede evidence) but still
    // dispatches at this stream end and must not lose its workspace to this
    // settlement's cleanup. When the transfer fails (successor missing,
    // different workspace, or already terminal), the old record keeps
    // disposable ownership and today's settlement cleanup runs rather than
    // leaking the checkout.
    let disposableOwnershipTransferred = false;
    if (record.disposableWorkspace) {
      const disposableSuccessorHandleId =
        supersedeEvidence?.kind === "same_owner_follow_up"
          ? supersedeEvidence.successorHandleId
          : this.findSameOwnerFollowUpForDisposableTransfer(event, record, queueCutSnapshot);
      if (disposableSuccessorHandleId != null) {
        disposableOwnershipTransferred = await this.transferDisposableWorkspaceToSuccessor(
          record,
          disposableSuccessorHandleId
        );
      }
      if (disposableOwnershipTransferred) {
        next.disposableWorkspace = false;
      }
    }
    await this.settleWorkspaceTurn({
      cause: { kind: "correlated-stream-end" },
      record,
      next,
      waiterSettlement:
        next.status === "completed"
          ? { status: "completed", result: this.buildWorkspaceTurnWaitResult(next) }
          : { status: "error", error: new Error(next.error ?? "Workspace turn failed") },
      // This stream-end is strictly correlated (workspaceId + turnId), so it proves the
      // delegated turn's real outcome. A handle that settled interrupted/error from a
      // transient failure (provider error, restart) may have self-healed via auto-retry
      // of the same turn; let this settlement correct that stale record.
      // An intermediate stop cannot replace a concrete continuation failure.
      allowTerminalResettle:
        event.metadata.finishReason !== "tool-calls" ||
        (record.messageId === event.messageId &&
          record.finalMessage?.metadata?.finishReason === "tool-calls") ||
        (typeof event.metadata.historySequence === "number" &&
          typeof record.finalMessage?.metadata?.historySequence === "number" &&
          event.metadata.historySequence > record.finalMessage.metadata.historySequence),
      disposableOwnershipTransferred,
    });
    return true;
  }

  async finalizeWorkspaceTurnFromStreamAbort(event: StreamAbortEvent): Promise<boolean> {
    const active = this.activeWorkspaceTurnHandleByWorkspaceId.get(event.workspaceId);
    if (active == null) {
      return false;
    }
    const record = await this.taskHandleStore.getWorkspaceTurn(
      active.ownerWorkspaceId,
      active.handleId
    );
    if (record == null) {
      this.activeWorkspaceTurnHandleByWorkspaceId.delete(event.workspaceId);
      return true;
    }
    if (!this.isActiveWorkspaceTurn(record)) {
      this.activeWorkspaceTurnHandleByWorkspaceId.delete(event.workspaceId);
      return true;
    }
    if (event.abortReason !== "user") {
      return true;
    }
    const next: WorkspaceTurnTaskHandleRecord = {
      ...record,
      status: "interrupted",
      updatedAt: getIsoNow(),
    };
    await this.settleWorkspaceTurn({
      cause: { kind: "user-stream-abort" },
      record,
      next,
      waiterSettlement: { status: "error", error: new Error("Workspace turn interrupted") },
    });
    return true;
  }

  private async getActiveWorkspaceTurnRecordForWorkspace(
    workspaceId: string
  ): Promise<WorkspaceTurnTaskHandleRecord | null> {
    const active = this.activeWorkspaceTurnHandleByWorkspaceId.get(workspaceId);
    if (active != null) {
      const record = await this.taskHandleStore.getWorkspaceTurn(
        active.ownerWorkspaceId,
        active.handleId
      );
      if (record?.workspaceId === workspaceId && isActiveWorkspaceTurnTaskStatus(record.status)) {
        return record;
      }
      this.activeWorkspaceTurnHandleByWorkspaceId.delete(workspaceId);
    }

    const records = await this.taskHandleStore.listAllWorkspaceTurns({
      statuses: ["starting", "running"],
    });
    return records.toReversed().find((record) => record.workspaceId === workspaceId) ?? null;
  }

  async getActiveWorkspaceTurnMuxMetadataForWorkspace(
    workspaceId: string,
    options?: { requireAcceptedRegistration?: boolean }
  ): Promise<WorkspaceTurnMuxMetadata | undefined> {
    const candidate = await this.getActiveWorkspaceTurnRecordForWorkspace(workspaceId);
    if (candidate == null) {
      return undefined;
    }

    return await this.workspaceTurnSettlementLocks.withLock(candidate.handleId, async () => {
      const current = await this.taskHandleStore.getWorkspaceTurn(
        candidate.ownerWorkspaceId,
        candidate.handleId
      );
      const active = this.activeWorkspaceTurnHandleByWorkspaceId.get(workspaceId);
      if (
        current?.workspaceId !== workspaceId ||
        !isActiveWorkspaceTurnTaskStatus(current?.status)
      ) {
        if (
          active?.handleId === candidate.handleId &&
          active.ownerWorkspaceId === candidate.ownerWorkspaceId
        ) {
          this.activeWorkspaceTurnHandleByWorkspaceId.delete(workspaceId);
        }
        return undefined;
      }

      // Peer sends must not correlate with a turn whose send has not passed admission (a
      // creation-time reservation's requireIdle send can still fail) or with a stale persisted
      // record left by failed startup reconciliation: an attached correlation makes the peer
      // trigger's stream-end settle that unaccepted/stale owner handle as if the peer response
      // were the delegated task result. Family wakes keep the legacy behavior (correlating a
      // recovered delegated turn is how child reports continue it after restart).
      if (options?.requireAcceptedRegistration === true) {
        if (
          active?.handleId !== candidate.handleId ||
          active.ownerWorkspaceId !== candidate.ownerWorkspaceId ||
          !active.accepted
        ) {
          return undefined;
        }
      }

      return this.buildWorkspaceTurnMuxMetadata(current);
    });
  }

  // A queued report can defer the preceding stream-end. If dispatch then fails, settle that
  // exact turn here because no replacement stream-end can arrive.
  async settleWorkspaceTurnContinuationFailure(
    workspaceId: string,
    muxMetadata: WorkspaceTurnMuxMetadata,
    status: "interrupted" | "error",
    error: string
  ): Promise<void> {
    const record = await this.taskHandleStore.getWorkspaceTurn(
      muxMetadata.ownerWorkspaceId,
      muxMetadata.taskHandleId
    );
    if (
      record?.workspaceId !== workspaceId ||
      record?.turnId !== muxMetadata.turnId ||
      !isActiveWorkspaceTurnTaskStatus(record?.status)
    ) {
      return;
    }

    const next: WorkspaceTurnTaskHandleRecord = {
      ...record,
      status,
      updatedAt: getIsoNow(),
      error,
    };
    delete next.deferredMessageIds;
    await this.settleWorkspaceTurn({
      cause: { kind: "continuation-failure" },
      record,
      next,
      waiterSettlement: { status: "error", error: new Error(error) },
    });
  }

  private async hasRecoverableWorkspaceTurnRetryInFlight(
    workspaceId: string,
    errorMessageId: string,
    options: { requireAutoRetry: boolean }
  ): Promise<boolean> {
    const recoveryOutcome = await this.workspaceService.waitForPendingStreamErrorRecoveryDecision(
      workspaceId,
      errorMessageId
    );
    // The recorded per-attempt outcome survives a fast retry that already
    // finished streaming by the time this waiter (queued behind the workspace
    // event lock) runs; isStreaming alone would misread that success as
    // terminal.
    if (recoveryOutcome === "retry-started") {
      return true;
    }
    if (this.aiService.isStreaming(workspaceId)) {
      return true;
    }
    // Auto-retryable stream errors recover only through an actual scheduled
    // auto-retry. Unrelated queued manual messages must not keep the handle
    // running: they would start a different turn, leaving the parent awaiting a
    // turn that already failed (or settling it from an uncorrelated
    // stream-end).
    return options.requireAutoRetry
      ? this.workspaceService.hasPendingAutoRetry(workspaceId)
      : this.workspaceService.hasPendingQueuedOrPreparingTurn(workspaceId);
  }

  async finalizeWorkspaceTurnFromStreamError(event: ErrorEvent): Promise<boolean> {
    const record = await this.getActiveWorkspaceTurnRecordForWorkspace(event.workspaceId);
    if (record == null) {
      return false;
    }
    // Explicit in-session recovery cases (aborted, context_exceeded) may
    // continue through queued/preparing turns; auto-retryable errors require a
    // pending auto-retry of the same turn.
    const explicitRecovery =
      event.errorType != null && WORKSPACE_TURN_RECOVERABLE_STREAM_ERRORS.has(event.errorType);
    if (
      event.errorType != null &&
      isWorkspaceTurnRecoverableStreamError(event.errorType) &&
      (await this.hasRecoverableWorkspaceTurnRetryInFlight(record.workspaceId, event.messageId, {
        requireAutoRetry: !explicitRecovery,
      }))
    ) {
      return true;
    }
    const next: WorkspaceTurnTaskHandleRecord = {
      ...record,
      status: "error",
      updatedAt: getIsoNow(),
      error: event.error,
    };
    await this.settleWorkspaceTurn({
      cause: { kind: "terminal-stream-error" },
      record,
      next,
      waiterSettlement: { status: "error", error: new Error(event.error) },
    });
    return true;
  }

  async reconcileAgentTaskExecutionIds(): Promise<void> {
    const config = this.config.loadConfigOrDefault();
    let records: WorkspaceTurnTaskHandleRecord[];
    try {
      records = await this.taskHandleStore.listAllWorkspaceTurns();
    } catch (error: unknown) {
      // Startup initialization must be self-healing: inability to scan task handles should disable
      // this recovery pass, not prevent the application from starting.
      log.warn("Skipping persistent sub-agent execution reconciliation", { error });
      return;
    }

    interface TimestampedWorkspaceTurn {
      record: WorkspaceTurnTaskHandleRecord;
      updatedAtMs: number;
    }
    const timestampedRecords: TimestampedWorkspaceTurn[] = [];
    for (const record of records) {
      const updatedAtMs = Date.parse(record.updatedAt);
      const canonicalUpdatedAt = Number.isFinite(updatedAtMs)
        ? new Date(updatedAtMs).toISOString()
        : null;
      if (canonicalUpdatedAt !== record.updatedAt) {
        log.warn("Ignoring persistent sub-agent execution with invalid updatedAt", {
          handleId: record.handleId,
          workspaceId: record.workspaceId,
          updatedAt: record.updatedAt,
        });
        continue;
      }
      timestampedRecords.push({ record, updatedAtMs });
    }
    const recordsByHandleId = new Map(
      timestampedRecords.map((candidate) => [candidate.record.handleId, candidate])
    );
    const recordsByWorkspaceId = new Map<string, TimestampedWorkspaceTurn[]>();
    for (const candidate of timestampedRecords) {
      const workspaceRecords = recordsByWorkspaceId.get(candidate.record.workspaceId) ?? [];
      workspaceRecords.push(candidate);
      recordsByWorkspaceId.set(candidate.record.workspaceId, workspaceRecords);
    }

    for (const task of this.taskHost.listAgentTaskExecutionEntries(config)) {
      if (task.id == null) continue;
      try {
        const candidates = recordsByWorkspaceId.get(task.id) ?? [];
        const referenced =
          task.taskExecutionId != null ? recordsByHandleId.get(task.taskExecutionId) : undefined;
        // Recover the crash window where the handle record became durable before the stable child
        // pointer. Invalid timestamps are ignored so corrupt records cannot outrank active work.
        const latestCandidate = candidates.reduce<TimestampedWorkspaceTurn | undefined>(
          (latest, candidate) => {
            if (latest == null) return candidate;
            return candidate.updatedAtMs > latest.updatedAtMs ? candidate : latest;
          },
          undefined
        );
        const selected =
          referenced == null
            ? latestCandidate
            : latestCandidate != null && latestCandidate.updatedAtMs > referenced.updatedAtMs
              ? latestCandidate
              : referenced;
        const record = selected?.record;
        if (record == null) {
          await this.clearUnbackedAgentTaskExecutionMirror(task.id, task.taskExecutionId, config);
          continue;
        }

        let normalized: WorkspaceTurnTaskHandleRecord | null;
        try {
          normalized = await this.normalizeWorkspaceTurnRecord(record);
        } catch (error: unknown) {
          log.warn("Failed to reconcile persistent sub-agent execution", {
            taskId: task.id,
            handleId: record.handleId,
            error,
          });
          continue;
        }
        if (normalized?.workspaceId !== task.id) {
          await this.clearUnbackedAgentTaskExecutionMirror(task.id, task.taskExecutionId, config);
          continue;
        }

        if (isActiveWorkspaceTurnTaskStatus(normalized.status)) {
          const taskId = task.id;
          let claimed: boolean;
          try {
            claimed = await this.desktopInputCoordinator.withAdmission(taskId, () =>
              this.persistAgentTaskExecutionState(
                taskId,
                normalized.handleId,
                normalized.status,
                true,
                task.taskExecutionId
              )
            );
          } catch (error) {
            // Both durable activity sources must settle: leaving the pre-restart execution mirror
            // active would reserve the desktop even after TaskService interrupts the task.
            const message = getErrorMessage(error);
            await this.settleWorkspaceTurn({
              cause: { kind: "recovery-admission-failure" },
              record: normalized,
              next: { ...normalized, status: "error", updatedAt: getIsoNow(), error: message },
              waiterSettlement: { status: "error", error: new Error(message) },
            });
            continue;
          }
          if (!claimed) continue;
        } else {
          await this.taskHost.editWorkspaceEntry(
            task.id,
            (workspace) => {
              workspace.taskExecutionId = normalized.handleId;
              workspace.taskExecutionStatus = normalized.status;
            },
            { allowMissing: true }
          );
          await this.taskHost.emitWorkspaceMetadata(task.id);
        }
        if (isActiveWorkspaceTurnTaskStatus(normalized.status)) {
          this.activeWorkspaceTurnHandleByWorkspaceId.set(task.id, {
            handleId: normalized.handleId,
            ownerWorkspaceId: normalized.ownerWorkspaceId,
            // Fail closed: the restart killed any live stream, so this recovered registration
            // exists for settlement ownership, not peer admission. A revival or a fresh
            // acceptance re-marks the entry accepted.
            accepted: false,
          });
        }
      } catch (error: unknown) {
        // Startup recovery is best-effort: one read-only/corrupt child must not prevent Xum startup
        // or block reconciliation of the remaining persistent children.
        log.warn("Failed to persist persistent sub-agent execution reconciliation", {
          taskId: task.id,
          handleId: task.taskExecutionId,
          error,
        });
      }
    }
  }

  /**
   * Startup repair for an execution mirror with no backing handle record. With an ID the normal
   * generation-guarded clear applies. Without one, the mirror is an orphan: every settlement path
   * matches on taskExecutionId, so a stray active taskExecutionStatus could never settle — yet the
   * desktop ledger reads it as live control of the owner's desktop. Only the mirror is dropped;
   * the stable taskStatus is a separate activity source owned by TaskService recovery.
   */
  private async clearUnbackedAgentTaskExecutionMirror(
    workspaceId: string,
    taskExecutionId: string | undefined,
    snapshot: ReturnType<Config["loadConfigOrDefault"]>
  ): Promise<void> {
    if (taskExecutionId != null) {
      await this.updateAgentTaskExecutionState(workspaceId, taskExecutionId, null);
      return;
    }
    // Decide from the startup snapshot so the common no-mirror case costs no config reload
    // (initialize must not re-read config.json per completed-report task).
    if (findWorkspaceEntry(snapshot, workspaceId)?.workspace.taskExecutionStatus == null) {
      return;
    }
    let clearedOrphan = false;
    await this.taskHost.editWorkspaceEntry(
      workspaceId,
      (workspace) => {
        if (workspace.taskExecutionId != null || workspace.taskExecutionStatus == null) return;
        delete workspace.taskExecutionStatus;
        clearedOrphan = true;
      },
      { allowMissing: true }
    );
    if (clearedOrphan) {
      await this.taskHost.emitWorkspaceMetadata(workspaceId);
    }
  }

  async updateAgentTaskExecutionState(
    workspaceId: string,
    handleId: string,
    status: WorkspaceTurnTaskStatus | null
  ): Promise<void> {
    if (status != null && isActiveWorkspaceTurnTaskStatus(status)) {
      await this.desktopInputCoordinator.withAdmission(workspaceId, () =>
        this.persistAgentTaskExecutionState(workspaceId, handleId, status)
      );
    } else {
      await this.persistAgentTaskExecutionState(workspaceId, handleId, status);
    }
  }

  private async persistAgentTaskExecutionState(
    workspaceId: string,
    handleId: string,
    status: WorkspaceTurnTaskStatus | null,
    allowNewExecution = false,
    reconciledPreviousExecutionId?: string
  ): Promise<boolean> {
    // editWorkspaceEntry reports `updated` for a mere existing workspace, so a queued/stale
    // handle B settling must not count as settlement for the DIFFERENT live handle A the mirror
    // points at — track whether the matching mirror was actually mutated.
    let settledMatchingMirror = false;
    let claimedActiveMirror = false;
    const updated = await this.taskHost.editWorkspaceEntry(
      workspaceId,
      (workspace, config) => {
        if (status == null) {
          if (workspace.taskExecutionId === handleId) {
            delete workspace.taskExecutionId;
            delete workspace.taskExecutionStatus;
            settledMatchingMirror = true;
          }
          return;
        }
        if (isActiveWorkspaceTurnTaskStatus(status)) {
          const live = this.activeWorkspaceTurnHandleByWorkspaceId.get(workspaceId);
          // A delayed acceptance/recovery callback must not steal a newer continuation's mirror.
          if (live != null && live.handleId !== handleId) return;
          if (live == null) {
            if (
              !allowNewExecution &&
              (workspace.taskExecutionId !== handleId ||
                !isActiveWorkspaceTurnTaskStatus(workspace.taskExecutionStatus))
            )
              return;
            if (
              workspace.taskExecutionId !== handleId &&
              isActiveWorkspaceTurnTaskStatus(workspace.taskExecutionStatus) &&
              // Startup's timestamp-selected successor may replace the pointer it actually read,
              // but never a different continuation published while reconciliation was suspended.
              (reconciledPreviousExecutionId == null ||
                workspace.taskExecutionId !== reconciledPreviousExecutionId)
            )
              return;
          }
          claimedActiveMirror = true;
          workspace.taskExecutionId = handleId;
          workspace.taskExecutionStatus = status;
          // Cross-process/independent writes can land between the desktop gate's admission check
          // and this transform. Re-validate against the config this transaction actually
          // commits so a competing controller published meanwhile rejects the active mirror
          // (terminal/clear branches stay ungated: releasing must always be allowed).
          this.desktopInputCoordinator.assertAdmission(config, workspaceId);
          return;
        }
        if (workspace.taskExecutionId === handleId) {
          workspace.taskExecutionStatus = status;
          settledMatchingMirror = true;
        }
      },
      { allowMissing: true }
    );
    if (updated) {
      // A settled MATCHING execution mirror is authoritative settlement: any stop latch
      // retained for an unconfirmed stop of this workspace has been superseded and must be
      // released — holding it past settlement would bar the workspace from peer messaging
      // until restart. A non-matching handle settling leaves the live execution unrefuted, so
      // its latch must stay.
      //
      // Remove the matching live registration BEFORE releasing (synchronously, in the same
      // tick): Config.saveConfig swallows write failures, so `updated` does not prove the
      // terminal mirror reached disk — a peer admission probe reading a stale running mirror
      // between this release and the caller's own guarded registration delete would otherwise
      // still find an accepted live handle and escape the stop. Without the registration,
      // hasLiveRunningExecution refuses regardless of what the on-disk mirror claims. Callers'
      // later guarded deletes simply no-op.
      if (settledMatchingMirror) {
        const live = this.activeWorkspaceTurnHandleByWorkspaceId.get(workspaceId);
        if (live?.handleId === handleId) {
          this.activeWorkspaceTurnHandleByWorkspaceId.delete(workspaceId);
        }
        this.taskHost.releaseRetainedStopLatches(workspaceId);
      }
      await this.taskHost.emitWorkspaceMetadata(workspaceId);
    }
    return claimedActiveMirror || settledMatchingMirror;
  }
}

import * as path from "path";
import * as fs from "fs/promises";
import writeFileAtomic from "write-file-atomic";
import assert from "@/common/utils/assert";
import {
  toGoalSnapshot,
  toPendingGoalSnapshot,
  toValidGoalId,
  type GoalHistoryEndReason,
  type GoalHistoryEntry,
  type GoalRecordV1,
  type GoalSetError,
  type GoalSnapshot,
  type GoalStatus,
} from "@/common/types/goal";
import type { WorkspaceActivitySnapshot } from "@/common/types/workspace";
import type { Workspace } from "@/common/types/project";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import {
  GoalBoardV1Schema,
  GoalHistoryEntrySchema,
  GoalRecordV1Schema,
} from "@/common/orpc/schemas/goal";
import type { GoalBoardEntry, GoalBoardSnapshot, GoalBoardV1 } from "@/common/types/goal";
import {
  createMuxMessage,
  isSyntheticSnapshotUserMessage,
  pickStartupRetrySendOptions,
} from "@/common/types/message";
import type { ProvidersConfigMap, SendMessageOptions } from "@/common/orpc/types";
import { isWorkspaceArchived } from "@/common/utils/archive";
import {
  hasBudgetedResumableGoal,
  modelHasPricingData,
  normalizeGoalBudgetCents,
  UNPRICED_TARGET_MODEL_GOAL_MESSAGE,
} from "@/common/utils/goals/budgetPricing";
import type { SendMessageError } from "@/common/types/errors";
import { ProvidersConfigStore, type Config } from "@/node/config";
import type { HistoryService } from "@/node/services/historyService";
import type { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";
import {
  DEFAULT_GOAL_CONTINUATION_COOLDOWN_MS,
  GOAL_BUDGET_LIMIT_KIND,
  GOAL_CONTINUATION_IDLE_CONSUMER_NAME,
  GOAL_CONTINUATION_IDLE_CONSUMER_PRIORITY,
  GOAL_CONTINUATION_KIND,
  type GoalSyntheticMessageKind,
} from "@/constants/goals";
import { buildGoalBudgetLimitMessage, buildGoalContinuationMessage } from "@/constants/goalPrompts";
import type { IdleDispatcher, IdleDispatchPayload } from "./idleDispatcher";
import { log } from "./log";
import { NOOP_TIMELINE_RECORDER, type TimelineRecorder } from "./timelineRecorder";
import {
  applyBudgetDrivenStatus,
  evaluateGoalContinuationBeforeGoal,
  evaluateGoalContinuationGoal,
  getGoalCostMicroCents,
  hasReachedGoalBudgetLimit,
  hasReachedGoalTurnLimit,
  isBudgetWrapupEligibleOrigin,
  MICRO_CENTS_PER_CENT,
  type GoalContinuationDecision,
  type GoalContinuationPolicyProbe,
  type GoalContinuationSkipReason,
  type GoalStreamOriginKind,
} from "./goalContinuationPolicy";

const GOAL_FILE = "goal.json";
const GOAL_BOARD_FILE = "goal-board.json";
const PENDING_GOAL_EDIT_MESSAGE =
  "Goal is still being saved. Wait for the current stream to finish before editing it.";
const GOAL_SET_DISCARDED_BY_USER_STOP_MESSAGE =
  "Goal change discarded: the stream was stopped while this change was in flight.";
const REPLACE_GUARDED_STATUSES: ReadonlySet<GoalStatus> = new Set([
  "active",
  "budget_limited",
  "paused",
]);

const GOAL_HISTORY_FILE = "goal-history.jsonl";
// Cap the number of history entries returned to the renderer. Goal lifecycles
// are coarse-grained (one entry per clear / replace / mark-complete) so a
// generous cap still keeps the response payload bounded; older entries remain
// on disk in the JSONL but are simply not surfaced to the UI.
const GOAL_HISTORY_RENDER_CAP = 200;

function costUsdToMicroCents(costUsd: number | null | undefined): number {
  return Math.max(0, Math.round((costUsd ?? 0) * 100 * MICRO_CENTS_PER_CENT));
}

type GoalLifecycleEvent =
  | "goal_created"
  | "goal_replaced"
  | "goal_cleared"
  | "goal_paused"
  | "goal_resumed"
  | "goal_completed"
  | "goal_budget_changed"
  | "goal_budget_limited"
  | "goal_continuation_fired"
  | "goal_wrapup_fired"
  | "goal_crash_gate_set";

type GoalLifecycleProperties = Record<string, string | number | boolean | null>;
type GoalLifecycleInitiator = "user" | "model" | "auto";

export interface GoalLifecycleAnalyticsSink {
  recordGoalLifecycleEvent(event: GoalLifecycleEvent, properties: GoalLifecycleProperties): void;
}

interface SetGoalReplacementGuard {
  replaceExistingGoal?: boolean | null;
  expectedGoalId?: string | null;
}

export interface SetGoalInput {
  workspaceId: string;
  objective?: string | null;
  status?: GoalStatus | null;
  budgetCents?: number | null;
  turnCap?: number | null;
  completionSummary?: string | null;
  expectedGoalId?: string | null;
  /**
   * Internal model-tool guard for replacing active-like goals. It is checked
   * under the goal file lock so stale pre-reads cannot authorize a replace.
   */
  replacementGuard?: SetGoalReplacementGuard | null;
  requireUserAcknowledgmentSinceMs?: number | null;
  initiator?: GoalLifecycleInitiator;
  /**
   * Internal model-tool path: treat an objective payload as "start a new goal"
   * even when the objective text matches the current goal.
   */
  forceNewGoal?: boolean | null;
  /**
   * When true and a current goal already exists, an objective update mutates
   * the existing record in place (preserving goalId + accounting) instead of
   * archiving + replacing. See the matching field on the public
   * `GoalSetInputSchema` for the rationale.
   */
  editInPlace?: boolean | null;
}

export type { GoalStreamOriginKind } from "./goalContinuationPolicy";

export interface GoalContinuationRuntimeState {
  isInitializing?: boolean;
  isRuntimeCompatible?: boolean;
  isBusy?: boolean;
  hasQueuedMessages?: boolean;
  hasPendingFollowUp?: boolean;
}

export interface GoalContinuationRuntimeBridge {
  hasActiveDescendantTasks(workspaceId: string): boolean;
  getRuntimeState(workspaceId: string): GoalContinuationRuntimeState;
  executeGoalContinuation(input: {
    workspaceId: string;
    message: string;
    options: SendMessageOptions;
    startStreamInBackground?: boolean;
    kind?: GoalSyntheticMessageKind;
    /** Stamped on the synthetic user row so chat-tail reconciliation can scope it to this goal. */
    goalId?: string;
    /**
     * Codex P1 (PRRT_kwDOPxxmWM6cOgXR): re-evaluated through the send's
     * admission gates up to the last gate before the pre-turn batch becomes
     * irrevocable. An explicit Pause completing during the send preflight
     * (pricing/settings/history awaits) flips this stale, refusing the
     * captured continuation instead of landing its row after the pause
     * boundary as fresh active evidence.
     */
    admissionStale?: () => boolean;
  }): Promise<boolean>;
  /**
   * Build default SendMessageOptions for a kickoff continuation that is armed
   * outside of a stream-end (e.g. when the user resumes a paused goal on an
   * idle workspace). Returns null when defaults can't be derived.
   */
  getKickoffSendOptions?(workspaceId: string): Promise<SendMessageOptions | null>;
}

type PendingGoalContinuationSource = "stream_end" | "kickoff" | "budget_wrapup";

export interface PendingGoalContinuationCandidate {
  goalId: string;
  requestedAtMs: number;
  streamEndedAtMs: number;
  source: PendingGoalContinuationSource;
  sendOptions: SendMessageOptions;
}

interface GoalPersistenceOptions {
  replacementGoalId?: string | null;
  replacementCreatedAtMs?: number | null;
  /**
   * When provided, persistence re-checks the user-stop generation after every
   * await preceding a durable write and discards the mutation if a stop landed
   * (Codex P1 PRRT_kwDOPxxmWM6cClKV). Only the direct setter path passes this;
   * the stream-end drain relies on `recordUserStoppedStream` deleting pending
   * mutations before the drain claims them.
   */
  userStopGate?: { generationAtEntry: number };
}

/**
 * Defensive validation for persisted timestamps: chat.jsonl rows are unchecked
 * JSON, so metadata numbers can arrive malformed (negative, NaN, or a string
 * masquerading through a cast). Only finite non-negative numbers participate
 * in goal-safety comparisons; everything else is treated as absent.
 */
function toValidEpochMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

interface ChatTailGoalModeResult {
  mode: "active" | "paused" | null;
  /**
   * Why the tail resolved to paused: an explicit `goal-pause-boundary` row vs
   * an ordinary manual user row. Reconciliation uses this to distinguish an
   * explicit pause from the implicit "no continuation appended yet" state of a
   * freshly armed kickoff (see `applyChatTailGoalMode`).
   */
  pausedBy?: "pause_boundary" | "manual_user";
  /**
   * When `pausedBy === "pause_boundary"`: true when the boundary row carried a
   * goalId matching the reconciled goal. Scoped boundaries are only appended
   * AFTER their pause persisted durably, so a durably ACTIVE goal beneath a
   * matching scoped boundary proves a later Resume — reconciliation must not
   * let the stale boundary undo it. Legacy unscoped boundaries keep the old
   * any-goal semantics (Codex P2 PRRT_kwDOPxxmWM6cLpIT).
   */
  boundaryGoalScoped?: boolean;
  /**
   * When `pausedBy === "manual_user"`: the moment the user authored the pausing
   * row — its persisted enqueue time (queued sends) or the row timestamp.
   * Reconciliation compares this against the goal's explicit user-activation
   * consent stamp (`lastUserActivationAtMs`) to tell rows the user visibly
   * left pending while activating the goal (must not pause a never-driven
   * goal) from genuine interventions (must pause even if the dispatch-time
   * auto-pause was lost to a crash). Codex security P2 PRRT_kwDOPxxmWM6cSGrq:
   * `createdAtMs` is deliberately NOT the anchor — a model publishing a goal
   * after a queued correction would grandfather its autonomy past it.
   */
  manualRowAuthoredAtMs?: number;
  /**
   * When `pausedBy === "manual_user"`: true when a COMPLETED assistant row
   * immediately follows the manual row, i.e. the turn that consumed the row
   * settled. In the kickoff window this identifies the goal-creating turn's
   * own initiating prompt (that turn PRODUCED the goal, so the row is not an
   * unprocessed intervention); an unprocessed or queue-dispatched intervention
   * is the tail's final row and stays false.
   */
  manualRowProcessed?: boolean;
  /**
   * `explicitPauseGenerations` value captured BEFORE the history read that
   * produced this evidence. Tail reads run outside the goal file lock, so an
   * explicit Pause can fully commit (durable write, boundary append, hold
   * release) between the read and the locked apply — "tail says active"
   * evidence from before that Pause must not reactivate the paused goal
   * (Codex P1 PRRT_kwDOPxxmWM6cMQqq).
   */
  pauseGenerationAtRead: number;
}

interface GoalContinuationEligibilityResult {
  eligible: boolean;
  reason?: GoalContinuationSkipReason;
  goal?: GoalRecordV1;
  candidate?: PendingGoalContinuationCandidate;
  lastStreamStamp?: GoalStreamStamp;
  deferUntilMs?: number;
}

interface PendingGoalMutation {
  objective: string;
  budgetCents?: number | null;
  turnCap?: number | null;
  status?: GoalStatus | null;
  completionSummary?: string | null;
  expectedGoalId?: string | null;
  replacementGuard?: SetGoalReplacementGuard | null;
  initiator?: GoalLifecycleInitiator;
  forceNewGoal?: boolean | null;
  /** Stable id for the optimistic record returned before the deferred write drains. */
  projectedGoalId?: string | null;
  /**
   * Stream-start generation at install time. A drain claims only mutations
   * belonging to the stream it settles: an un-awaited provider-error drain
   * overlapping an automatic retry must not claim a set_goal installed by the
   * retry stream — persisting it early would archive/replace the goal before
   * the retry's accounting and outlive a later user abort meant to discard it
   * (Codex P1 PRRT_kwDOPxxmWM6cJ6M-).
   */
  streamStartGeneration?: number;
  /**
   * Creation time of the optimistic record. The drain re-creates the durable
   * goal, but the user could already see (and react to) the projected goal
   * mid-stream — a later stream-end `createdAtMs` would misclassify a queued
   * intervention as pre-goal input (Codex P1).
   */
  projectedCreatedAtMs?: number | null;
  /**
   * Carries the caller's `editInPlace` intent across mid-stream deferral so
   * a queued rename preserves goalId + accounting when it drains.
   */
  editInPlace?: boolean | null;
}

interface GoalStreamStamp {
  originKind: GoalStreamOriginKind;
  sequence: number;
  goalId: string | null;
}

interface StreamAccountingInput {
  workspaceId: string;
  /** Total cost attributable to this stream from start (cumulative for previews, final for records). */
  costUsd?: number | null;
  isCompaction?: boolean;
  streamStartedAtMs?: number | null;
  streamOriginKind?: GoalStreamOriginKind;
}

export interface ChildReportAttributionInput {
  parentWorkspaceId: string;
  childWorkspaceId: string;
  childCostCents: number;
}

export interface ChildReportAttributionResult {
  goalBefore: GoalRecordV1;
  goalAfter: GoalRecordV1;
  attributed: boolean;
  causedBudgetLimit: boolean;
}

function skippedChildAttribution(goal: GoalRecordV1): ChildReportAttributionResult {
  return {
    goalBefore: goal,
    goalAfter: goal,
    attributed: false,
    causedBudgetLimit: false,
  };
}

export class WorkspaceGoalChildWorkspaceError extends Error {
  readonly code = "GOAL_CHILD_WORKSPACE";

  constructor(workspaceId: string) {
    super(
      `Workspace ${workspaceId} is a child task workspace. Goals can only be set on parent workspaces.`
    );
    this.name = "WorkspaceGoalChildWorkspaceError";
  }
}

export class WorkspaceGoalTransitionError extends Error {
  readonly code = "GOAL_INVALID_TRANSITION";

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceGoalTransitionError";
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function lengthBucket(length: number): string {
  if (length < 10) return "0-9";
  if (length < 50) return "10-49";
  if (length < 100) return "50-99";
  return "100+";
}

function centsBucket(cents: number): string {
  if (cents === 0) return "0";
  if (cents < 100) return "1-99";
  if (cents < 1_000) return "100-999";
  return "1000+";
}

function countBucket(count: number): string {
  if (count === 0) return "0";
  if (count < 10) return "1-9";
  if (count < 100) return "10-99";
  return "100+";
}

/**
 * Local helper kept bare-decimal because the only call site (clear summary)
 * embeds it in a template literal that already supplies the `$` prefix.
 * Distinct from the shared `formatGoalCents` in `budgetPricing.ts` (which is
 * dollar-prefixed); callers that want the prefixed form must import from
 * there rather than defining a local copy.
 */
function formatCentsBare(cents: number): string {
  return (cents / 100).toFixed(2);
}

function actionForStatus(status: GoalStatus): "pause" | "resume" | "complete" {
  if (status === "active") {
    return "resume";
  }
  if (status === "complete") {
    return "complete";
  }
  return "pause";
}

function completionSummaryPatch(
  status: GoalStatus | null | undefined,
  completionSummary: string | null
): Pick<GoalRecordV1, "completionSummary"> | Record<string, never> {
  if (status === "complete" && completionSummary != null) {
    return { completionSummary };
  }
  if (status != null && status !== "complete") {
    return { completionSummary: undefined };
  }
  return {};
}

/**
 * Whitelist the model/agent configuration carried into synthetic continuations.
 *
 * The prior turn's full `SendMessageOptions` may carry payload-adjacent fields
 * (e.g. attachments at the IPC boundary, edit/correlation ids, mux metadata)
 * that should never be re-sent on auto-continuations:
 *  - re-sending attachments inflates cost and can hit per-request limits.
 *  - replaying `editMessageId` / `acpPromptId` / `muxMetadata` retargets the
 *    synthetic message at the wrong turn or breaks ACP correlation.
 *
 * `pickStartupRetrySendOptions` already encodes the canonical whitelist used
 * for crash-recovery retries, so reuse it here.
 */
function continuationSendOptions(sendOptions: SendMessageOptions): SendMessageOptions {
  const options: SendMessageOptions = {
    ...pickStartupRetrySendOptions(sendOptions),
    allowAgentSetGoal: undefined,
  };
  // Startup retries preserve workspace-turn correlation, but goal continuations start a new turn.
  delete options.muxMetadata;
  return options;
}

export interface WorkspaceGoalServiceOptions {
  /** Override interactive continuation cooldown; CLI goal runs use 0 to drive immediately. */
  continuationCooldownMs?: number;
  /** Allow CLI kickoff turns to receive the same budget-limit wrap-up as continuations. */
  allowUserOriginBudgetWrapup?: boolean;
  /** Prevent setGoal from queuing an automatic kickoff when the CLI sends its own message. */
  suppressKickoffContinuation?: boolean;
}

export class WorkspaceGoalService {
  private readonly fileLocks = workspaceFileLocks;
  private readonly continuationCooldownMs: number;
  private readonly allowUserOriginBudgetWrapup: boolean;
  private readonly suppressKickoffContinuation: boolean;
  private readonly pendingGoalMutations = new Map<string, PendingGoalMutation>();
  private readonly pendingGoalSnapshots = new Map<string, GoalSnapshot>();
  private readonly liveGoalPreviewSnapshots = new Map<string, GoalSnapshot>();

  private pendingContinuationCandidates = new Map<string, PendingGoalContinuationCandidate>();
  private continuationReRequestTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastUserStopAtMsByWorkspace = new Map<string, number>();
  /**
   * Monotonic per-workspace user-stop counter, bumped synchronously by
   * `recordUserStoppedStream`. Setters capture it at entry and treat any
   * change as "a stop landed while I was in flight" (Codex P1
   * PRRT_kwDOPxxmWM6cClKV). The timestamp map above cannot serve this role:
   * two stops in the same millisecond compare equal, and user-resume /
   * promotion paths DELETE the timestamp, which a `!==` comparison would
   * misread as a fresh stop and falsely discard an unrelated in-flight setter.
   */
  private readonly userStopGenerationsByWorkspace = new Map<string, number>();
  /**
   * Stops whose acknowledgment write has not committed yet. Codex security P2
   * (PRRT_kwDOPxxmWM6cS7qG): `recordUserStoppedStream` bumps the stop
   * generation BEFORE awaiting the goal lock, so a redispatch admission built
   * inside that window captures the post-Stop generation as its fresh
   * baseline while reading the pre-Stop active record — and the later
   * active→active acknowledgment write moves no generation. While a Stop is
   * in flight, admissions must refuse outright; once the acknowledgment
   * commits, the durable `requireUserAcknowledgmentSinceMs` gate takes over.
   */
  private readonly pendingStopAcknowledgmentCounts = new Map<string, number>();
  private recordedStreamStartedAtMsByWorkspace = new Map<string, number>();
  private lastGoalStreamStamps = new Map<string, GoalStreamStamp>();
  /**
   * Monotonic per-workspace stream-end drain counter. Bumped when
   * `applyPendingAfterStreamEnd` starts and again when it exits, so a queued
   * setGoal can detect that a drain ran while it was in flight and must not
   * install a pending mutation nothing will drain (Codex P2
   * PRRT_kwDOPxxmWM6cBr9Q).
   */
  private readonly streamEndDrainGenerations = new Map<string, number>();
  /**
   * Highest stream-start generation any drain bump above was acting for
   * (recorded with max semantics at both drain entry and exit). A drain bump
   * only forces an in-flight setter onto the direct-persistence path when the
   * bumping drain was settling the setter's own stream (or a newer one): an
   * old un-awaited error drain exiting while a retry stream is live must not
   * push the retry's setters past the deferral — the mutation they queue is
   * stamped with the retry's generation and claimed by the retry's own drain
   * (Codex P1 PRRT_kwDOPxxmWM6cLA0R).
   */
  private readonly lastDrainStreamStartGenerations = new Map<string, number>();
  /**
   * Workspaces whose last stream has ended and fully drained (or was user
   * stopped, which skips the drain). The extension-metadata streaming flag
   * clears asynchronously after stream end, so setters admitted after the
   * drain's final empty-map check could otherwise still read a stale "live"
   * flag and install a mutation nothing will drain (Codex P2
   * PRRT_kwDOPxxmWM6cCH_L). Cleared when the next stream start is recorded.
   */
  private readonly drainSettledWorkspaces = new Set<string>();

  /**
   * workspaceId → goalId whose pause finalization is in flight (armed under
   * the goal file lock alongside the durable paused write, released after
   * `finalizeGoalPersistence` returns). Between the paused write and the
   * finalizer's boundary append the chat tail still ends at this goal's own
   * continuation row, so a concurrent getGoal reconciliation would flip the
   * goal back to active — making the finalizer's identity guard bail and skip
   * the candidate delete + boundary append while the Pause call reports a
   * stale paused result (Codex P1 PRRT_kwDOPxxmWM6cIyKW). While the hold is
   * set, chat-tail reconciliation must not reactivate the held goal; genuine
   * user mutations (resume, replacement) write through setGoal and are
   * unaffected, so a newer user action still wins over the pause.
   */
  private readonly pauseFinalizationHolds = new Map<string, { goalId: string; depth: number }>();

  /**
   * Monotonic per-workspace count of explicit pause admissions, bumped under
   * the goal file lock alongside each durable paused write (wherever the
   * pause-finalization hold is armed). Chat-tail reads stamp the value they
   * captured before their history I/O; automatic paused→active writers
   * (`applyChatTailGoalMode`, `recordContinuationFired`) refuse when the
   * generation moved since — the "tail says active" evidence predates an
   * explicit Pause and must not undo it (Codex P1 PRRT_kwDOPxxmWM6cMQqq).
   * Reconciliation pauses do not bump it, preserving the kickoff-window
   * auto-flip recovery.
   */
  private readonly explicitPauseGenerations = new Map<string, number>();

  /**
   * Codex P1 (PRRT_kwDOPxxmWM6cPBWd, PRRT_kwDOPxxmWM6cPBWX): monotonic
   * per-workspace count of durable writes that commit a `complete` or
   * `budget_limited` record, bumped inside `writeGoal` (the single goal.json
   * write choke point, so every path — direct setters, drained mutations,
   * accounting flips, child attribution, wrap-up suppression — is counted).
   * Continuation/wrap-up dispatch admission probes capture it at dispatch
   * entry: a same-goal terminal transition committing during the send
   * preflight neither deletes the candidate nor bumps the pause generation,
   * so without this the captured send would be admitted against a completed
   * goal or in place of (or despite the suppression of) the budget wrap-up.
   * Over-counting is safe: a refused send re-requests dispatch and
   * eligibility re-derives the correct action from durable state.
   */
  private readonly terminalStatusGenerations = new Map<string, number>();

  /**
   * Codex P1 (PRRT_kwDOPxxmWM6cPuM6): monotonic per-workspace count of
   * durable writes that change the goal identity (bumped inside `writeGoal`
   * when the written goalId differs from the last one written by this
   * process). An active→active replacement bumps neither the pause nor the
   * terminal generation, and the replaced goal's candidate can stay
   * installed until the replacement's kickoff finalizer arms — without this,
   * a captured continuation for goal A could be admitted after goal B became
   * durable and its stream accounting would charge B for A's work. The first
   * write of a process also bumps (last-written unknown): a spuriously
   * refused send just re-requests dispatch, whereas a missed replacement
   * corrupts the successor's budget.
   */
  private readonly goalIdentityGenerations = new Map<string, number>();
  private readonly lastWrittenGoalIdentities = new Map<
    string,
    { goalId: string; objective: string }
  >();
  private readonly lastWrittenGoalStatuses = new Map<string, GoalRecordV1["status"]>();

  private armPauseFinalizationHold(workspaceId: string, goalId: string): void {
    this.explicitPauseGenerations.set(
      workspaceId,
      (this.explicitPauseGenerations.get(workspaceId) ?? 0) + 1
    );
    const existing = this.pauseFinalizationHolds.get(workspaceId);
    if (existing?.goalId === goalId) {
      existing.depth += 1;
      return;
    }
    // A newer pause (e.g. for a replacement goal) supersedes the older hold;
    // the superseded finalizer bails on its identity re-check anyway.
    this.pauseFinalizationHolds.set(workspaceId, { goalId, depth: 1 });
  }

  private releasePauseFinalizationHold(workspaceId: string, goalId: string): void {
    const existing = this.pauseFinalizationHolds.get(workspaceId);
    if (existing?.goalId !== goalId) {
      return;
    }
    existing.depth -= 1;
    if (existing.depth <= 0) {
      this.pauseFinalizationHolds.delete(workspaceId);
    }
  }

  /** True when a pause persisted durably and its finalization side effects are still owed. */
  private pauseFinalizationHoldApplies(
    input: SetGoalInput,
    result: Result<GoalRecordV1, GoalSetError>
  ): boolean {
    return input.status === "paused" && result.success && result.data.status === "paused";
  }
  /**
   * Monotonic per-workspace stream-start counter, bumped synchronously by
   * `recordStreamStarted`. The stream-end drain captures it at entry and only
   * marks the workspace settled at exit when no newer stream started while it
   * ran (Codex P1 PRRT_kwDOPxxmWM6cEl37): a provider-error drain runs
   * un-awaited and can still be persisting when an automatic retry emits
   * stream-start — re-adding the settled marker then would let a set_goal in
   * the retry bypass mid-stream deferral.
   */
  private readonly streamStartGenerations = new Map<string, number>();
  private nextGoalStreamStampSequence = 1;
  private goalContinuationBridge: GoalContinuationRuntimeBridge | null = null;
  private goalContinuationDispatcher: IdleDispatcher | null = null;
  private goalContinuationConsumerDisposer: (() => void) | null = null;

  private timelineRecorder: TimelineRecorder = NOOP_TIMELINE_RECORDER;

  private onActivityChange?: (workspaceId: string, snapshot: WorkspaceActivitySnapshot) => void;

  /**
   * Injected callback that interrupts the active stream for a workspace.
   * Wired in `coreServices` via `WorkspaceService.interruptStream`. Tests
   * that don't supply one simply skip the interrupt step — `promote
   * UpcomingGoal` then falls back to its file-lock body as a plain
   * stream-free promotion, which keeps unit tests deterministic.
   */
  private streamInterrupter?: (workspaceId: string) => Promise<void>;

  constructor(
    private readonly config: Config,
    private readonly historyService: HistoryService,
    private readonly extensionMetadata: ExtensionMetadataService,
    private readonly analytics?: GoalLifecycleAnalyticsSink,
    options: WorkspaceGoalServiceOptions = {},
    private readonly providersConfigStore = new ProvidersConfigStore(config.rootDir)
  ) {
    this.continuationCooldownMs =
      options.continuationCooldownMs ?? DEFAULT_GOAL_CONTINUATION_COOLDOWN_MS;
    this.allowUserOriginBudgetWrapup = options.allowUserOriginBudgetWrapup === true;
    this.suppressKickoffContinuation = options.suppressKickoffContinuation === true;
    assert(
      Number.isFinite(this.continuationCooldownMs) && this.continuationCooldownMs >= 0,
      "WorkspaceGoalService requires a non-negative continuation cooldown"
    );
  }

  async restoreGoalAccountingSnapshot(
    workspaceId: string,
    streamStartedAtMs: number | null = null
  ): Promise<void> {
    assert(workspaceId.trim().length > 0, "restoreGoalAccountingSnapshot requires workspaceId");
    await this.restorePersistedGoalSnapshot(workspaceId, { streamStartedAtMs });
  }

  setTimelineRecorder(recorder: TimelineRecorder): void {
    this.timelineRecorder = recorder;
  }

  setOnActivityChange(
    listener: (workspaceId: string, snapshot: WorkspaceActivitySnapshot) => void
  ): void {
    this.onActivityChange = listener;
  }

  /**
   * The optimistic goal published while a goal is set mid-stream, before
   * stream-end persistence writes goal.json. Returns null when no mutation is
   * queued for the workspace.
   *
   * Consumed by `WorkspaceService.emitWorkspaceActivity` to overlay the
   * optimistic goal onto activity snapshots that are built from (still
   * pre-stream) persisted metadata — e.g. `status_set`/`todo_write`/recency
   * emits during the same stream. Without the overlay those snapshots replay
   * the stale pre-stream goal and the Goal tab flickers back to it until the
   * next goal read re-emits the optimistic one. This service clears the pending
   * snapshot before emitting authoritative reverts (abort) or durable
   * persistence (stream-end), so those transitions naturally win.
   */
  getPendingGoalSnapshot(workspaceId: string): GoalSnapshot | null {
    return this.pendingGoalSnapshots.get(workspaceId) ?? null;
  }

  setStreamInterrupter(interrupter: (workspaceId: string) => Promise<void>): void {
    this.streamInterrupter = interrupter;
  }

  private async readChatTailGoalMode(
    workspaceId: string,
    currentGoalId?: string | null
  ): Promise<ChatTailGoalModeResult> {
    // Codex P1 (PRRT_kwDOPxxmWM6cMQqq): capture the explicit-pause generation
    // BEFORE the history I/O so consumers can tell whether an explicit Pause
    // committed after this evidence was read (see field doc on the result).
    const pauseGenerationAtRead = this.explicitPauseGenerations.get(workspaceId) ?? 0;
    const evidence = await this.scanChatTailGoalMode(workspaceId, currentGoalId);
    return { ...evidence, pauseGenerationAtRead };
  }

  private async scanChatTailGoalMode(
    workspaceId: string,
    currentGoalId?: string | null
  ): Promise<Omit<ChatTailGoalModeResult, "pauseGenerationAtRead">> {
    const historyResult = await this.historyService.getLastMessages(workspaceId, 100);
    if (!historyResult.success) {
      log.warn("Failed to read chat tail for goal mode reconciliation", {
        workspaceId,
        error: historyResult.error,
      });
      return { mode: null };
    }

    if (historyResult.data.length === 0) {
      return { mode: null };
    }

    // Codex P2 (PRRT_kwDOPxxmWM6cJ6NC): once the scan has skipped a row
    // scoped to a DIFFERENT goal, it has crossed into an older goal's
    // history. Legacy unscoped continuation rows beneath that crossing are
    // that older goal's rows (written before goal scoping existed) and must
    // not reactivate the current goal; unscoped rows keep their any-goal
    // compatibility semantics only while the scan is still inside
    // unattributed history.
    let crossedOtherGoalHistory = false;
    for (let index = historyResult.data.length - 1; index >= 0; index -= 1) {
      const message = historyResult.data[index];
      if (message.role !== "user" || isSyntheticSnapshotUserMessage(message)) {
        continue;
      }

      if (message.metadata?.kind === GOAL_CONTINUATION_KIND) {
        // Codex P2 (PRRT_kwDOPxxmWM6cH3kV): a replaced goal's continuation row
        // is not proof that the CURRENT goal is active. When goal A is paused
        // and replaced with an explicitly paused goal B, a reconciliation that
        // runs before B's pause finalizer appends its boundary skips A's
        // goal-scoped boundary above and would otherwise reach A's older
        // continuation row and silently reactivate B. Rows scoped to a
        // different goal are invisible here, mirroring the boundary skip;
        // legacy rows without a goalId keep the old any-goal semantics.
        // Codex P2 (PRRT_kwDOPxxmWM6cOHpI): legacy any-goal semantics apply
        // only when the scoping ID is genuinely absent. A present-but-
        // malformed ID (object, number, empty string) is not trustworthy
        // ACTIVITY evidence — degrading it to legacy-active could reactivate
        // a durably paused goal off corrupt data. Skip the row entirely: it
        // neither proves activity nor marks other-goal history.
        const rawRowGoalId: unknown = message.metadata.goalId;
        const rowGoalId = toValidGoalId(rawRowGoalId);
        if (rawRowGoalId != null && rowGoalId == null) {
          continue;
        }
        if (currentGoalId != null && rowGoalId != null && rowGoalId !== currentGoalId) {
          crossedOtherGoalHistory = true;
          continue;
        }
        if (rowGoalId == null && crossedOtherGoalHistory) {
          continue;
        }
        return { mode: "active" };
      }
      if (message.metadata?.muxMetadata?.type === "goal-pause-boundary") {
        // Validated before comparison: a malformed ID must degrade to the
        // legacy unscoped branch below (conservative paused, unscoped), not
        // count as another goal's boundary (see toValidGoalId).
        const boundaryGoalId = toValidGoalId(message.metadata.muxMetadata.goalId);
        if (currentGoalId != null && boundaryGoalId != null && boundaryGoalId !== currentGoalId) {
          crossedOtherGoalHistory = true;
          // Codex P2 (PRRT_kwDOPxxmWM6cEl4F, PRRT_kwDOPxxmWM6cGSPK): a stale
          // pause finalizer's boundary can land AFTER a replacement goal (and
          // even after that goal's own manual rows). A mismatched goal-scoped
          // boundary is not the tail's final signal — skip it and keep
          // scanning so a genuine post-goal manual row beneath it still
          // reconciles the replacement (e.g. to paused after a crash lost the
          // dispatch-time auto-pause). Legacy rows without a goalId keep the
          // old any-goal semantics.
          continue;
        }
        return {
          mode: "paused",
          pausedBy: "pause_boundary",
          ...(boundaryGoalId != null && boundaryGoalId === currentGoalId
            ? { boundaryGoalScoped: true }
            : {}),
        };
      }
      if (message.metadata?.synthetic === true) {
        continue;
      }
      // Queue-dispatched rows persist their authoring time separately: the row
      // timestamp is stamped at dispatch, which can postdate a goal created at
      // the blocking turn's stream end even though the user typed pre-goal.
      // Codex P2 (PRRT_kwDOPxxmWM6b_1_J): chat.jsonl rows are unchecked JSON,
      // so validate each candidate before comparing — a malformed enqueuedAtMs
      // (negative, NaN, or a string) must fall back to the row timestamp
      // instead of silently misclassifying a post-goal intervention as
      // pre-goal and leaving the goal running.
      const authoredAtMs =
        toValidEpochMs(message.metadata?.enqueuedAtMs) ??
        toValidEpochMs(message.metadata?.timestamp);
      // A COMPLETED assistant row immediately after the manual row proves the
      // turn that consumed it settled (see manualRowProcessed field doc). A
      // partial assistant row (crash mid-response) stays unprocessed so the
      // fail-closed pause + crash-recovery acknowledgment gates apply.
      // Codex security P2 (PRRT_kwDOPxxmWM6cS8Bx): synthetic assistant
      // artifacts (goal-cleared summaries, family-message payloads) are not
      // the manual turn's settled response — only a real, completed assistant
      // response proves the turn consumed the row.
      const followerRow = historyResult.data[index + 1];
      const manualRowProcessed =
        followerRow?.role === "assistant" &&
        followerRow.metadata?.partial !== true &&
        followerRow.metadata?.synthetic !== true;
      return {
        mode: "paused",
        pausedBy: "manual_user",
        ...(authoredAtMs != null ? { manualRowAuthoredAtMs: authoredAtMs } : {}),
        ...(manualRowProcessed ? { manualRowProcessed: true } : {}),
      };
    }

    return { mode: null };
  }

  private applyChatTailGoalMode(
    workspaceId: string,
    goal: GoalRecordV1,
    chatTailMode: ChatTailGoalModeResult
  ): GoalRecordV1 {
    if (chatTailMode.mode == null || (goal.status !== "active" && goal.status !== "paused")) {
      return goal;
    }

    // Mismatched goal-scoped pause boundaries (a stale pause finalizer's
    // artifact racing a replacement) never reach here: readChatTailGoalMode
    // skips them while scanning when given the current goal's identity (Codex
    // P2 PRRT_kwDOPxxmWM6cEl4F, PRRT_kwDOPxxmWM6cGSPK).

    // Kickoff window: a freshly activated goal (model set_goal / user Resume)
    // arms a kickoff continuation candidate before its first goal_continuation
    // row is appended, so the chat tail still ends at a pre-goal manual user
    // row. Reconciling active→paused here would let any concurrent read (Goal
    // panel, tool building, a synthetic bash-monitor wake turn) pause the goal
    // before the kickoff fires — and the wake turn's stream-end hook could then
    // drop the kickoff candidate, stranding the goal (see
    // requestContinuationAfterStreamEnd). Explicit pauses are unaffected: every
    // explicit pause path deletes the candidate first and appends a
    // goal-pause-boundary row, which is deliberately not suppressed here.
    if (
      goal.status === "active" &&
      chatTailMode.mode === "paused" &&
      chatTailMode.pausedBy === "manual_user"
    ) {
      // Durable kickoff window: a goal that has never fired a continuation has
      // no goal_continuation row in history yet, so the chat tail still ends at
      // a manual user row that predates the goal. The in-memory candidate guard
      // below covers the live process, but candidates are lost on restart and
      // can be evicted by unrelated paths — after which the very next getGoal
      // (heartbeat / wake-turn tool assembly, Goal panel reads, stream-end
      // hooks) would silently pause the goal before it ever ran (user report:
      // scheduled heartbeats "pausing" fresh goals).
      //
      // Scoped to two provably-safe cases (Codex security P2
      // PRRT_kwDOPxxmWM6cSGrq — "authored before the goal existed" alone is
      // NOT consent, because a model can publish a goal AFTER the user queued
      // a stop/correction and would grandfather its autonomy past it):
      //  1. The manual row was PROCESSED — a completed assistant row follows
      //     it, so for a never-driven goal it is the initiating prompt whose
      //     turn produced the goal, not an unprocessed intervention. (An
      //     intervention's dispatch-time hook pauses the goal durably before
      //     its turn streams, so a later processed row cannot resurrect
      //     autonomy; the residual gap is a pause-write failure that is
      //     already logged and wrap-up-suppressed.)
      //  2. The row was authored before the goal's explicit user-activation
      //     consent stamp — the user activated the goal with the message
      //     visibly pending, a genuine opt-in. Model-created goals carry no
      //     stamp and fail closed.
      // Rows authored after the consent stamp are genuine interventions and
      // must still pause even when the dispatch-time auto-pause was lost to a
      // crash (persisted state stays self-healing). Explicit pause paths are
      // unaffected: they append a goal-pause-boundary row, which reconciles
      // via the pause_boundary branch. Strict ordering (Codex P2
      // PRRT_kwDOPxxmWM6cS8Bu): same-millisecond equality cannot prove the
      // row was pending at activation — it fails closed to pause.
      //
      // The consent arm applies independently of the never-driven guard
      // (Codex P2 PRRT_kwDOPxxmWM6cTN_r): a user who explicitly resumed with
      // the queued message already pending has opted in, and the row's
      // dispatch-time tail sync runs BEFORE manual-message goal safety —
      // writing the resumed goal back to paused here would discard the Resume
      // with no repair path (candidate restoration requires an active goal).
      // The processed-row arm stays scoped to the kickoff window: for a
      // driven goal, a settled manual turn with no later continuation row
      // means the dispatch-time auto-pause was lost, and reconciling to
      // paused is the self-healing path.
      const consentCoversManualRow =
        chatTailMode.manualRowAuthoredAtMs != null &&
        goal.lastUserActivationAtMs != null &&
        chatTailMode.manualRowAuthoredAtMs < goal.lastUserActivationAtMs;
      if (
        consentCoversManualRow ||
        (goal.lastContinuationFiredAtMs == null && chatTailMode.manualRowProcessed === true)
      ) {
        return goal;
      }
      const candidate = this.pendingContinuationCandidates.get(workspaceId);
      if (candidate?.source === "kickoff" && candidate.goalId === goal.goalId) {
        return goal;
      }
    }

    // Codex P2 (PRRT_kwDOPxxmWM6cLpIT): every pause path persists the durable
    // paused status BEFORE its finalizer appends the goal-scoped boundary, so
    // a durably ACTIVE goal beneath its own scoped boundary proves an explicit
    // Resume postdated the pause (the finalizer's append raced the Resume) or
    // a crash interrupted the resumed goal's kickoff window. Either way the
    // Resume is the newer user intent — the stale boundary must not write the
    // goal back to paused. Legacy unscoped boundaries keep any-goal semantics.
    // The inference is sound only because AUTOMATIC paused→active writers
    // (the branch below and recordContinuationFired) refuse across an explicit
    // Pause via the finalization hold + explicit-pause generation (Codex P1
    // PRRT_kwDOPxxmWM6cMQqq) — a user Resume is the only remaining writer that
    // can leave a durably active goal beneath its own scoped boundary.
    if (
      goal.status === "active" &&
      chatTailMode.mode === "paused" &&
      chatTailMode.pausedBy === "pause_boundary" &&
      chatTailMode.boundaryGoalScoped === true
    ) {
      return goal;
    }

    // Codex P1 (PRRT_kwDOPxxmWM6cIyKW): between a durable pause write and its
    // finalizer appending the goal-pause-boundary, the tail still ends at this
    // goal's own continuation row. Reactivating here would make the
    // finalizer's identity guard bail (status drifted), skipping the candidate
    // delete and boundary append — silently unwinding a pause the caller was
    // just told succeeded. Suppress same-goal automatic reactivation while the
    // finalization is in flight; genuine user mutations (resume, replacement)
    // write through setGoal directly and still win.
    //
    // Codex P1 (PRRT_kwDOPxxmWM6cMQqq): the hold only covers the in-flight
    // window. Tail reads run outside the goal lock, so an explicit Pause can
    // fully commit (write, boundary append, hold release) between the read
    // and this apply — the generation stamp detects that the "active"
    // evidence predates the Pause. The next read sees the appended boundary
    // and reconciles paused normally, so this only refuses stale evidence.
    if (
      goal.status === "paused" &&
      chatTailMode.mode === "active" &&
      (this.pauseFinalizationHolds.get(workspaceId)?.goalId === goal.goalId ||
        (this.explicitPauseGenerations.get(workspaceId) ?? 0) !==
          chatTailMode.pauseGenerationAtRead)
    ) {
      return goal;
    }

    const desiredStatus = chatTailMode.mode;
    if (goal.status === desiredStatus) {
      return goal;
    }

    // User rationale: goal running/paused mode is locked to the chat tail by
    // construction. A goal-continuation user turn is the only durable proof that
    // the model has been asked to keep driving the goal; any other latest user
    // turn leaves the goal paused until Resume appends a fresh continuation.
    const next = GoalRecordV1Schema.parse({
      ...goal,
      status: desiredStatus,
      updatedAtMs: Date.now(),
    });
    return applyBudgetDrivenStatus(next, { nowMs: Date.now() });
  }

  private async syncGoalStatusToChatTail(workspaceId: string): Promise<GoalRecordV1 | null> {
    // Chat-tail reads go through the history service, which shares
    // `workspaceFileLocks` — reading the tail while holding the goal file lock
    // deadlocks. Pre-read the goal identity unlocked so goal-scoped pause
    // boundaries from replaced goals are skipped while scanning (Codex P2
    // PRRT_kwDOPxxmWM6cGSPK); the locked section re-verifies the identity and
    // skips reconciliation for this round when a concurrent setter changed it
    // (the next read re-syncs against the fresh identity).
    const preRead = await this.readGoalFile(workspaceId);
    const chatTailMode =
      preRead != null ? await this.readChatTailGoalMode(workspaceId, preRead.goalId) : null;
    return this.fileLocks.withLock(workspaceId, async () => {
      const current = await this.readGoalFile(workspaceId);
      if (!current) {
        await this.pushGoalReadSnapshot(workspaceId, null);
        return null;
      }
      if (chatTailMode == null || current.goalId !== preRead?.goalId) {
        return current;
      }

      const next = this.applyChatTailGoalMode(workspaceId, current, chatTailMode);
      if (next === current) {
        return current;
      }

      await this.writeGoal(workspaceId, next);
      await this.pushGoalReadSnapshot(workspaceId, next);
      this.emitBudgetLimited(workspaceId, next, current.status);
      this.emitStatusLifecycle(next, current.status, "auto");
      return next;
    });
  }

  private async appendGoalPauseBoundaryIfNeeded(
    workspaceId: string,
    goalId: string
  ): Promise<boolean> {
    const chatTailMode = await this.readChatTailGoalMode(workspaceId, goalId);
    if (chatTailMode.mode !== "active") {
      return true;
    }

    // Hidden synthetic user boundary: it makes Pause durable in the same
    // declarative state model as Resume without rewriting prior continuation
    // history. The row is model-visible but not rendered unless synthetic debug
    // messages are enabled, matching other context-only system breadcrumbs.
    // The goalId scope keeps a stale pause's boundary from ever reconciling a
    // replacement goal to paused (Codex P2 PRRT_kwDOPxxmWM6cEl4F).
    const message = createMuxMessage(
      `goal-paused-${Date.now()}-${crypto.randomUUID()}`,
      "user",
      "Goal paused by the user. Do not continue the goal until a later goal continuation message.",
      {
        timestamp: Date.now(),
        synthetic: true,
        muxMetadata: { type: "goal-pause-boundary", goalId },
      }
    );
    const appendResult = await this.historyService.appendToHistory(workspaceId, message);
    if (!appendResult.success) {
      log.warn("Failed to append goal pause boundary", {
        workspaceId,
        error: appendResult.error,
      });
      return false;
    }
    return true;
  }

  // Shared resolver for the goal service's per-workspace session files
  // (goal.json / goal-history.jsonl / goal-board.json). Centralizes the
  // non-empty workspaceId guard and session-dir join so each file accessor
  // doesn't re-assert and re-join the same way.
  private resolveSessionFilePath(workspaceId: string, fileName: string): string {
    assert(workspaceId.trim().length > 0, "WorkspaceGoalService requires non-empty workspaceId");
    return path.join(this.config.sessionsDir, workspaceId, fileName);
  }

  private getFilePath(workspaceId: string): string {
    return this.resolveSessionFilePath(workspaceId, GOAL_FILE);
  }

  private getHistoryFilePath(workspaceId: string): string {
    return this.resolveSessionFilePath(workspaceId, GOAL_HISTORY_FILE);
  }

  /**
   * Append a goal record snapshot to the workspace's goal-history JSONL.
   * Callers are expected to hold the workspace file lock so this never races
   * with a `writeGoal` for the same workspace. A serialize-then-append failure
   * is logged but never bubbled: the user's lifecycle action (clear, replace,
   * complete) must succeed even if history persistence fails, because the
   * authoritative state lives in `goal.json` and the lifecycle event log.
   */
  private async appendGoalHistoryEntry(
    workspaceId: string,
    goal: GoalRecordV1,
    endReason: GoalHistoryEndReason
  ): Promise<void> {
    const entry: GoalHistoryEntry = {
      version: 1,
      endReason,
      endedAtMs: Date.now(),
      goal,
    };
    const filePath = this.getHistoryFilePath(workspaceId);
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      // JSONL append: one entry per line, no rewriting prior history. Newline
      // first would corrupt readers expecting a trailing newline on the last
      // record, so we always emit `<json>\n`.
      await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
    } catch (error) {
      log.warn("Failed to append goal history entry", { workspaceId, endReason, error });
    }
  }

  private createGoal(input: {
    objective: string;
    budgetCents: number | null;
    turnCap: number | null;
    status?: GoalStatus | null;
    completionSummary?: string | null;
    goalId?: string | null;
    /**
     * Preserved creation time for goals projected mid-stream: the durable
     * record must date from when the user could first see the goal, or queued
     * interventions typed against the visible goal would be misread as
     * pre-goal input by the goal-safety guards.
     */
    createdAtMs?: number | null;
  }): GoalRecordV1 {
    const now = input.createdAtMs ?? Date.now();
    const status = input.status ?? "active";
    const goal = GoalRecordV1Schema.parse({
      version: 1,
      goalId: input.goalId ?? crypto.randomUUID(),
      objective: input.objective,
      status,
      budgetCents: normalizeGoalBudgetCents(input.budgetCents),
      turnCap: input.turnCap,
      costCents: 0,
      costMicroCents: 0,
      turnsUsed: 0,
      attributedChildren: [],
      budgetLimitInjectedForGoalId: null,
      requireUserAcknowledgmentSinceMs: null,
      lastContinuationFiredAtMs: null,
      ...(input.completionSummary != null
        ? { completionSummary: input.completionSummary.trim() }
        : {}),
      createdAtMs: now,
      updatedAtMs: now,
    });
    return status === "active" ? applyBudgetDrivenStatus(goal, { nowMs: Date.now() }) : goal;
  }

  private async writeGoal(workspaceId: string, goal: GoalRecordV1): Promise<void> {
    const filePath = this.getFilePath(workspaceId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await writeFileAtomic(filePath, `${JSON.stringify(goal, null, 2)}\n`, "utf-8");
    // See terminalStatusGenerations: bumped at the write commit point so
    // in-flight dispatch admission probes observe terminal transitions from
    // every write path. Codex P1 (PRRT_kwDOPxxmWM6cTN_o): transitions OUT of
    // a terminal status bump too — raising/removing an exhausted limit
    // re-arms budget_limited→active without changing identity, objective, or
    // pause state, and a captured budget wrap-up admission would otherwise
    // stay fresh and charge a stale stopping turn after reactivation.
    // Non-terminal→non-terminal writes (per-stream accounting on active
    // goals) still never bump.
    const isTerminalStatus = goal.status === "complete" || goal.status === "budget_limited";
    const previousWrittenStatus = this.lastWrittenGoalStatuses.get(workspaceId);
    const wasTerminalStatus =
      previousWrittenStatus === "complete" || previousWrittenStatus === "budget_limited";
    this.lastWrittenGoalStatuses.set(workspaceId, goal.status);
    if (isTerminalStatus || wasTerminalStatus) {
      this.terminalStatusGenerations.set(
        workspaceId,
        (this.terminalStatusGenerations.get(workspaceId) ?? 0) + 1
      );
    }
    // See explicitPauseGenerations: also bumped at the write commit point
    // (Codex P1 PRRT_kwDOPxxmWM6cSREI). persistGoalMutationLocked awaits
    // snapshot/preview publication AFTER the durable paused write and before
    // setGoalImmediately arms the finalization hold — a captured
    // continuation's admissionStale probe would otherwise still read the
    // pre-pause generation during that publication window and admit an
    // autonomous turn against the committed Pause. Restore/reconciliation
    // writes of paused records bump too; consumers compare generations for
    // inequality, so extra bumps only cause conservative staleness refusals
    // that retry.
    if (goal.status === "paused") {
      this.explicitPauseGenerations.set(
        workspaceId,
        (this.explicitPauseGenerations.get(workspaceId) ?? 0) + 1
      );
    }
    // See goalIdentityGenerations: identity changes (replacement, revival,
    // first write of the process) invalidate captured dispatch admissions.
    // Codex P1 (PRRT_kwDOPxxmWM6cS8B1): same-ID objective revisions
    // (editInPlace renames) count too — a captured continuation's payload
    // embeds the old objective, so admitting it after the user redirects the
    // goal would run tools toward work the user just replaced. Limit-only
    // edits stay fresh: they do not change what work runs, and newly
    // exhausted limits flip status (bumping the terminal generation above).
    const lastIdentity = this.lastWrittenGoalIdentities.get(workspaceId);
    if (lastIdentity?.goalId !== goal.goalId || lastIdentity.objective !== goal.objective) {
      this.lastWrittenGoalIdentities.set(workspaceId, {
        goalId: goal.goalId,
        objective: goal.objective,
      });
      this.goalIdentityGenerations.set(
        workspaceId,
        (this.goalIdentityGenerations.get(workspaceId) ?? 0) + 1
      );
    }
  }

  private async renameCorruptGoal(
    workspaceId: string,
    filePath: string,
    error: unknown
  ): Promise<void> {
    const corruptPath = `${filePath}.corrupt-${Date.now()}`;
    try {
      await fs.rename(filePath, corruptPath);
    } catch (renameError) {
      if (!isNotFound(renameError)) {
        log.warn("Failed to rename corrupt goal.json", { workspaceId, error: renameError });
      }
    }
    log.warn("Ignoring corrupt goal.json", { workspaceId, corruptPath, error });
    await this.pushSnapshot(workspaceId, null);
  }

  private async readGoalFile(workspaceId: string): Promise<GoalRecordV1 | null> {
    const filePath = this.getFilePath(workspaceId);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }

    try {
      return GoalRecordV1Schema.parse(JSON.parse(raw));
    } catch (error) {
      await this.renameCorruptGoal(workspaceId, filePath, error);
      return null;
    }
  }

  private async pushSnapshot(
    workspaceId: string,
    goal: GoalRecordV1 | null
  ): Promise<GoalSnapshot | null> {
    const snapshot = goal ? toGoalSnapshot(goal) : null;
    const activity = await this.extensionMetadata.setGoal(workspaceId, snapshot);
    this.onActivityChange?.(workspaceId, activity);
    return snapshot;
  }

  private async pushTransientGoalSnapshot(
    workspaceId: string,
    snapshot: GoalSnapshot
  ): Promise<"delivered" | "no_baseline" | "unavailable"> {
    let activity: WorkspaceActivitySnapshot | null;
    try {
      activity = await this.extensionMetadata.getSnapshot(workspaceId, { throwOnError: true });
    } catch (error) {
      // A suspect baseline (failed sidecar reconcile / unreadable main)
      // must not feed an emitted overlay: partial-main fields would clear
      // status in the renderer. "unavailable" is deliberately DISTINCT from
      // the authoritative "no_baseline": the durable pushSnapshot fallback
      // writes through the lenient load (accepting the same suspect partial
      // main this strict read refused) and emits the result — converting
      // this failure into that fallback would clear exactly the renderer
      // state the strict read preserves.
      log.debug("Skipping transient goal emit after failed snapshot read", {
        workspaceId,
        error,
      });
      return "unavailable";
    }
    if (!activity) {
      // No baseline activity snapshot to overlay the transient goal on
      // (extensionMetadata has no entry for this workspace yet). Callers
      // that must guarantee delivery — e.g. live cost previews — should
      // observe "no_baseline" and fall back to `pushSnapshot`, which
      // creates the entry and emits via the durable path. Pending-goal
      // publication does not retry here because it only fires after a
      // `setGoal` that already created the entry.
      return "no_baseline";
    }
    this.onActivityChange?.(workspaceId, {
      ...activity,
      goal: snapshot,
      transientGoalOnly: true,
    });
    return "delivered";
  }

  private async pushLiveGoalPreviewOverlay(
    workspaceId: string,
    durableGoal: GoalRecordV1
  ): Promise<void> {
    const livePreview = this.liveGoalPreviewSnapshots.get(workspaceId);
    if (!livePreview || livePreview.goalId !== durableGoal.goalId) {
      return;
    }

    const durableSnapshot = toGoalSnapshot(durableGoal);
    if (livePreview.costCents <= durableSnapshot.costCents) {
      return;
    }

    // Preserve live "budget used" while a user edits budget/turn limits mid-stream.
    // The mutable edit must persist the durable pre-stream accounting to goal.json so
    // final `recordStreamAccounting` can add the cumulative stream cost exactly once,
    // but the Goals UI should keep showing the same live usage Stats already reports.
    await this.pushTransientGoalSnapshot(workspaceId, {
      ...durableSnapshot,
      costCents: livePreview.costCents,
    });
  }
  private async publishPendingGoalSnapshot(workspaceId: string, goal: GoalRecordV1): Promise<void> {
    const snapshot = toPendingGoalSnapshot(goal);
    this.pendingGoalSnapshots.set(workspaceId, snapshot);
    await this.pushTransientGoalSnapshot(workspaceId, snapshot);
  }

  private async pushGoalReadSnapshot(
    workspaceId: string,
    goal: GoalRecordV1 | null
  ): Promise<GoalSnapshot | null> {
    const pendingSnapshot = this.pendingGoalSnapshots.get(workspaceId);
    if (pendingSnapshot) {
      // Goal reads keep activity snapshots warm, but mid-stream queued goals
      // must keep showing the transient replacement until stream-end persistence.
      await this.pushTransientGoalSnapshot(workspaceId, pendingSnapshot);
      return pendingSnapshot;
    }
    if (!goal) {
      // Goals are GA, so normal model/tool-availability paths call getGoal()
      // for every turn. Avoid writing `goal: null` on every no-goal read;
      // explicit lifecycle operations (clear/corrupt repair/etc.) still push
      // null snapshots when state actually changes.
      return null;
    }
    return this.pushSnapshot(workspaceId, goal);
  }

  private async restorePersistedGoalSnapshot(
    workspaceId: string,
    options: { streamStartedAtMs?: number | null } = {}
  ): Promise<void> {
    try {
      await this.fileLocks.withLock(workspaceId, async () => {
        this.liveGoalPreviewSnapshots.delete(workspaceId);
        if (options.streamStartedAtMs != null) {
          // A new stream is starting: queued mid-stream setGoal is meaningful
          // again, so leave the settled fast-path (see drainSettledWorkspaces).
          this.drainSettledWorkspaces.delete(workspaceId);
          this.recordedStreamStartedAtMsByWorkspace.set(workspaceId, options.streamStartedAtMs);
        }
        const current = await this.readGoalFile(workspaceId);
        await this.pushSnapshot(workspaceId, current);
      });
    } catch (error) {
      log.warn("Failed to restore persisted goal snapshot", { workspaceId, error });
    }
  }

  private assertParentWorkspace(workspaceId: string): void {
    const workspace = this.config.findWorkspace(workspaceId);
    if (workspace?.parentWorkspaceId != null) {
      throw new WorkspaceGoalChildWorkspaceError(workspaceId);
    }
  }

  private emitLifecycle(event: GoalLifecycleEvent, properties: GoalLifecycleProperties): void {
    try {
      this.analytics?.recordGoalLifecycleEvent(event, properties);
    } catch (error) {
      log.warn("Failed to record goal lifecycle event", { event, error });
    }
  }

  private async isWorkspaceStreaming(workspaceId: string): Promise<boolean> {
    const snapshot = await this.extensionMetadata.getSnapshot(workspaceId);
    return snapshot?.streaming === true;
  }

  /**
   * Bounded poll for the workspace's streaming flag to drop. Same backoff
   * as `runDeferredAutoPromoteAfterStreamEnd` so callers never wait more
   * than ~600ms. Returns silently when the timer exhausts; the caller is
   * expected to proceed regardless (promote falls open).
   */
  private async waitForStreamSettled(workspaceId: string): Promise<void> {
    const backoffMs = [0, 50, 100, 200, 250];
    for (const delay of backoffMs) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      if (!(await this.isWorkspaceStreaming(workspaceId))) return;
    }
  }

  registerGoalContinuationConsumer(
    idleDispatcher: IdleDispatcher,
    bridge: GoalContinuationRuntimeBridge
  ): () => void {
    assert(idleDispatcher, "registerGoalContinuationConsumer requires an idle dispatcher");
    assert(bridge, "registerGoalContinuationConsumer requires a runtime bridge");
    assert(
      this.goalContinuationConsumerDisposer == null,
      "goal continuation idle consumer is already registered"
    );

    this.goalContinuationBridge = bridge;
    this.goalContinuationDispatcher = idleDispatcher;
    this.goalContinuationConsumerDisposer = idleDispatcher.registerConsumer({
      name: GOAL_CONTINUATION_IDLE_CONSUMER_NAME,
      priority: GOAL_CONTINUATION_IDLE_CONSUMER_PRIORITY,
      buildPayload: (workspaceId) => this.buildGoalContinuationPayload(workspaceId),
    });

    return () => {
      this.goalContinuationConsumerDisposer?.();
      this.goalContinuationConsumerDisposer = null;
      this.goalContinuationBridge = null;
      this.goalContinuationDispatcher = null;
      for (const timer of this.continuationReRequestTimers.values()) {
        clearTimeout(timer);
      }
      this.continuationReRequestTimers.clear();
    };
  }

  private async getPricedContinuationSendOptions(
    workspaceId: string,
    goal: GoalRecordV1,
    sendOptions: SendMessageOptions
  ): Promise<SendMessageOptions | null> {
    const normalized = continuationSendOptions(sendOptions);
    if (!hasBudgetedResumableGoal(goal)) {
      return normalized;
    }
    const providersConfig = this.getProvidersConfigForPricing();
    if (modelHasPricingData(normalized.model, providersConfig)) {
      return normalized;
    }
    const kickoff = await this.goalContinuationBridge?.getKickoffSendOptions?.(workspaceId);
    if (!kickoff || kickoff.agentId === "plan" || kickoff.agentId === "compact") {
      return null;
    }
    const fallback = continuationSendOptions(kickoff);
    return modelHasPricingData(fallback.model, providersConfig) ? fallback : null;
  }

  async requestContinuationAfterStreamEnd(input: {
    workspaceId: string;
    sendOptions: SendMessageOptions;
    streamEndedAtMs?: number;
  }): Promise<void> {
    assert(
      input.workspaceId.trim().length > 0,
      "requestContinuationAfterStreamEnd requires workspaceId"
    );
    if (this.goalContinuationDispatcher == null) {
      return;
    }

    const existingCandidate = this.pendingContinuationCandidates.get(input.workspaceId);
    if (existingCandidate?.source === "kickoff") {
      const kickoffGoal = await this.normalizeGoalLimits(input.workspaceId, {
        syncChatTail: false,
      });
      if (
        kickoffGoal?.goalId === existingCandidate.goalId &&
        (kickoffGoal.status === "active" || kickoffGoal.status === "paused")
      ) {
        // Model-created goals arm a kickoff candidate when the queued set_goal
        // drains. The enclosing user stream also calls this stream-end hook; do
        // not downgrade that kickoff into a stream_end candidate, because
        // stream_end candidates reconcile against the pre-goal manual user row
        // and would pause the new goal before it can continue.
        //
        // `paused` is included because chat-tail reconciliation can flip a
        // kickoff-window goal to paused before its first continuation row lands
        // (e.g. when a synthetic bash-monitor wake turn runs first and its
        // stream end lands here). Eligibility and dispatch deliberately accept
        // paused kickoff candidates and recordContinuationFired flips the goal
        // back to active. Every explicit pause path deletes the candidate
        // first, so a paused goal with an armed kickoff can only be that
        // auto-flip — dropping it here would strand the goal (issue: bash
        // monitor wakes disabling freshly set goals).
        await this.goalContinuationDispatcher.requestDispatch(
          input.workspaceId,
          GOAL_CONTINUATION_IDLE_CONSUMER_NAME
        );
        return;
      }
    }

    const goal = await this.getGoal(input.workspaceId);
    if (goal?.status !== "active" && goal?.status !== "budget_limited") {
      this.pendingContinuationCandidates.delete(input.workspaceId);
      return;
    }

    const sendOptions = await this.getPricedContinuationSendOptions(
      input.workspaceId,
      goal,
      input.sendOptions
    );
    if (!sendOptions) {
      this.pendingContinuationCandidates.delete(input.workspaceId);
      return;
    }

    const streamEndedAtMs = input.streamEndedAtMs ?? Date.now();
    this.pendingContinuationCandidates.set(input.workspaceId, {
      goalId: goal.goalId,
      requestedAtMs: Date.now(),
      streamEndedAtMs,
      source: "stream_end",
      sendOptions,
    });
    await this.goalContinuationDispatcher.requestDispatch(
      input.workspaceId,
      GOAL_CONTINUATION_IDLE_CONSUMER_NAME
    );
  }

  clearPendingContinuationForManualUserMessage(workspaceId: string): void {
    assert(
      workspaceId.trim().length > 0,
      "clearPendingContinuationForManualUserMessage requires workspaceId"
    );
    this.pendingContinuationCandidates.delete(workspaceId);
  }

  /**
   * Synchronously remove and return the pending continuation candidate so a
   * manual user message can be classified without leaving the candidate
   * consumable.
   *
   * Codex P1 (PRRT_kwDOPxxmWM6cClKd): a direct send on an idle workspace does
   * not mark the session busy until after its durable row is appended, so an
   * eligibility check running while `acknowledgeUser` is awaited would see an
   * idle session, skip chat-tail sync for a kickoff candidate, and dispatch a
   * continuation despite the user's intervention. Taking the candidate before
   * that await closes the window; the pre-goal queue-race branch restores it
   * via `restorePendingContinuationCandidate`.
   */
  takePendingContinuationCandidateForManualUserMessage(
    workspaceId: string
  ): PendingGoalContinuationCandidate | null {
    assert(
      workspaceId.trim().length > 0,
      "takePendingContinuationCandidateForManualUserMessage requires workspaceId"
    );
    const candidate = this.pendingContinuationCandidates.get(workspaceId) ?? null;
    this.pendingContinuationCandidates.delete(workspaceId);
    return candidate;
  }

  /**
   * Restore a candidate suspended by
   * `takePendingContinuationCandidateForManualUserMessage` after the manual
   * message proved to be a pre-goal queue-race send (authored before the goal
   * existed — not an intervention). No-op when something newer armed during
   * the suspension. Re-requests dispatch because a dispatch consumed during
   * the suspension found no candidate and nothing else would retry.
   *
   * Codex P2 (PRRT_kwDOPxxmWM6cErQ7): verified under the goal file lock — a
   * concurrent pause can persist while the manual send was being classified,
   * and kickoff eligibility deliberately accepts paused goals (the durable
   * kickoff window), so an unverified restore would reactivate the autonomous
   * loop despite Pause. Pauses persist under this same lock and delete
   * candidates in their finalization afterwards, so either the pause is
   * already durable here (we drop the stale candidate) or its finalization
   * runs after this restore and deletes it.
   */
  async restorePendingContinuationCandidate(
    workspaceId: string,
    candidate: PendingGoalContinuationCandidate
  ): Promise<void> {
    assert(
      workspaceId.trim().length > 0,
      "restorePendingContinuationCandidate requires workspaceId"
    );
    const restored = await this.fileLocks.withLock(workspaceId, async () => {
      if (this.pendingContinuationCandidates.has(workspaceId)) {
        return false;
      }
      const current = await this.readGoalFile(workspaceId);
      if (current?.goalId !== candidate.goalId) {
        return false;
      }
      // Codex P2 (PRRT_kwDOPxxmWM6cPbjX): a suspended candidate can belong to
      // a budget_limited goal (e.g. an auto-promoted revival whose retained
      // spend already exceeds its budget) — the active-only rule would strand
      // the owed wrap-up until a restart reconstructs it. Accept the restore
      // when the durable record still owes its wrap-up: not user-suppressed
      // and not already injected. Source-agnostic on purpose: eligibility's
      // budget_limited branch dispatches the one-shot wrap-up from any
      // candidate source. Other statuses keep the active-only rule (a
      // pause/completion during classification wins).
      const wrapupStillOwed =
        current.status === "budget_limited" &&
        current.budgetLimitOriginKind !== "user" &&
        current.budgetLimitInjectedForGoalId !== current.goalId;
      if (current.status !== "active" && !wrapupStillOwed) {
        return false;
      }
      this.pendingContinuationCandidates.set(workspaceId, candidate);
      return true;
    });
    if (!restored) {
      return;
    }
    this.goalContinuationDispatcher
      ?.requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME)
      .catch((error: unknown) => {
        log.warn("Failed to re-request dispatch after candidate restore", { workspaceId, error });
      });
  }

  /**
   * Codex P1 (PRRT_kwDOPxxmWM6cPuMw): admission revalidation for a goal-loop
   * synthetic turn that is being REDISPATCHED outside its original guarded
   * send — e.g. a compaction follow-up whose original `requireIdle` +
   * `admissionStale` guards did not survive the durable handoff. The
   * original closure cannot be persisted, so re-derive: verify the durable
   * goal still admits the kind (continuation → active; budget wrap-up →
   * budget_limited, unsuppressed, and either unreserved or reserved by this
   * persisted follow-up) and return a fresh staleness probe over
   * the pause/terminal/identity generations for the send's admission gates.
   */
  async buildGoalRedispatchAdmission(
    workspaceId: string,
    goalId: string,
    kind: GoalSyntheticMessageKind
  ): Promise<{ admissible: false } | { admissible: true; admissionStale: () => boolean }> {
    assert(workspaceId.trim().length > 0, "buildGoalRedispatchAdmission requires workspaceId");
    assert(goalId.trim().length > 0, "buildGoalRedispatchAdmission requires goalId");
    // Snapshot before the async read. A transition may commit after readFile
    // captured the old bytes but before it resolves; pairing that stale record
    // with post-transition baselines would make the returned probe look fresh.
    const pauseGenerationAtBuild = this.explicitPauseGenerations.get(workspaceId) ?? 0;
    const terminalGenerationAtBuild = this.terminalStatusGenerations.get(workspaceId) ?? 0;
    const identityGenerationAtBuild = this.goalIdentityGenerations.get(workspaceId) ?? 0;
    // Codex security P2 (PRRT_kwDOPxxmWM6cSx0M): a user Stop leaves an active
    // goal's status and identity untouched (recordUserStoppedStream only bumps
    // the stop generation synchronously; the acknowledgment gate persists
    // later), so the generation probes above stay fresh across it — a
    // recovered goal-scoped follow-up admitted before the Stop could start an
    // exec turn after it. Sample the stop generation with the others.
    const userStopGenerationAtBuild = this.userStopGenerationsByWorkspace.get(workspaceId) ?? 0;
    const current = await this.readGoalFile(workspaceId);
    if (
      (this.explicitPauseGenerations.get(workspaceId) ?? 0) !== pauseGenerationAtBuild ||
      (this.terminalStatusGenerations.get(workspaceId) ?? 0) !== terminalGenerationAtBuild ||
      (this.goalIdentityGenerations.get(workspaceId) ?? 0) !== identityGenerationAtBuild ||
      this.userStopLandedSince(workspaceId, userStopGenerationAtBuild) ||
      // Codex security P2 (PRRT_kwDOPxxmWM6cS7qG): a Stop whose acknowledgment
      // write has not committed bumped the generation BEFORE this baseline was
      // captured — the baseline is fresh and the record still reads pre-Stop.
      // Refuse while the Stop is in flight; after commit the durable
      // acknowledgment gate below covers new builds.
      (this.pendingStopAcknowledgmentCounts.get(workspaceId) ?? 0) > 0 ||
      current?.goalId !== goalId ||
      current.requireUserAcknowledgmentSinceMs != null
    ) {
      return { admissible: false };
    }
    if (kind === GOAL_BUDGET_LIMIT_KIND) {
      // This method is called for the persisted compaction follow-up. If the
      // original wrap-up send was accepted as an on-send compaction request,
      // it already reserved this goal ID before the real follow-up dispatches;
      // the matching pending follow-up owns that reservation.
      const wrapupAdmitted =
        current.status === "budget_limited" &&
        current.budgetLimitOriginKind !== "user" &&
        (current.budgetLimitInjectedForGoalId == null ||
          current.budgetLimitInjectedForGoalId === goalId);
      if (!wrapupAdmitted) {
        return { admissible: false };
      }
    } else if (current.status !== "active") {
      return { admissible: false };
    }
    return {
      admissible: true,
      admissionStale: () =>
        (this.explicitPauseGenerations.get(workspaceId) ?? 0) !== pauseGenerationAtBuild ||
        (this.terminalStatusGenerations.get(workspaceId) ?? 0) !== terminalGenerationAtBuild ||
        (this.goalIdentityGenerations.get(workspaceId) ?? 0) !== identityGenerationAtBuild ||
        this.userStopLandedSince(workspaceId, userStopGenerationAtBuild) ||
        (this.pendingStopAcknowledgmentCounts.get(workspaceId) ?? 0) > 0,
    };
  }

  /**
   * Codex P2 (PRRT_kwDOPxxmWM6cRJEE): a budget wrap-up send accepted before a
   * crash can resume through a persisted compaction follow-up whose original
   * dispatcher never committed tryMarkBudgetLimitInjected. The redispatched
   * follow-up owns the wrap-up now: install the missing reservation (an
   * existing matching reservation is already correct and left untouched) so
   * the recovered stream's end cannot arm and fire a second wrap-up.
   */
  async reserveBudgetWrapupForRedispatch(workspaceId: string, goalId: string): Promise<void> {
    assert(workspaceId.trim().length > 0, "reserveBudgetWrapupForRedispatch requires workspaceId");
    assert(goalId.trim().length > 0, "reserveBudgetWrapupForRedispatch requires goalId");
    await this.fileLocks.withLock(workspaceId, async () => {
      const current = await this.readGoalFile(workspaceId);
      if (
        current?.goalId !== goalId ||
        current.status !== "budget_limited" ||
        current.budgetLimitOriginKind === "user" ||
        current.budgetLimitInjectedForGoalId != null
      ) {
        return;
      }
      const next = GoalRecordV1Schema.parse({
        ...current,
        budgetLimitInjectedForGoalId: goalId,
        updatedAtMs: Date.now(),
      });
      await this.writeGoal(workspaceId, next);
      await this.pushSnapshot(workspaceId, next);
    });
  }

  /**
   * Treat an agent's text-only `goal_continuation` turn as implicit
   * completion. The continuation prompt asks the agent to call
   * `complete_goal` explicitly, but real models sometimes finish with a
   * plain text "looks done" reply instead. Without this fallback the
   * continuation loop would re-fire on the same idle output until budget
   * or cooldown gates intervene.
   *
   * AgentSession owns the "no tool calls + goalKind === continuation"
   * predicate (it has the stream parts + activeStreamContext in scope);
   * this method re-reads goal state and only acts when the goal is
   * currently `active`. `budget_limited` is intentionally out-of-scope —
   * its one-shot wrap-up flow owns terminal text turns. `paused` /
   * `complete` / missing goals also fall through.
   *
   * Errors from the underlying `setGoal` (e.g. a concurrent clear/replace
   * surfacing as `goal_conflict`, or a status flip racing with the read)
   * are logged and swallowed so the stream-end handler never throws on
   * this best-effort path.
   *
   * **Auto-promotion of upcoming goals.** When the workspace has queued
   * upcoming goals, the inline `setGoal({ status: "complete" })` call
   * triggers `maybeAutoPromoteOnComplete`, but that helper skips while
   * `isWorkspaceStreaming` is still true — and at stream-end the
   * `extensionMetadata.setStreaming(false)` update is asynchronous, so
   * the skip is likely. We therefore re-run the deferred auto-promote
   * pass (`runDeferredAutoPromoteAfterStreamEnd`) after a successful
   * completion. This is the same hook `applyPendingAfterStreamEnd`
   * already uses for the parallel "agent called `complete_goal`
   * mid-stream" case (#3326 Codex P2 PRRT_kwDOPxxmWM6DMh9j); without
   * it the next upcoming goal stays stuck in `upcoming` until some
   * later manual mutation.
   */
  async completeGoalFromSilentContinuation(input: {
    workspaceId: string;
    completionSummary: string;
  }): Promise<GoalRecordV1 | null> {
    assert(
      input.workspaceId.trim().length > 0,
      "completeGoalFromSilentContinuation requires workspaceId"
    );
    const summary = input.completionSummary.trim();
    if (summary.length === 0) {
      return null;
    }
    const goal = await this.getGoal(input.workspaceId);
    if (goal?.status !== "active") {
      return null;
    }
    const result = await this.setGoal({
      workspaceId: input.workspaceId,
      status: "complete",
      initiator: "model",
      completionSummary: summary,
      // Optimistic-concurrency guard so a goal that was cleared or
      // replaced between the read above and the write below surfaces as
      // a typed `goal_conflict` instead of a confusing validation error.
      expectedGoalId: goal.goalId,
    });
    if (!result.success) {
      log.info("completeGoalFromSilentContinuation: skipped", {
        workspaceId: input.workspaceId,
        error: result.error.type,
      });
      return null;
    }
    // Auto-promote any queued upcoming goal once streaming actually
    // settles. See the JSDoc above for the race description; this
    // mirrors `applyPendingAfterStreamEnd`'s tail so both completion
    // paths (mid-stream tool call + silent text-only) converge on the
    // same promotion behaviour.
    await this.runDeferredAutoPromoteAfterStreamEnd(input.workspaceId);
    return result.data;
  }

  /**
   * Notify the goal service that a new stream actually started. Synchronous on
   * purpose: it must land before any setter admitted during the new stream
   * checks the settled fast-path.
   *
   * Codex P1 (PRRT_kwDOPxxmWM6cClKS): `applyPendingAfterStreamEnd` marks the
   * workspace settled after every drain (and `recordUserStoppedStream` after
   * every abort), but production only cleared the marker on terminal-error
   * restoration. Without this hook, every subsequent successful stream saw the
   * stale settled marker and a model `set_goal` persisted goal.json mid-stream
   * instead of deferring to the stream-end drain — archiving the outgoing goal
   * before its stream accounting, skipping the new goal's accounting
   * (createdAtMs postdates stream start), and leaving nothing for a user stop
   * to discard.
   */
  recordStreamStarted(workspaceId: string): void {
    assert(workspaceId.trim().length > 0, "recordStreamStarted requires workspaceId");
    // Only the settled marker: recording the new stream's start time in
    // `recordedStreamStartedAtMsByWorkspace` would suppress the stream's own
    // accounting previews (a match there means "deltas from this stream are
    // stale", set by terminal-error restoration).
    this.drainSettledWorkspaces.delete(workspaceId);
    this.streamStartGenerations.set(
      workspaceId,
      (this.streamStartGenerations.get(workspaceId) ?? 0) + 1
    );
  }

  async recordUserStoppedStream(workspaceId: string, stoppedAtMs = Date.now()): Promise<void> {
    assert(workspaceId.trim().length > 0, "recordUserStoppedStream requires workspaceId");
    assert(Number.isFinite(stoppedAtMs) && stoppedAtMs >= 0, "user stop timestamp must be valid");
    this.lastUserStopAtMsByWorkspace.set(workspaceId, stoppedAtMs);
    this.userStopGenerationsByWorkspace.set(
      workspaceId,
      (this.userStopGenerationsByWorkspace.get(workspaceId) ?? 0) + 1
    );
    // A user stop ends the stream WITHOUT a stream-end drain (AgentSession
    // deliberately skips it), so treat the workspace as settled: setters
    // admitted after this stop must persist directly instead of queueing a
    // mutation nothing will drain (see drainSettledWorkspaces).
    this.drainSettledWorkspaces.add(workspaceId);
    this.pendingContinuationCandidates.delete(workspaceId);
    this.pendingGoalSnapshots.delete(workspaceId);
    this.liveGoalPreviewSnapshots.delete(workspaceId);
    // Drop queued goal mutations too. If a
    // user sets a goal mid-stream then stops the stream, the mutation would
    // otherwise stay queued and apply on the NEXT stream's stream-end via
    // applyPendingAfterStreamEnd, writing goal.json with createdAtMs > the
    // userStopAtMs gate — auto-continuation would then fire in a context the
    // user did not intend (the stop was meant to discard the goal change).
    const hadPendingGoalMutation = this.pendingGoalMutations.delete(workspaceId);

    // Armed in the same synchronous block as the generation bump above so no
    // admission can observe the bumped generation without the latch (see
    // pendingStopAcknowledgmentCounts).
    this.pendingStopAcknowledgmentCounts.set(
      workspaceId,
      (this.pendingStopAcknowledgmentCounts.get(workspaceId) ?? 0) + 1
    );
    try {
      await this.recordUserStoppedStreamLocked(workspaceId, stoppedAtMs, hadPendingGoalMutation);
    } finally {
      const remaining = (this.pendingStopAcknowledgmentCounts.get(workspaceId) ?? 1) - 1;
      if (remaining <= 0) {
        this.pendingStopAcknowledgmentCounts.delete(workspaceId);
      } else {
        this.pendingStopAcknowledgmentCounts.set(workspaceId, remaining);
      }
    }
  }

  private async recordUserStoppedStreamLocked(
    workspaceId: string,
    stoppedAtMs: number,
    hadPendingGoalMutation: boolean
  ): Promise<void> {
    await this.fileLocks.withLock(workspaceId, async () => {
      const current = await this.readGoalFile(workspaceId);
      if (current?.status !== "active" && current?.status !== "budget_limited") {
        // Mid-stream /goal now publishes an optimistic activity snapshot so the
        // Goal panel opens immediately. If the user aborts that stream, revert
        // the panel to the persisted goal file (or null) along with dropping the
        // queued mutation.
        if (hadPendingGoalMutation) {
          await this.pushSnapshot(workspaceId, current);
        }
        return;
      }
      const next = GoalRecordV1Schema.parse({
        ...current,
        requireUserAcknowledgmentSinceMs: Math.floor(stoppedAtMs),
        updatedAtMs: Date.now(),
      });
      await this.writeGoal(workspaceId, next);
      await this.pushSnapshot(workspaceId, next);
    });
  }

  async buildGoalContinuationPayload(workspaceId: string): Promise<IdleDispatchPayload | null> {
    const eligibility = await this.checkGoalContinuationEligibility(workspaceId, Date.now());
    if (!eligibility.eligible) {
      // Self-deferring reasons (e.g. `currently_streaming`, `initializing`)
      // re-request dispatch on a ~1s timer, so logging at info level produces
      // one line per retry for the entire duration of an active stream. Drop
      // those to debug; keep terminal reasons at info since they fire once
      // and are useful diagnostic signal.
      const logFn = eligibility.deferUntilMs != null ? log.debug : log.info;
      logFn("WorkspaceGoalService: skipped goal continuation", {
        workspaceId,
        reason: eligibility.reason,
      });
      if (eligibility.deferUntilMs != null) {
        this.scheduleContinuationReRequest(workspaceId, eligibility.deferUntilMs);
        return null;
      }
      return null;
    }

    const { goal, candidate } = eligibility;
    assert(goal != null, "eligible goal continuation requires a goal");
    assert(candidate != null, "eligible goal continuation requires a pending candidate");

    if (goal.status === "budget_limited") {
      const lastStreamStamp = eligibility.lastStreamStamp;
      assert(lastStreamStamp != null, "eligible budget wrap-up requires a stream stamp");
      const message = buildGoalBudgetLimitMessage(goal);
      return {
        dispatch: async () => {
          // Send first, mark only on accept. If sendMessage rejects transiently
          // (e.g. requireIdle fails because a new turn started), we want a future
          // dispatch to retry — we must not permanently flip
          // budgetLimitInjectedForGoalId or the goal gets stuck in budget_limited
          // with no wrap-up. Mirrors the active-continuation path below.
          //
          // Codex P1 (PRRT_kwDOPxxmWM6cPBWX): a manual send during this
          // send's preflight can suppress the wrap-up (delete the candidate,
          // stamp durable + live user origin) without ever making the session
          // busy — e.g. an unpriced manual send rejected in its own
          // preflight. tryMarkBudgetLimitInjected refusing after acceptance
          // is too late (the wrap-up stream already started), so the
          // admission probe re-validates the captured candidate, the live
          // stamp's wrap-up eligibility, and the terminal-status generation
          // (suppression's durable write bumps it before the live stamp
          // updates) up to the last gate before the send is irrevocable.
          const wrapupTerminalGenerationAtDispatch =
            this.terminalStatusGenerations.get(workspaceId) ?? 0;
          // Codex P1 (PRRT_kwDOPxxmWM6cPuM6): replacement of the
          // budget-limited goal during the preflight is an identity change.
          const wrapupIdentityGenerationAtDispatch =
            this.goalIdentityGenerations.get(workspaceId) ?? 0;
          const accepted = await this.goalContinuationBridge?.executeGoalContinuation({
            workspaceId,
            message,
            options: candidate.sendOptions,
            startStreamInBackground: false,
            kind: GOAL_BUDGET_LIMIT_KIND,
            goalId: goal.goalId,
            admissionStale: () => {
              if (this.pendingContinuationCandidates.get(workspaceId) !== candidate) {
                return true;
              }
              const stamp = this.lastGoalStreamStamps.get(workspaceId);
              if (
                stamp?.goalId !== goal.goalId ||
                !isBudgetWrapupEligibleOrigin(stamp.originKind, this.allowUserOriginBudgetWrapup)
              ) {
                return true;
              }
              return (
                (this.terminalStatusGenerations.get(workspaceId) ?? 0) !==
                  wrapupTerminalGenerationAtDispatch ||
                (this.goalIdentityGenerations.get(workspaceId) ?? 0) !==
                  wrapupIdentityGenerationAtDispatch
              );
            },
          });
          if (accepted !== true) {
            this.scheduleContinuationReRequest(workspaceId, Date.now() + 1_000);
            return;
          }
          this.timelineRecorder.record(workspaceId, {
            kind: "goal.continuation_dispatched",
            source: { system: "goal" },
            status: "started",
            data: { reason: "budget_limit", digest: goal.objective },
          });
          const reserved = await this.tryMarkBudgetLimitInjected(
            workspaceId,
            goal.goalId,
            lastStreamStamp
          );
          if (reserved) {
            this.emitBudgetWrapupFired(reserved, Date.now());
          }
          this.deletePendingCandidateIfStillSame(workspaceId, candidate);
        },
      };
    }

    const continuationGoal =
      goal.status === "paused" && candidate.source === "kickoff"
        ? GoalRecordV1Schema.parse({ ...goal, status: "active" })
        : goal;
    assert(
      continuationGoal.status === "active",
      "goal idle payload requires active, paused-kickoff, or budget-limited goal"
    );
    const message = buildGoalContinuationMessage(continuationGoal);
    return {
      dispatch: async () => {
        // Codex P1 (PRRT_kwDOPxxmWM6cOgXR): an explicit Pause completing
        // while the send below runs its unlocked preflight would otherwise go
        // unobserved — requireIdle still admits (Pause does not make the
        // session busy) and the continuation row would land after the pause
        // boundary as fresh active evidence. Every explicit pause path
        // deletes the candidate and bumps the explicit-pause generation, so
        // the probe flips stale and the send is refused before its pre-turn
        // batch becomes irrevocable. Reconciliation pauses do neither, so the
        // kickoff-window recovery dispatch still proceeds.
        const pauseGenerationAtDispatch = this.explicitPauseGenerations.get(workspaceId) ?? 0;
        // Codex P1 (PRRT_kwDOPxxmWM6cPBWd): a same-goal transition to
        // complete (model/user completion) or budget_limited (accounting or
        // child attribution) during the preflight neither deletes the
        // candidate nor bumps the pause generation — the terminal-status
        // generation covers those, refusing a normal continuation against a
        // completed goal or one that now owes the budget wrap-up instead.
        const terminalGenerationAtDispatch = this.terminalStatusGenerations.get(workspaceId) ?? 0;
        // Codex P1 (PRRT_kwDOPxxmWM6cPuM6): an active→active replacement
        // bumps neither generation above and may leave this candidate
        // installed until the replacement's kickoff finalizer arms — the
        // identity generation covers it.
        const identityGenerationAtDispatch = this.goalIdentityGenerations.get(workspaceId) ?? 0;
        const accepted = await this.goalContinuationBridge?.executeGoalContinuation({
          workspaceId,
          message,
          options: candidate.sendOptions,
          startStreamInBackground: candidate.source === "kickoff",
          kind: GOAL_CONTINUATION_KIND,
          goalId: goal.goalId,
          admissionStale: () =>
            this.pendingContinuationCandidates.get(workspaceId) !== candidate ||
            (this.explicitPauseGenerations.get(workspaceId) ?? 0) !== pauseGenerationAtDispatch ||
            (this.terminalStatusGenerations.get(workspaceId) ?? 0) !==
              terminalGenerationAtDispatch ||
            (this.goalIdentityGenerations.get(workspaceId) ?? 0) !== identityGenerationAtDispatch,
        });
        if (accepted !== true) {
          this.scheduleContinuationReRequest(workspaceId, Date.now() + 1_000);
          return;
        }
        this.timelineRecorder.record(workspaceId, {
          kind: "goal.continuation_dispatched",
          source: { system: "goal" },
          status: "started",
          data: { digest: goal.objective },
        });
        await this.recordContinuationFired(workspaceId, goal.goalId, Date.now());
        if (candidate.source !== "kickoff") {
          this.deletePendingCandidateIfStillSame(workspaceId, candidate);
          return;
        }
        // Keep kickoff candidates until the stream-end path replaces or clears
        // them. Background startup failures happen after the synthetic user row
        // is accepted; retaining the candidate lets the failure hook re-request
        // dispatch instead of stranding the active goal.
      },
    };
  }

  /**
   * Delete the pending continuation candidate for a workspace ONLY if the map
   * entry still references the same candidate this dispatch closure captured.
   *
   * Between executeGoalContinuation returning true and the cleanup
   * delete, two file-lock awaits yield the event loop
   * (tryMarkBudgetLimitInjected / recordContinuationFired). If the
   * continuation stream fails immediately and the stream-end handler writes a
   * NEW candidate during the yield, an unconditional delete-by-key would drop
   * that fresh candidate — the next dispatch cycle would then find no
   * candidate and skip silently.
   *
   * Reference equality is the simplest correct guard: each pending candidate
   * is a distinct object, so identity checks against the captured closure
   * variable cannot collide with a concurrently-written replacement.
   */
  private deletePendingCandidateIfStillSame(
    workspaceId: string,
    candidate: PendingGoalContinuationCandidate
  ): void {
    if (this.pendingContinuationCandidates.get(workspaceId) === candidate) {
      this.pendingContinuationCandidates.delete(workspaceId);
    }
  }

  async checkGoalContinuationEligibility(
    workspaceId: string,
    nowMs: number
  ): Promise<GoalContinuationEligibilityResult> {
    assert(workspaceId.trim().length > 0, "checkGoalContinuationEligibility requires workspaceId");
    assert(Number.isFinite(nowMs) && nowMs >= 0, "checkGoalContinuationEligibility requires nowMs");

    const candidate = this.pendingContinuationCandidates.get(workspaceId) ?? null;
    const finish = (
      decision: GoalContinuationDecision,
      goal?: GoalRecordV1,
      lastStreamStamp?: GoalStreamStamp
    ): GoalContinuationEligibilityResult => {
      if (decision.kind === "continue") {
        return { eligible: true, goal, candidate: candidate ?? undefined, lastStreamStamp };
      }
      if (decision.kind === "stop" && decision.dropCandidate) {
        this.pendingContinuationCandidates.delete(workspaceId);
      }
      return {
        eligible: false,
        reason: decision.reason,
        ...(decision.kind === "defer" ? { deferUntilMs: decision.untilMs } : {}),
      };
    };
    const bridge = this.goalContinuationBridge;
    const probe: GoalContinuationPolicyProbe = {
      nowMs,
      candidate,
      bridgeRegistered: bridge != null,
    };
    const evaluateProbe = () => evaluateGoalContinuationBeforeGoal(probe);
    let decision = evaluateProbe();
    if (decision) return finish(decision);
    assert(
      candidate != null && bridge != null,
      "registered continuation requires candidate and bridge"
    );

    const workspace = this.findWorkspaceConfigEntry(workspaceId);
    probe.workspace = {
      found: workspace != null,
      archived:
        workspace != null && isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt),
      hasPath: Boolean(workspace?.path),
      isChild: workspace?.parentWorkspaceId != null,
    };
    decision = evaluateProbe();
    if (decision) return finish(decision);

    probe.hasActiveDescendantTasks = bridge.hasActiveDescendantTasks(workspaceId);
    decision = evaluateProbe();
    if (decision) return finish(decision);

    const runtimeState = bridge.getRuntimeState(workspaceId);
    probe.runtime = {
      isInitializing: runtimeState.isInitializing === true,
      isRuntimeCompatible: runtimeState.isRuntimeCompatible !== false,
      isBusy: runtimeState.isBusy === true,
      hasQueuedMessages: runtimeState.hasQueuedMessages === true,
      hasPendingFollowUp: runtimeState.hasPendingFollowUp === true,
    };
    decision = evaluateProbe();
    if (decision) return finish(decision);

    probe.isStreaming = await this.isWorkspaceStreaming(workspaceId);
    decision = evaluateProbe();
    if (decision) return finish(decision);

    probe.userStopAtMs = this.lastUserStopAtMsByWorkspace.get(workspaceId) ?? null;
    if (probe.userStopAtMs != null) {
      probe.stopCheckGoal = await this.readGoalFile(workspaceId);
    }
    decision = evaluateProbe();
    if (decision) return finish(decision);

    const goal = await this.normalizeGoalLimits(workspaceId, {
      syncChatTail: candidate.source !== "kickoff",
    });
    const lastStreamStamp =
      goal?.status === "budget_limited"
        ? (this.lastGoalStreamStamps.get(workspaceId) ?? null)
        : null;
    decision = evaluateGoalContinuationGoal({
      nowMs,
      candidate,
      goal,
      lastStreamStamp,
      continuationCooldownMs: this.continuationCooldownMs,
      allowUserOriginBudgetWrapup: this.allowUserOriginBudgetWrapup,
    });
    return finish(decision, goal ?? undefined, lastStreamStamp ?? undefined);
  }

  private scheduleContinuationReRequest(workspaceId: string, dueAtMs: number): void {
    if (this.goalContinuationDispatcher == null) {
      return;
    }
    const delayMs = Math.max(0, dueAtMs - Date.now());
    const existing = this.continuationReRequestTimers.get(workspaceId);
    if (existing != null) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.continuationReRequestTimers.delete(workspaceId);
      if (!this.pendingContinuationCandidates.has(workspaceId)) {
        return;
      }
      this.goalContinuationDispatcher
        ?.requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME)
        .catch((error: unknown) => {
          log.warn("Failed to re-request goal continuation dispatch", { workspaceId, error });
        });
    }, delayMs);
    this.continuationReRequestTimers.set(workspaceId, timer);
  }

  private findWorkspaceConfigEntry(workspaceId: string): Workspace | null {
    const config = this.config.loadConfigOrDefault();
    for (const [, projectConfig] of config.projects) {
      const workspace = projectConfig.workspaces.find((candidate) => candidate.id === workspaceId);
      if (workspace) {
        return workspace;
      }
    }
    return null;
  }

  private async normalizeGoalLimits(
    workspaceId: string,
    options: { syncChatTail?: boolean } = {}
  ): Promise<GoalRecordV1 | null> {
    // Tail reads must stay outside the goal file lock (shared with the
    // history service — see syncGoalStatusToChatTail). Pre-read the identity
    // for boundary scoping; identity drift under the lock skips chat-tail
    // reconciliation for this round only.
    const preRead = options.syncChatTail === true ? await this.readGoalFile(workspaceId) : null;
    const preReadChatTailMode =
      preRead != null ? await this.readChatTailGoalMode(workspaceId, preRead.goalId) : null;
    return this.fileLocks.withLock(workspaceId, async () => {
      const current = await this.readGoalFile(workspaceId);
      if (!current) {
        await this.pushGoalReadSnapshot(workspaceId, null);
        return null;
      }
      const chatTailMode =
        preReadChatTailMode != null && current.goalId === preRead?.goalId
          ? preReadChatTailMode
          : null;
      const budgetNormalized = applyBudgetDrivenStatus(current, { nowMs: Date.now() });
      const next = chatTailMode
        ? this.applyChatTailGoalMode(workspaceId, budgetNormalized, chatTailMode)
        : budgetNormalized;
      if (next !== current) {
        await this.writeGoal(workspaceId, next);
        await this.pushGoalReadSnapshot(workspaceId, next);
        this.emitBudgetLimited(workspaceId, next, current.status);
        this.emitStatusLifecycle(next, current.status, "auto");
        return next;
      }
      await this.pushGoalReadSnapshot(workspaceId, current);
      return current;
    });
  }

  private async recordContinuationFired(
    workspaceId: string,
    expectedGoalId: string,
    firedAtMs: number
  ): Promise<void> {
    // Read outside the goal file lock (shared with the history service) and
    // scope boundary skipping to the expected goal — the locked section below
    // already refuses when the durable goal is not that goal.
    const chatTailMode = await this.readChatTailGoalMode(workspaceId, expectedGoalId);
    await this.fileLocks.withLock(workspaceId, async () => {
      const current = await this.readGoalFile(workspaceId);
      if (current?.goalId !== expectedGoalId) {
        return;
      }
      // Codex P1 (PRRT_kwDOPxxmWM6cMQqq): the paused→active acceptance exists
      // for reconciliation's spurious kickoff-window pause (see the paused
      // kickoff comment in requestContinuationAfterStreamEnd), but an EXPLICIT
      // Pause admitted after this continuation was dispatched must not be
      // undone — flipping active here lands durably beneath the pause's own
      // scoped boundary, which the Resume-wins reconciliation rule then
      // preserves as if the user had resumed. Refuse while the pause
      // finalization is in flight (hold armed) or when an explicit pause
      // committed after the tail evidence above was read (stale evidence).
      const explicitPauseSupersedes =
        this.pauseFinalizationHolds.get(workspaceId)?.goalId === current.goalId ||
        (this.explicitPauseGenerations.get(workspaceId) ?? 0) !==
          chatTailMode.pauseGenerationAtRead;
      const continuationAccepted =
        current.status === "active" ||
        (current.status === "paused" && chatTailMode.mode === "active" && !explicitPauseSupersedes);
      if (!continuationAccepted) {
        return;
      }
      const next = GoalRecordV1Schema.parse({
        ...current,
        status: "active",
        lastContinuationFiredAtMs: firedAtMs,
        updatedAtMs: firedAtMs,
      });
      await this.writeGoal(workspaceId, next);
      await this.pushSnapshot(workspaceId, next);
      this.emitStatusLifecycle(next, current.status, "auto");
      this.emitContinuationFired(next, firedAtMs);
    });
  }

  private emitContinuationFired(goal: GoalRecordV1, firedAtMs: number): void {
    const budgetRemaining =
      goal.budgetCents == null ? null : Math.max(0, goal.budgetCents - goal.costCents);
    this.emitLifecycle("goal_continuation_fired", {
      turns_used: goal.turnsUsed,
      cost_cents_bucket: centsBucket(goal.costCents),
      budget_remaining_cents_bucket:
        budgetRemaining == null ? "unlimited" : centsBucket(budgetRemaining),
      elapsed_minutes_bucket: countBucket(
        Math.floor(Math.max(0, firedAtMs - goal.createdAtMs) / 60_000)
      ),
      turn_cap_present: goal.turnCap != null,
      source: "stream_end_idle_dispatch",
    });
  }

  private async tryMarkBudgetLimitInjected(
    workspaceId: string,
    expectedGoalId: string,
    expectedLastStreamStamp: GoalStreamStamp
  ): Promise<GoalRecordV1 | null> {
    assert(expectedGoalId.trim().length > 0, "budget wrap-up reservation requires a goal id");
    assert(
      isBudgetWrapupEligibleOrigin(
        expectedLastStreamStamp.originKind,
        this.allowUserOriginBudgetWrapup
      ),
      "budget wrap-up reservation requires a goal-attributable stream"
    );

    return this.fileLocks.withLock(workspaceId, async () => {
      const currentStamp = this.lastGoalStreamStamps.get(workspaceId);
      if (
        currentStamp?.goalId !== expectedGoalId ||
        !isBudgetWrapupEligibleOrigin(currentStamp.originKind, this.allowUserOriginBudgetWrapup)
      ) {
        return null;
      }

      const current = await this.readGoalFile(workspaceId);
      if (
        current?.goalId !== expectedGoalId ||
        current.status !== "budget_limited" ||
        current.budgetLimitInjectedForGoalId === expectedGoalId
      ) {
        return null;
      }

      const next = GoalRecordV1Schema.parse({
        ...current,
        budgetLimitInjectedForGoalId: expectedGoalId,
        updatedAtMs: Date.now(),
      });
      await this.writeGoal(workspaceId, next);
      await this.pushSnapshot(workspaceId, next);
      return next;
    });
  }

  private emitBudgetWrapupFired(goal: GoalRecordV1, firedAtMs: number): void {
    this.emitLifecycle("goal_wrapup_fired", {
      turns_used: goal.turnsUsed,
      cost_cents_bucket: centsBucket(goal.costCents),
      "cost-overshoot": centsBucket(
        Math.max(0, goal.costCents - (goal.budgetCents ?? goal.costCents))
      ),
      elapsed_minutes_bucket: countBucket(
        Math.floor(Math.max(0, firedAtMs - goal.createdAtMs) / 60_000)
      ),
      source: "stream_end_idle_dispatch",
    });
  }

  private validateStatusTransition(
    current: GoalRecordV1 | null,
    nextStatus: GoalStatus,
    completionSummary: string | null,
    initiator: GoalLifecycleInitiator
  ): void {
    if (!current) {
      throw new WorkspaceGoalTransitionError(
        `Cannot ${actionForStatus(nextStatus)} a goal because no goal is set.`
      );
    }

    // Reviving a completed goal is a deliberate user action: agents that
    // marked a goal complete via the `complete_goal` tool (initiator
    // "model") must not be able to walk that back on the next turn — that
    // would let a loop re-arm itself indefinitely. But a human in the
    // GoalTab is allowed to resume the goal they archived themselves
    // (e.g., the agent declared victory too early), so we only block
    // non-user initiators here.
    if (current.status === "complete" && nextStatus !== "complete" && initiator !== "user") {
      throw new WorkspaceGoalTransitionError(
        `Cannot ${actionForStatus(nextStatus)} a completed goal. Clear it before starting another.`
      );
    }

    // From `complete` the user may go to either `active` (resume work) or
    // `paused` (revive without immediately re-arming continuations).
    // From any other state the normal pause/resume guards still apply.
    if (nextStatus === "paused" && current.status !== "active" && current.status !== "complete") {
      throw new WorkspaceGoalTransitionError("Cannot pause a goal that is not active.");
    }

    if (nextStatus === "active" && current.status !== "paused" && current.status !== "complete") {
      throw new WorkspaceGoalTransitionError("Cannot resume a goal that is not paused.");
    }

    if (nextStatus === "complete") {
      if (completionSummary == null || completionSummary.length === 0) {
        throw new WorkspaceGoalTransitionError("Completion summary is required.");
      }
      if (current.status !== "active" && current.status !== "budget_limited") {
        throw new WorkspaceGoalTransitionError(
          "Cannot complete a goal that is not active or budget-limited."
        );
      }
    }
  }

  private conflictForExpectedGoalId(
    current: GoalRecordV1 | null,
    expectedGoalId: string | null | undefined
  ): GoalSetError | null {
    if (expectedGoalId === undefined) {
      return null;
    }
    const actualGoalId = current?.goalId ?? null;
    if (actualGoalId === expectedGoalId) {
      return null;
    }
    return { type: "goal_conflict", expectedGoalId, actualGoalId };
  }

  private conflictForReplacementGuard(
    current: GoalRecordV1 | null,
    replacementGuard: SetGoalReplacementGuard | null | undefined
  ): GoalSetError | null {
    if (!replacementGuard || !current || !REPLACE_GUARDED_STATUSES.has(current.status)) {
      return null;
    }

    if (replacementGuard.replaceExistingGoal !== true) {
      return {
        type: "invalid_transition",
        message:
          "set_goal would replace the current active goal. Continue or complete the existing goal, or ask the user before replacing it. If the user explicitly asked to replace it, call get_goal and retry with replaceExistingGoal=true and expectedGoalId.",
      };
    }

    if (replacementGuard.expectedGoalId !== current.goalId) {
      return {
        type: "invalid_transition",
        message: `set_goal replacement requires expectedGoalId to match the current goalId from get_goal (${current.goalId}).`,
      };
    }

    return null;
  }

  /**
   * Explicit-user-activation consent stamp — the anchor for the queue-race
   * pause bypasses (Codex security P2 PRRT_kwDOPxxmWM6cSGrq). Only explicit
   * user actions that transition a goal into `active` stamp it (direct
   * create, Resume, board promote); model set_goal, auto-promotion, and
   * accounting re-arms leave it unset so their goals FAIL CLOSED — a queued
   * manual message always pauses them. The oRPC schema deliberately omits
   * `initiator`, so renderer calls default to "user" here while the model can
   * only enter through tools that pass `initiator: "model"`.
   */
  private stampUserActivation(
    next: GoalRecordV1,
    previousStatus: GoalRecordV1["status"] | null,
    initiator: GoalLifecycleInitiator | undefined,
    activatedAtMs: number
  ): GoalRecordV1 {
    if (
      next.status !== "active" ||
      previousStatus === "active" ||
      (initiator ?? "user") !== "user"
    ) {
      return next;
    }
    return GoalRecordV1Schema.parse({ ...next, lastUserActivationAtMs: activatedAtMs });
  }

  private applyMutableFields(goal: GoalRecordV1, input: SetGoalInput): GoalRecordV1 {
    const completionSummary = input.completionSummary?.trim() ?? null;
    if (input.status != null) {
      this.validateStatusTransition(
        goal,
        input.status,
        completionSummary,
        input.initiator ?? "user"
      );
    }

    const next: GoalRecordV1 = GoalRecordV1Schema.parse({
      ...goal,
      ...(input.status != null ? { status: input.status } : {}),
      ...(Object.hasOwn(input, "budgetCents")
        ? { budgetCents: normalizeGoalBudgetCents(input.budgetCents) }
        : {}),
      ...(Object.hasOwn(input, "turnCap") ? { turnCap: input.turnCap ?? null } : {}),
      ...(Object.hasOwn(input, "requireUserAcknowledgmentSinceMs")
        ? { requireUserAcknowledgmentSinceMs: input.requireUserAcknowledgmentSinceMs ?? null }
        : {}),
      ...completionSummaryPatch(input.status, completionSummary),
      updatedAtMs: Date.now(),
    });
    return applyBudgetDrivenStatus(next, { nowMs: Date.now() });
  }

  private applyCostAccounting(
    goal: GoalRecordV1,
    costMicroCentsThisStream: number
  ): Pick<GoalRecordV1, "costCents" | "costMicroCents"> {
    const costMicroCents = getGoalCostMicroCents(goal) + costMicroCentsThisStream;
    return {
      costCents: Math.round(costMicroCents / MICRO_CENTS_PER_CENT),
      costMicroCents,
    };
  }

  private emitBudgetLimited(
    workspaceId: string,
    goal: GoalRecordV1,
    previousStatus: GoalStatus,
    properties?: GoalLifecycleProperties
  ): void {
    if (previousStatus === "budget_limited" || goal.status !== "budget_limited") {
      return;
    }

    this.timelineRecorder.record(workspaceId, {
      kind: "goal.budget_limited",
      source: { system: "goal", key: `goal-budget-limited:${goal.goalId}:${goal.updatedAtMs}` },
      status: "completed",
      data: { digest: goal.objective },
    });
    this.emitLifecycle("goal_budget_limited", {
      hasBudget: goal.budgetCents != null,
      hasTurnCap: goal.turnCap != null,
      "cost-overshoot": hasReachedGoalBudgetLimit(goal)
        ? centsBucket(Math.max(0, goal.costCents - (goal.budgetCents ?? 0)))
        : null,
      "turn-overshoot": hasReachedGoalTurnLimit(goal)
        ? countBucket(Math.max(0, goal.turnsUsed - (goal.turnCap ?? 0)))
        : null,
      ...(properties ?? {}),
    });
  }

  private budgetDeltaProperties(
    field: "budget" | "turn-cap",
    previous: number | null,
    next: number | null
  ): GoalLifecycleProperties {
    const previousValue = previous ?? 0;
    const nextValue = next ?? 0;
    const delta = nextValue - previousValue;
    let deltaSign = "zero";
    let raisedVsLowered = "unchanged";
    if (delta > 0) {
      deltaSign = "positive";
      raisedVsLowered = "raised";
    } else if (delta < 0) {
      deltaSign = "negative";
      raisedVsLowered = "lowered";
    }
    return {
      [`${field}-delta-sign`]: deltaSign,
      [`${field}-raised-vs-lowered`]: raisedVsLowered,
      [`${field}-delta-cents`]: field === "budget" ? delta : null,
      [`${field}-delta-turns`]: field === "turn-cap" ? delta : null,
    };
  }

  private emitBudgetChanged(
    current: GoalRecordV1 | null,
    next: GoalRecordV1,
    input: SetGoalInput
  ): void {
    const budgetTouched = Object.hasOwn(input, "budgetCents");
    const turnCapTouched = Object.hasOwn(input, "turnCap");
    if (!budgetTouched && !turnCapTouched) {
      return;
    }

    this.emitLifecycle("goal_budget_changed", {
      hasBudget: next.budgetCents != null,
      hasTurnCap: next.turnCap != null,
      ...(budgetTouched
        ? this.budgetDeltaProperties("budget", current?.budgetCents ?? null, next.budgetCents)
        : {}),
      ...(turnCapTouched
        ? this.budgetDeltaProperties("turn-cap", current?.turnCap ?? null, next.turnCap)
        : {}),
    });
  }

  private emitStatusLifecycle(
    goal: GoalRecordV1,
    previousStatus: GoalStatus,
    initiator: GoalLifecycleInitiator
  ): void {
    if (goal.status === previousStatus) {
      return;
    }

    if (goal.status === "paused") {
      this.emitLifecycle("goal_paused", { initiator });
    } else if (
      goal.status === "active" &&
      (previousStatus === "paused" || previousStatus === "complete")
    ) {
      // BudgetLimited → Active is a budget-driven re-arm, not a user resume;
      // it is reported via goal_budget_changed only. Complete → Active is
      // a user-initiated revive (validateStatusTransition only lets the
      // `user` initiator out of `complete`) — surface it as `goal_resumed`
      // so the lifecycle funnel sees revived goals symmetrically with
      // paused→active resumes.
      this.emitLifecycle("goal_resumed", { initiator });
    } else if (goal.status === "complete") {
      this.emitLifecycle("goal_completed", {
        initiator,
        summaryLengthBucket: lengthBucket(goal.completionSummary?.length ?? 0),
      });
    }
  }

  private getProvidersConfigForPricing(): ProvidersConfigMap | null {
    const providersConfig = this.providersConfigStore.loadProvidersConfig();
    return providersConfig as ProvidersConfigMap | null;
  }

  async requestPendingGoalContinuationDispatch(workspaceId: string): Promise<void> {
    assert(
      workspaceId.trim().length > 0,
      "requestPendingGoalContinuationDispatch requires workspaceId"
    );
    if (!this.pendingContinuationCandidates.has(workspaceId)) {
      return;
    }
    await this.goalContinuationDispatcher?.requestDispatch(
      workspaceId,
      GOAL_CONTINUATION_IDLE_CONSUMER_NAME
    );
  }

  async syncGoalModeWithChatTail(workspaceId: string): Promise<GoalRecordV1 | null> {
    assert(workspaceId.trim().length > 0, "syncGoalModeWithChatTail requires workspaceId");
    return this.syncGoalStatusToChatTail(workspaceId);
  }

  async getGoal(workspaceId: string): Promise<GoalRecordV1 | null> {
    return this.normalizeGoalLimits(workspaceId, { syncChatTail: true });
  }

  /**
   * Reject sends/resumes that would run a non-terminal budgeted goal on an
   * unpriced model. Without this gate, the turn streams happily, accounting
   * records 0 cost (no pricing data → `getTotalCost(...) ?? 0`), and budget
   * enforcement is silently bypassed for real work. Persistence-only blocks
   * are not enough: the actual stream is what burns the budget.
   *
   * Owned by WorkspaceGoalService so every dispatch path can share one gate
   * implementation:
   *  - `WorkspaceService.sendMessage` / `resumeStream` (initial calls) — to
   *    avoid persisting an unpriced model into workspace AI settings before
   *    the rejection.
   *  - `AgentSession.sendMessage` (every internal/queued/auto dispatch) — to
   *    catch races where the goal becomes budgeted while a queued message
   *    waits, or where a server-internal caller picks an unpriced model.
   *
   * Intentionally does NOT honour `options.skipAiSettingsPersistence`: that
   * field is part of the public `SendMessageOptionsSchema` and forwarded
   * verbatim by the router, so trusting it would let any oRPC caller flip a
   * single bool to disarm the gate. Internal compaction / heartbeat callers
   * always pick a priced model via `getPreferredCompactionSettings` /
   * heartbeat builders, so they hit the early `modelHasPricingData` exit
   * below without touching `goal.json`.
   */
  async assertPricedModelForBudgetedGoal(
    workspaceId: string,
    model: string | undefined
  ): Promise<Result<void, SendMessageError>> {
    if (!model || modelHasPricingData(model, this.getProvidersConfigForPricing())) {
      return Ok(undefined);
    }
    const goal = await this.getGoal(workspaceId);
    if (!hasBudgetedResumableGoal(goal)) {
      return Ok(undefined);
    }
    return Err({ type: "unknown", raw: UNPRICED_TARGET_MODEL_GOAL_MESSAGE });
  }

  async inheritFromFork(
    parentWorkspaceId: string,
    forkWorkspaceId: string
  ): Promise<GoalRecordV1 | null> {
    assert(
      parentWorkspaceId.trim().length > 0,
      "inheritFromFork requires non-empty parentWorkspaceId"
    );
    assert(forkWorkspaceId.trim().length > 0, "inheritFromFork requires non-empty forkWorkspaceId");
    assert(
      parentWorkspaceId !== forkWorkspaceId,
      "inheritFromFork requires distinct parent and fork workspaces"
    );

    const parentGoal = await this.fileLocks.withLock(parentWorkspaceId, () =>
      this.readGoalFile(parentWorkspaceId)
    );
    if (!parentGoal) {
      return null;
    }

    const inherited = this.createGoal({
      objective: parentGoal.objective,
      budgetCents: parentGoal.budgetCents,
      turnCap: parentGoal.turnCap,
      status: "paused",
    });

    return this.fileLocks.withLock(forkWorkspaceId, async () => {
      const existingForkGoal = await this.readGoalFile(forkWorkspaceId);
      assert(existingForkGoal == null, "inheritFromFork expects a fresh fork workspace goal file");
      await this.writeGoal(forkWorkspaceId, inherited);
      await this.pushSnapshot(forkWorkspaceId, inherited);
      this.emitLifecycle("goal_created", {
        viaFork: true,
        sourceStatus: parentGoal.status,
        objectiveLengthBucket: lengthBucket(inherited.objective.length),
        hasBudget: inherited.budgetCents != null,
        hasTurnCap: inherited.turnCap != null,
      });
      return inherited;
    });
  }

  async setGoal(input: SetGoalInput): Promise<Result<GoalRecordV1, GoalSetError>> {
    // Catch the two known throw paths (`assertParentWorkspace` and
    // `applyMutableFields`/`validateStatusTransition`) and surface them as
    // typed Result errors so the oRPC `setGoal` handler does not leak them as
    // unhandled 500s.
    try {
      return await this.setGoalInternal(input);
    } catch (error) {
      if (error instanceof WorkspaceGoalChildWorkspaceError) {
        return Err({ type: "child_workspace", message: error.message });
      }
      if (error instanceof WorkspaceGoalTransitionError) {
        return Err({ type: "invalid_transition", message: error.message });
      }
      throw error;
    }
  }

  private async setGoalInternal(input: SetGoalInput): Promise<Result<GoalRecordV1, GoalSetError>> {
    const objective = input.objective?.trim();
    this.assertParentWorkspace(input.workspaceId);
    // Codex P2 (PRRT_kwDOPxxmWM6cBr9Q): captured synchronously at entry so the
    // in-lock recheck below can detect a stream-end drain that started or
    // finished while this setter was in flight. The extension-metadata
    // streaming flag updates asynchronously after stream end, so it alone can
    // hold a stale "live" long enough for a setter to queue a mutation the
    // drain has already stopped watching for.
    const drainGenerationAtEntry = this.streamEndDrainGenerations.get(input.workspaceId) ?? 0;
    // Codex P1 (PRRT_kwDOPxxmWM6cLA0R): captured synchronously alongside the
    // drain generation so the in-lock rechecks can tell whether a later drain
    // bump came from a drain settling THIS setter's stream (stale → persist
    // directly) or from an older stream's un-awaited error drain exiting while
    // the setter's stream is live (queue normally — that stream's own drain
    // claims the stamped mutation).
    const setterStreamStartGenerationAtEntry =
      this.streamStartGenerations.get(input.workspaceId) ?? 0;
    // Codex P1 (PRRT_kwDOPxxmWM6cCH_H): also captured synchronously at entry.
    // A user stop landing while this setter is in flight means the stopped
    // turn's goal change must be discarded — recordUserStoppedStream deletes
    // only already-installed mutations, so a setter still in its pre-install
    // awaits would otherwise install (or directly persist) a goal the abort
    // meant to discard.
    const userStopGenerationAtEntry =
      this.userStopGenerationsByWorkspace.get(input.workspaceId) ?? 0;

    if (!objective && this.pendingGoalSnapshots.has(input.workspaceId)) {
      // Until stream-end persists the queued objective, status/budget-only edits
      // would target the old durable goal (or no goal) while the panel displays
      // the optimistic replacement. Reject them instead of mutating the wrong record.
      return Err({ type: "invalid_transition", message: PENDING_GOAL_EDIT_MESSAGE });
    }

    // -----------------------------------------------------------------------
    // Mid-stream branch: setGoal during an active stream defers the actual
    // disk write until applyPendingAfterStreamEnd. The returned `Ok(projected)`
    // is a synthetic record for immediate UI rendering; it has NOT been
    // persisted yet.
    //
    // The projected goalId is persisted through the queued mutation so model
    // tool results remain valid optimistic-concurrency tokens after stream-end.
    // Without carrying this id into the drain, a transcript-persisted set_goal
    // result could point complete_goal at a throwaway pre-persistence id.
    // -----------------------------------------------------------------------
    if (
      objective &&
      !this.drainSettledWorkspaces.has(input.workspaceId) &&
      (await this.isWorkspaceStreaming(input.workspaceId))
    ) {
      const deferredResult = await this.fileLocks.withLock(input.workspaceId, async () => {
        if (this.userStopLandedSince(input.workspaceId, userStopGenerationAtEntry)) {
          return Err({
            type: "invalid_transition" as const,
            message: GOAL_SET_DISCARDED_BY_USER_STOP_MESSAGE,
          });
        }
        if (
          !(await this.isWorkspaceStreaming(input.workspaceId)) ||
          this.drainSettledWorkspaces.has(input.workspaceId) ||
          this.drainRanForRelevantStreamSince(
            input.workspaceId,
            drainGenerationAtEntry,
            setterStreamStartGenerationAtEntry
          )
        ) {
          // The stream can end while this caller waits for the goal file lock.
          // Persist immediately instead of queueing after stream-end already
          // drained. The drain-generation and settled checks cover the
          // stale-streaming window: the async streaming flag can still read
          // "live" after the drain finished, and a mutation installed then
          // would be stranded.
          return null;
        }
        const current = await this.readGoalFile(input.workspaceId);
        const conflict =
          this.conflictForExpectedGoalId(current, input.expectedGoalId) ??
          this.conflictForReplacementGuard(current, input.replacementGuard);
        if (conflict) {
          return Err(conflict);
        }
        // For an `editInPlace` rename, the eventual drain renames the
        // existing record instead of creating a fresh one. Mirror that path
        // here so the optimistic Goal tab snapshot preserves id/accounting
        // and applies budget-driven status before stream end.
        let projected: GoalRecordV1;
        let projectedIsFreshGoal = false;
        if (input.editInPlace === true && current) {
          const renamed = GoalRecordV1Schema.parse({
            ...current,
            objective,
            updatedAtMs: Date.now(),
          });
          projected = this.applyMutableFields(renamed, input);
        } else if (input.forceNewGoal !== true && current?.objective === objective) {
          const hasMutableChange =
            input.status != null ||
            input.completionSummary != null ||
            Object.hasOwn(input, "budgetCents") ||
            Object.hasOwn(input, "turnCap") ||
            Object.hasOwn(input, "requireUserAcknowledgmentSinceMs");
          projected = hasMutableChange ? this.applyMutableFields(current, input) : current;
        } else {
          projected = this.createGoal({
            objective,
            budgetCents: input.budgetCents ?? null,
            turnCap: input.turnCap ?? null,
            status: input.status,
            completionSummary: input.completionSummary,
          });
          projectedIsFreshGoal = true;
        }
        if (
          (projected.status === "active" || projected.status === "budget_limited") &&
          !(await this.canRunBudgetedGoalOnKickoffModel(input.workspaceId, projected))
        ) {
          return Err({
            type: "invalid_transition" as const,
            message: UNPRICED_TARGET_MODEL_GOAL_MESSAGE,
          });
        }
        if (this.userStopLandedSince(input.workspaceId, userStopGenerationAtEntry)) {
          return Err({
            type: "invalid_transition" as const,
            message: GOAL_SET_DISCARDED_BY_USER_STOP_MESSAGE,
          });
        }
        if (
          !(await this.isWorkspaceStreaming(input.workspaceId)) ||
          this.drainSettledWorkspaces.has(input.workspaceId) ||
          this.drainRanForRelevantStreamSince(
            input.workspaceId,
            drainGenerationAtEntry,
            setterStreamStartGenerationAtEntry
          )
        ) {
          // Avoid queueing after the one stream-end drain has already observed no
          // pending mutation (stale-streaming reads included — see the
          // drain-generation comment on the first recheck above).
          return null;
        }
        // Codex P1 (PRRT_kwDOPxxmWM6b-orH): the mutation must be installed
        // synchronously after the streaming
        // re-check, BEFORE the publication await. `recordUserStoppedStream`
        // deletes pending mutations synchronously before taking the goal file
        // lock, so a user abort landing during publication must find the
        // mutation already installed — installing it afterwards would
        // resurrect a goal the abort just discarded, silently applying it at
        // the end of the NEXT stream (AgentSession deliberately skips the
        // stream-end drain for user aborts).
        const pendingMutation: PendingGoalMutation = {
          objective,
          streamStartGeneration: this.streamStartGenerations.get(input.workspaceId) ?? 0,
          ...(Object.hasOwn(input, "budgetCents")
            ? { budgetCents: input.budgetCents ?? null }
            : {}),
          ...(Object.hasOwn(input, "turnCap") ? { turnCap: input.turnCap ?? null } : {}),
          ...(input.status != null ? { status: input.status } : {}),
          ...(input.completionSummary != null
            ? { completionSummary: input.completionSummary }
            : {}),
          ...(Object.hasOwn(input, "expectedGoalId")
            ? { expectedGoalId: input.expectedGoalId ?? null }
            : {}),
          ...(input.replacementGuard != null ? { replacementGuard: input.replacementGuard } : {}),
          ...(input.initiator != null ? { initiator: input.initiator } : {}),
          ...(input.forceNewGoal != null ? { forceNewGoal: input.forceNewGoal } : {}),
          projectedGoalId: projected.goalId,
          projectedCreatedAtMs: projected.createdAtMs,
          // Forward `editInPlace` so an inline rename submitted while the
          // agent is streaming still takes the rename branch when the
          // pending mutation drains.
          ...(input.editInPlace != null ? { editInPlace: input.editInPlace } : {}),
        };
        this.pendingGoalMutations.set(input.workspaceId, pendingMutation);
        // A user can run /goal while the first turn is still streaming. The
        // durable goal write must wait for stream accounting, but the Goal panel
        // reads activity snapshots, so publish the projected goal immediately
        // without persisting this crash-unsafe optimistic state.
        await this.publishPendingGoalSnapshot(input.workspaceId, projected);
        if (
          projectedIsFreshGoal &&
          this.pendingGoalMutations.get(input.workspaceId) === pendingMutation
        ) {
          // Codex P2 (PRRT_kwDOPxxmWM6b-CH5, PRRT_kwDOPxxmWM6b-Uli): stamp
          // fresh-goal creation AFTER publication completes. createGoal()'s
          // construction stamp predates the kickoff-model validation await,
          // the streaming re-check, and the async activity-snapshot read
          // inside publication — a message queued during any of those awaits
          // postdated that stamp while the goal was not yet visible anywhere.
          // For USER-drained creations, `createdAtMs` feeds the explicit
          // activation consent stamp (see stampUserActivation in the creation
          // branch), so a stale construction-time stamp would misread such a
          // message as an intervention against a goal the user could not have
          // seen. Existing-goal branches keep their original durable
          // createdAtMs — those goals were published long ago.
          //
          // The identity guard (Codex P1 PRRT_kwDOPxxmWM6b-orH) skips the
          // re-stamp when a user abort (or competing setter) removed or
          // replaced OUR mutation during the publication await — re-installing
          // the mutation or snapshot here would resurrect state the abort
          // deliberately discarded.
          const publishedAtMs = Date.now();
          projected = GoalRecordV1Schema.parse({
            ...projected,
            createdAtMs: publishedAtMs,
            updatedAtMs: publishedAtMs,
          });
          this.pendingGoalMutations.set(input.workspaceId, {
            ...pendingMutation,
            projectedCreatedAtMs: publishedAtMs,
          });
          // Sync the in-memory pending snapshot so later re-publishes match
          // what the drain will persist.
          this.pendingGoalSnapshots.set(input.workspaceId, toPendingGoalSnapshot(projected));
        }
        return Ok(projected);
      });
      if (deferredResult != null) {
        return deferredResult;
      }
    }

    if (this.userStopLandedSince(input.workspaceId, userStopGenerationAtEntry)) {
      // Codex P1 (PRRT_kwDOPxxmWM6cCH_H): the abort can also land after the
      // pre-lock admission read `streaming=false` — do not fall through to
      // immediate persistence for a setter the stop meant to discard.
      return Err({
        type: "invalid_transition" as const,
        message: GOAL_SET_DISCARDED_BY_USER_STOP_MESSAGE,
      });
    }
    // Codex P1 (PRRT_kwDOPxxmWM6cClKV): the check above is not the last word —
    // setGoalImmediately still awaits the file lock, kickoff-model validation,
    // history archival, and writes. Carry the stop generation through the
    // locked persistence so an abort landing during any of those awaits
    // discards the change instead of durably creating a goal from the aborted
    // turn.
    return this.setGoalImmediately(
      { ...input, objective },
      { userStopGate: { generationAtEntry: userStopGenerationAtEntry } }
    );
  }

  /** Whether a user stop was recorded after the caller captured `generationAtEntry`. */
  private userStopLandedSince(workspaceId: string, generationAtEntry: number): boolean {
    return (this.userStopGenerationsByWorkspace.get(workspaceId) ?? 0) !== generationAtEntry;
  }

  private async canRunBudgetedGoalOnKickoffModel(
    workspaceId: string,
    goal: GoalRecordV1
  ): Promise<boolean> {
    if (!hasBudgetedResumableGoal(goal)) {
      return true;
    }
    const model = (await this.goalContinuationBridge?.getKickoffSendOptions?.(workspaceId))?.model;
    if (!model) {
      return true;
    }
    return modelHasPricingData(model, this.getProvidersConfigForPricing());
  }

  private async setGoalImmediately(
    input: SetGoalInput & { objective?: string },
    options?: GoalPersistenceOptions
  ): Promise<Result<GoalRecordV1, GoalSetError>> {
    const result = await this.fileLocks.withLock(input.workspaceId, async () => {
      const persisted = await this.persistGoalMutationLocked(input, options);
      // Arm under the same lock tenure as the paused write so no other locked
      // writer can observe the paused record before the hold exists.
      if (this.pauseFinalizationHoldApplies(input, persisted) && persisted.success) {
        this.armPauseFinalizationHold(input.workspaceId, persisted.data.goalId);
      }
      return persisted;
    });
    try {
      return await this.finalizeGoalPersistence(input, result, options);
    } finally {
      if (this.pauseFinalizationHoldApplies(input, result) && result.success) {
        this.releasePauseFinalizationHold(input.workspaceId, result.data.goalId);
      }
    }
  }

  /**
   * Locked core of `setGoalImmediately`: validates guards against the durable
   * record and persists. Callers MUST hold the goal file lock. The stream-end
   * drain calls this inside its claim tenure (Codex P2 PRRT_kwDOPxxmWM6cBACj)
   * so no setter can interleave between claiming a pending mutation and
   * persisting it — every later setter therefore validates its guards against
   * durable state that already includes the drained mutation.
   */
  private async persistGoalMutationLocked(
    input: SetGoalInput & { objective?: string },
    options?: GoalPersistenceOptions
  ): Promise<Result<GoalRecordV1, GoalSetError>> {
    // Codex P1 (PRRT_kwDOPxxmWM6cClKV): recordUserStoppedStream bumps the stop
    // generation synchronously (it does NOT wait for this lock), so a stop can
    // land during any await inside this tenure. Re-check after every await
    // that precedes a durable write so the abort discards the change instead
    // of acknowledging an already-written goal.
    const discardIfUserStopLanded = (): Result<GoalRecordV1, GoalSetError> | null =>
      options?.userStopGate != null &&
      this.userStopLandedSince(input.workspaceId, options.userStopGate.generationAtEntry)
        ? Err({
            type: "invalid_transition" as const,
            message: GOAL_SET_DISCARDED_BY_USER_STOP_MESSAGE,
          })
        : null;
    {
      const stoppedBeforeRead = discardIfUserStopLanded();
      if (stoppedBeforeRead) {
        return stoppedBeforeRead;
      }
      const current = await this.readGoalFile(input.workspaceId);
      const conflict =
        this.conflictForExpectedGoalId(current, input.expectedGoalId) ??
        this.conflictForReplacementGuard(current, input.replacementGuard);
      if (conflict) {
        return Err(conflict);
      }
      const trimmedObjective = input.objective?.trim();
      const objective =
        trimmedObjective && trimmedObjective.length > 0 ? trimmedObjective : current?.objective;
      if (!objective) {
        // No objective + status mutation + no current goal will fall into
        // `validateStatusTransition(null, ...)` below, which throws a typed
        // `WorkspaceGoalTransitionError`. That throw is caught by the outer
        // `setGoal` wrapper and surfaced as a typed `invalid_transition`
        // Result error — no
        // unhandled 500 reaches the oRPC layer.
        if (input.status != null) {
          this.validateStatusTransition(
            null,
            input.status,
            input.completionSummary?.trim() ?? null,
            input.initiator ?? "user"
          );
        }
        // No-objective + no-status path (e.g. RightSidebar "Update budget"
        // race where another window cleared the goal concurrently): use the
        // typed transition error so the outer `setGoal` wrapper surfaces it
        // as a typed `invalid_transition` Result instead of letting a plain
        // Error escape as an unhandled 500.
        throw new WorkspaceGoalTransitionError(
          "Goal objective is required because no goal currently exists for this workspace."
        );
      }

      // Edit-in-place objective change: when the caller is the right-sidebar
      // "Edit goal objective" affordance (or any other entry point that opts in
      // via `editInPlace`), changing the objective on the existing goal should
      // feel like editing budget / turn-cap — preserve `goalId` + accounting.
      // The default `setGoal` path (slash command, kickoff prompts) still
      // archives + recreates because callers there express the intent "start a
      // new goal", not "rename the current one".
      const isEditInPlace =
        input.editInPlace === true && current != null && current.objective !== objective;
      if (isEditInPlace) {
        const previousStatus = current.status;
        const renamed = GoalRecordV1Schema.parse({
          ...current,
          objective,
          updatedAtMs: Date.now(),
        });
        // Apply other inline edits (status / budget / turnCap) on top of the
        // renamed record so a single payload can rename and update budget
        // atomically.
        const withEdits = this.stampUserActivation(
          this.applyMutableFields(renamed, input),
          current.status,
          input.initiator,
          Date.now()
        );
        if (
          (withEdits.status === "active" || withEdits.status === "budget_limited") &&
          !(await this.canRunBudgetedGoalOnKickoffModel(input.workspaceId, withEdits))
        ) {
          return Err({
            type: "invalid_transition" as const,
            message: UNPRICED_TARGET_MODEL_GOAL_MESSAGE,
          });
        }
        const stoppedBeforeEditWrite = discardIfUserStopLanded();
        if (stoppedBeforeEditWrite) {
          return stoppedBeforeEditWrite;
        }
        await this.writeGoal(input.workspaceId, withEdits);
        // Codex P1 (PRRT_kwDOPxxmWM6cMpoV): same post-write window as the
        // same-objective and creation branches — a queued rename claimed by
        // the stream-end drain (or a live-stream edit) can have the Stop land
        // inside writeGoal, after the pre-write check passed. Restore the
        // prior record before releasing the lock so the aborted turn's edit
        // never survives.
        const stoppedDuringEditWrite = discardIfUserStopLanded();
        if (stoppedDuringEditWrite) {
          await this.writeGoal(input.workspaceId, current);
          await this.pushSnapshot(input.workspaceId, current);
          return stoppedDuringEditWrite;
        }
        await this.pushSnapshot(input.workspaceId, withEdits);
        await this.pushLiveGoalPreviewOverlay(input.workspaceId, withEdits);
        // Codex P1 (PRRT_kwDOPxxmWM6cOHpB): same publication-await window as
        // the same-objective branch — keep the veto active through the final
        // awaited publication step.
        const stoppedDuringEditPublication = discardIfUserStopLanded();
        if (stoppedDuringEditPublication) {
          await this.writeGoal(input.workspaceId, current);
          await this.pushSnapshot(input.workspaceId, current);
          return stoppedDuringEditPublication;
        }
        this.emitBudgetChanged(current, withEdits, input);
        this.emitBudgetLimited(input.workspaceId, withEdits, previousStatus);
        this.emitStatusLifecycle(withEdits, previousStatus, input.initiator ?? "user");
        // Lifecycle event: this is a rename, not a replace. Reuse
        // `goal_replaced` (same-objective semantics already overloaded for
        // attribute-only mutations) with `sameObjective: false` so analytics
        // can still distinguish rename from a full reset by checking
        // `goalId` continuity in the funnel.
        this.emitLifecycle("goal_replaced", {
          sameObjective: false,
          objectiveLengthBucket: lengthBucket(objective.length),
          hasBudget: withEdits.budgetCents != null,
          hasTurnCap: withEdits.turnCap != null,
          editInPlace: true,
        });
        await this.maybeAutoPromoteOnComplete(input.workspaceId, withEdits, previousStatus, {
          stopVeto: () => discardIfUserStopLanded() != null,
        });
        // Codex P1 (PRRT_kwDOPxxmWM6cOgXV): same conditional restore as the
        // same-objective branch (see comment there).
        const stoppedDuringEditPromotion = discardIfUserStopLanded();
        if (stoppedDuringEditPromotion) {
          const durableNow = await this.readGoalFile(input.workspaceId);
          if (durableNow?.goalId === withEdits.goalId) {
            await this.writeGoal(input.workspaceId, current);
            await this.pushSnapshot(input.workspaceId, current);
            return stoppedDuringEditPromotion;
          }
        }
        return Ok(withEdits);
      }

      if (input.forceNewGoal !== true && current?.objective === objective) {
        const hasMutableChange =
          input.status != null ||
          input.completionSummary != null ||
          Object.hasOwn(input, "budgetCents") ||
          Object.hasOwn(input, "turnCap") ||
          Object.hasOwn(input, "requireUserAcknowledgmentSinceMs");
        const previousStatus = current.status;
        let updated = hasMutableChange ? this.applyMutableFields(current, input) : current;
        if (hasMutableChange) {
          if (
            (updated.status === "active" || updated.status === "budget_limited") &&
            !(await this.canRunBudgetedGoalOnKickoffModel(input.workspaceId, updated))
          ) {
            return Err({
              type: "invalid_transition" as const,
              message: UNPRICED_TARGET_MODEL_GOAL_MESSAGE,
            });
          }
          const stoppedBeforeMutableWrite = discardIfUserStopLanded();
          if (stoppedBeforeMutableWrite) {
            return stoppedBeforeMutableWrite;
          }

          // User resume is an explicit opt-in after a stop/crash gate; clear
          // both the in-memory stop marker and persisted acknowledgment gate.
          if (
            previousStatus === "paused" &&
            updated.status === "active" &&
            (input.initiator ?? "user") === "user"
          ) {
            this.lastUserStopAtMsByWorkspace.delete(input.workspaceId);
            updated = GoalRecordV1Schema.parse({
              ...updated,
              requireUserAcknowledgmentSinceMs: null,
              updatedAtMs: Date.now(),
            });
          }
          updated = this.stampUserActivation(updated, previousStatus, input.initiator, Date.now());
          await this.writeGoal(input.workspaceId, updated);
          // Codex P1 (PRRT_kwDOPxxmWM6cLpIP): the write itself yields. A model
          // complete_goal takes this direct branch during the live stream; a
          // Stop landing inside writeGoal advances the generation
          // synchronously but its locked section queues behind this tenure —
          // and for an already-complete goal it neither discards nor installs
          // an acknowledgment gate. Recheck after the write and restore the
          // prior record before releasing the lock so the aborted turn's
          // mutation never survives (the stop's queued section then gates the
          // restored record normally).
          const stoppedDuringMutableWrite = discardIfUserStopLanded();
          if (stoppedDuringMutableWrite) {
            await this.writeGoal(input.workspaceId, current);
            await this.pushSnapshot(input.workspaceId, current);
            return stoppedDuringMutableWrite;
          }
          await this.pushSnapshot(input.workspaceId, updated);
          await this.pushLiveGoalPreviewOverlay(input.workspaceId, updated);
          // Codex P1 (PRRT_kwDOPxxmWM6cOHpB): the publication awaits above run
          // inside the same lock tenure AFTER the post-write sample — a Stop
          // landing during them would leave the aborted turn's mutation (e.g.
          // a model complete_goal) durable with nothing left to discard it.
          // Keep the veto active through the final awaited publication step;
          // the restore also re-publishes the prior snapshot, superseding the
          // transiently published mutation.
          const stoppedDuringPublication = discardIfUserStopLanded();
          if (stoppedDuringPublication) {
            await this.writeGoal(input.workspaceId, current);
            await this.pushSnapshot(input.workspaceId, current);
            return stoppedDuringPublication;
          }
          this.emitBudgetChanged(current, updated, input);
          this.emitBudgetLimited(input.workspaceId, updated, previousStatus);
          this.emitStatusLifecycle(updated, previousStatus, input.initiator ?? "user");
          await this.maybeAutoPromoteOnComplete(input.workspaceId, updated, previousStatus, {
            stopVeto: () => discardIfUserStopLanded() != null,
          });
          // Codex P1 (PRRT_kwDOPxxmWM6cOgXV): auto-promotion awaits board/
          // streaming/pricing reads after the publication sample. The vetoes
          // inside it prevent promotion writes once a stop lands, so if the
          // durable record is still this turn's completion, restore the prior
          // record; if a promotion already replaced goal.json (stop landed
          // inside the promotion writes), leave it — the stop's queued
          // section gates the promoted active goal instead.
          const stoppedDuringPromotion = discardIfUserStopLanded();
          if (stoppedDuringPromotion) {
            const durableNow = await this.readGoalFile(input.workspaceId);
            if (durableNow?.goalId === updated.goalId) {
              await this.writeGoal(input.workspaceId, current);
              await this.pushSnapshot(input.workspaceId, current);
              return stoppedDuringPromotion;
            }
          }
        }
        if (input.objective != null) {
          this.emitLifecycle("goal_replaced", {
            sameObjective: true,
            objectiveLengthBucket: lengthBucket(objective.length),
            hasBudget: updated.budgetCents != null,
            hasTurnCap: updated.turnCap != null,
          });
        }
        return Ok(updated);
      }

      let next = this.createGoal({
        objective,
        budgetCents: input.budgetCents ?? null,
        turnCap: input.turnCap ?? null,
        status: input.status,
        completionSummary: input.completionSummary,
        goalId: options?.replacementGoalId ?? null,
        createdAtMs: options?.replacementCreatedAtMs ?? null,
      });
      if (
        (next.status === "active" || next.status === "budget_limited") &&
        !(await this.canRunBudgetedGoalOnKickoffModel(input.workspaceId, next))
      ) {
        return Err({
          type: "invalid_transition" as const,
          message: UNPRICED_TARGET_MODEL_GOAL_MESSAGE,
        });
      }
      const stoppedBeforeArchive = discardIfUserStopLanded();
      if (stoppedBeforeArchive) {
        return stoppedBeforeArchive;
      }
      this.liveGoalPreviewSnapshots.delete(input.workspaceId);
      // Archive the outgoing goal to history before we overwrite goal.json.
      // The new goal gets a fresh `goalId` so the right-sidebar GoalTab needs
      // a record of the prior one in its completed-goals list (cleared/
      // replaced/completed all flow through here for the "previous current
      // goal" snapshot).
      if (current) {
        await this.appendGoalHistoryEntry(
          input.workspaceId,
          current,
          current.status === "complete" ? "completed" : "replaced"
        );
        // A stop landing during the archive append leaves a cosmetic history
        // entry, but the durable goal.json write below must still be
        // discarded.
        const stoppedAfterArchive = discardIfUserStopLanded();
        if (stoppedAfterArchive) {
          return stoppedAfterArchive;
        }
      }
      if (options?.replacementCreatedAtMs == null) {
        // Codex P2 (PRRT_kwDOPxxmWM6cBr9B): direct creations must also carry a
        // publication-time createdAtMs. The construction stamp predates the
        // kickoff-model validation and history-archive awaits — a message the
        // user authored during those long awaits would postdate it and be
        // misread as an intervention against a goal not yet visible.
        //
        // Codex P2 (PRRT_kwDOPxxmWM6cDhNO): the stamp is taken BEFORE the
        // single durable write below (not re-stamped after the snapshot push)
        // so the record and its visibility stamp commit atomically — a crash
        // can never leave the provisional construction stamp on disk for
        // restart reconciliation to misread. The residual gap is only the
        // write+push awaits themselves (local file I/O, milliseconds): a
        // message authored inside that gap fails toward a pause the user can
        // Resume, whereas a crash-stranded stale stamp silently paused a
        // never-driven goal with no signal. Drained queued mutations pass
        // replacementCreatedAtMs and already carry their publication stamp.
        const publishedAtMs = Date.now();
        next = GoalRecordV1Schema.parse({
          ...next,
          createdAtMs: publishedAtMs,
          updatedAtMs: publishedAtMs,
        });
      }
      // Consent anchor for the queue-race pause bypasses: `createdAtMs` is the
      // moment the user's create action became visible (direct creates) or the
      // drained user mutation's publication stamp — a message authored before
      // it was pending when the user acted. Model-initiated creations never
      // stamp (fail closed).
      next = this.stampUserActivation(next, null, input.initiator, next.createdAtMs);
      await this.writeGoal(input.workspaceId, next);
      // Codex P1 (PRRT_kwDOPxxmWM6cMGn8): the creation/replacement write
      // itself yields — this is the stream-end drain's main path for a
      // mid-stream set_goal. Mirror the mutable-branch post-write recheck
      // (PRRT_kwDOPxxmWM6cLpIP): a Stop landing inside the write must not
      // leave the aborted turn's goal durable. The archive entry above stays
      // (cosmetic, same as a stop during the archive append); the durable
      // record is restored — or removed when no goal existed before.
      const stoppedDuringCreateWrite = discardIfUserStopLanded();
      if (stoppedDuringCreateWrite) {
        if (current) {
          await this.writeGoal(input.workspaceId, current);
          await this.pushSnapshot(input.workspaceId, current);
        } else {
          await fs.rm(this.getFilePath(input.workspaceId), { force: true });
          await this.pushSnapshot(input.workspaceId, null);
        }
        return stoppedDuringCreateWrite;
      }
      await this.pushSnapshot(input.workspaceId, next);
      // Codex P1 (PRRT_kwDOPxxmWM6cOHpB): the snapshot publication also runs
      // inside this tenure after the post-write sample — keep the veto active
      // through it (same restore as the post-write branch above).
      const stoppedDuringCreatePublication = discardIfUserStopLanded();
      if (stoppedDuringCreatePublication) {
        if (current) {
          await this.writeGoal(input.workspaceId, current);
          await this.pushSnapshot(input.workspaceId, current);
        } else {
          await fs.rm(this.getFilePath(input.workspaceId), { force: true });
          await this.pushSnapshot(input.workspaceId, null);
        }
        return stoppedDuringCreatePublication;
      }
      this.emitBudgetChanged(current, next, input);
      this.emitLifecycle(current ? "goal_replaced" : "goal_created", {
        sameObjective: current?.objective === objective,
        objectiveLengthBucket: lengthBucket(objective.length),
        hasBudget: next.budgetCents != null,
        hasTurnCap: next.turnCap != null,
      });
      return Ok(next);
    }
  }

  /**
   * Post-lock finalization shared by `setGoalImmediately` and the stream-end
   * drain: lifecycle/timeline side effects, pause-boundary handling, kickoff
   * arming, and chat-tail syncs. Runs outside the goal file lock.
   */
  private async finalizeGoalPersistence(
    input: SetGoalInput & { objective?: string },
    result: Result<GoalRecordV1, GoalSetError>,
    options?: GoalPersistenceOptions
  ): Promise<Result<GoalRecordV1, GoalSetError>> {
    if (!result.success) {
      return result;
    }
    // Codex P1 (PRRT_kwDOPxxmWM6cClKV): a stop landing after the durable write
    // but before finalization already cleared continuation candidates — arming
    // here would resurrect the autonomous loop the abort meant to halt. Only
    // the arming side effects are stop-opposed: pause boundaries and chat-tail
    // syncs make the written record stick and must still run. Evaluated lazily
    // at each arm site so stops landing during earlier finalization awaits are
    // seen too.
    const stopVetoesArming = (): boolean =>
      options?.userStopGate != null &&
      this.userStopLandedSince(input.workspaceId, options.userStopGate.generationAtEntry);

    if (input.objective != null) {
      this.recordGoalSet(input.workspaceId, result.data);
    }
    if (input.status === "complete" && result.data.status === "complete") {
      this.timelineRecorder.record(input.workspaceId, {
        kind: "goal.completed",
        source: {
          system: "goal",
          key: `goal-completed:${result.data.goalId}:${result.data.updatedAtMs}`,
        },
        status: "completed",
        data: { digest: result.data.completionSummary ?? result.data.objective },
      });
    }

    if (input.status === "paused" && result.data.status === "paused") {
      // Codex P2 (PRRT_kwDOPxxmWM6cECpZ): finalization runs outside the goal
      // file lock, so a replacement or clear-and-promote queued behind our
      // pause can persist before this resumes. Applying stale pause side
      // effects would delete the NEWER goal's continuation candidate and
      // append a pause boundary that chat-tail sync applies to the newer goal
      // — silently pausing a replacement the user just created. Re-verify the
      // paused goal is still the durable record (mirrors the arming identity
      // check below); no await sits between this read and the candidate
      // delete.
      const durableAtPause = await this.readGoalFile(input.workspaceId);
      if (durableAtPause?.goalId !== result.data.goalId || durableAtPause.status !== "paused") {
        return result;
      }
      this.pendingContinuationCandidates.delete(input.workspaceId);
      const pauseBoundaryReady = await this.appendGoalPauseBoundaryIfNeeded(
        input.workspaceId,
        result.data.goalId
      );
      if (!pauseBoundaryReady) {
        return result;
      }
      const synced = await this.syncGoalStatusToChatTail(input.workspaceId);
      return Ok(synced ?? result.data);
    }

    if (result.data.status === "active") {
      if (!stopVetoesArming()) {
        await this.armKickoffContinuationIfIdle(input.workspaceId, result.data);
      }
      if (input.initiator === "model") {
        // A model-created set_goal starts from an ordinary user turn, not a
        // goal-continuation row. Do not reconcile it against chat tail here or
        // the new goal pauses itself before its kickoff continuation can run.
        return result;
      }
      const synced = await this.syncGoalStatusToChatTail(input.workspaceId);
      return Ok(synced ?? result.data);
    }
    if (result.data.status === "budget_limited" && !stopVetoesArming()) {
      await this.armBudgetWrapupForBudgetLimitedGoal(input.workspaceId, result.data);
    }
    return result;
  }

  /**
   * Arm a pending continuation candidate whose request and stream-end
   * timestamps are both "now". Shared by the kickoff and budget-wrap-up paths,
   * which arm an otherwise-identical candidate differing only in `source`. The
   * stream_end path is intentionally not routed through here because it carries
   * an inbound `streamEndedAtMs` and pre-normalized `sendOptions`.
   */
  private armImmediateContinuationCandidate(
    workspaceId: string,
    goal: GoalRecordV1,
    source: "kickoff" | "budget_wrapup",
    sendOptions: SendMessageOptions
  ): void {
    const nowMs = Date.now();
    this.pendingContinuationCandidates.set(workspaceId, {
      goalId: goal.goalId,
      requestedAtMs: nowMs,
      streamEndedAtMs: nowMs,
      source,
      sendOptions: continuationSendOptions(sendOptions),
    });
  }

  private async armKickoffContinuationIfIdle(
    workspaceId: string,
    goal: GoalRecordV1
  ): Promise<void> {
    if (this.suppressKickoffContinuation) {
      return;
    }
    if (goal.status !== "active") {
      return;
    }
    if (this.goalContinuationDispatcher == null || this.goalContinuationBridge == null) {
      return;
    }
    const existingCandidate = this.pendingContinuationCandidates.get(workspaceId);
    if (existingCandidate?.goalId === goal.goalId) {
      // A real stream-end already armed this goal; re-request dispatch in case
      // the previous request was consumed while an acknowledgment gate was set.
      try {
        await this.goalContinuationDispatcher.requestDispatch(
          workspaceId,
          GOAL_CONTINUATION_IDLE_CONSUMER_NAME
        );
      } catch (error: unknown) {
        log.warn("Failed to re-request kickoff goal continuation dispatch", {
          workspaceId,
          error,
        });
      }
      return;
    }
    const sendOptions = await this.goalContinuationBridge.getKickoffSendOptions?.(workspaceId);
    if (!sendOptions) {
      return;
    }
    if (sendOptions.agentId === "plan" || sendOptions.agentId === "compact") {
      return;
    }
    // Codex P2 (PRRT_kwDOPxxmWM6cClKY): the kickoff-options await above runs
    // outside the goal file lock, so a newer setter can persist a replacement
    // goal AND arm its own candidate while this stale finalizer is suspended.
    // Arming now would overwrite the newer goal's candidate with one that
    // eligibility drops for goal-ID mismatch, leaving the durable goal with no
    // kickoff. Re-verify this goal is still the durable active record, and do
    // not overwrite a candidate that already belongs to it (no await sits
    // between these checks and the arm below). A candidate for a DIFFERENT
    // goal is stale by definition here — we just proved ours is durable — and
    // must be replaced, or the durable goal is the one left kickoff-less.
    const durable = await this.readGoalFile(workspaceId);
    if (durable?.goalId !== goal.goalId || durable.status !== "active") {
      return;
    }
    if (this.pendingContinuationCandidates.get(workspaceId)?.goalId === goal.goalId) {
      return;
    }

    this.armImmediateContinuationCandidate(workspaceId, goal, "kickoff", sendOptions);
    try {
      await this.goalContinuationDispatcher.requestDispatch(
        workspaceId,
        GOAL_CONTINUATION_IDLE_CONSUMER_NAME
      );
    } catch (error: unknown) {
      log.warn("Failed to request kickoff goal continuation dispatch", { workspaceId, error });
    }
  }

  // Promotions write goal.json directly instead of going through `setGoal`, so they must record the
  // new objective themselves: otherwise the workspace's active goal changes with no timeline row.
  private recordGoalSet(workspaceId: string, goal: GoalRecordV1): void {
    this.timelineRecorder.record(workspaceId, {
      kind: "goal.set",
      source: { system: "goal", key: `goal-set:${goal.goalId}:${goal.updatedAtMs}` },
      status: "completed",
      data: { digest: goal.objective },
    });
  }

  private armContinuationForPromotedGoal(workspaceId: string, goal: GoalRecordV1): void {
    // Promotion is an explicit handoff to this queued goal. Any stop/ack gate
    // was attached to an older active turn and would otherwise strand the
    // promoted goal until the user pause/unpauses it.
    this.lastUserStopAtMsByWorkspace.delete(workspaceId);
    if (goal.status === "active") {
      this.armKickoffContinuationIfIdle(workspaceId, goal).catch((error: unknown) => {
        log.warn("Failed to arm promoted goal continuation", { workspaceId, error });
      });
    } else if (goal.status === "budget_limited") {
      this.armBudgetWrapupForBudgetLimitedGoal(workspaceId, goal).catch((error: unknown) => {
        log.warn("Failed to arm promoted goal budget wrap-up", { workspaceId, error });
      });
    }
  }

  /**
   * Re-arm pending continuation / budget-wrap-up dispatches after a process
   * restart. `pendingContinuationCandidates` and `lastGoalStreamStamps` are
   * in-memory and are wiped on restart; the goal record on disk is the
   * persisted source of truth, so we re-derive whatever dispatch state is
   * owed by the persisted status.
   *
   * Without this, a `budget_limited` goal with `budgetLimitInjectedForGoalId
   * === null` (i.e. the budget was hit but the wrap-up message had not yet
   * fired before the crash) is permanently stranded:
   *   - eligibility lookup finds no in-memory stamp and returns
   *     `budget_wrapup_suppressed`, deleting the candidate.
   *   - `armKickoffContinuationIfIdle` only fires for `status === "active"`.
   *
   * The user would need to manually clear the goal or raise the budget to
   * recover. Instead we synthesize the stamp + candidate so the wrap-up can
   * fire on the next idle moment.
   *
   * Called from `AgentSession.runStartupRecovery` per workspace.
   */
  async recoverPendingDispatchAfterRestart(workspaceId: string): Promise<void> {
    assert(
      workspaceId.trim().length > 0,
      "recoverPendingDispatchAfterRestart requires workspaceId"
    );
    const goal = await this.normalizeGoalLimits(workspaceId, { syncChatTail: true });
    if (!goal) {
      return;
    }
    if (goal.status === "active") {
      await this.armKickoffContinuationIfIdle(workspaceId, goal);
      await this.syncGoalStatusToChatTail(workspaceId);
      return;
    }
    if (goal.status === "budget_limited" && goal.budgetLimitInjectedForGoalId === null) {
      // only synthesize a wrap-up if the stream that hit the
      // budget was goal-attributable. A user-origin stream that exhausted
      // the budget was correctly suppressed pre-restart
      // (`checkGoalContinuationEligibility` rejects it as
      // `budget_wrapup_suppressed`); after restart we'd otherwise lose that
      // suppression because in-memory `lastGoalStreamStamps` is empty and
      // this function would synthesize a `GOAL_CONTINUATION_KIND` stamp.
      // Legacy goal records with `budgetLimitOriginKind` undefined arm by
      // default — the field is new and most existing budget_limited goals
      // would otherwise be permanently stranded.
      const originKind = goal.budgetLimitOriginKind ?? null;
      if (originKind === "user") {
        return;
      }
      await this.armBudgetWrapupForBudgetLimitedGoal(workspaceId, goal);
    }
  }

  /**
   * Synthesize a `GOAL_CONTINUATION_KIND` stream stamp + arm a continuation
   * candidate so the budget-wrap-up eligibility check passes its identity
   * guards (`lastStreamStamp.goalId === goal.goalId` && a non-user origin).
   *
   * Called from two paths:
   *   1. `recoverPendingDispatchAfterRestart` — in-memory dispatch state was
   *      wiped on restart and the persisted goal is `budget_limited` with no
   *      wrap-up injected.
   *   2. `attributeChildReport` — a child task's cost rolled the goal into
   *      `budget_limited`. Without this the wrap-up never fires because the
   *      attribution path does not produce a continuation-origin stream.
   */
  private async armBudgetWrapupForBudgetLimitedGoal(
    workspaceId: string,
    goal: GoalRecordV1
  ): Promise<void> {
    if (this.goalContinuationDispatcher == null || this.goalContinuationBridge == null) {
      return;
    }
    if (this.pendingContinuationCandidates.has(workspaceId)) {
      return;
    }
    const sendOptions = await this.goalContinuationBridge.getKickoffSendOptions?.(workspaceId);
    if (!sendOptions || sendOptions.agentId === "plan" || sendOptions.agentId === "compact") {
      return;
    }
    // Codex P2 (PRRT_kwDOPxxmWM6cClKY): mirror the kickoff arming re-check —
    // the options await runs unlocked, so a candidate armed (or a replacement
    // goal persisted) during it must win over this stale wrap-up finalizer.
    if (this.pendingContinuationCandidates.has(workspaceId)) {
      return;
    }
    const durable = await this.readGoalFile(workspaceId);
    if (
      durable?.goalId !== goal.goalId ||
      durable.status !== "budget_limited" ||
      // Codex P2 (PRRT_kwDOPxxmWM6cMpoe): manual suppression can complete
      // during the unlocked awaits above (or before a caller passing a stale
      // record). A durable user-origin record means the user already
      // intervened — overwriting the live user-origin stamp with a
      // goal-attributable one here would resurrect the wrap-up the
      // suppression just disarmed.
      durable.budgetLimitOriginKind === "user" ||
      this.pendingContinuationCandidates.has(workspaceId)
    ) {
      return;
    }

    this.recordLastGoalStream(workspaceId, GOAL_CONTINUATION_KIND, goal.goalId);
    this.armImmediateContinuationCandidate(workspaceId, goal, "budget_wrapup", sendOptions);
    this.goalContinuationDispatcher
      .requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME)
      .catch((error: unknown) => {
        log.warn("Failed to request budget-wrap-up dispatch", {
          workspaceId,
          error,
        });
      });
  }

  async requireUserAcknowledgment(
    workspaceId: string,
    sinceMs = Date.now()
  ): Promise<GoalRecordV1 | null> {
    assert(
      Number.isInteger(sinceMs) && sinceMs >= 0,
      "requireUserAcknowledgment requires a non-negative integer timestamp"
    );
    return this.fileLocks.withLock(workspaceId, async () => {
      const current = await this.readGoalFile(workspaceId);
      if (!current) {
        await this.pushSnapshot(workspaceId, null);
        return null;
      }
      const next = this.applyMutableFields(current, {
        workspaceId,
        requireUserAcknowledgmentSinceMs: sinceMs,
      });
      await this.writeGoal(workspaceId, next);
      await this.pushSnapshot(workspaceId, next);
      return next;
    });
  }

  async acknowledgeUser(
    workspaceId: string,
    options?: { authoredAtMs?: number | null }
  ): Promise<GoalRecordV1 | null> {
    assert(workspaceId.trim().length > 0, "acknowledgeUser requires workspaceId");
    return this.fileLocks.withLock(workspaceId, async () => {
      const current = await this.readGoalFile(workspaceId);
      if (!current) {
        await this.pushSnapshot(workspaceId, null);
        return null;
      }
      if (current.requireUserAcknowledgmentSinceMs == null) {
        await this.pushSnapshot(workspaceId, current);
        return current;
      }
      // Codex P1 (PRRT_kwDOPxxmWM6cECpj): a message authored BEFORE the
      // acknowledgment gate was set cannot acknowledge it. A pre-goal send
      // stuck in preflight across a user stop would otherwise clear the
      // stop's durable gate; its pre-goal classification then skips the
      // auto-pause, so after a restart (which loses the in-memory stop
      // timestamp) recovery re-arms the goal despite the newer Stop. Callers
      // acting for an explicit fresh user action (slash workflows, direct
      // sends carrying their request-entry authoring time) postdate the gate
      // and clear it as before. Equality is treated as stale (Codex P1
      // PRRT_kwDOPxxmWM6cHJVn): a same-millisecond timestamp cannot prove the
      // send was admitted after the Stop, and keeping the gate is the safe
      // failure mode — the user can always acknowledge with a later message.
      const authoredAtMs = toValidEpochMs(options?.authoredAtMs);
      if (authoredAtMs != null && authoredAtMs <= current.requireUserAcknowledgmentSinceMs) {
        await this.pushSnapshot(workspaceId, current);
        return current;
      }

      const next = this.applyMutableFields(current, {
        workspaceId,
        requireUserAcknowledgmentSinceMs: null,
      });
      await this.writeGoal(workspaceId, next);
      await this.pushSnapshot(workspaceId, next);
      return next;
    });
  }

  /**
   * Durably suppress the autonomous budget wrap-up after a post-limit manual
   * user message. Deleting the in-memory candidate is not enough: after a
   * restart, `recoverPendingDispatchAfterRestart` sees a goal-attributable
   * `budgetLimitOriginKind` with `budgetLimitInjectedForGoalId === null` and
   * re-synthesizes the wrap-up despite the user's intervening message (Codex
   * P2 PRRT_kwDOPxxmWM6cJ6NM). Re-stamping the origin as `"user"` reuses the
   * existing durable suppression the recovery path already honors.
   */
  async suppressBudgetWrapupForManualUserMessage(
    workspaceId: string,
    goalId: string
  ): Promise<void> {
    assert(
      workspaceId.trim().length > 0,
      "suppressBudgetWrapupForManualUserMessage requires workspaceId"
    );
    assert(goalId.trim().length > 0, "suppressBudgetWrapupForManualUserMessage requires goalId");
    return this.fileLocks.withLock(workspaceId, async () => {
      const current = await this.readGoalFile(workspaceId);
      // Codex P2 (PRRT_kwDOPxxmWM6cLpID): scope the suppression to the goal
      // the manual message actually acknowledged. A replacement goal that
      // persisted while the acknowledgment await unwound owes its own wrap-up
      // — a pre-replacement message cannot have been intervening against it.
      if (current?.status !== "budget_limited" || current.goalId !== goalId) {
        return;
      }
      // Codex P2 (PRRT_kwDOPxxmWM6cLA0M): persist the durable origin FIRST.
      // Publishing the in-memory suppression before the write would let a
      // failed write leave this process suppressing the wrap-up while
      // goal.json stays goal-attributable — after a restart, recovery would
      // re-arm the autonomous wrap-up despite the manual intervention.
      // Memory only updates after the durable state it mirrors exists.
      // Codex P2 (PRRT_kwDOPxxmWM6cKkGL): the durable stamp only protects
      // restarts. The LIVE stream stamp stays goal-attributable through the
      // manual turn's own accounting (recordStreamAccounting preserves
      // budget_limited stamps), so the manual turn's stream-end would arm a
      // fresh candidate that wrap-up eligibility accepts — dispatching the
      // autonomous wrap-up right after the user's intervention. Re-mark the
      // live stamp user-origin so eligibility rejects it in-process too.
      const markLiveStampUserOrigin = (): void => {
        const liveStamp = this.lastGoalStreamStamps.get(workspaceId);
        if (liveStamp?.goalId === current.goalId && liveStamp.originKind !== "user") {
          this.lastGoalStreamStamps.set(workspaceId, { ...liveStamp, originKind: "user" });
        }
      };
      if (current.budgetLimitOriginKind !== "user") {
        const next = GoalRecordV1Schema.parse({
          ...current,
          budgetLimitOriginKind: "user",
          updatedAtMs: Date.now(),
        });
        await this.writeGoal(workspaceId, next);
        // Codex P2 (PRRT_kwDOPxxmWM6cMpob): the durable origin is committed —
        // publish the live suppression BEFORE the snapshot await. A snapshot
        // failure after the write would otherwise throw out of this method
        // with the live stamp still goal-attributable, letting this process's
        // stream-end arm the wrap-up while goal.json already says "user".
        markLiveStampUserOrigin();
        await this.pushSnapshot(workspaceId, next);
      } else {
        markLiveStampUserOrigin();
      }
    });
  }

  async requireUserAcknowledgmentForCrashRecovery(
    workspaceId: string,
    sinceMs = Date.now()
  ): Promise<GoalRecordV1 | null> {
    assert(
      Number.isInteger(sinceMs) && sinceMs >= 0,
      "requireUserAcknowledgmentForCrashRecovery requires a non-negative integer timestamp"
    );
    const next = await this.requireUserAcknowledgment(workspaceId, sinceMs);
    if (next) {
      this.emitLifecycle("goal_crash_gate_set", {
        workspaceIdLengthBucket: lengthBucket(workspaceId.length),
      });
    }
    return next;
  }

  private recordLastGoalStream(
    workspaceId: string,
    originKind: GoalStreamOriginKind,
    goalId: string | null
  ): GoalStreamStamp {
    const stamp = {
      originKind,
      sequence: this.nextGoalStreamStampSequence,
      goalId,
    };
    this.nextGoalStreamStampSequence += 1;
    this.lastGoalStreamStamps.set(workspaceId, stamp);
    return stamp;
  }

  /**
   * A stream whose cost previews became ineligible mid-flight (the goal was
   * paused/completed, or a budget edit flipped it to budget_limited while a
   * maintenance stream ran) must not keep showing its earlier live preview.
   *
   * Codex P2 (PRRT_kwDOPxxmWM6cEl4P): merely returning the durable snapshot
   * left the stale preview cached in `liveGoalPreviewSnapshots`, where
   * `pushLiveGoalPreviewOverlay` kept re-emitting cost that final accounting
   * discards — the Goal UI then snapped backward only at stream end. Clear the
   * cache and publish the durable record once, so later deltas (no cached
   * preview) stay cheap no-ops.
   */
  private async resetIneligibleCostPreview(
    workspaceId: string,
    current: GoalRecordV1
  ): Promise<GoalSnapshot | null> {
    if (this.liveGoalPreviewSnapshots.has(workspaceId)) {
      // Codex P2 (PRRT_kwDOPxxmWM6cOgXY): publish BEFORE clearing the cache.
      // Deleting first meant a failed publication left no cached preview for
      // later deltas to observe, so the reset was never retried and the Goal
      // UI kept the stale cost until an unrelated snapshot happened to
      // succeed. If the push throws, the cache stays intact and the next
      // usage delta retries the reset.
      const snapshot = await this.pushSnapshot(workspaceId, current);
      this.liveGoalPreviewSnapshots.delete(workspaceId);
      return snapshot;
    }
    return toGoalSnapshot(current);
  }

  /**
   * Push a live cost preview to the activity snapshot. The cost is the
   * cumulative current-stream cost on top of the durable base;
   * `recordStreamAccounting` performs final accounting at stream end.
   *
   * Previously this path always called `pushSnapshot` which rewrote the
   * shared `extensionMetadata.json` (writeFileAtomic, serialized through a
   * global mutation lock) on every `usage-delta` event. That made the Goals
   * UI cost lag behind the Stats/Costs tabs mid-stream: Stats reads the
   * frontend aggregator in-memory, while Goal cost waited on a per-delta
   * disk write + activity round-trip. Restart recovery overwrites
   * extensionMetadata from goal.json anyway (`restorePersistedGoalSnapshot`
   * and `restoreGoalAccountingSnapshot`), so preview writes were redundant
   * once a baseline activity snapshot exists.
   *
   * Prefer `pushTransientGoalSnapshot` so subscribers (the renderer's
   * WorkspaceStore, the Goal tab) receive the preview without the global
   * write lock. If no baseline activity exists yet, fall back to
   * `pushSnapshot` so the first preview still creates and emits the
   * workspace activity entry instead of being dropped.
   */
  async previewStreamAccounting(input: StreamAccountingInput): Promise<GoalSnapshot | null> {
    assert(input.workspaceId.trim().length > 0, "previewStreamAccounting requires workspaceId");
    if (input.isCompaction === true) {
      return null;
    }

    const pendingSnapshot = this.pendingGoalSnapshots.get(input.workspaceId);
    if (pendingSnapshot) {
      return pendingSnapshot;
    }

    const costMicroCentsThisStream = costUsdToMicroCents(input.costUsd);
    return this.fileLocks.withLock(input.workspaceId, async () => {
      const current = await this.readGoalFile(input.workspaceId);
      if (!current) {
        return null;
      }

      if (input.streamStartedAtMs != null && current.createdAtMs > input.streamStartedAtMs) {
        return null;
      }
      if (
        input.streamStartedAtMs != null &&
        this.recordedStreamStartedAtMsByWorkspace.get(input.workspaceId) === input.streamStartedAtMs
      ) {
        return null;
      }

      if (current.status === "paused" || current.status === "complete") {
        return this.resetIneligibleCostPreview(input.workspaceId, current);
      }
      // Mirror recordStreamAccounting's maintenance skip: final accounting
      // discards non-goal-driven cost on a budget_limited goal, so previewing
      // it would show climbing cost mid-stream that snaps back at stream end.
      const previewOriginKind = input.streamOriginKind ?? "user";
      if (
        current.status === "budget_limited" &&
        previewOriginKind !== "goal_continuation" &&
        previewOriginKind !== "goal_budget_limit"
      ) {
        return this.resetIneligibleCostPreview(input.workspaceId, current);
      }

      const preview = GoalRecordV1Schema.parse({
        ...current,
        ...this.applyCostAccounting(current, costMicroCentsThisStream),
        updatedAtMs: Date.now(),
      });
      const snapshot = toGoalSnapshot(preview);
      this.liveGoalPreviewSnapshots.set(input.workspaceId, snapshot);
      const transientResult = await this.pushTransientGoalSnapshot(input.workspaceId, snapshot);
      if (transientResult === "no_baseline") {
        // If the baseline activity snapshot does not exist yet (for
        // example, extensionMetadata was reset or stream-start's
        // fire-and-forget metadata write has not finished), fall back to
        // the durable path so this preview is still delivered to Goals UI
        // subscribers instead of being dropped. "unavailable" must NOT take
        // this path: the durable write's lenient load would accept the
        // suspect partial main the strict read refused and emit it,
        // clearing renderer goal/status state — return the computed preview
        // without delivery instead (renderer keeps last-known state).
        return this.pushSnapshot(input.workspaceId, preview);
      }
      return snapshot;
    });
  }

  async recordStreamAccounting(input: StreamAccountingInput): Promise<GoalRecordV1 | null> {
    assert(input.workspaceId.trim().length > 0, "recordStreamAccounting requires workspaceId");
    const originKind = input.streamOriginKind ?? (input.isCompaction === true ? "other" : "user");

    if (input.isCompaction === true) {
      this.recordLastGoalStream(input.workspaceId, originKind, null);
      return null;
    }

    const costMicroCentsThisStream = costUsdToMicroCents(input.costUsd);
    this.liveGoalPreviewSnapshots.delete(input.workspaceId);
    return this.fileLocks.withLock(input.workspaceId, async () => {
      const current = await this.readGoalFile(input.workspaceId);
      if (!current) {
        this.recordLastGoalStream(input.workspaceId, originKind, null);
        return null;
      }

      if (input.streamStartedAtMs != null && current.createdAtMs > input.streamStartedAtMs) {
        this.recordLastGoalStream(input.workspaceId, originKind, current.goalId);
        await this.pushSnapshot(input.workspaceId, current);
        return null;
      }

      // Non-running goals only accrue cost from streams that are actually goal
      // work racing the status change (an in-flight continuation or budget
      // wrap-up). Maintenance streams — scheduled heartbeats ("user" origin,
      // no agentInitiated flag) and background wake turns ("other") — must not
      // charge turns/cost or bump updatedAtMs on a goal that is not running;
      // doing so made every heartbeat/wake look like it had just touched the
      // goal. `budget_limited` is included so background activity while the
      // wrap-up is pending cannot inflate the recorded overshoot. Mirrors
      // attributeChildReport's paused/complete skip.
      const isGoalDrivenStream =
        originKind === "goal_continuation" || originKind === "goal_budget_limit";
      if (current.status !== "active" && !isGoalDrivenStream) {
        // Codex P2 (PRRT_kwDOPxxmWM6cBACb, PRRT_kwDOPxxmWM6cBr9I): a skipped
        // maintenance stream on a budget_limited goal must never overwrite
        // the stamp of the stream that hit the budget. A goal-driven stamp
        // keeps the pending wrap-up eligible (overwriting it would suppress
        // the final wrap-up turn); a user-origin stamp deliberately
        // suppresses the wrap-up (overwriting it with a wake's "other" stamp
        // would dispatch an autonomous wrap-up the user's own budget-limited
        // stream intentionally blocked). Only stamp when no stamp exists for
        // this goal (e.g. after restart, where suppression is handled by the
        // durable budgetLimitInjectedForGoalId gate).
        const existingStamp = this.lastGoalStreamStamps.get(input.workspaceId);
        const preserveExistingStamp =
          current.status === "budget_limited" && existingStamp?.goalId === current.goalId;
        if (!preserveExistingStamp) {
          // Codex P2 (PRRT_kwDOPxxmWM6cDhNX): with no in-memory stamp (e.g.
          // after a restart), consult the durable origin before stamping. A
          // user-origin budget hit was deliberately suppressed pre-restart
          // (`recoverPendingDispatchAfterRestart` honors it) — recording the
          // maintenance stream's wrap-up-eligible origin here would let the
          // next stream-end request dispatch the autonomous wrap-up that
          // suppression blocked. Re-record "user" instead so the durable
          // suppression survives maintenance activity.
          const stampOriginKind =
            current.status === "budget_limited" && current.budgetLimitOriginKind === "user"
              ? "user"
              : originKind;
          this.recordLastGoalStream(input.workspaceId, stampOriginKind, current.goalId);
        }
        await this.pushSnapshot(input.workspaceId, current);
        return current;
      }

      // Only count goal-attributable turns. A rare `user`-origin stream that
      // reaches here while still active must not consume a turn against the cap.
      const turnsDelta = originKind === "user" ? 0 : 1;
      const accounted = GoalRecordV1Schema.parse({
        ...current,
        ...this.applyCostAccounting(current, costMicroCentsThisStream),
        turnsUsed: current.turnsUsed + turnsDelta,
        updatedAtMs: Date.now(),
      });
      const next = applyBudgetDrivenStatus(accounted, { originKind, nowMs: Date.now() });
      if (input.streamStartedAtMs != null) {
        this.recordedStreamStartedAtMsByWorkspace.set(input.workspaceId, input.streamStartedAtMs);
      }
      await this.writeGoal(input.workspaceId, next);
      await this.pushSnapshot(input.workspaceId, next);
      this.recordLastGoalStream(input.workspaceId, originKind, next.goalId);
      this.emitBudgetLimited(input.workspaceId, next, current.status);
      return next;
    });
  }

  async attributeChildReport(
    input: ChildReportAttributionInput
  ): Promise<ChildReportAttributionResult | null> {
    assert(
      input.parentWorkspaceId.trim().length > 0,
      "attributeChildReport requires parentWorkspaceId"
    );
    assert(
      input.childWorkspaceId.trim().length > 0,
      "attributeChildReport requires childWorkspaceId"
    );
    assert(
      input.parentWorkspaceId !== input.childWorkspaceId,
      "attributeChildReport requires distinct parent and child workspaces"
    );
    assert(
      Number.isInteger(input.childCostCents) && input.childCostCents >= 0,
      "attributeChildReport requires a non-negative integer childCostCents"
    );

    return this.fileLocks.withLock(input.parentWorkspaceId, async () => {
      const current = await this.readGoalFile(input.parentWorkspaceId);
      if (!current) {
        return null;
      }

      if (current.status === "paused" || current.status === "complete") {
        await this.pushSnapshot(input.parentWorkspaceId, current);
        return skippedChildAttribution(current);
      }

      if (current.attributedChildren.includes(input.childWorkspaceId)) {
        await this.pushSnapshot(input.parentWorkspaceId, current);
        return skippedChildAttribution(current);
      }

      const accounted = GoalRecordV1Schema.parse({
        ...current,
        ...this.applyCostAccounting(current, input.childCostCents * MICRO_CENTS_PER_CENT),
        turnsUsed: current.turnsUsed + 1,
        attributedChildren: [...current.attributedChildren, input.childWorkspaceId],
        updatedAtMs: Date.now(),
      });
      // Tag the budget-limit transition so post-restart recovery knows the
      // wrap-up is owed . `goal_continuation` is the right tag here
      // because the wrap-up MUST fire — child attribution is goal-attributable
      // work. The recovery path checks for `!= "user"`.
      const next = applyBudgetDrivenStatus(accounted, {
        originKind: "goal_continuation",
        nowMs: Date.now(),
      });
      const causedLimit = current.status === "active" && next.status === "budget_limited";

      await this.writeGoal(input.parentWorkspaceId, next);
      await this.pushSnapshot(input.parentWorkspaceId, next);
      this.emitBudgetLimited(input.parentWorkspaceId, next, current.status, {
        "caused-by-child": true,
      });
      // when child attribution drives the
      // goal into budget_limited, arm the same wrap-up stamp + candidate the
      // restart-recovery path uses. Without this the goal sits stuck in
      // budget_limited with no mechanism to fire the wrap-up because the
      // attribution path never produces a normal stream-end candidate/stamp.
      if (causedLimit) {
        await this.armBudgetWrapupForBudgetLimitedGoal(input.parentWorkspaceId, next);
      } else if (next.status === "active") {
        this.armKickoffContinuationIfIdle(input.parentWorkspaceId, next).catch((error: unknown) => {
          log.warn("Failed to arm parent goal continuation after child attribution", {
            workspaceId: input.parentWorkspaceId,
            error,
          });
        });
      }
      return {
        goalBefore: current,
        goalAfter: next,
        attributed: true,
        causedBudgetLimit: causedLimit,
      };
    });
  }

  async clearGoal(workspaceId: string): Promise<GoalRecordV1 | null> {
    const cleared = await this.fileLocks.withLock(workspaceId, async () => {
      const current = await this.readGoalFile(workspaceId);
      this.pendingGoalMutations.delete(workspaceId);
      this.pendingGoalSnapshots.delete(workspaceId);
      this.liveGoalPreviewSnapshots.delete(workspaceId);
      this.pendingContinuationCandidates.delete(workspaceId);
      this.recordedStreamStartedAtMsByWorkspace.delete(workspaceId);
      this.lastGoalStreamStamps.delete(workspaceId);
      const timer = this.continuationReRequestTimers.get(workspaceId);
      if (timer != null) {
        clearTimeout(timer);
        this.continuationReRequestTimers.delete(workspaceId);
      }
      if (!current) {
        await this.pushSnapshot(workspaceId, null);
        return null;
      }

      // Archive the cleared goal to history before deleting the canonical
      // record. `endReason` reflects the goal's *exit reason*: a manual clear
      // of a goal that the user (or model) had already marked complete is
      // recorded as "completed" so the UI can label it as such in the
      // completed-goals list under the present goal.
      await this.appendGoalHistoryEntry(
        workspaceId,
        current,
        current.status === "complete" ? "completed" : "cleared"
      );

      await fs.rm(this.getFilePath(workspaceId), { force: true });
      // Goal deletion is an identity transition too. In-flight admissions only
      // observe generation counters after their initial durable read, so clear
      // must invalidate them even when no upcoming goal is promoted.
      this.lastWrittenGoalIdentities.delete(workspaceId);
      this.lastWrittenGoalStatuses.delete(workspaceId);
      this.goalIdentityGenerations.set(
        workspaceId,
        (this.goalIdentityGenerations.get(workspaceId) ?? 0) + 1
      );
      await this.pushSnapshot(workspaceId, null);
      this.emitLifecycle("goal_cleared", {
        finalStatus: current.status,
        costCentsBucket: centsBucket(current.costCents),
        turnsUsed: current.turnsUsed,
      });
      // Auto-promote the head of `upcoming` (if any) to the active slot
      // so the workspace's roadmap continues without an extra user
      // action. Promotion uses initiator-neutral lifecycle reporting
      // (`goal_created`); the user can still pause / replace as desired.
      await this.promoteNextUpcomingUnlocked(workspaceId);
      return current;
    });

    if (cleared) {
      await this.appendClearSummary(workspaceId, cleared);
    }

    return cleared;
  }

  private async appendClearSummary(workspaceId: string, goal: GoalRecordV1): Promise<void> {
    // The goal-cleared summary exists for MODEL context — after a goal
    // is cleared the agent still needs to know what just happened so it
    // can answer follow-up questions ("what did we just finish?",
    // "resume the previous one"). The right-sidebar Goal Board already
    // surfaces the same information visually (Completed / Archived
    // sections), so rendering this synthetic message as a full assistant
    // chat bubble was pure noise — it appeared inline whenever the user
    // cleared, replaced, or completed a goal, and clobbered the actual
    // conversation flow.
    //
    // `uiVisible: false` (the default for synthetic messages) keeps it
    // in the AI request payload but hides it from the rendered transcript,
    // which is what we want here.
    const summary = `Goal cleared: "${goal.objective}" — spent $${formatCentsBare(goal.costCents)} over ${goal.turnsUsed} turns (status: ${goal.status})`;
    const message = createMuxMessage(
      `goal-cleared-${Date.now()}-${crypto.randomUUID()}`,
      "assistant",
      summary,
      {
        synthetic: true,
        muxMetadata: { type: "goal-cleared-summary" },
      }
    );
    const result = await this.historyService.appendToHistory(workspaceId, message);
    if (!result.success) {
      log.warn("Failed to append goal cleared summary", { workspaceId, error: result.error });
    }
  }

  private bumpStreamEndDrainGeneration(workspaceId: string, streamStartGeneration: number): void {
    this.streamEndDrainGenerations.set(
      workspaceId,
      (this.streamEndDrainGenerations.get(workspaceId) ?? 0) + 1
    );
    // Max semantics: concurrent drains can exit out of order, and a newer
    // drain's entry must not be masked by an older drain's later exit.
    this.lastDrainStreamStartGenerations.set(
      workspaceId,
      Math.max(this.lastDrainStreamStartGenerations.get(workspaceId) ?? 0, streamStartGeneration)
    );
  }

  /**
   * True when a stream-end drain started or exited since the caller captured
   * `drainGenerationAtEntry` AND that drain was settling the caller's own
   * stream or a newer one. Bumps from drains settling OLDER streams are
   * ignored: the caller's stream is still live, so a queued mutation (stamped
   * with the caller's stream-start generation) will be claimed by that
   * stream's own drain (Codex P1 PRRT_kwDOPxxmWM6cLA0R).
   */
  private drainRanForRelevantStreamSince(
    workspaceId: string,
    drainGenerationAtEntry: number,
    streamStartGenerationAtEntry: number
  ): boolean {
    if ((this.streamEndDrainGenerations.get(workspaceId) ?? 0) === drainGenerationAtEntry) {
      return false;
    }
    return (
      (this.lastDrainStreamStartGenerations.get(workspaceId) ?? 0) >= streamStartGenerationAtEntry
    );
  }

  async applyPendingAfterStreamEnd(workspaceId: string): Promise<GoalRecordV1 | null> {
    this.liveGoalPreviewSnapshots.delete(workspaceId);
    // Codex P1 (PRRT_kwDOPxxmWM6cEl37): captured synchronously at entry. The
    // provider-error path launches this drain un-awaited, so an automatic
    // retry's stream-start can land while the drain is persisting — the exit
    // below must not mark that newer live stream settled.
    const streamStartGenerationAtEntry = this.streamStartGenerations.get(workspaceId) ?? 0;
    // Codex P2 (PRRT_kwDOPxxmWM6cBr9Q): bump the drain generation at entry so
    // setters admitted BEFORE this drain detect it at their in-lock recheck
    // and persist directly instead of installing a mutation this drain may
    // already have stopped watching for.
    this.bumpStreamEndDrainGeneration(workspaceId, streamStartGenerationAtEntry);
    let drained: GoalRecordV1 | null = null;

    // Codex P2 (PRRT_kwDOPxxmWM6b_KgE): a queued setGoal may be holding the
    // goal file lock mid-publication; its post-publication re-stamp replaces
    // the mutation object with one carrying the finalized publication
    // createdAtMs. Taking the mutation without the locked handoff would drain
    // the pre-publication construction stamp, and a message authored during
    // the publication await would then be misclassified as a post-goal
    // intervention.
    //
    // Codex P2 (PRRT_kwDOPxxmWM6cANQH): the claim (read + delete) must happen
    // INSIDE one lock tenure — setters install/replace mutations only while
    // holding this lock, so an unlocked reread-then-delete could steal an
    // older mutation mid-setter. The claim also honors discards that landed
    // in the window (user abort / clearGoal), which delete the mutation
    // before the claim runs.
    //
    // Codex P2 (PRRT_kwDOPxxmWM6cAl6e, PRRT_kwDOPxxmWM6cANQH,
    // PRRT_kwDOPxxmWM6cBACj): each pass claims AND persists inside ONE lock
    // tenure via `persistGoalMutationLocked`. Setters install/replace
    // mutations only while holding this lock, so nothing can interleave
    // between the claim and its persistence — a later setter always validates
    // its expectedGoalId/replacement guard against durable state that already
    // includes every drained pass, keeping accepted guards coherent on
    // replay.
    //
    // Codex P2 (PRRT_kwDOPxxmWM6cBACH): loop until a locked claim observes no
    // mutation instead of a fixed pass cap — a cap exit could strand the
    // newest mutation with no remaining stream-end hook. Termination: nothing
    // can install while we hold the lock, each iteration consumes the single
    // mutation slot, and new installs require a setter that still observes
    // the (stale) live-stream flag, which closes shortly after stream end.
    while (true) {
      // Unlocked fast path: setters install before publication, so a setter
      // mid-publication always has a visible mutation here; an empty map means
      // there is nothing to hand off (the common no-mutation stream end).
      if (this.pendingGoalMutations.get(workspaceId) == null) {
        break;
      }
      // Mirror the `setGoal` wrapper here: invalid queued transitions must
      // be logged and swallowed so the stream-end pipeline stays alive.
      // The caller already treats null as "no apply happened".
      let claimedMutation = false;
      try {
        const tenure = await this.fileLocks.withLock(workspaceId, async () => {
          const claimed = this.pendingGoalMutations.get(workspaceId);
          if (claimed == null) {
            // Discarded (user abort / clearGoal) between the fast path and
            // the claim.
            return null;
          }
          // Codex P1 (PRRT_kwDOPxxmWM6cJ6M-): claims are stream-scoped. A
          // mutation stamped by a NEWER stream (an automatic retry that
          // started while this un-awaited provider-error drain was still
          // looping) belongs to that stream's own stream-end drain — claiming
          // it here would persist/archive the goal before the retry's
          // accounting and strip a later user abort of its discard window.
          // Legacy unstamped mutations (none in practice — installs always
          // stamp) fall back to claimable.
          if (
            (claimed.streamStartGeneration ?? streamStartGenerationAtEntry) !==
            streamStartGenerationAtEntry
          ) {
            return null;
          }
          claimedMutation = true;
          this.pendingGoalMutations.delete(workspaceId);
          this.pendingGoalSnapshots.delete(workspaceId);
          // Codex P1 (PRRT_kwDOPxxmWM6cMGn8): recordUserStoppedStream discards
          // a queued mutation by deleting the pending-map entry, but this
          // claim just removed it — a Stop landing during the persistence
          // awaits below would no longer have anything to invalidate and the
          // drain would durably archive/write the stopped turn's goal change.
          // Capture the stop generation synchronously with the claim (stops
          // BEFORE the claim already deleted the entry, so nothing older can
          // false-discard) and carry it through persistence + finalization so
          // every await rechecks it, mirroring setGoalImmediately.
          const userStopGate = {
            generationAtEntry: this.userStopGenerationsByWorkspace.get(workspaceId) ?? 0,
          };
          const {
            projectedGoalId,
            projectedCreatedAtMs,
            streamStartGeneration: _claimedGeneration,
            ...pendingInput
          } = claimed;
          const input = { workspaceId, ...pendingInput };
          const result = await this.persistGoalMutationLocked(input, {
            replacementGoalId: projectedGoalId ?? null,
            replacementCreatedAtMs: projectedCreatedAtMs ?? null,
            userStopGate,
          });
          // Mirror setGoalImmediately: arm the pause-finalization hold under
          // the same lock tenure as the paused write.
          if (this.pauseFinalizationHoldApplies(input, result) && result.success) {
            this.armPauseFinalizationHold(workspaceId, result.data.goalId);
          }
          return { input, result, userStopGate };
        });
        if (tenure == null) {
          break;
        }
        try {
          const finalized = await this.finalizeGoalPersistence(tenure.input, tenure.result, {
            // A stop landing after the durable write but before finalization
            // must veto kickoff arming here too (same rule as the setter).
            userStopGate: tenure.userStopGate,
          });
          drained = finalized.success ? finalized.data : drained;
        } finally {
          if (
            this.pauseFinalizationHoldApplies(tenure.input, tenure.result) &&
            tenure.result.success
          ) {
            this.releasePauseFinalizationHold(workspaceId, tenure.result.data.goalId);
          }
        }
      } catch (error) {
        log.warn("applyPendingAfterStreamEnd: dropped invalid queued goal mutation", {
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        // Always re-read the durable record after a claim: queued snapshots
        // are optimistic, and drains can succeed as persistence no-ops,
        // reject, or throw.
        if (claimedMutation) {
          await this.restorePersistedGoalSnapshot(workspaceId);
        }
      }
    }

    // Codex P2 (PRRT_kwDOPxxmWM6cBr9Q): bump again on exit, synchronously with
    // the loop's final empty-map check (no await sits between them). A setter
    // admitted DURING this drain whose in-lock recheck runs after that final
    // check therefore sees a changed generation and persists directly; one
    // whose recheck ran earlier installed a mutation the loop drained.
    this.bumpStreamEndDrainGeneration(workspaceId, streamStartGenerationAtEntry);
    // Codex P2 (PRRT_kwDOPxxmWM6cCH_L): setters admitted AFTER this point
    // capture the already-bumped generation, so the generation gate cannot
    // help them — mark the workspace settled (also synchronously with the
    // final empty-map check) so they observe a deterministic "no stream-end
    // hook is coming" state and persist directly until the next stream start
    // clears it.
    //
    // Codex P1 (PRRT_kwDOPxxmWM6cEl37): unless a newer stream already started
    // while this drain ran — its recordStreamStarted cleared the marker, and
    // re-adding it here would let a set_goal in that live stream persist
    // mid-stream, bypassing abort-time discard and stream-end accounting.
    if ((this.streamStartGenerations.get(workspaceId) ?? 0) === streamStartGenerationAtEntry) {
      this.drainSettledWorkspaces.add(workspaceId);
    }

    // Stream-end deferred auto-promotion.
    //
    // Runs AFTER any queued setGoal drains so the deferred setGoal can
    // target the same goal it was queued against — otherwise its
    // `expectedGoalId` would race ahead of the promote and the
    // setGoalImmediately call would return `goal_conflict` and silently
    // drop the user's edit.
    //
    // Two reasons this helper might find work to do at this point:
    //   (a) The agent called `complete_goal` mid-stream — goal.json is
    //       already complete and no pending mutation queued.
    //   (b) The queued mutation we just drained completed the goal —
    //       `maybeAutoPromoteOnComplete` skipped because the stream
    //       was still live during the drain's `applyMutableFields`.
    // Either way, the active goal is `complete` on disk by now and the
    // upcoming head deserves promotion.
    await this.runDeferredAutoPromoteAfterStreamEnd(workspaceId);

    return drained;
  }

  /**
   * Stream-end hook for deferred auto-promotion. When the agent marks
   * the active goal complete mid-stream, `maybeAutoPromoteOnComplete`
   * skips because `isWorkspaceStreaming` is still true. This method
   * runs after the stream has settled and picks up where that skipped:
   * if the current active goal is `complete` and there's an upcoming
   * head, archive the completed goal to history and promote the head.
   *
   * **Retry on streaming race.** `applyPendingAfterStreamEnd`
   * is called from AgentSession once per stream; the
   * `extensionMetadata.setStreaming(false)` call comes from a separate
   * async listener in WorkspaceService and may not have run yet. We
   * poll `isWorkspaceStreaming` with a small bounded backoff so we
   * don't drop the auto-promote on this race. If after all retries
   * we still see streaming, give up — the next manual mutation will
   * land here naturally.
   *
   * Failures are logged + swallowed; the stream-end pipeline must not
   * be disrupted by board mutations.
   */
  private async runDeferredAutoPromoteAfterStreamEnd(workspaceId: string): Promise<void> {
    // Quick early exit if there's nothing to promote — avoids the
    // streaming-poll cost on the hot path for single-goal workspaces.
    const earlyBoard = await this.readBoard(workspaceId);
    if (earlyBoard.upcoming.length === 0) {
      return;
    }
    const earlyGoal = await this.readGoalFile(workspaceId);
    if (earlyGoal?.status !== "complete") {
      return;
    }

    // poll for stop-streaming up to ~600ms total. The races
    // we've seen in practice resolve in one or two ticks; the longer
    // bound is defensive against laggy listeners. We stop polling the
    // first time we see streaming=false (so the common case is fast).
    const POLL_DELAYS_MS = [0, 50, 100, 200, 250];
    let stillStreaming = true;
    for (const delayMs of POLL_DELAYS_MS) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      if (!(await this.isWorkspaceStreaming(workspaceId))) {
        stillStreaming = false;
        break;
      }
    }
    if (stillStreaming) {
      log.warn(
        "Deferred auto-promote skipped: workspace still streaming after retries; will rearm on next mutation",
        { workspaceId, goalId: earlyBoard.upcoming[0].goalId }
      );
      return;
    }

    try {
      await this.fileLocks.withLock(workspaceId, async () => {
        const current = await this.readGoalFile(workspaceId);
        if (current?.status !== "complete") {
          return;
        }
        const board = await this.readBoard(workspaceId);
        if (board.upcoming.length === 0) {
          return;
        }
        const [head] = board.upcoming;
        const projected = GoalRecordV1Schema.parse({
          ...head,
          status: "active",
          updatedAtMs: Date.now(),
        });
        if (!(await this.canRunBudgetedGoalOnKickoffModel(workspaceId, projected))) {
          log.warn(
            "Deferred auto-promote skipped: queued goal is budgeted but kickoff model is unpriced",
            { workspaceId, goalId: head.goalId }
          );
          return;
        }
        // Same as `maybeAutoPromoteOnComplete`: archive the completed
        // goal then write the promotion. Both happen under the same
        // workspace lock as the stream-end accounting drain so the UI
        // sees a consistent board.
        await this.appendGoalHistoryEntry(workspaceId, current, "completed");
        await this.promoteNextUpcomingUnlocked(workspaceId);
      });
    } catch (error) {
      log.warn("Deferred auto-promote after stream end failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Goal board (multi-goal queue)
  //
  // The board is stored at `goal-board.json` next to `goal.json` so the
  // existing single-goal storage + agent contract are untouched. The
  // agent's `get_goal` tool still reads only `goal.json` and never sees
  // upcoming or archived goals — the user owns the queue, not the agent.
  //
  // Concurrency uses the same per-workspace `fileLocks` as goal.json so
  // a board mutation can't race a setGoal write that flips the active
  // goal. Auto-promotion (`promoteNextOnComplete`) reads/writes both
  // files inside one lock for the same reason.
  // ───────────────────────────────────────────────────────────────────────

  private getBoardFilePath(workspaceId: string): string {
    return this.resolveSessionFilePath(workspaceId, GOAL_BOARD_FILE);
  }

  private async readBoard(workspaceId: string): Promise<GoalBoardV1> {
    const filePath = this.getBoardFilePath(workspaceId);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      return GoalBoardV1Schema.parse(JSON.parse(raw));
    } catch (error) {
      if (isNotFound(error)) {
        return { version: 1, upcoming: [], archived: [] };
      }
      log.warn("Ignoring corrupt goal-board.json", { workspaceId, error });
      return { version: 1, upcoming: [], archived: [] };
    }
  }

  private async writeBoard(workspaceId: string, board: GoalBoardV1): Promise<void> {
    const filePath = this.getBoardFilePath(workspaceId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // When both lists are empty, drop the file entirely so a workspace
    // that never used the board stays bit-identical to a never-touched
    // one (matches the heartbeat / goal-defaults pattern).
    if (board.upcoming.length === 0 && board.archived.length === 0) {
      await fs.rm(filePath, { force: true });
      return;
    }
    await writeFileAtomic(filePath, `${JSON.stringify(board, null, 2)}\n`, "utf-8");
  }

  /**
   * Renderer-facing snapshot of all four board sections, oldest-first
   * within each section. Active comes from `goal.json`, completed from
   * `goal-history.jsonl` (newest first, capped at the existing render
   * cap), upcoming + archived from `goal-board.json`.
   */
  async getGoalBoard(workspaceId: string): Promise<GoalBoardSnapshot> {
    return this.fileLocks.withLock(workspaceId, async () => {
      const [activeGoal, board, history] = await Promise.all([
        this.readGoalFile(workspaceId),
        this.readBoard(workspaceId),
        this.readHistoryUnlocked(workspaceId),
      ]);

      const entries: GoalBoardEntry[] = [];

      if (activeGoal) {
        entries.push({ section: "active", goal: activeGoal });
      }
      for (const goal of board.upcoming) {
        entries.push({ section: "upcoming", goal });
      }
      // Completed entries come from history. We dedupe against:
      //   - the active goal id (stale history line race during edit)
      //   - the archived list (archived-from-complete goals)
      //   - the upcoming list (when a user archives a completed goal then
      //     revives it, the original history entry still exists; without
      //     this dedup the goal would render in both Upcoming and Completed).
      //   - earlier history rows for the same goalId (a goal
      //     completed → archived → revived → promoted → completed
      //     again has TWO 'completed' rows; we want only the newest).
      //     `history` is sorted newest-first, so the first row we see
      //     for a goalId is the most recent.
      const seenCompletedIds = new Set<string>();
      for (const entry of history) {
        if (entry.endReason !== "completed") continue;
        if (activeGoal && entry.goal.goalId === activeGoal.goalId) continue;
        if (board.archived.some((g) => g.goalId === entry.goal.goalId)) continue;
        if (board.upcoming.some((g) => g.goalId === entry.goal.goalId)) continue;
        if (seenCompletedIds.has(entry.goal.goalId)) continue;
        seenCompletedIds.add(entry.goal.goalId);
        entries.push({ section: "complete", goal: entry.goal, endedAtMs: entry.endedAtMs });
      }
      for (const goal of board.archived) {
        entries.push({ section: "archived", goal });
      }

      return { entries };
    });
  }

  /**
   * Read history WITHOUT acquiring the lock. Only callers that already
   * hold the lock may use this (`getGoalBoard` reads goal.json + board
   * + history under one lock).
   */
  private async readHistoryUnlocked(
    workspaceId: string,
    logCorruptLines = false
  ): Promise<GoalHistoryEntry[]> {
    const filePath = this.getHistoryFilePath(workspaceId);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const indexed: Array<{ index: number; entry: GoalHistoryEntry }> = [];
      let appendIndex = 0;
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          indexed.push({
            index: appendIndex,
            entry: GoalHistoryEntrySchema.parse(JSON.parse(trimmed)),
          });
        } catch (error) {
          if (logCorruptLines) {
            log.warn("Skipping corrupt goal history entry", { workspaceId, error });
          }
        }
        appendIndex += 1;
      }
      indexed.sort((a, b) => {
        if (b.entry.endedAtMs !== a.entry.endedAtMs) {
          return b.entry.endedAtMs - a.entry.endedAtMs;
        }
        return b.index - a.index;
      });
      return indexed.slice(0, GOAL_HISTORY_RENDER_CAP).map((row) => row.entry);
    } catch (error) {
      if (isNotFound(error)) return [];
      log.warn("Failed to read goal history", { workspaceId, error });
      return [];
    }
  }

  /**
   * Append a new goal to the workspace's `upcoming` list. The goal is
   * created in the standard way (via `createGoal`) so it has a stable
   * goalId + cost accounting fields, but its status is the placeholder
   * `paused` — meaningless until promotion, but it satisfies the
   * non-empty status constraint on `GoalRecordV1`. Promotion (manual or
   * auto) is what actually flips it to `active`.
   */
  async addUpcomingGoal(input: {
    workspaceId: string;
    objective: string;
    budgetCents?: number | null;
    turnCap?: number | null;
  }): Promise<GoalRecordV1> {
    this.assertParentWorkspace(input.workspaceId);
    const objective = input.objective.trim();
    assert(objective.length > 0, "addUpcomingGoal requires a non-empty objective");

    return this.fileLocks.withLock(input.workspaceId, async () => {
      const board = await this.readBoard(input.workspaceId);
      const goal = this.createGoal({
        objective,
        budgetCents: input.budgetCents ?? null,
        turnCap: input.turnCap ?? null,
        // `paused` is the placeholder status for upcoming goals — they
        // are not actively running and not yet acknowledged by the
        // agent. The promote path replaces this with `active` after a
        // proper write through setGoal.
        status: "paused",
      });
      const next: GoalBoardV1 = {
        ...board,
        upcoming: [...board.upcoming, goal],
      };
      await this.writeBoard(input.workspaceId, next);
      return goal;
    });
  }

  /**
   * Patch an upcoming goal in place. Used by the right-sidebar Upcoming
   * row's inline editor — users can change a queued goal's objective,
   * budget, or turn cap without first promoting it. Returns the patched
   * record on success and `null` when the id is unknown (idempotent for
   * double-submit). Fields explicitly set to `null` clear the limit;
   * fields left as `undefined` are preserved from the existing record
   * so the UI can patch a single column.
   *
   * Active goals do not flow through this method — they keep using
   * `setGoal` with `editInPlace: true` so the agent's view stays in sync
   * via the lifecycle event stream. Upcoming goals are not visible to
   * the agent, so a pure file-locked write is sufficient here.
   */
  async updateUpcomingGoal(input: {
    workspaceId: string;
    goalId: string;
    objective?: string;
    budgetCents?: number | null;
    turnCap?: number | null;
  }): Promise<GoalRecordV1 | null> {
    this.assertParentWorkspace(input.workspaceId);
    if (input.objective?.trim().length === 0) {
      throw new WorkspaceGoalTransitionError("Goal objective cannot be empty.");
    }
    return this.fileLocks.withLock(input.workspaceId, async () => {
      const board = await this.readBoard(input.workspaceId);
      const idx = board.upcoming.findIndex((g) => g.goalId === input.goalId);
      if (idx === -1) return null;
      const existing = board.upcoming[idx];
      const updated: GoalRecordV1 = GoalRecordV1Schema.parse({
        ...existing,
        objective: input.objective === undefined ? existing.objective : input.objective.trim(),
        budgetCents: input.budgetCents === undefined ? existing.budgetCents : input.budgetCents,
        turnCap: input.turnCap === undefined ? existing.turnCap : input.turnCap,
        updatedAtMs: Date.now(),
      });
      const nextUpcoming = [...board.upcoming];
      nextUpcoming[idx] = updated;
      await this.writeBoard(input.workspaceId, { ...board, upcoming: nextUpcoming });
      return updated;
    });
  }

  /**
   * Move a goal from one board location to archived. The goal can come
   * from any section: active (the slot is cleared and history records a
   * "cleared" entry), upcoming (removed from queue), or complete
   * (snapshotted from history into the board so the user can still see
   * it after the history line scrolls off the render cap).
   *
   * The user is the only initiator of archive — the agent never sees
   * archived goals (filtered out of `goal-board.json` reads in the
   * agent tool boundary if/when those tools are added).
   */
  async archiveGoal(workspaceId: string, goalId: string): Promise<void> {
    this.assertParentWorkspace(workspaceId);
    await this.fileLocks.withLock(workspaceId, async () => {
      const [activeGoal, board, history] = await Promise.all([
        this.readGoalFile(workspaceId),
        this.readBoard(workspaceId),
        this.readHistoryUnlocked(workspaceId),
      ]);

      // Already archived: idempotent no-op so a double-click doesn't
      // surprise the user.
      if (board.archived.some((g) => g.goalId === goalId)) {
        return;
      }

      // Source priority: always prefer the currently-active
      // slot. A goal that was completed → archived → revived →
      // promoted → completed-again has both a stale history entry AND
      // is the current active. Checking history first would snapshot
      // the stale history row and leave the live active slot in
      // place; the user's archive click would then appear not to
      // work and could surface duplicate Archived rows.
      if (activeGoal?.goalId === goalId) {
        // Append a "cleared" history entry so the user's view of
        // completed/cleared history stays accurate, then place a
        // snapshot in archived. We use the current ACTIVE record
        // (with its latest accounting) rather than any older history
        // entry for the same id.
        await this.appendGoalHistoryEntry(workspaceId, activeGoal, "cleared");
        await fs.rm(this.getFilePath(workspaceId), { force: true });
        await this.pushSnapshot(workspaceId, null);
        const next: GoalBoardV1 = {
          ...board,
          archived: [activeGoal, ...board.archived],
        };
        await this.writeBoard(workspaceId, next);
        return;
      }

      // Source: upcoming list.
      const upcomingIdx = board.upcoming.findIndex((g) => g.goalId === goalId);
      if (upcomingIdx !== -1) {
        const [removed] = board.upcoming.splice(upcomingIdx, 1);
        const next: GoalBoardV1 = {
          ...board,
          archived: [removed, ...board.archived],
        };
        await this.writeBoard(workspaceId, next);
        return;
      }

      // Source: history (completed goal). Add to archived; the
      // `getGoalBoard` dedup filters the history line so the goal
      // doesn't double-render.
      const historyEntry = history.find(
        (e) => e.goal.goalId === goalId && e.endReason === "completed"
      );
      if (historyEntry) {
        const next: GoalBoardV1 = {
          ...board,
          archived: [historyEntry.goal, ...board.archived],
        };
        await this.writeBoard(workspaceId, next);
        return;
      }
      // Unknown id: silently ignored. The renderer can race a board
      // refresh against a concurrent clear; throwing here would
      // surface confusing errors for what is a benign race.
    });
  }

  /**
   * Move an archived goal back into `upcoming`. The user can then
   * promote it to active or leave it in the queue.
   */
  async reviveArchivedGoal(workspaceId: string, goalId: string): Promise<void> {
    this.assertParentWorkspace(workspaceId);
    await this.fileLocks.withLock(workspaceId, async () => {
      const board = await this.readBoard(workspaceId);
      const idx = board.archived.findIndex((g) => g.goalId === goalId);
      if (idx === -1) return;
      const [revived] = board.archived.splice(idx, 1);
      const next: GoalBoardV1 = {
        ...board,
        upcoming: [...board.upcoming, revived],
      };
      await this.writeBoard(workspaceId, next);
    });
  }

  /**
   * Reorder the `upcoming` list to match the given goalId sequence.
   * Goals whose ids aren't in the input list are appended at the end
   * (defensive against concurrent additions); ids in the input that
   * don't match an upcoming goal are silently dropped (defensive
   * against stale UI state).
   */
  async reorderUpcomingGoals(workspaceId: string, upcomingIds: string[]): Promise<void> {
    this.assertParentWorkspace(workspaceId);
    await this.fileLocks.withLock(workspaceId, async () => {
      const board = await this.readBoard(workspaceId);
      const byId = new Map(board.upcoming.map((g) => [g.goalId, g]));
      const reordered: GoalRecordV1[] = [];
      for (const id of upcomingIds) {
        const goal = byId.get(id);
        if (goal) {
          reordered.push(goal);
          byId.delete(id);
        }
      }
      // Anything still in the map wasn't covered by the input order;
      // preserve their relative order at the end.
      for (const goal of board.upcoming) {
        if (byId.has(goal.goalId)) {
          reordered.push(goal);
        }
      }
      const next: GoalBoardV1 = { ...board, upcoming: reordered };
      await this.writeBoard(workspaceId, next);
    });
  }

  /**
   * Promote an upcoming goal to active. If a goal is already active,
   * it is demoted to the head of `upcoming` so the user's roadmap
   * stays intact (matches the design's "swap on drag-to-activate"
   * semantics — the demoted goal is the natural next pick).
   *
   * **Mid-stream guard.** Promotion overwrites `goal.json`,
   * which `recordStreamAccounting` reads on every chunk to attribute
   * cost. If we promote while a stream is still running for the
   * current active goal, the freshly-promoted goal would absorb the
   * previous goal's cost. Interrupt/poll first so the promoted goal can
   * safely receive its kickoff continuation once the workspace is idle.
   *
   * Returns the new active record (the promoted goal, with status
   * flipped to `active` via the normal createGoal-like path) or
   * `null` when the requested upcoming id doesn't exist.
   */
  async promoteUpcomingGoal(workspaceId: string, goalId: string): Promise<GoalRecordV1 | null> {
    this.assertParentWorkspace(workspaceId);

    // Interrupt the active stream (if any) before promoting so the
    // in-flight turn's costs are attributed to the goal that ran them.
    // The promoted goal's view (via the agent's `get_goal` tool) then
    // takes effect on the kickoff continuation; otherwise a mid-stream
    // promote could attribute the current stream tail to the new goal.
    //
    // Behavior intentionally fails open: if no interrupter is wired
    // (tests) or the interrupt errors, we still proceed to promote.
    // The promotion arm below picks up the new goal via `get_goal`; worst
    // case is the small slice of stream tail that lands before the abort
    // settles. We log so production paths flag the rare error.
    if (await this.isWorkspaceStreaming(workspaceId)) {
      if (this.streamInterrupter) {
        try {
          await this.streamInterrupter(workspaceId);
        } catch (error) {
          log.warn("promoteUpcomingGoal: stream interrupt failed; continuing with promote", {
            workspaceId,
            error,
          });
        }
        // Stream tear-down may not flip `streaming=false` synchronously
        // with `interruptStream` resolving. Poll briefly (same backoff
        // as `runDeferredAutoPromoteAfterStreamEnd`) so the file-lock
        // body sees the post-interrupt state.
        await this.waitForStreamSettled(workspaceId);
      }
    }

    const promotedGoal = await this.fileLocks.withLock(workspaceId, async () => {
      const [currentActive, board] = await Promise.all([
        this.readGoalFile(workspaceId),
        this.readBoard(workspaceId),
      ]);
      const idx = board.upcoming.findIndex((g) => g.goalId === goalId);
      if (idx === -1) return null;
      const [promoted] = board.upcoming.splice(idx, 1);

      // Flip status to active. We reuse `createGoal` shape via direct
      // schema parse rather than calling setGoal to avoid re-entering
      // the streaming/conflict path — promotion happens inside one
      // file lock and shouldn't fan out into the public setGoal flow.
      //
      // a previously-active goal demoted back into upcoming
      // may already have cost ≥ budget or turnsUsed ≥ turnCap
      // (e.g. it hit `budget_limited`, was demoted by a different
      // promote, then re-queued). Run `applyBudgetDrivenStatus` so the
      // re-activated record correctly lands in `budget_limited` if the
      // limits are already exhausted; otherwise it would accept a send
      // and only flip after the next chunk's accounting.
      //
      // Also clear `completionSummary` so a previously-completed goal
      // that's been archived → revived → promoted doesn't carry its
      // 'done' message into the new active turn. The agent's
      // `get_goal` tool reads goal.json directly and would otherwise
      // see a stale summary. Matches the
      // `completionSummaryPatch` invariant for non-complete statuses.
      const now = Date.now();
      const baseActivated = GoalRecordV1Schema.parse({
        ...promoted,
        status: "active",
        updatedAtMs: now,
        completionSummary: undefined,
        requireUserAcknowledgmentSinceMs: null,
        // The user is the only caller of board promotion — an explicit
        // activation consent (see stampUserActivation).
        lastUserActivationAtMs: now,
      });
      const activated = applyBudgetDrivenStatus(baseActivated, { nowMs: Date.now() });

      // gate budgeted goal promotion on pricing data. A user
      // who queued a goal under a priced model and then switched to an
      // unpriced one would otherwise activate a budgeted goal they
      // can't actually send messages against — `assertPricedModelFor
      // BudgetedGoal` would block every send until the model is
      // changed or the goal cleared. Same guard `setGoal` uses for
      // direct creates.
      if (!(await this.canRunBudgetedGoalOnKickoffModel(workspaceId, activated))) {
        throw new WorkspaceGoalTransitionError(UNPRICED_TARGET_MODEL_GOAL_MESSAGE);
      }

      // Demote the previously-active goal to the head of upcoming, but
      // ONLY if it's still alive. A completed goal sitting in the active
      // slot (the user-marked-complete + queued-next workflow) must NOT
      // re-enter the queue: completed goals are terminal
      // from the queue's perspective. Push them to history under the
      // "completed" reason so the board's Completed section surfaces
      // them, and skip the upcoming demote.
      let nextUpcoming: GoalRecordV1[];
      if (currentActive) {
        if (currentActive.status === "complete") {
          await this.appendGoalHistoryEntry(workspaceId, currentActive, "completed");
          nextUpcoming = board.upcoming;
        } else {
          nextUpcoming = [currentActive, ...board.upcoming];
        }
      } else {
        nextUpcoming = board.upcoming;
      }

      await this.writeBoard(workspaceId, {
        ...board,
        upcoming: nextUpcoming,
      });
      await this.writeGoal(workspaceId, activated);
      await this.pushSnapshot(workspaceId, activated);
      this.emitLifecycle("goal_resumed", { initiator: "user" });
      return activated;
    });
    if (promotedGoal) {
      this.recordGoalSet(workspaceId, promotedGoal);
      this.armContinuationForPromotedGoal(workspaceId, promotedGoal);
    }
    return promotedGoal;
  }

  /**
   * Called after a `complete` status transition inside `setGoal` to move the
   * completed goal into the Complete board section and promote the next queued
   * goal into focus.
   *
   * Behavior:
   *   - If the transition isn't into `complete`, no-op.
   *   - If there are no upcoming goals queued, no-op — the existing
   *     UX (completion summary on the active card) stays intact for
   *     users who don't use the queue. This preserves backward compat.
   *   - Otherwise: append the completed goal to `goal-history.jsonl`
   *     under `completed` endReason, then promote the head of upcoming
   *     into the active slot. The previously-completed goal then only
   *     lives in history (the Board renders it under the Completed
   *     section).
   *
   * Caller must hold the workspace file lock; promotion + history
   * append happen under the same lock as the original mutation so the
   * board snapshot is always consistent.
   */
  private async maybeAutoPromoteOnComplete(
    workspaceId: string,
    completedGoal: GoalRecordV1,
    previousStatus: GoalStatus,
    options?: { stopVeto?: () => boolean }
  ): Promise<void> {
    if (completedGoal.status !== "complete" || previousStatus === "complete") {
      return;
    }
    const board = await this.readBoard(workspaceId);
    if (board.upcoming.length === 0) {
      return;
    }
    // check BOTH the streaming guard and the pricing
    // gate BEFORE appending the completion history entry. Either
    // failure here means promotion can't go through; we must leave
    // the completed goal in `goal.json` so a later retry archives it
    // exactly once instead of producing a duplicate Completed row.
    if (await this.isWorkspaceStreaming(workspaceId)) {
      log.warn("Auto-promote on complete skipped: workspace is still streaming", {
        workspaceId,
        goalId: board.upcoming[0].goalId,
      });
      return;
    }
    const [head] = board.upcoming;
    const projected = GoalRecordV1Schema.parse({
      ...head,
      status: "active",
      updatedAtMs: Date.now(),
    });
    if (!(await this.canRunBudgetedGoalOnKickoffModel(workspaceId, projected))) {
      log.warn(
        "Auto-promote on complete skipped: queued goal is budgeted but kickoff model is unpriced",
        { workspaceId, goalId: head.goalId }
      );
      return;
    }
    // Codex P1 (PRRT_kwDOPxxmWM6cOgXV): the board/streaming/pricing reads
    // above await after the caller's last stop sample. Re-sample before the
    // first durable write so an abort landing during those reads neither
    // archives the aborted completion nor promotes the next goal; the caller
    // re-checks after we return and restores the prior record.
    if (options?.stopVeto?.() === true) {
      return;
    }
    // Move the completed goal into history before overwriting goal.json
    // with the promoted goal. The board's Completed section reads from
    // history, so this is what makes the just-completed goal visible
    // there.
    await this.appendGoalHistoryEntry(workspaceId, completedGoal, "completed");
    await this.promoteNextUpcomingUnlocked(workspaceId, options);
  }

  /**
   * Called after a goal is marked complete (by agent or user) or
   * cleared. If `upcoming` has a head, promote it to active so the
   * agent has a roadmap to pick up immediately. Promotion also arms the
   * kickoff continuation when a runtime bridge can supply send options; this
   * matches explicit resume and prevents queued goals from waiting on a
   * pause/unpause nudge.
   *
   * Caller must hold the workspace file lock. Returns the new active
   * record if a promotion happened, null otherwise.
   */
  private async promoteNextUpcomingUnlocked(
    workspaceId: string,
    options?: { stopVeto?: () => boolean }
  ): Promise<GoalRecordV1 | null> {
    const board = await this.readBoard(workspaceId);
    if (board.upcoming.length === 0) return null;
    // same mid-stream guard as `promoteUpcomingGoal`.
    // `clearGoal` and `maybeAutoPromoteOnComplete` invoke this helper
    // while a stream may still be running (the agent's `complete_goal`
    // tool fires mid-turn). Writing the queued goal to `goal.json` in
    // that window lets the remaining stream cost get attributed to the
    // newly-promoted record. Skip the auto-promote while streaming —
    // the caller (manual setGoal/clearGoal flow) already succeeded;
    // the upcoming head stays intact and the user can trigger a
    // promote later (or stream-end will land here naturally on the
    // next mutation).
    if (await this.isWorkspaceStreaming(workspaceId)) {
      log.warn("Auto-promote on complete skipped: workspace is still streaming", {
        workspaceId,
        goalId: board.upcoming[0].goalId,
      });
      return null;
    }
    const [head, ...rest] = board.upcoming;
    const now = Date.now();
    // same budget-driven normalization as
    // `promoteUpcomingGoal`. Cover the auto-promote-on-complete path
    // and the deferred stream-end path; both write the head into
    // `goal.json` and need to respect already-exhausted limits.
    // Also clear `completionSummary` (see `promoteUpcomingGoal` for
    // the rationale — agent's `get_goal` would otherwise see a stale
    // 'done' message on a revived/promoted goal).
    const baseActivated = GoalRecordV1Schema.parse({
      ...head,
      status: "active",
      updatedAtMs: now,
      completionSummary: undefined,
      requireUserAcknowledgmentSinceMs: null,
      // Auto-promotion is not user consent: clear any stale activation stamp
      // a previously user-activated (then demoted) goal may still carry so the
      // queue-race pause bypasses fail closed for this activation.
      lastUserActivationAtMs: null,
    });
    const activated = applyBudgetDrivenStatus(baseActivated, { nowMs: Date.now() });
    // same pricing gate as `promoteUpcomingGoal`. If the next
    // queued goal is budgeted and the workspace is currently on an
    // unpriced model, refuse the auto-promotion — otherwise we'd leave
    // the workspace in a state where the user can't send messages
    // (their active goal is blocked by `assertPricedModelForBudgetedGoal`).
    // The completion mutation still succeeds; the upcoming list keeps
    // its head and the user is left to either change models or clear
    // the head goal before the next promote attempt.
    if (!(await this.canRunBudgetedGoalOnKickoffModel(workspaceId, activated))) {
      log.warn(
        "Auto-promote on complete skipped: queued goal is budgeted but kickoff model is unpriced",
        { workspaceId, goalId: head.goalId }
      );
      return null;
    }
    // Codex P1 (PRRT_kwDOPxxmWM6cOgXV): last stop sample before the promotion
    // writes — an abort landing during this helper's own board/streaming/
    // pricing reads must not promote a goal from the aborted turn.
    if (options?.stopVeto?.() === true) {
      return null;
    }
    // Snapshot for the post-write rollback below: the caller's completion (or
    // prior record) currently occupies goal.json.
    const priorGoal = options?.stopVeto != null ? await this.readGoalFile(workspaceId) : null;
    await this.writeBoard(workspaceId, { ...board, upcoming: rest });
    await this.writeGoal(workspaceId, activated);
    await this.pushSnapshot(workspaceId, activated);
    // Codex P1 (PRRT_kwDOPxxmWM6cS8B4): the sample above precedes the three
    // awaited writes. A Stop landing inside them would otherwise leave the
    // promotion durable — the caller deliberately skips restoring once
    // goal.json no longer holds its completion, so the aborted turn's
    // completion would survive and the board would advance despite the Stop.
    // Re-sample and roll the transaction back: restore the pre-promotion
    // board and goal record and re-publish. The completed goal's history
    // entry stays (append-only and cosmetic, matching stops that land during
    // other archive appends); the caller's own recheck then restores its
    // pre-completion record normally.
    if (options?.stopVeto?.() === true) {
      await this.writeBoard(workspaceId, board);
      if (priorGoal != null) {
        await this.writeGoal(workspaceId, priorGoal);
      } else {
        await fs.rm(this.getFilePath(workspaceId), { force: true });
      }
      await this.pushSnapshot(workspaceId, priorGoal);
      return null;
    }
    this.emitLifecycle("goal_created", {
      viaFork: false,
      sourceStatus: head.status,
      objectiveLengthBucket: lengthBucket(head.objective.length),
      hasBudget: activated.budgetCents != null,
      hasTurnCap: activated.turnCap != null,
    });
    this.recordGoalSet(workspaceId, activated);
    this.armContinuationForPromotedGoal(workspaceId, activated);
    return activated;
  }
}

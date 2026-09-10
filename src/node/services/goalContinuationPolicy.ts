import type { GoalRecordV1 } from "@/common/types/goal";
import { hasGoalBudgetLimit, normalizeGoalBudgetCents } from "@/common/utils/goals/budgetPricing";

export const MICRO_CENTS_PER_CENT = 1_000_000;

/**
 * Returns the goal's accumulated cost in micro-cents, falling back to the
 * coarser `costCents` field for goals persisted before micro-cent tracking
 * was added.
 */
export function getGoalCostMicroCents(goal: GoalRecordV1): number {
  return goal.costMicroCents ?? goal.costCents * MICRO_CENTS_PER_CENT;
}

export type GoalContinuationSkipReason =
  | "not_registered"
  | "no_pending_candidate"
  | "workspace_not_found"
  | "archived"
  | "transcript_only"
  | "initializing"
  | "incompatible_runtime"
  | "child_workspace"
  | "active_descendant_tasks"
  | "currently_streaming"
  | "queued_user_input"
  | "pending_follow_up"
  | "plan_mode"
  | "compact_mode"
  | "user_stop"
  | "goal_missing"
  | "goal_mismatch"
  | "goal_not_active"
  | "requires_ack"
  | "budget_wrapup_already_fired"
  | "budget_wrapup_suppressed"
  | "cooldown";
export type GoalStreamOriginKind = "goal_continuation" | "goal_budget_limit" | "user" | "other";
export type GoalContinuationDecision =
  | { kind: "continue"; mode: "continuation" | "budget_wrapup" }
  | { kind: "defer"; reason: GoalContinuationSkipReason; untilMs: number }
  | { kind: "stop"; reason: GoalContinuationSkipReason; dropCandidate: boolean };

export interface GoalContinuationPolicyState {
  nowMs: number;
  bridgeRegistered: boolean;
  candidate: {
    goalId: string;
    source: "stream_end" | "kickoff" | "budget_wrapup";
    sendOptions: { agentId?: string | null; mode?: string | null };
  } | null;
  workspace: { found: boolean; archived: boolean; hasPath: boolean; isChild: boolean };
  hasActiveDescendantTasks: boolean;
  runtime: {
    isInitializing: boolean;
    isRuntimeCompatible: boolean;
    isBusy: boolean;
    hasQueuedMessages: boolean;
    hasPendingFollowUp: boolean;
  };
  isStreaming: boolean;
  userStopAtMs: number | null;
  stopCheckGoal: Pick<GoalRecordV1, "createdAtMs"> | null;
  goal: Pick<
    GoalRecordV1,
    | "goalId"
    | "status"
    | "requireUserAcknowledgmentSinceMs"
    | "budgetLimitInjectedForGoalId"
    | "lastContinuationFiredAtMs"
  > | null;
  lastStreamStamp: { goalId: string | null; originKind: GoalStreamOriginKind } | null;
  continuationCooldownMs: number;
  allowUserOriginBudgetWrapup: boolean;
}

/**
 * Staged input for `evaluateGoalContinuationBeforeGoal`: the shell gathers
 * I/O progressively and an absent (undefined) field means "not gathered yet",
 * so evaluation stops there with null. This keeps the pre-extraction I/O
 * gating (e.g. no goal-file reads while the workspace is busy) while every
 * decision branch stays pure.
 */
export type GoalContinuationPolicyProbe = Pick<
  GoalContinuationPolicyState,
  "nowMs" | "bridgeRegistered" | "candidate"
> &
  Partial<
    Pick<
      GoalContinuationPolicyState,
      | "workspace"
      | "hasActiveDescendantTasks"
      | "runtime"
      | "isStreaming"
      | "userStopAtMs"
      | "stopCheckGoal"
    >
  >;

const stop = (
  reason: GoalContinuationSkipReason,
  dropCandidate: boolean
): GoalContinuationDecision => ({ kind: "stop", reason, dropCandidate });
const defer = (reason: GoalContinuationSkipReason, untilMs: number): GoalContinuationDecision => ({
  kind: "defer",
  reason,
  untilMs,
});

export function evaluateGoalContinuationBeforeGoal(
  state: GoalContinuationPolicyProbe
): GoalContinuationDecision | null {
  const candidate = state.candidate;
  if (!candidate) return stop("no_pending_candidate", false);
  if (!state.bridgeRegistered) return stop("not_registered", false);
  if (!state.workspace) return null;
  if (!state.workspace.found) return stop("workspace_not_found", true);
  if (state.workspace.archived) return stop("archived", true);
  if (!state.workspace.hasPath) return stop("transcript_only", true);
  if (state.workspace.isChild) return stop("child_workspace", true);
  if (state.hasActiveDescendantTasks == null) return null;
  if (state.hasActiveDescendantTasks) return stop("active_descendant_tasks", false);
  if (!state.runtime) return null;
  if (state.runtime.isInitializing) return defer("initializing", state.nowMs + 1_000);
  if (!state.runtime.isRuntimeCompatible) return stop("incompatible_runtime", true);
  if (state.runtime.isBusy) return defer("currently_streaming", state.nowMs + 1_000);
  if (state.isStreaming == null) return null;
  if (state.isStreaming) return defer("currently_streaming", state.nowMs + 1_000);
  if (state.runtime.hasQueuedMessages) return stop("queued_user_input", false);
  if (state.runtime.hasPendingFollowUp) return stop("pending_follow_up", false);
  if (candidate.sendOptions.agentId === "plan" || candidate.sendOptions.mode === "plan") {
    return stop("plan_mode", true);
  }
  if (candidate.sendOptions.agentId === "compact" || candidate.sendOptions.mode === "compact") {
    return stop("compact_mode", true);
  }
  if (state.userStopAtMs === undefined) return null;
  if (state.userStopAtMs == null) return null;
  if (state.stopCheckGoal === undefined) return null;
  if (!state.stopCheckGoal) return stop("goal_missing", true);
  return state.userStopAtMs >= state.stopCheckGoal.createdAtMs ? stop("user_stop", true) : null;
}

export function evaluateGoalContinuationGoal(
  state: Pick<
    GoalContinuationPolicyState,
    | "nowMs"
    | "candidate"
    | "goal"
    | "lastStreamStamp"
    | "continuationCooldownMs"
    | "allowUserOriginBudgetWrapup"
  >
): GoalContinuationDecision {
  const { candidate, goal } = state;
  if (!goal || !candidate) return stop("goal_missing", true);
  if (goal.goalId !== candidate.goalId) return stop("goal_mismatch", true);
  if (
    goal.status !== "active" &&
    goal.status !== "budget_limited" &&
    (goal.status !== "paused" || candidate.source !== "kickoff")
  ) {
    return stop("goal_not_active", true);
  }
  if (goal.requireUserAcknowledgmentSinceMs != null) return stop("requires_ack", false);
  if (goal.status === "budget_limited") {
    if (goal.budgetLimitInjectedForGoalId === goal.goalId) {
      return stop("budget_wrapup_already_fired", true);
    }
    if (
      state.lastStreamStamp?.goalId !== goal.goalId ||
      !isBudgetWrapupEligibleOrigin(
        state.lastStreamStamp.originKind,
        state.allowUserOriginBudgetWrapup
      )
    ) {
      return stop("budget_wrapup_suppressed", true);
    }
    return { kind: "continue", mode: "budget_wrapup" };
  }
  const lastFiredAtMs = goal.lastContinuationFiredAtMs ?? null;
  return lastFiredAtMs != null && state.nowMs - lastFiredAtMs < state.continuationCooldownMs
    ? defer("cooldown", lastFiredAtMs + state.continuationCooldownMs)
    : { kind: "continue", mode: "continuation" };
}

export function evaluateGoalContinuation(
  state: GoalContinuationPolicyState
): GoalContinuationDecision {
  return evaluateGoalContinuationBeforeGoal(state) ?? evaluateGoalContinuationGoal(state);
}

export function hasReachedGoalBudgetLimit(goal: GoalRecordV1): boolean {
  const { budgetCents } = goal;
  if (budgetCents == null || !hasGoalBudgetLimit(budgetCents)) {
    return false;
  }
  return getGoalCostMicroCents(goal) >= budgetCents * MICRO_CENTS_PER_CENT;
}

export function hasReachedGoalTurnLimit(goal: GoalRecordV1): boolean {
  return goal.turnCap != null && goal.turnsUsed >= goal.turnCap;
}

export function hasReachedAnyGoalLimit(goal: GoalRecordV1): boolean {
  return hasReachedGoalBudgetLimit(goal) || hasReachedGoalTurnLimit(goal);
}

export function isBudgetWrapupEligibleOrigin(
  originKind: GoalStreamOriginKind,
  allowUserOriginBudgetWrapup: boolean
): boolean {
  return allowUserOriginBudgetWrapup || originKind !== "user";
}

export function applyBudgetDrivenStatus(
  goal: GoalRecordV1,
  options: { originKind?: GoalStreamOriginKind; nowMs: number }
): GoalRecordV1 {
  const budgetCents = normalizeGoalBudgetCents(goal.budgetCents);
  const normalized =
    budgetCents === goal.budgetCents ? goal : { ...goal, budgetCents, updatedAtMs: options.nowMs };
  const reachedLimit = hasReachedAnyGoalLimit(normalized);
  const limit = normalized.status === "active" && reachedLimit;
  const rearm = normalized.status === "budget_limited" && !reachedLimit;
  if (!limit && !rearm) return normalized;
  return {
    ...normalized,
    status: limit ? "budget_limited" : "active",
    budgetLimitInjectedForGoalId: rearm ? null : normalized.budgetLimitInjectedForGoalId,
    budgetLimitOriginKind: limit ? (options.originKind ?? null) : null,
    updatedAtMs: options.nowMs,
  };
}

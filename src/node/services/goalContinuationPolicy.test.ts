import { describe, expect, test } from "bun:test";
import type { GoalRecordV1 } from "@/common/types/goal";
import {
  applyBudgetDrivenStatus,
  evaluateGoalContinuation,
  hasReachedAnyGoalLimit,
  hasReachedGoalBudgetLimit,
  hasReachedGoalTurnLimit,
  isBudgetWrapupEligibleOrigin,
  type GoalContinuationDecision,
  type GoalContinuationPolicyState,
  type GoalStreamOriginKind,
} from "./goalContinuationPolicy";

const GOAL_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_GOAL_ID = "22222222-2222-4222-8222-222222222222";

function goal(overrides: Partial<GoalRecordV1> = {}): GoalRecordV1 {
  return {
    version: 1,
    goalId: GOAL_ID,
    objective: "Finish the refactor",
    status: "active",
    budgetCents: 100,
    turnCap: 10,
    costCents: 0,
    costMicroCents: 0,
    turnsUsed: 0,
    attributedChildren: [],
    budgetLimitInjectedForGoalId: null,
    budgetLimitOriginKind: null,
    requireUserAcknowledgmentSinceMs: null,
    lastContinuationFiredAtMs: null,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    ...overrides,
  };
}

type PolicyOverrides = Omit<
  Partial<GoalContinuationPolicyState>,
  "candidate" | "workspace" | "runtime" | "goal" | "lastStreamStamp"
> & {
  candidate?: GoalContinuationPolicyState["candidate"];
  workspace?: Partial<GoalContinuationPolicyState["workspace"]>;
  runtime?: Partial<GoalContinuationPolicyState["runtime"]>;
  goal?: GoalContinuationPolicyState["goal"];
  lastStreamStamp?: GoalContinuationPolicyState["lastStreamStamp"];
};

function policyState(overrides: PolicyOverrides = {}): GoalContinuationPolicyState {
  const base: GoalContinuationPolicyState = {
    nowMs: 10_000,
    bridgeRegistered: true,
    candidate: {
      goalId: GOAL_ID,
      source: "stream_end",
      sendOptions: { agentId: "exec", mode: "exec" },
    },
    workspace: { found: true, archived: false, hasPath: true, isChild: false },
    hasActiveDescendantTasks: false,
    runtime: {
      isInitializing: false,
      isRuntimeCompatible: true,
      isBusy: false,
      hasQueuedMessages: false,
      hasPendingFollowUp: false,
    },
    isStreaming: false,
    userStopAtMs: null,
    stopCheckGoal: null,
    goal: goal(),
    lastStreamStamp: null,
    continuationCooldownMs: 1_000,
    allowUserOriginBudgetWrapup: false,
  };
  return {
    ...base,
    ...overrides,
    candidate: overrides.candidate === undefined ? base.candidate : overrides.candidate,
    workspace: { ...base.workspace, ...overrides.workspace },
    runtime: { ...base.runtime, ...overrides.runtime },
    goal: overrides.goal === undefined ? base.goal : overrides.goal,
    lastStreamStamp:
      overrides.lastStreamStamp === undefined ? base.lastStreamStamp : overrides.lastStreamStamp,
  };
}

describe("evaluateGoalContinuation", () => {
  const cases: Array<{
    name: string;
    state: PolicyOverrides;
    expected: GoalContinuationDecision;
  }> = [
    {
      name: "stops without a pending candidate",
      state: { candidate: null },
      expected: { kind: "stop", reason: "no_pending_candidate", dropCandidate: false },
    },
    {
      name: "keeps the candidate when no bridge is registered",
      state: { bridgeRegistered: false },
      expected: { kind: "stop", reason: "not_registered", dropCandidate: false },
    },
    {
      name: "drops a candidate for a missing workspace",
      state: { workspace: { found: false } },
      expected: { kind: "stop", reason: "workspace_not_found", dropCandidate: true },
    },
    {
      name: "drops a candidate for an archived workspace",
      state: { workspace: { archived: true } },
      expected: { kind: "stop", reason: "archived", dropCandidate: true },
    },
    {
      name: "drops a transcript-only workspace candidate",
      state: { workspace: { hasPath: false } },
      expected: { kind: "stop", reason: "transcript_only", dropCandidate: true },
    },
    {
      name: "drops a child workspace candidate",
      state: { workspace: { isChild: true } },
      expected: { kind: "stop", reason: "child_workspace", dropCandidate: true },
    },
    {
      name: "keeps a candidate while descendant tasks are active",
      state: { hasActiveDescendantTasks: true },
      expected: { kind: "stop", reason: "active_descendant_tasks", dropCandidate: false },
    },
    {
      name: "defers while the runtime initializes",
      state: { runtime: { isInitializing: true } },
      expected: { kind: "defer", reason: "initializing", untilMs: 11_000 },
    },
    {
      name: "drops an incompatible runtime candidate",
      state: { runtime: { isRuntimeCompatible: false } },
      expected: { kind: "stop", reason: "incompatible_runtime", dropCandidate: true },
    },
    {
      name: "defers while the runtime is busy",
      state: { runtime: { isBusy: true } },
      expected: { kind: "defer", reason: "currently_streaming", untilMs: 11_000 },
    },
    {
      name: "defers while the workspace streams",
      state: { isStreaming: true },
      expected: { kind: "defer", reason: "currently_streaming", untilMs: 11_000 },
    },
    {
      name: "keeps a candidate behind queued user input",
      state: { runtime: { hasQueuedMessages: true } },
      expected: { kind: "stop", reason: "queued_user_input", dropCandidate: false },
    },
    {
      name: "keeps a candidate behind a pending follow-up",
      state: { runtime: { hasPendingFollowUp: true } },
      expected: { kind: "stop", reason: "pending_follow_up", dropCandidate: false },
    },
    {
      name: "drops plan-mode candidates",
      state: {
        candidate: {
          goalId: GOAL_ID,
          source: "stream_end",
          sendOptions: { agentId: "plan", mode: "exec" },
        },
      },
      expected: { kind: "stop", reason: "plan_mode", dropCandidate: true },
    },
    {
      name: "drops compact-mode candidates",
      state: {
        candidate: {
          goalId: GOAL_ID,
          source: "stream_end",
          sendOptions: { agentId: "exec", mode: "compact" },
        },
      },
      expected: { kind: "stop", reason: "compact_mode", dropCandidate: true },
    },
    {
      name: "drops when the stop-check goal is missing",
      state: { userStopAtMs: 2_000, stopCheckGoal: null },
      expected: { kind: "stop", reason: "goal_missing", dropCandidate: true },
    },
    {
      name: "drops when the user stopped after goal creation",
      state: { userStopAtMs: 2_000, stopCheckGoal: { createdAtMs: 2_000 } },
      expected: { kind: "stop", reason: "user_stop", dropCandidate: true },
    },
    {
      name: "drops when the normalized goal is missing",
      state: { goal: null },
      expected: { kind: "stop", reason: "goal_missing", dropCandidate: true },
    },
    {
      name: "drops when goal identity changed",
      state: { goal: goal({ goalId: OTHER_GOAL_ID }) },
      expected: { kind: "stop", reason: "goal_mismatch", dropCandidate: true },
    },
    {
      name: "drops inactive goals",
      state: { goal: goal({ status: "complete" }) },
      expected: { kind: "stop", reason: "goal_not_active", dropCandidate: true },
    },
    {
      name: "allows a paused kickoff",
      state: {
        candidate: { goalId: GOAL_ID, source: "kickoff", sendOptions: { agentId: "exec" } },
        goal: goal({ status: "paused" }),
      },
      expected: { kind: "continue", mode: "continuation" },
    },
    {
      name: "keeps a candidate while acknowledgment is required",
      state: { goal: goal({ requireUserAcknowledgmentSinceMs: 9_000 }) },
      expected: { kind: "stop", reason: "requires_ack", dropCandidate: false },
    },
    {
      name: "drops an already-fired budget wrap-up",
      state: {
        goal: goal({ status: "budget_limited", budgetLimitInjectedForGoalId: GOAL_ID }),
      },
      expected: { kind: "stop", reason: "budget_wrapup_already_fired", dropCandidate: true },
    },
    {
      name: "drops a suppressed budget wrap-up",
      state: {
        goal: goal({ status: "budget_limited" }),
        lastStreamStamp: { goalId: GOAL_ID, originKind: "user" },
      },
      expected: { kind: "stop", reason: "budget_wrapup_suppressed", dropCandidate: true },
    },
    {
      name: "continues an eligible budget wrap-up",
      state: {
        goal: goal({ status: "budget_limited" }),
        lastStreamStamp: { goalId: GOAL_ID, originKind: "goal_continuation" },
      },
      expected: { kind: "continue", mode: "budget_wrapup" },
    },
    {
      name: "defers during cooldown",
      state: { goal: goal({ lastContinuationFiredAtMs: 9_500 }) },
      expected: { kind: "defer", reason: "cooldown", untilMs: 10_500 },
    },
    {
      name: "continues exactly at the cooldown boundary",
      state: { goal: goal({ lastContinuationFiredAtMs: 9_000 }) },
      expected: { kind: "continue", mode: "continuation" },
    },
    {
      name: "continues immediately when CLI cooldown is zero",
      state: { continuationCooldownMs: 0, goal: goal({ lastContinuationFiredAtMs: 10_000 }) },
      expected: { kind: "continue", mode: "continuation" },
    },
  ];

  for (const entry of cases) {
    test(entry.name, () => {
      expect(evaluateGoalContinuation(policyState(entry.state))).toEqual(entry.expected);
    });
  }
});

describe("budget wrap-up origins", () => {
  const origins: GoalStreamOriginKind[] = [
    "goal_continuation",
    "goal_budget_limit",
    "user",
    "other",
  ];
  for (const allowUserOriginBudgetWrapup of [false, true]) {
    for (const origin of origins) {
      test(`${origin} with user-origin ${allowUserOriginBudgetWrapup ? "allowed" : "blocked"}`, () => {
        expect(isBudgetWrapupEligibleOrigin(origin, allowUserOriginBudgetWrapup)).toBe(
          origin !== "user" || allowUserOriginBudgetWrapup
        );
      });
    }
  }
});

describe("goal limit helpers", () => {
  test("uses micro-cent precision at the budget boundary", () => {
    expect(hasReachedGoalBudgetLimit(goal({ costCents: 100, costMicroCents: 99_999_999 }))).toBe(
      false
    );
    expect(hasReachedGoalBudgetLimit(goal({ costCents: 99, costMicroCents: 100_000_000 }))).toBe(
      true
    );
  });

  test("uses whole cents for legacy goals", () => {
    expect(hasReachedGoalBudgetLimit(goal({ costCents: 100, costMicroCents: undefined }))).toBe(
      true
    );
    expect(hasReachedGoalBudgetLimit(goal({ budgetCents: 0, costCents: 100 }))).toBe(false);
  });

  test("reaches the turn limit at the cap", () => {
    expect(hasReachedGoalTurnLimit(goal({ turnsUsed: 9 }))).toBe(false);
    expect(hasReachedGoalTurnLimit(goal({ turnsUsed: 10 }))).toBe(true);
    expect(hasReachedAnyGoalLimit(goal({ budgetCents: null, turnsUsed: 10 }))).toBe(true);
  });
});

describe("applyBudgetDrivenStatus", () => {
  test("limits an active goal and persists the origin", () => {
    expect(
      applyBudgetDrivenStatus(goal({ turnsUsed: 10 }), {
        originKind: "goal_continuation",
        nowMs: 2_000,
      })
    ).toMatchObject({
      status: "budget_limited",
      budgetLimitOriginKind: "goal_continuation",
      updatedAtMs: 2_000,
    });
  });

  test("re-arms a budget-limited goal when its cap is raised", () => {
    expect(
      applyBudgetDrivenStatus(
        goal({
          status: "budget_limited",
          turnsUsed: 10,
          turnCap: 20,
          budgetLimitInjectedForGoalId: GOAL_ID,
          budgetLimitOriginKind: "goal_continuation",
        }),
        { nowMs: 2_000 }
      )
    ).toMatchObject({
      status: "active",
      budgetLimitInjectedForGoalId: null,
      budgetLimitOriginKind: null,
      updatedAtMs: 2_000,
    });
  });

  test("normalizes zero budgets before evaluating limits", () => {
    expect(
      applyBudgetDrivenStatus(goal({ status: "budget_limited", budgetCents: 0 }), {
        nowMs: 2_000,
      })
    ).toMatchObject({ status: "active", budgetCents: null, updatedAtMs: 2_000 });
  });
});

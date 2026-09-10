import type { z } from "zod";
import type {
  GoalBoardEntrySchema,
  GoalBoardSnapshotSchema,
  GoalBoardV1Schema,
  GoalHistoryEndReasonSchema,
  GoalHistoryEntrySchema,
  GoalRecordV1Schema,
  GoalSetErrorSchema,
  GoalSnapshotSchema,
  GoalStatusSchema,
} from "@/common/orpc/schemas/goal";
import { GoalIdSchema } from "@/common/orpc/schemas/goal";

/**
 * Defensive validation for goal-scoping IDs read from unchecked persisted
 * metadata (chat.jsonl rows, compaction summaries). Durable goal IDs are
 * always UUIDs (see GoalIdSchema), so any non-UUID value is corrupt data —
 * not another goal's identity (Codex P2 PRRT_kwDOPxxmWM6cNxUY,
 * PRRT_kwDOPxxmWM6cRJEC).
 *
 * Callers treat a present-but-invalid ID by failure direction (Codex P2
 * PRRT_kwDOPxxmWM6cOHpI): a pause BOUNDARY degrades to legacy unscoped
 * semantics (conservative paused, never scoped), a CONTINUATION row is
 * skipped outright (corrupt data must not manufacture activity evidence),
 * and recovery paths discard the row's goal attribution entirely.
 */
export function toValidGoalId(value: unknown): string | null {
  const parsed = GoalIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export type GoalStatus = z.infer<typeof GoalStatusSchema>;
export type GoalRecordV1 = z.infer<typeof GoalRecordV1Schema>;
export type GoalSnapshot = z.infer<typeof GoalSnapshotSchema>;
export type GoalHistoryEndReason = z.infer<typeof GoalHistoryEndReasonSchema>;
export type GoalHistoryEntry = z.infer<typeof GoalHistoryEntrySchema>;
export type GoalBoardV1 = z.infer<typeof GoalBoardV1Schema>;
export type GoalBoardEntry = z.infer<typeof GoalBoardEntrySchema>;
export type GoalBoardSnapshot = z.infer<typeof GoalBoardSnapshotSchema>;

export type GoalSetError = z.infer<typeof GoalSetErrorSchema>;

/**
 * Conceptual lifecycle of a goal as seen on the goal-board UI. This is the
 * "where does this card live?" question, distinct from runtime mode:
 *
 *   - `active`   — the (at most one) goal the agent is currently driving.
 *                  May itself be running / paused / budget-limited — see
 *                  `GoalActiveMode` below for that sub-status.
 *   - `complete` — agent or user marked it done.
 *
 *   - `upcoming` — queued behind the active goal; the user has lined
 *                  this up next but the agent is not yet driving it.
 *   - `archived` — the user manually stashed this (after completion, or
 *                  to deprioritize without losing the context). Hidden
 *                  from the agent and from auto-promotion.
 *
 * The storage enum (`GoalStatus`) does NOT carry `upcoming` / `archived`
 * — those live on the per-workspace `goal-board.json` side table so the
 * existing single-goal `goal.json` storage and agent contract stay
 * unchanged. The UI gets the lifecycle by combining sources via
 * `GoalBoardSectionSchema` instead of squinting at one flat enum.
 */
export type GoalLifecycle = "active" | "complete";

/**
 * When a goal is lifecycle-`active`, its sub-status describes what the
 * agent is doing with it right now:
 *
 *   - `running`        — the agent may auto-continue this goal.
 *   - `paused`         — latest user turn is not a goal continuation (manual
 *                        intervention, explicit pause), or safety gates such as
 *                        an interrupted stream. Continuations are suppressed
 *                        until the user resumes.
 *   - `budget_limited` — internal-only transient state set by the budget
 *                        gate when cost or turn caps are hit.
 *
 * `null` when the goal is not lifecycle-active.
 */
export type GoalActiveMode = "running" | "paused" | "budget_limited";

export function goalLifecycle(status: GoalStatus): GoalLifecycle {
  switch (status) {
    case "active":
    case "paused":
    case "budget_limited":
      return "active";
    case "complete":
      return "complete";
  }
}

export function goalActiveMode(status: GoalStatus): GoalActiveMode | null {
  switch (status) {
    case "active":
      return "running";
    case "paused":
      return "paused";
    case "budget_limited":
      return "budget_limited";
    case "complete":
      return null;
  }
}

/**
 * True when the goal is the workspace's lifecycle-active goal (regardless
 * of whether it is currently running, paused, or budget-limited).
 *
 * Prefer this over `status === "active"` at every UI gate: the latter
 * silently treats a paused goal as "not active" even though paused is a
 * sub-status of active, which has caused bugs like the Resume button
 * disappearing when a budget cap is hit.
 */
export function isGoalLifecycleActive(status: GoalStatus): boolean {
  return goalLifecycle(status) === "active";
}

export function isGoalRunning(status: GoalStatus): boolean {
  return goalActiveMode(status) === "running";
}

export function isGoalPendingPersistence(goal: GoalSnapshot | null | undefined): boolean {
  return goal?.pendingPersistence === true;
}

export function toGoalSnapshot(goal: GoalRecordV1): GoalSnapshot {
  return {
    goalId: goal.goalId,
    status: goal.status,
    objective: goal.objective,
    budgetCents: goal.budgetCents,
    costCents: goal.costCents,
    turnsUsed: goal.turnsUsed,
    turnCap: goal.turnCap,
    ...(goal.completionSummary != null ? { completionSummary: goal.completionSummary } : {}),
    startedAtMs: goal.createdAtMs,
  };
}

export function toPendingGoalSnapshot(goal: GoalRecordV1): GoalSnapshot {
  return { ...toGoalSnapshot(goal), pendingPersistence: true };
}

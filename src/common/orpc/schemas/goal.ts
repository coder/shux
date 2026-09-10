import { z } from "zod";

export const GoalStatusSchema = z.enum(["active", "paused", "budget_limited", "complete"]);

/**
 * Public-callable subset of `GoalStatus`. `budget_limited` is reserved for
 * internal transitions driven by `applyBudgetDrivenStatus` — accepting it
 * from the oRPC layer would let a caller transition a paused goal to
 * `budget_limited`, which the budget-driven re-arm logic would then flip
 * back to `active`, bypassing the normal resume validation.
 */
export const PublicGoalStatusSchema = z.enum(["active", "paused", "complete"]);

/**
 * Origin kind of the stream that drove the goal into `budget_limited`.
 * Persisted in the goal record so `recoverPendingDispatchAfterRestart` can
 * decide whether to arm the wrap-up: only continuation/budget-limit/other
 * origins should trigger a synthetic wrap-up; if a user-origin stream hit
 * the budget the wrap-up was correctly suppressed pre-restart and must
 * stay suppressed.
 *
 * `null` means the field has not been set (legacy goal records, goals that
 * are not currently `budget_limited`).
 */
export const GoalBudgetLimitOriginKindSchema = z
  .enum(["goal_continuation", "goal_budget_limit", "user", "other"])
  .nullable();

/**
 * Durable goal identifiers are always UUIDs (`crypto.randomUUID()` at
 * creation). Share this schema wherever an unchecked value claims to be a
 * goal ID so validation stays as strict as the persisted record contract.
 */
export const GoalIdSchema = z.string().uuid();

export const GoalRecordV1Schema = z.object({
  version: z.literal(1),
  goalId: GoalIdSchema,
  objective: z.string().min(1),
  status: GoalStatusSchema,
  budgetCents: z.number().int().nonnegative().nullable(),
  turnCap: z.number().int().positive().nullable(),
  costCents: z.number().int().nonnegative(),
  // Total cost in millionths of a cent. Public snapshots still expose whole
  // cents, but persisted goal accounting must not discard sub-cent turns.
  costMicroCents: z.number().int().nonnegative().optional(),
  turnsUsed: z.number().int().nonnegative(),
  attributedChildren: z.array(z.string()),
  budgetLimitInjectedForGoalId: z.string().uuid().nullable(),
  // Origin of the stream that put the goal into `budget_limited`. Optional
  // so legacy persisted goal records keep loading without migration; new
  // writes set it explicitly. Only consulted by
  // `recoverPendingDispatchAfterRestart`.
  budgetLimitOriginKind: GoalBudgetLimitOriginKindSchema.optional(),
  requireUserAcknowledgmentSinceMs: z.number().int().nonnegative().nullable(),
  lastContinuationFiredAtMs: z.number().int().nonnegative().nullable().optional(),
  // Timestamp of the last EXPLICIT user action that made this goal active
  // (direct create, Resume, board promote — never model set_goal,
  // auto-promotion, or accounting re-arms). This is the consent anchor for
  // the queue-race pause bypasses: a manual message authored before this
  // moment was visibly pending when the user activated the goal, which is a
  // genuine opt-in. Optional so legacy records load without migration; goals
  // without it (including every model-created goal) FAIL CLOSED — a queued
  // manual message always pauses them (Codex security P2
  // PRRT_kwDOPxxmWM6cSGrq).
  lastUserActivationAtMs: z.number().int().nonnegative().nullable().optional(),
  completionSummary: z.string().optional(),
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
});

export const GoalSnapshotSchema = z.object({
  goalId: z.string().uuid(),
  status: GoalStatusSchema,
  objective: z.string().min(1),
  budgetCents: z.number().int().nonnegative().nullable(),
  costCents: z.number().int().nonnegative(),
  turnsUsed: z.number().int().nonnegative(),
  turnCap: z.number().int().positive().nullable(),
  completionSummary: z.string().optional(),
  startedAtMs: z.number().int().nonnegative(),
  pendingPersistence: z.boolean().optional(),
});

/**
 * Why a goal left the workspace's "current goal" slot. Persisted in the
 * goal-history JSONL so the goal board can surface completed goals without
 * re-creating lifecycle context from chat history.
 */
export const GoalHistoryEndReasonSchema = z.enum(["completed", "cleared", "replaced"]);

/**
 * One entry in the workspace's append-only goal history. Captures a snapshot
 * of the goal record at the moment it left the "current" slot, plus the
 * reason and time of departure so the UI can sort + label entries.
 */
export const GoalHistoryEntrySchema = z.object({
  version: z.literal(1),
  endReason: GoalHistoryEndReasonSchema,
  endedAtMs: z.number().int().nonnegative(),
  goal: GoalRecordV1Schema,
});

// Discriminated union so the oRPC handler can return typed errors for the
// invalid-transition / child-workspace branches that `setGoal` previously
// allowed to escape as unhandled 500s.
//
// `goal_conflict` carries the expected and actual goal ids. `expectedGoalId:
// null` means the caller explicitly expected no goal; `undefined` on input
// means no optimistic-concurrency check.
// The no-goal + status-set + no-objective path is classified as
// `invalid_transition`.
export const GoalSetErrorSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("goal_conflict"),
    expectedGoalId: z.string().uuid().nullable(),
    actualGoalId: z.string().uuid().nullable(),
  }),
  z.object({
    type: z.literal("child_workspace"),
    message: z.string(),
  }),
  z.object({
    type: z.literal("invalid_transition"),
    message: z.string(),
  }),
]);

export const GoalSetInputSchema = z.object({
  workspaceId: z.string().min(1),
  objective: z.string().nullish(),
  status: PublicGoalStatusSchema.nullish(),
  budgetCents: z.number().int().nonnegative().nullable().optional(),
  turnCap: z.number().int().positive().nullable().optional(),
  completionSummary: z.string().nullish(),
  expectedGoalId: z.string().uuid().nullish(),
  // When true and a current goal already exists, an objective update mutates
  // the existing record in place (preserving goalId + accounting) instead of
  // replacing it with a fresh goal. This backs the right-sidebar "Edit goal
  // objective" affordance, which should feel like the inline budget / turn-cap
  // edits rather than starting over. `/goal <objective>` and other replace
  // entry points omit the flag (default false) to keep their existing
  // semantics.
  editInPlace: z.boolean().nullish(),
  // NOTE: Internal-only fields like `requireUserAcknowledgmentSinceMs`
  // (crash-recovery acknowledgment gate), `initiator`, and other workflow
  // signals MUST NOT be exposed in the public oRPC schema. A client that
  // could pass `requireUserAcknowledgmentSinceMs: null` would otherwise be able to
  // clear the gate without user interaction, bypassing both the
  // acknowledgment requirement and the auto-pause that `acknowledgeUser`
  // applies. Internal callers use `WorkspaceGoalService.SetGoalInput`
  // directly, which still carries these fields.
});

export const GoalGetInputSchema = z.object({ workspaceId: z.string().min(1) });
export const GoalClearInputSchema = z.object({ workspaceId: z.string().min(1) });
/**
 * The "goal board" is the workspace's roadmap: a sequence of goals the
 * user has lined up, plus a holding pen for goals they have archived (so
 * archives stay visible in the UI without polluting the active or
 * upcoming lists). Completed goals come from the existing append-only
 * `goal-history.jsonl` and are not stored on the board.
 *
 * Persisted at `goal-board.json` next to `goal.json`. Kept as a separate
 * file so the existing goal.json + agent contract are untouched: the
 * agent's `get_goal` tool reads only `goal.json` and never learns about
 * upcoming or archived goals (the agent doesn't get to reorder its own
 * roadmap; the user owns the queue).
 */
export const GoalBoardV1Schema = z.object({
  version: z.literal(1),
  upcoming: z.array(GoalRecordV1Schema),
  archived: z.array(GoalRecordV1Schema),
});

/**
 * Where in the board a goal lives. `active` and `complete` are computed
 * from `goal.json` + `goal-history.jsonl`; `upcoming` and `archived`
 * live in `goal-board.json`. The renderer uses this to drive section
 * placement in the GoalTab without having to learn each underlying
 * storage location.
 */
export const GoalBoardSectionSchema = z.enum(["active", "upcoming", "complete", "archived"]);

/**
 * One row in the renderer-facing board response. Carries the goal record
 * plus its section so the UI can render four lists without having to
 * splice together the underlying sources itself.
 */
export const GoalBoardEntrySchema = z.object({
  section: GoalBoardSectionSchema,
  goal: GoalRecordV1Schema,
  /**
   * Append timestamp (ms since epoch) of the underlying history entry.
   * Only set for `complete` and `archived` entries — `active` /
   * `upcoming` don't have a meaningful "when did it leave" timestamp.
   */
  endedAtMs: z.number().int().nonnegative().optional(),
});

export const GoalBoardSnapshotSchema = z.object({
  entries: z.array(GoalBoardEntrySchema),
});

export const GoalBoardGetInputSchema = z.object({ workspaceId: z.string().min(1) });

/**
 * Add a new goal to the workspace's `upcoming` list. Mirrors the
 * objective + budget + turn-cap shape of `GoalSetInputSchema` for
 * symmetry; the backend resolves defaults the same way (
 * `resolveGoalSetIntent` is invoked client-side before this lands).
 */
export const GoalBoardAddUpcomingInputSchema = z.object({
  workspaceId: z.string().min(1),
  objective: z.string().min(1),
  budgetCents: z.number().int().nonnegative().nullable().optional(),
  turnCap: z.number().int().positive().nullable().optional(),
});

export const GoalBoardArchiveInputSchema = z.object({
  workspaceId: z.string().min(1),
  goalId: z.string().uuid(),
});

export const GoalBoardReviveInputSchema = z.object({
  workspaceId: z.string().min(1),
  goalId: z.string().uuid(),
});

export const GoalBoardReorderInputSchema = z.object({
  workspaceId: z.string().min(1),
  /**
   * The full new ordering of the `upcoming` list. We require the client
   * to pass the entire reordered list rather than (fromIndex, toIndex)
   * so concurrent edits don't drift the index — the server validates
   * the IDs match what it has and ignores out-of-band entries.
   */
  upcomingIds: z.array(z.string().uuid()),
});

export const GoalBoardPromoteInputSchema = z.object({
  workspaceId: z.string().min(1),
  goalId: z.string().uuid(),
});

/**
 * Patch an existing upcoming goal in place. Each field is optional so
 * the renderer can patch a single column (e.g. only objective) without
 * resending the others. `null` for budgetCents/turnCap explicitly
 * clears the limit; omitting the field leaves it untouched.
 */
export const GoalBoardUpdateUpcomingInputSchema = z.object({
  workspaceId: z.string().min(1),
  goalId: z.string().uuid(),
  objective: z.string().min(1).optional(),
  budgetCents: z.number().int().nonnegative().nullable().optional(),
  turnCap: z.number().int().positive().nullable().optional(),
});

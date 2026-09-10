import { z } from "zod";

export const TIMELINE_EVENT_KINDS = [
  "turn.user",
  "turn.synthetic",
  "turn.monitor_wake",
  "turn.background_wake",
  "turn.delegated",
  "turn.completed",
  "turn.interrupted",
  "turn.failed",
  "retry.scheduled",
  "retry.abandoned",
  "compaction.triggered",
  "compaction.completed",
  "context.reset",
  "history.cleared",
  "task.created",
  "task.progress",
  "task.reported",
  "task.failed",
  "task.interrupted",
  "workflow.attached",
  "workflow.result",
  "heartbeat.configured",
  "heartbeat.dispatched",
  "heartbeat.skipped",
  "goal.set",
  "goal.completed",
  "goal.budget_limited",
  "goal.continuation_dispatched",
  "settings.changed",
  "agent.event",
  "agent.plan_proposed",
  "agent.notified",
] as const;

export const TimelineEventKindSchema = z.enum(TIMELINE_EVENT_KINDS);
export type TimelineEventKind = z.infer<typeof TimelineEventKindSchema>;

// Kinds recorded by earlier builds of the timeline experiment. Unknown kinds render generically,
// so retired ones stay hidden instead of resurfacing the per-tool-call noise the feed dropped.
export const TIMELINE_RETIRED_KINDS: ReadonlySet<string> = new Set([
  "tool.call",
  "agent.mark",
  "agent.status",
  "agent.todo_completed",
]);

const timelineSourceShape = {
  system: z.enum(["chat", "heartbeat", "goal", "task", "settings", "agent"]),
  key: z.string().min(1).optional(),
};

export const TimelineSourceSchema = z.object(timelineSourceShape).strict();

const timelineAnchorShape = {
  // History sequences are 0-based, so the first message in a workspace anchors at 0.
  historySequence: z.number().int().nonnegative().optional(),
  messageId: z.string().min(1).optional(),
  toolCallId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  childWorkspaceId: z.string().min(1).optional(),
};

export const TimelineAnchorSchema = z.object(timelineAnchorShape).strict();

export const TimelineStatusSchema = z.enum([
  "started",
  "completed",
  "failed",
  "interrupted",
  "skipped",
]);

/**
 * Text reaching a timeline row is rendered in the sidebar, but several sources are unbounded: a
 * sub-agent's full report, or a provider error whose payload can run to megabytes. Bound it before
 * it reaches the append-only log, which is never rewritten and is shipped over IPC on every page.
 */
export const TIMELINE_TEXT_MAX_LENGTH = 600;

// Row digests are truncated by the mapper to this length. The preview card relies on the exact
// producer lengths to tell truncation apart from a digest that naturally ends in "...".
export const TIMELINE_ROW_DIGEST_MAX_LENGTH = 120;

function truncateNormalized(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

// TaskService stores longer digests than mapped rows, so cross-producer comparisons must reapply
// this cap.
export function truncateTimelineRowDigest(value: string): string {
  return truncateNormalized(value, TIMELINE_ROW_DIGEST_MAX_LENGTH);
}

export function truncateTimelineDigest(value: string): string {
  return truncateNormalized(value, TIMELINE_TEXT_MAX_LENGTH);
}

// A completed sub-agent report is recorded by TaskService and is also injected into parent history,
// which the mapper turns into a row too. Both sides key on the task so one report yields one row.
export function subagentReportSourceKey(taskId: string): string {
  return `task-report:${taskId}`;
}

// Free-text payload fields, as opposed to identifiers and enums that are bounded by their producer.
export const TIMELINE_TEXT_DATA_FIELDS = ["digest", "description", "reason", "title"] as const;

export function boundTimelineTextFields(
  data: TimelineEventData | undefined
): TimelineEventData | undefined {
  if (data == null) {
    return data;
  }
  let bounded = data;
  for (const field of TIMELINE_TEXT_DATA_FIELDS) {
    const value = bounded[field];
    if (value != null) {
      bounded = { ...bounded, [field]: truncateTimelineDigest(value) };
    }
  }
  return bounded;
}

const timelineEventDataShape = {
  model: z.string().optional(),
  mode: z.string().optional(),
  agentId: z.string().optional(),
  reason: z.string().optional(),
  errorKind: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  title: z.string().optional(),
  digest: z.string().optional(),
  description: z.string().optional(),
  category: z.enum(["picked_up", "milestone", "decision", "blocker", "handoff"]).optional(),
  usagePercent: z.number().optional(),
  newUsagePercent: z.number().optional(),
  attempt: z.number().int().positive().optional(),
  delayMs: z.number().nonnegative().optional(),
  scheduledAt: z.number().optional(),
  runId: z.string().optional(),
  goalId: z.string().optional(),
};

export const TimelineEventDataSchema = z.object(timelineEventDataShape).strict();

/**
 * Largest value `Date` accepts. A persisted row beyond it would throw a RangeError from
 * `toISOString()` while rendering, taking the whole feed down, so such a row is skipped on read.
 */
const MAX_DATE_MS = 8_640_000_000_000_000;

const timelineEventShape = {
  v: z.literal(1),
  seq: z.number().int().positive(),
  id: z.string().min(1),
  ts: z.number().nonnegative().max(MAX_DATE_MS),
  kind: z.string().min(1),
  source: TimelineSourceSchema,
  anchor: TimelineAnchorSchema.optional(),
  epoch: z.number().int().positive().optional(),
  status: TimelineStatusSchema.optional(),
  data: TimelineEventDataSchema.optional(),
};

export const TimelineEventSchema = z.object(timelineEventShape).strict();

// Reads tolerate keys and enum values this build does not declare, at every level, because a
// downgrade must still render rows a newer build wrote and retired kinds carry fields that were
// removed. Writes stay strict so we only persist known facts; dropping such a row on read instead
// would hide it from the feed entirely, and the log is never rewritten to repair it.
export const TimelineStoredEventSchema = z.object({
  ...timelineEventShape,
  source: z.object({ ...timelineSourceShape, system: z.string().min(1) }),
  anchor: z.object(timelineAnchorShape).optional(),
  status: z.string().min(1).optional(),
  data: z.object({ ...timelineEventDataShape, category: z.string().min(1).optional() }).optional(),
});

// Sequence recovery must survive rows this build cannot otherwise parse, or a new append could
// reuse a sequence number that already exists on disk.
export const TimelineSequenceEnvelopeSchema = z.object({ seq: z.number().int().positive() });

export const TimelineEventDraftSchema = TimelineEventSchema.omit({
  v: true,
  seq: true,
  id: true,
}).extend({
  ts: z.number().nonnegative().max(MAX_DATE_MS).optional(),
});

export const TimelineListInputSchema = z
  .object({
    cursor: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(200).optional(),
  })
  .strict();

// Wire payloads carry rows straight off disk, so they must tolerate the same future shapes reads
// do; validating them strictly would fail a whole page over one row a newer build wrote.
export const TimelinePageSchema = z
  .object({
    events: z.array(TimelineStoredEventSchema),
    nextCursor: z.number().int().positive().nullable(),
    hasOlder: z.boolean(),
  })
  .strict();

export const TimelineSubscriptionEventSchema = z.discriminatedUnion("type", [
  // The snapshot is the newest page, so it carries the same pagination metadata as `list`. Clients
  // page older events from this cursor instead of issuing their own initial `list`, which could
  // otherwise race appends and leave a permanent gap between the two pages.
  z
    .object({
      type: z.literal("snapshot"),
      events: z.array(TimelineStoredEventSchema),
      nextCursor: z.number().int().positive().nullable(),
      hasOlder: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal("appended"), events: z.array(TimelineStoredEventSchema) }).strict(),
]);

export const TimelinePreviewInputSchema = TimelineAnchorSchema;

export const TimelinePreviewSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    textExcerpt: z.string().max(TIMELINE_TEXT_MAX_LENGTH),
  })
  .strict();

export type TimelineSource = z.infer<typeof TimelineSourceSchema>;
export type TimelineAnchor = z.infer<typeof TimelineAnchorSchema>;
export type TimelineStatus = z.infer<typeof TimelineStatusSchema>;
export type TimelineEventData = z.infer<typeof TimelineEventDataSchema>;
export type TimelineEvent = z.infer<typeof TimelineStoredEventSchema>;
export type TimelineEventDraft = z.infer<typeof TimelineEventDraftSchema>;
export type TimelineListInput = z.infer<typeof TimelineListInputSchema>;
export type TimelinePage = z.infer<typeof TimelinePageSchema>;
export type TimelineSubscriptionEvent = z.infer<typeof TimelineSubscriptionEventSchema>;
export type TimelinePreview = z.infer<typeof TimelinePreviewSchema>;

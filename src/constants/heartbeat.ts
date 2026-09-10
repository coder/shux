export const HEARTBEAT_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const HEARTBEAT_MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const HEARTBEAT_DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

export const HEARTBEAT_CONTEXT_MODE_VALUES = ["normal", "compact", "reset"] as const;
export type HeartbeatContextMode = (typeof HEARTBEAT_CONTEXT_MODE_VALUES)[number];
export const HEARTBEAT_DEFAULT_CONTEXT_MODE: HeartbeatContextMode = "normal";

// Trigger: "idle" anchors the countdown to the last activity (a heartbeat fires only after
// the workspace has been quiet for a full interval); "interval" is a fixed wall-clock cadence
// that ignores activity.
export const HEARTBEAT_TRIGGER_VALUES = ["idle", "interval"] as const;
export type HeartbeatTrigger = (typeof HEARTBEAT_TRIGGER_VALUES)[number];
export const HEARTBEAT_DEFAULT_TRIGGER: HeartbeatTrigger = "idle";

// whenBusy: what happens when the heartbeat deadline fires while the workspace is busy
// (streaming, queued input, or active descendant tasks). "skip" misses the slot and waits
// for the next one; "tool-end"/"turn-end" enqueue the heartbeat message with the matching
// queue dispatch mode (SendMessageOptions.queueDispatchMode).
export const HEARTBEAT_WHEN_BUSY_VALUES = ["skip", "tool-end", "turn-end"] as const;
export type HeartbeatWhenBusy = (typeof HEARTBEAT_WHEN_BUSY_VALUES)[number];

/**
 * Queue dedupe key for scheduled heartbeat messages. A second heartbeat is never enqueued
 * while a previous one is still pending in the message queue (coalescing): heartbeats are
 * periodic check-ins, so a stacked duplicate adds noise without new information.
 */
export const HEARTBEAT_QUEUE_DEDUPE_KEY = "heartbeat-request";

export function isHeartbeatTrigger(value: unknown): value is HeartbeatTrigger {
  return HEARTBEAT_TRIGGER_VALUES.includes(value as HeartbeatTrigger);
}

export function isHeartbeatWhenBusy(value: unknown): value is HeartbeatWhenBusy {
  return HEARTBEAT_WHEN_BUSY_VALUES.includes(value as HeartbeatWhenBusy);
}

/**
 * Guard for the server-managed `scheduleUpdatedAt` cadence-edit timestamp (epoch ms).
 * Shared by the config normalizer and settings writer so persisted garbage is dropped
 * identically everywhere (self-healing).
 */
export function isValidHeartbeatScheduleUpdatedAt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export interface HeartbeatSchedulePolicy {
  trigger: HeartbeatTrigger;
  whenBusy: HeartbeatWhenBusy;
}

/**
 * Resolve the effective scheduling policy from (possibly sparse) persisted heartbeat settings.
 *
 * Defaults are intentionally resolved at read time instead of via Zod `.default()`:
 * strict-mode tool providers (OpenAI) send explicit `null` for omitted fields (which
 * `.default()` does not rewrite), and the `whenBusy` default is conditional on the resolved
 * trigger — an idle-triggered heartbeat skips busy slots (today's behavior), while a
 * fixed-interval heartbeat defaults to delivery after the current turn. Keeping unset values
 * unset in `~/.xum/config.json` also preserves the distinction between "user chose skip" and
 * "user never touched it".
 *
 * Invalid/null/undefined values fall back to the defaults (self-healing for hand-edited or
 * stale persisted config).
 */
export function resolveHeartbeatSchedulePolicy(
  settings: { trigger?: unknown; whenBusy?: unknown } | null | undefined
): HeartbeatSchedulePolicy {
  const trigger = isHeartbeatTrigger(settings?.trigger)
    ? settings.trigger
    : HEARTBEAT_DEFAULT_TRIGGER;
  const whenBusy = isHeartbeatWhenBusy(settings?.whenBusy)
    ? settings.whenBusy
    : trigger === "interval"
      ? "turn-end"
      : "skip";
  return { trigger, whenBusy };
}

export const HEARTBEAT_RESET_BOUNDARY_MESSAGE =
  "Heartbeat context reset. Earlier chat history is preserved on disk, but future requests will start from this boundary without generating a compaction summary.";

// Keep the idle-duration lead-in fixed so custom workspace heartbeats only override the
// instruction body, not the scheduler-generated runtime context.
export const HEARTBEAT_DEFAULT_MESSAGE_BODY =
  "Check in on the current state of this workspace — review any pending work, check for stale context, and determine if any action is needed. If everything looks good, briefly confirm the workspace status.";

const HEARTBEAT_MS_PER_MINUTE = 60 * 1000;
const HEARTBEAT_MS_PER_HOUR = 60 * HEARTBEAT_MS_PER_MINUTE;

/**
 * Human-readable heartbeat cadence, e.g. "30 minutes", "2 hours", "1 hour".
 *
 * Total over any positive interval: whole hours render as hours; everything else
 * rounds to the nearest minute. Rounding (rather than a raw "<ms> ms" fallback) keeps
 * an in-range but non-whole-minute intervalMs from leaking a millisecond count into the
 * UI/summary. Shared by the backend result summary (src/node/services/tools/heartbeat.ts)
 * and the HeartbeatToolCall card so the two never drift.
 */
export function formatHeartbeatInterval(intervalMs: number): string {
  if (intervalMs % HEARTBEAT_MS_PER_HOUR === 0) {
    const hours = intervalMs / HEARTBEAT_MS_PER_HOUR;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const minutes = Math.max(1, Math.round(intervalMs / HEARTBEAT_MS_PER_MINUTE));
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** Compact cadence for the header pill, e.g. "30m", "2h". Rounds like {@link formatHeartbeatInterval}. */
export function formatHeartbeatIntervalShort(intervalMs: number): string {
  if (intervalMs % HEARTBEAT_MS_PER_HOUR === 0) {
    return `${intervalMs / HEARTBEAT_MS_PER_HOUR}h`;
  }
  return `${Math.max(1, Math.round(intervalMs / HEARTBEAT_MS_PER_MINUTE))}m`;
}

export const HEARTBEAT_REMOVED_SUMMARY = "Heartbeat settings removed for this workspace.";

/** Human-readable heartbeat state, shared by the heartbeat tool result and the timeline row. */
export function summarizeHeartbeatSettings(
  settings: { enabled: boolean; intervalMs: number; trigger?: unknown; whenBusy?: unknown } | null
): string {
  if (!settings) {
    return "No heartbeat settings are configured for this workspace.";
  }

  const status = settings.enabled ? "enabled" : "disabled";
  // Mention the schedule shape only when it deviates from the default idle trigger.
  const scheduleSuffix =
    resolveHeartbeatSchedulePolicy(settings).trigger === "interval" ? " (fixed schedule)" : "";
  return `Heartbeat is ${status} for this workspace at ${formatHeartbeatInterval(settings.intervalMs)}${scheduleSuffix}.`;
}

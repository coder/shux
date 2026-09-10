/**
 * Host→guest sandbox event vocabulary (Track 2 RLM kernel).
 *
 * Events are queued on a workspace's persistent sandbox mount and drained by
 * guest code via `mux.events()`. The queue is best-effort acceleration only:
 * it lives in process memory, so an app restart drops undrained events. That
 * is harmless by design — the durable top-level terminal wake (taskService
 * terminal attention) remains the source of truth for task completion.
 */

/** Event type posted when a spawned child task reaches a terminal report. */
export const TASK_TERMINAL_EVENT_TYPE = "task-terminal";

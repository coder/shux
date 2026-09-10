import { z } from "zod";

/**
 * Internal attention policy for background work (sub-agent tasks, workspace-turn
 * handles, workflow runs). Determines how the owning workspace's stream-end
 * treats the work while it is still active.
 *
 * - `blocking_until_terminal`: active work forces the owner to call `task_await`
 *   before ending its turn (the historical force-await behavior). This is the
 *   default for foreground/default launches and for any legacy record missing a
 *   persisted policy (backward compatibility).
 * - `notify_on_terminal`: active work does NOT block the owner's turn-end. When
 *   the work reaches a terminal state Xum sends a targeted synthetic wake-up so
 *   the owner can integrate the completed output. This is derived from
 *   `run_in_background: true` and from foreground waits detached by a queued
 *   message or a foreground-wait timeout.
 *
 * This is internal in v1: it is not exposed as a model-visible tool parameter.
 */
export const BACKGROUND_WORK_ATTENTION_POLICIES = [
  "blocking_until_terminal",
  "notify_on_terminal",
] as const;

export type BackgroundWorkAttentionPolicy = (typeof BACKGROUND_WORK_ATTENTION_POLICIES)[number];

export const BackgroundWorkAttentionPolicySchema = z.enum(BACKGROUND_WORK_ATTENTION_POLICIES);

/** Missing/legacy persisted policy is treated as blocking for backward compatibility. */
export const DEFAULT_BACKGROUND_WORK_ATTENTION_POLICY: BackgroundWorkAttentionPolicy =
  "blocking_until_terminal";

export function resolveBackgroundWorkAttentionPolicy(
  policy: BackgroundWorkAttentionPolicy | undefined | null
): BackgroundWorkAttentionPolicy {
  return policy ?? DEFAULT_BACKGROUND_WORK_ATTENTION_POLICY;
}

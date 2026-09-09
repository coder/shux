// Smooth streaming presentation constants.
// These control the jitter buffer that makes streamed text appear at a steady cadence
// instead of bursty token clumps. Internal-only; no user-facing setting.
// Short visual debounce for sidebar status handoffs so the row stays anchored while
// startup/streaming flags settle on adjacent renders.
export const WORKSPACE_STREAMING_STATUS_TRANSITION_MS = 150;

/**
 * Average character-per-token estimate used to convert tokens-per-second (from
 * the streaming TPS calculator) into characters-per-second (consumed by the
 * smoothing engine to target the model's actual emission rate). 4 is the
 * standard heuristic for English text and most code.
 */
export const APPROX_CHARS_PER_TOKEN = 4;

export const STREAM_SMOOTHING = {
  /** Baseline reveal speed in characters per second when no live model rate is known yet. */
  BASE_CHARS_PER_SEC: 72,
  /** Floor — never slower than this even when buffer is nearly empty. */
  MIN_CHARS_PER_SEC: 24,
  /** Ceiling — hard cap to prevent overwhelming the markdown renderer. */
  MAX_CHARS_PER_SEC: 420,
  /** Backlog level where adaptive reveal runs at MAX_CHARS_PER_SEC. */
  CATCHUP_BACKLOG_CHARS: 180,
  /**
   * Soft catch-up threshold: above this lag the engine ramps target rate so
   * the lag drains within ~SOFT_CATCHUP_DRAIN_MS — instead of a visible jump.
   */
  SOFT_CATCHUP_LAG_CHARS: 60,
  /** Time horizon over which the engine aims to drain a soft-catchup lag. */
  SOFT_CATCHUP_DRAIN_MS: 250,
  /**
   * Hard safety threshold. Only a pathological burst (slow renderer, paused
   * tab) should ever push backlog this far; if it happens, snap visible
   * forward to keep the user from staring at a long invisible tail. With a
   * model emitting at typical rates the soft catch-up keeps backlog far
   * below this.
   */
  MAX_VISUAL_LAG_CHARS: 1024,
  /** Max characters revealed in a single animation frame. */
  MAX_FRAME_CHARS: 48,
  /**
   * Min characters revealed per tick once budget permits. Set to 2 so reveals
   * coalesce to ~30 Hz at the base rate instead of ~60 Hz — equal visual
   * smoothness to humans, half the markdown-reparse cost.
   */
  MIN_FRAME_CHARS: 2,
} as const;

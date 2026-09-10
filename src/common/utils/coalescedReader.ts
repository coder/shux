import assert from "@/common/utils/assert";

/**
 * Runs an async `read` at most once at a time, coalescing bursts of triggers into at
 * most one trailing read: trigger() marks state dirty, and a single reader loop keeps
 * reading until a read completes with no trigger landing during it. Because only the
 * latest state matters to callers, a burst of N triggers costs at most 2 reads instead
 * of queueing N, and serialized reads cannot resolve out of order (a stale snapshot can
 * never overwrite a newer one).
 *
 * A failed read re-marks dirty and retries after `retryDelayMs` instead of discarding
 * the trigger — a trigger may be the only signal an event source ever emits (e.g. a
 * process exit), so dropping it on a transient failure would leave consumers stale
 * forever. stop() ends the loop; triggers after stop() are ignored.
 */
export function createCoalescedReader(options: {
  read: () => Promise<void>;
  retryDelayMs: number;
}): {
  trigger: () => void;
  stop: () => void;
} {
  assert(
    Number.isFinite(options.retryDelayMs) && options.retryDelayMs >= 0,
    "createCoalescedReader requires a non-negative retryDelayMs"
  );
  let dirty = false;
  let running = false;
  let stopped = false;

  const run = async (): Promise<void> => {
    running = true;
    try {
      while (dirty && !stopped) {
        dirty = false;
        try {
          await options.read();
        } catch {
          dirty = true;
          await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs));
        }
      }
    } finally {
      running = false;
    }
  };

  return {
    trigger: () => {
      if (stopped) return;
      dirty = true;
      // Fire-and-forget is safe: run() catches read failures internally and cannot reject.
      if (!running) void run();
    },
    stop: () => {
      stopped = true;
    },
  };
}

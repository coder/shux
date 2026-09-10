import { afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn, vi } from "bun:test";
import { Duration } from "effect";
import { calculateBackoffDelay } from "@/common/utils/messages/retryState";
import { makeTestEffectRunner, type TestEffectRunner } from "./di/testEffectRunner";
import { RetryManager, type RetryStatusEvent } from "./retryManager";

/**
 * The backoff sleep runs on the injected `EffectRunner`'s clock, so the suite
 * drives it with a `TestClock` (`clock.adjust`) instead of intercepting
 * `setTimeout`. `setSystemTime` only pins `Date.now()` for the `scheduledAt`
 * stamp; it never drove timing. One default-runner smoke at the bottom keeps
 * the production path (Effect's default clock → real `setTimeout`) covered.
 */
describe("RetryManager", () => {
  let clock: TestEffectRunner;

  beforeEach(() => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    clock = makeTestEffectRunner();
  });

  afterEach(async () => {
    setSystemTime();
    await clock.dispose();
  });

  function createRetryManager() {
    const onRetry = vi.fn(() => Promise.resolve());
    const events: RetryStatusEvent[] = [];
    const onStatusChange = vi.fn((event: RetryStatusEvent) => {
      events.push(event);
    });

    return {
      manager: new RetryManager("workspace-1", onRetry, onStatusChange, clock.runner),
      onRetry,
      onStatusChange,
      events,
    };
  }

  /** Advance far past any backoff: a retry that is still armed would fire. */
  const adjustPastAnyBackoff = () => clock.adjust(Duration.millis(calculateBackoffDelay(6) * 2));

  it("uses exponential backoff delays from common retry state utilities", () => {
    expect(calculateBackoffDelay(0)).toBe(1000);
    expect(calculateBackoffDelay(1)).toBe(2000);
    expect(calculateBackoffDelay(2)).toBe(4000);
    expect(calculateBackoffDelay(6)).toBe(60000);
  });

  it("abandons non-retryable errors", async () => {
    const { manager, onRetry, onStatusChange, events } = createRetryManager();

    manager.handleStreamFailure({ type: "api_key_not_found" });

    expect(onStatusChange).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ type: "auto-retry-abandoned", reason: "api_key_not_found" }]);
    expect(manager.isRetryPending).toBe(false);
    await adjustPastAnyBackoff();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("non-retryable error cancels pending retryable timer", async () => {
    const { manager, onRetry, events } = createRetryManager();

    // Schedule a retryable error first
    manager.handleStreamFailure({ type: "unknown" });
    expect(manager.isRetryPending).toBe(true);

    // Then a non-retryable error arrives — should cancel the pending timer
    manager.handleStreamFailure({ type: "api_key_not_found" });
    expect(manager.isRetryPending).toBe(false);
    expect(events).toContainEqual({ type: "auto-retry-abandoned", reason: "api_key_not_found" });
    await adjustPastAnyBackoff();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("schedules and runs retry exactly at the backoff delay", async () => {
    const { manager, onRetry, events } = createRetryManager();

    manager.handleStreamFailure({ type: "unknown", message: "transient" });

    const expectedDelay = calculateBackoffDelay(1);
    expect(events).toEqual([
      {
        type: "auto-retry-scheduled",
        attempt: 1,
        delayMs: expectedDelay,
        scheduledAt: Date.now(),
      },
    ]);
    expect(manager.isRetryPending).toBe(true);

    await clock.adjust(Duration.millis(expectedDelay - 1));
    expect(onRetry).not.toHaveBeenCalled();
    expect(manager.isRetryPending).toBe(true);

    await clock.adjust(Duration.millis(1));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ type: "auto-retry-starting", attempt: 1 });
    expect(manager.isRetryPending).toBe(false);
  });

  it("exposes pending scheduled retry for reconnect snapshots", async () => {
    const { manager } = createRetryManager();

    manager.handleStreamFailure({ type: "unknown", message: "transient" });

    const snapshot = manager.getScheduledStatusSnapshot();
    expect(snapshot).toEqual({
      type: "auto-retry-scheduled",
      attempt: 1,
      delayMs: calculateBackoffDelay(1),
      scheduledAt: Date.now(),
    });

    // Snapshot should be defensive-copied.
    if (!snapshot) {
      throw new Error("Expected a pending retry snapshot");
    }
    snapshot.attempt = 99;

    expect(manager.getScheduledStatusSnapshot()).toEqual({
      type: "auto-retry-scheduled",
      attempt: 1,
      delayMs: calculateBackoffDelay(1),
      scheduledAt: Date.now(),
    });

    await clock.adjust(Duration.millis(calculateBackoffDelay(1)));
    expect(manager.getScheduledStatusSnapshot()).toBeNull();
  });

  it("clears pending scheduled snapshot when retry is canceled", () => {
    const { manager } = createRetryManager();

    manager.handleStreamFailure({ type: "unknown" });
    expect(manager.getScheduledStatusSnapshot()).not.toBeNull();

    manager.cancel();
    expect(manager.getScheduledStatusSnapshot()).toBeNull();
  });

  it("cancel clears pending retry timer", async () => {
    const { manager, onRetry } = createRetryManager();

    manager.handleStreamFailure({ type: "unknown" });
    expect(manager.isRetryPending).toBe(true);

    manager.cancel();
    expect(manager.isRetryPending).toBe(false);
    await adjustPastAnyBackoff();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("scheduled observers can cancel before the retry fiber is installed", async () => {
    const onRetry = vi.fn(() => Promise.resolve());
    const manager = new RetryManager(
      "workspace-1",
      onRetry,
      (event) => {
        if (event.type === "auto-retry-scheduled") manager.cancel();
      },
      clock.runner
    );

    manager.handleStreamFailure({ type: "unknown" });
    expect(manager.isRetryPending).toBe(false);
    expect(manager.getScheduledStatusSnapshot()).toBeNull();
    await adjustPastAnyBackoff();
    expect(onRetry).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("a reentrant replacement owns its fiber and status through the retired wake time", async () => {
    const onRetry = vi.fn(() => Promise.resolve());
    const events: RetryStatusEvent[] = [];
    const manager = new RetryManager(
      "workspace-1",
      onRetry,
      (event) => {
        events.push(event);
        if (event.type === "auto-retry-scheduled" && event.attempt === 1) {
          manager.handleStreamFailure({ type: "unknown", message: "replacement" });
        }
      },
      clock.runner
    );

    manager.handleStreamFailure({ type: "unknown", message: "retired" });
    const replacement = manager.getScheduledStatusSnapshot();
    await clock.adjust(Duration.millis(calculateBackoffDelay(1)));
    expect(onRetry).not.toHaveBeenCalled();
    expect(manager.isRetryPending).toBe(true);
    expect(manager.getScheduledStatusSnapshot()).toEqual(replacement);
    manager.cancel();
    await adjustPastAnyBackoff();
    expect(events.filter((event) => event.type === "auto-retry-starting")).toHaveLength(0);
    expect(onRetry).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("setEnabled(false) prevents scheduling", async () => {
    const { manager, onRetry, onStatusChange } = createRetryManager();

    manager.setEnabled(false);
    manager.handleStreamFailure({ type: "unknown" });

    expect(onStatusChange).not.toHaveBeenCalled();
    expect(manager.isRetryPending).toBe(false);
    await adjustPastAnyBackoff();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("setEnabled(false) cancels pending retry and emits abandoned event", async () => {
    const { manager, onRetry, events } = createRetryManager();

    manager.handleStreamFailure({ type: "unknown" });
    expect(manager.isRetryPending).toBe(true);

    manager.setEnabled(false);
    expect(manager.isRetryPending).toBe(false);
    expect(events).toContainEqual({
      type: "auto-retry-abandoned",
      reason: "disabled_by_user",
    });
    await adjustPastAnyBackoff();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("setEnabled(false) emits abandoned even after timer has fired (in-flight retry)", async () => {
    const { manager, events } = createRetryManager();

    // Schedule a retry, then let the backoff elapse so the fiber is past its
    // sleep but state.attempt > 0 (retry callback is in-flight).
    manager.handleStreamFailure({ type: "unknown" });
    expect(manager.isRetryPending).toBe(true);
    await clock.adjust(Duration.millis(calculateBackoffDelay(1)));
    expect(manager.isRetryPending).toBe(false);

    // Disable while the retry callback is executing. Even though the timer
    // is gone, the UI should still be cleared via abandoned event.
    manager.setEnabled(false);
    expect(events).toContainEqual({
      type: "auto-retry-abandoned",
      reason: "disabled_by_user",
    });
  });

  it("setEnabled(false) during auto-retry-starting prevents queued resume", async () => {
    const onRetry = vi.fn(() => Promise.resolve());
    const events: RetryStatusEvent[] = [];

    const managerRef: { current?: RetryManager } = {};
    const onStatusChange = vi.fn((event: RetryStatusEvent) => {
      events.push(event);
      if (event.type === "auto-retry-starting") {
        managerRef.current?.setEnabled(false);
      }
    });

    const manager = new RetryManager("workspace-1", onRetry, onStatusChange, clock.runner);
    managerRef.current = manager;

    manager.handleStreamFailure({ type: "unknown" });
    await clock.adjust(Duration.millis(calculateBackoffDelay(1)));

    expect(onRetry).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      type: "auto-retry-abandoned",
      reason: "disabled_by_user",
    });
  });

  it("starting publication owns exactly one claim even when its observer cancels synchronously", async () => {
    let owned = false;
    const released = vi.fn(() => {
      owned = false;
    });
    const onRetry = vi.fn(() => Promise.resolve());
    const begin = vi.fn(() => {
      owned = true;
      return { [Symbol.dispose]: released };
    });
    const manager = new RetryManager(
      "workspace-1",
      onRetry,
      (event) => {
        if (event.type !== "auto-retry-starting") return;
        expect(owned).toBe(true);
        manager.cancel();
        expect(owned).toBe(false);
      },
      clock.runner,
      begin
    );
    manager.handleStreamFailure({ type: "unknown" });
    await clock.adjust(calculateBackoffDelay(1));
    expect(begin).toHaveBeenCalledTimes(1);
    expect(released).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("an observer throwing after rescheduling cannot retire its replacement", async () => {
    const onRetry = vi.fn(() => Promise.resolve());
    const manager = new RetryManager(
      "workspace-1",
      onRetry,
      (event) => {
        if (event.type === "auto-retry-scheduled" && event.attempt === 1) {
          manager.handleStreamFailure({ type: "unknown" });
          throw new Error("observer failed after replacement");
        }
      },
      clock.runner
    );
    expect(() => manager.handleStreamFailure({ type: "unknown" })).toThrow();
    expect(manager.getScheduledStatusSnapshot()?.attempt).toBe(2);
    await clock.adjust(calculateBackoffDelay(2));
    expect(onRetry).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  it.each([false, true])(
    "a throwing starting observer releases only its own claim (replacement=%s)",
    async (replace) => {
      let owned = 0;
      const onRetry = vi.fn(() => Promise.resolve());
      const events: RetryStatusEvent[] = [];
      const manager = new RetryManager(
        "workspace-1",
        onRetry,
        (event) => {
          events.push(event);
          if (event.type === "auto-retry-starting" && event.attempt === 1) {
            if (replace) manager.handleStreamFailure({ type: "unknown" });
            throw new Error("starting observer failed");
          }
        },
        clock.runner,
        () => {
          owned += 1;
          return {
            [Symbol.dispose]: () => {
              owned -= 1;
            },
          };
        }
      );
      manager.handleStreamFailure({ type: "unknown" });
      await clock.adjust(calculateBackoffDelay(1));
      expect(owned).toBe(0);
      expect(onRetry).not.toHaveBeenCalled();
      if (replace) {
        expect(manager.getScheduledStatusSnapshot()?.attempt).toBe(2);
        await clock.adjust(calculateBackoffDelay(2));
        expect(onRetry).toHaveBeenCalledTimes(1);
      } else {
        expect(events).toContainEqual({
          type: "auto-retry-abandoned",
          reason: "starting observer failed",
        });
      }
      manager.dispose();
      expect(owned).toBe(0);
    }
  );

  it("ignores stale onRetry rejection after disable", async () => {
    let rejectRetry: ((reason?: unknown) => void) | undefined;
    const onRetry = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectRetry = reject;
        })
    );

    const events: RetryStatusEvent[] = [];
    const onStatusChange = vi.fn((event: RetryStatusEvent) => {
      events.push(event);
    });

    const manager = new RetryManager("workspace-1", onRetry, onStatusChange, clock.runner);

    manager.handleStreamFailure({ type: "unknown" });
    await clock.adjust(Duration.millis(calculateBackoffDelay(1)));
    expect(onRetry).toHaveBeenCalledTimes(1);

    manager.setEnabled(false);
    rejectRetry?.(new Error("late_retry_failure"));
    await Promise.resolve();
    await Promise.resolve();

    const abandonedReasons = events
      .filter(
        (event): event is Extract<RetryStatusEvent, { type: "auto-retry-abandoned" }> =>
          event.type === "auto-retry-abandoned"
      )
      .map((event) => event.reason);

    expect(abandonedReasons).toContain("disabled_by_user");
    expect(abandonedReasons).not.toContain("late_retry_failure");
  });

  it("reschedules when a second failure arrives while retry is pending", async () => {
    const { manager, onRetry, events } = createRetryManager();

    // First failure schedules a retry
    manager.handleStreamFailure({ type: "unknown" });
    expect(manager.isRetryPending).toBe(true);
    await clock.adjust(Duration.millis(calculateBackoffDelay(1) - 1));

    // Second failure should cancel the first and reschedule with higher backoff
    manager.handleStreamFailure({ type: "network" });
    expect(manager.isRetryPending).toBe(true);

    const scheduleEvents = events.filter(
      (event): event is Extract<RetryStatusEvent, { type: "auto-retry-scheduled" }> =>
        event.type === "auto-retry-scheduled"
    );
    expect(scheduleEvents).toHaveLength(2);
    // Second attempt should have higher backoff than first
    expect(scheduleEvents[1].attempt).toBeGreaterThan(scheduleEvents[0].attempt);

    // The superseded timer is gone: only the new one can fire, and only once.
    const secondDelayMs = calculateBackoffDelay(2);
    await clock.adjust(Duration.millis(secondDelayMs - 1));
    expect(onRetry).not.toHaveBeenCalled();
    await clock.adjust(Duration.millis(1));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("handleStreamSuccess resets retry attempt progression", async () => {
    const { manager, events } = createRetryManager();

    manager.handleStreamFailure({ type: "unknown" });
    await clock.adjust(Duration.millis(calculateBackoffDelay(1)));

    manager.handleStreamSuccess();
    manager.handleStreamFailure({ type: "unknown" });

    const scheduleEvents = events.filter(
      (event): event is Extract<RetryStatusEvent, { type: "auto-retry-scheduled" }> =>
        event.type === "auto-retry-scheduled"
    );

    expect(scheduleEvents).toHaveLength(2);
    expect(scheduleEvents[0]?.attempt).toBe(1);
    expect(scheduleEvents[1]?.attempt).toBe(1);
  });
});

/**
 * Default-runner smoke: with no runner injected (direct construction, the
 * aiService fallback) the backoff sleeps on Effect's default clock, i.e. a
 * real `setTimeout`. Intercepting the timer registration proves that path
 * without a two-second wall-clock wait.
 */
describe("RetryManager on the default runner", () => {
  it("arms the backoff as a real setTimeout and runs onRetry when it fires", async () => {
    const timers: Array<{ delayMs: number; fire: () => void }> = [];
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      timeout?: number
    ) => {
      if (typeof handler !== "function") {
        throw new Error("RetryManager smoke only supports function timer handlers");
      }
      timers.push({ delayMs: timeout ?? 0, fire: handler as () => void });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    try {
      const onRetry = vi.fn(() => Promise.resolve());
      const manager = new RetryManager("workspace-1", onRetry, () => undefined);

      manager.handleStreamFailure({ type: "unknown" });
      expect(manager.isRetryPending).toBe(true);
      expect(timers.map((timer) => timer.delayMs)).toEqual([calculateBackoffDelay(1)]);

      timers[0].fire();
      await Promise.resolve();
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(manager.isRetryPending).toBe(false);
      manager.dispose();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});

import { describe, expect, it } from "bun:test";
import { Clock, Context, Duration, Effect, Exit, Fiber, Schedule, Scope } from "effect";
import { makeAppRuntime } from "./appRuntime";
import { defaultEffectRunner, EffectRunnerLive, EffectRunnerTag } from "./effectRunner";
import { makeTestEffectRunner } from "./testEffectRunner";

/**
 * Pins the runtime facts the clock-driven workers rely on when they run
 * through an `EffectRunner` (Phase 11 PR 2 acceptance), so a later effect
 * upgrade that changes them fails here rather than in a worker suite.
 */
describe("EffectRunner", () => {
  it("defaultEffectRunner forks synchronously up to the first sleep", () => {
    const steps: string[] = [];

    const fiber = defaultEffectRunner.runFork(
      Effect.gen(function* () {
        steps.push("before-sleep");
        yield* Effect.sleep(Duration.hours(1));
        steps.push("after-sleep");
      })
    );

    expect(steps).toEqual(["before-sleep"]);
    defaultEffectRunner.runFork(Fiber.interrupt(fiber));
  });

  it("EffectRunnerLive captures the upstream Clock (a TestClock when provided)", async () => {
    const clock = makeTestEffectRunner();
    try {
      expect(clock.runner.runSync(Clock.currentTimeMillis)).toBe(0);
      await clock.adjust(Duration.millis(1_500));
      expect(clock.runner.runSync(Clock.currentTimeMillis)).toBe(1_500);
    } finally {
      await clock.dispose();
    }
  });

  it("schedules forked fibers on the default scheduler, not the eager build's sync scheduler", async () => {
    // makeAppRuntime builds with runSync, whose fiber carries a microtask
    // scheduler. EffectRunnerLive strips it so runner.runFork behaves like
    // Effect.runFork: a yield resumes on a macrotask.
    const app = makeAppRuntime(EffectRunnerLive);
    const runner = app.get(EffectRunnerTag);
    let resumed = false;

    runner.runFork(
      Effect.yieldNow.pipe(
        Effect.andThen(
          Effect.sync(() => {
            resumed = true;
          })
        )
      )
    );

    expect(resumed).toBe(false);
    await Promise.resolve();
    expect(resumed).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));
    expect(resumed).toBe(true);
  });

  it("rejects effects with service requirements at the type level", () => {
    class Probe extends Context.Service<Probe, { readonly name: string }>()("test/Probe") {}
    const needsService: Effect.Effect<void, never, Probe> = Effect.void;
    // @ts-expect-error -- EffectRunner is not a service locator: R must be never.
    defaultEffectRunner.runSync(needsService);
  });
});

describe("makeTestEffectRunner", () => {
  it("runFork reaches its first sleep synchronously and adjust resumes it with its continuation", async () => {
    const clock = makeTestEffectRunner();
    try {
      const steps: string[] = [];
      clock.runner.runFork(
        Effect.gen(function* () {
          steps.push("before-sleep");
          yield* Effect.sleep(Duration.minutes(1));
          steps.push("after-sleep");
        })
      );
      expect(steps).toEqual(["before-sleep"]);

      await clock.adjust(Duration.seconds(59));
      expect(steps).toEqual(["before-sleep"]);

      // The due sleep and its synchronous continuation run before adjust resolves.
      await clock.adjust(Duration.seconds(1));
      expect(steps).toEqual(["before-sleep", "after-sleep"]);
    } finally {
      await clock.dispose();
    }
  });

  it("drives a Schedule.fixed cadence one tick per interval, including nested due sleeps", async () => {
    const clock = makeTestEffectRunner();
    try {
      let ticks = 0;
      const scope = Scope.makeUnsafe();
      clock.runner.runSync(
        Effect.forkIn(
          Effect.gen(function* () {
            yield* Effect.sleep(Duration.seconds(60));
            yield* Effect.sync(() => {
              ticks += 1;
            }).pipe(Effect.repeat(Schedule.fixed(Duration.seconds(30))));
          }),
          scope
        )
      );

      await clock.adjust(Duration.seconds(60));
      expect(ticks).toBe(1);
      await clock.adjust(Duration.seconds(30));
      expect(ticks).toBe(2);
      // One adjust spanning two intervals fires both slots (the second sleep is
      // registered while the first resumes, still inside the adjust window).
      await clock.adjust(Duration.seconds(60));
      expect(ticks).toBe(4);

      clock.runner.runSync(Scope.close(scope, Exit.void));
      await clock.adjust(Duration.seconds(90));
      expect(ticks).toBe(4);
    } finally {
      await clock.dispose();
    }
  });

  it("closes a scope owning a TestClock-suspended fiber synchronously", async () => {
    const clock = makeTestEffectRunner();
    try {
      const scope = Scope.makeUnsafe();
      let interrupted = false;
      const fiber = clock.runner.runSync(
        Effect.forkIn(
          Effect.sleep(Duration.hours(1)).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true;
              })
            )
          ),
          scope
        )
      );

      // The worker stop() contract: the close completes synchronously because
      // the fiber only suspends on its clock, TestClock included.
      clock.runner.runSync(Scope.close(scope, Exit.void));

      expect(interrupted).toBe(true);
      expect(fiber.pollUnsafe()).toBeDefined();
    } finally {
      await clock.dispose();
    }
  });
});

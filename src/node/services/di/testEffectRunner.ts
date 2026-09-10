/**
 * Test helper: an `EffectRunner` bound to a `TestClock`, so a worker
 * constructed with `runner` sleeps on virtual time that the test advances with
 * `adjust`/`setTime` (no real timers, no polling).
 *
 * Built exactly like production (`EffectRunnerLive` at the base of a
 * `makeAppRuntime` graph) with `TestClock.layer()` as the provider, so the
 * worker under test and the test's `adjust` share one clock. `adjust` resolves
 * after every due sleep has been resumed and its synchronous continuation has
 * run (pinned in `testEffectRunner.test.ts`).
 */
import { Layer } from "effect";
import type { Duration } from "effect";
import { TestClock } from "effect/testing";
import { disposeAppRuntime, makeAppRuntime } from "./appRuntime";
import { EffectRunnerLive, EffectRunnerTag, type EffectRunner } from "./effectRunner";

export interface TestEffectRunner {
  readonly runner: EffectRunner;
  /** Advance the test clock, running every sleep due on or before the new time. */
  adjust(duration: Duration.Input): Promise<void>;
  /** Set the test clock to an absolute time (ms since epoch); same firing rule. */
  setTime(timestampMs: number): Promise<void>;
  dispose(): Promise<void>;
}

export function makeTestEffectRunner(options?: TestClock.TestClock.Options): TestEffectRunner {
  const app = makeAppRuntime(EffectRunnerLive.pipe(Layer.provideMerge(TestClock.layer(options))));
  const runner = app.get(EffectRunnerTag);
  return {
    runner,
    // Run through the runner so `TestClock.adjust` reads the captured clock.
    adjust: (duration) => runner.runPromise(TestClock.adjust(duration)),
    setTime: (timestampMs) => runner.runPromise(TestClock.setTime(timestampMs)),
    dispose: () => disposeAppRuntime(app.managed),
  };
}

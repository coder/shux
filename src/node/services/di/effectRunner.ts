/**
 * `EffectRunner` — the context-bound, *unsupervised* runner seam (Effect
 * migration Phase 11, PR 2).
 *
 * Clock-driven workers (heartbeat, idle compaction, retry backoff) run their
 * lifecycle fibers through an `EffectRunner` instead of the global
 * `Effect.runX`. The runner is a thin `Effect.run…With(context)` bundle, so:
 *
 * - **Same start semantics as `Effect.runX`.** `runSync` completes
 *   synchronously (a fiber that suspends is a defect, exactly like
 *   `Effect.runSync`), and `runFork` executes the fiber up to its first async
 *   boundary before returning — the ordering the workers' `start()`/`stop()`
 *   contracts rely on.
 * - **Unsupervised.** Fibers forked through it belong to the worker's own
 *   `Scope` (explicit `start()`/`stop()`), not to the app runtime:
 *   `runtime.dispose()` neither interrupts nor awaits them, and a late worker
 *   callback after dispose cannot hit "ManagedRuntime disposed". Work that
 *   must be awaited on shutdown forks into `AppFiberScope` instead
 *   (`./appFiberScope.ts`).
 * - **Not a service locator.** Every method accepts only `Effect<A, E, never>`:
 *   defaulted references such as `Clock` do not appear in `R`, so a
 *   context-bound runner lets a worker run on a `TestClock`, while anything
 *   that needs a service must take it as an explicit constructor dependency.
 *
 * `defaultEffectRunner` is the global runtime (today's exact behavior) and is
 * the default for every constructor parameter that accepts a runner, so
 * direct construction in tests and CLI roots is unchanged.
 */
import { Context, Effect, Layer, Scheduler, Scope } from "effect";
import type { Exit, Fiber } from "effect";

export interface EffectRunner {
  runSync<A, E>(effect: Effect.Effect<A, E, never>): A;
  runSyncExit<A, E>(effect: Effect.Effect<A, E, never>): Exit.Exit<A, E>;
  runFork<A, E>(effect: Effect.Effect<A, E, never>): Fiber.Fiber<A, E>;
  runPromise<A, E>(effect: Effect.Effect<A, E, never>): Promise<A>;
  runPromiseExit<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>>;
}

/** The global Effect runtime — what every worker used before the seam existed. */
export const defaultEffectRunner: EffectRunner = {
  runSync: Effect.runSync,
  runSyncExit: Effect.runSyncExit,
  runFork: Effect.runFork,
  runPromise: Effect.runPromise,
  runPromiseExit: Effect.runPromiseExit,
};

/** A runner whose fibers start with `context` (its `Clock` and other refs). */
export function effectRunnerFromContext(context: Context.Context<never>): EffectRunner {
  return {
    runSync: Effect.runSyncWith(context),
    runSyncExit: Effect.runSyncExitWith(context),
    runFork: Effect.runForkWith(context),
    runPromise: Effect.runPromiseWith(context),
    runPromiseExit: Effect.runPromiseExitWith(context),
  };
}

export class EffectRunnerTag extends Context.Service<EffectRunnerTag, EffectRunner>()(
  "xum/EffectRunner"
) {}

/**
 * Captures the building fiber's context, so the runner carries whatever the
 * layers beneath it provide (stores, and in tests a `TestClock` as the `Clock`
 * reference). Place it at the base of the graph.
 *
 * Build-fiber artifacts are stripped because they are not services: the layer
 * `Scope` (unsupervised fibers must not hold the runtime's scope), the layer
 * memo map, and the eager `runSync` build's microtask scheduler — without the
 * omit, every fiber forked through the runner would be scheduled on that
 * scheduler instead of the default one `Effect.runFork` uses.
 */
export const EffectRunnerLive: Layer.Layer<EffectRunnerTag> = Layer.effect(
  EffectRunnerTag,
  Effect.map(Effect.context<never>(), (context) =>
    effectRunnerFromContext(
      Context.omit(Scope.Scope, Layer.CurrentMemoMap, Scheduler.Scheduler)(context)
    )
  )
);

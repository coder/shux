/**
 * App-lifetime Effect runtime (Effect migration Phase 11) — and the durable
 * **DI contract** for the Layer graph it builds.
 *
 * A `ManagedRuntime` built from the process's Layer graph: `./layers/app.ts`
 * (`AppLive`) for `ServiceContainer` roots (desktop, `xum server`, ACP,
 * tests/ipc), `CoreLive` alone for the headless CLI roots (`xum run`,
 * `xum workflow`, via `coreServicesRoot.ts`). It owns the app-lifetime
 * `Scope`, its built `Context<AppTags>` is what oRPC Effect-native handlers
 * receive as `"effect/context"`, and it is the source of the two runtime seams
 * described below. Subscription streams run on this context, so heartbeat
 * sleeps use the runtime's Clock without inheriting build-fiber artifacts.
 * Service classes were not rewritten for this: Layers are
 * thin adapters around the existing constructors, and the former composition
 * roots' setter/listener wiring lives in `CoreWiringLive`/`DesktopWiringLive`
 * in the original statement order.
 *
 * ## Invariants (Phase 11 compatibility contract, not permanent law)
 *
 * - **I1 — Synchronous layer bodies.** Every Layer in the graph builds without
 *   suspending (`Layer.succeed`/`Layer.sync`/`Layer.effect` over sync effects;
 *   `acquireRelease` with a sync acquire is fine). `makeAppRuntime` builds the
 *   graph eagerly with `runSync` and asserts that it completed, so a layer that
 *   suspends fails right here — at construction, exactly where a throwing
 *   service constructor failed before, i.e. inside every entry point's
 *   existing startup catch path (`desktop/main.ts` "Startup Failed" dialog,
 *   `cli/server.ts`/ACP log-and-exit). Asynchronous acquisition belongs in
 *   `ServiceContainer.initialize()` / startup effects or a future explicit
 *   async factory root, never silently inside a layer. Eager building also
 *   sets `cachedContext`, so every `runtime.runX` is `Effect.run…With(context)`
 *   and a fiber started through it runs synchronously up to its first async
 *   boundary (the sync-start fact the codebase's deterministic-winner funnels
 *   rely on; pinned in `effectRunner.test.ts`).
 * - **I2 — Services never hold the `ManagedRuntime`.** After `dispose()` every
 *   `runX` on it dies with "ManagedRuntime disposed", so a late worker callback
 *   would defect. Workers hold an `EffectRunner` (`./effectRunner.ts`,
 *   default `defaultEffectRunner` = the global `Effect.runX`) whose `runX` is
 *   `Effect.run…With(ctx)` — same sync-start semantics, still valid after the
 *   runtime is gone. Supervision, when needed, is explicit via
 *   `AppFiberScope` (`./appFiberScope.ts`).
 * - **I3 — Per-call pipelines are untouched.** `Effect.runPromise(this.effects…)`
 *   facades and the `memoryConsolidationService` check-and-reserve funnels are
 *   not routed through DI; no lookup, runner call, or `await` may be inserted
 *   before `inFlight.set` / `harvestInFlight.set`. Only lifecycle forks in the
 *   clock-driven workers (heartbeat, idle compaction, retry backoff,
 *   `StreamManager.schedulePartialWrite`) go through `this.runner.runX`.
 * - **I4 — Signatures unchanged.** Constructors, Promise facades, private
 *   methods (spy seams) and module exports keep their shapes; a runner is an
 *   optional trailing constructor parameter defaulting to `defaultEffectRunner`.
 * - **I5 — No layer finalizers.** Teardown order stays explicit in
 *   `ServiceContainer.dispose()`/`shutdown()` and the CLI cleanup lists; layer
 *   bodies and wiring layers are `Effect.sync`-only and register no finalizers
 *   or forks, so `disposeAppRuntime` (the last step) reorders nothing. The one
 *   supervised resource, `AppFiberScope`, is closed at a fixed early position
 *   (see "Shutdown order").
 * - **I6 — Construction order is declared, never implied.** Wiring layers
 *   replay the former roots' setter/listener statements in order; a
 *   constructor may touch only its *declared* dependencies (built earlier by
 *   staging). Dependency order is expressed only with `Layer.provide` /
 *   `Layer.provideMerge` stages — never through `Layer.mergeAll` argument
 *   order, whose siblings may build in any order.
 * - **I7 — In-process only.** DI changes no persisted data, IPC wire shapes, or
 *   oRPC handler bodies (beyond the `effect/context` source).
 * - **I8 — One set of Layer definitions per service.** Every process root
 *   builds from the same layers (`CoreLive` is shared by `AppLive` and the CLI
 *   root). Unit harnesses (`createTestHistoryService`, `createTestToolConfig`,
 *   `createAgentSessionHarness`, …) intentionally bypass Layers and construct
 *   services directly.
 *
 * **R6 firewall.** In production code `Layer`, `ManagedRuntime` and
 * `TestClock` are imported only under `src/node/services/di/`, and every
 * `Context.Service` tag is declared there (`di/tags.ts`, plus the two seam
 * tags in `effectRunner.ts`/`appFiberScope.ts`; `orpc/effectContext.ts`
 * re-exports `MemoryMeta` and builds a narrow test-only context), so an effect
 * RC rename touches one directory. Tests may inject a `TestClock` beneath the
 * real graph (`serviceContainer.test.ts`) but go through `di/` helpers.
 *
 * ## Two seams, deliberately asymmetric
 *
 * - `EffectRunner` is **unsupervised**: fibers forked through it belong to the
 *   worker's own `Scope` (explicit `start()`/`stop()`, which stay synchronous
 *   because those fibers suspend only on the clock). Neither
 *   `closeScopeBounded(appFiberScope)` nor `disposeAppRuntime` interrupts or
 *   awaits them (pinned in `appFiberScope.test.ts`). Its `R = never` signature
 *   is what makes "not a service locator" a type error rather than a review
 *   item, and what lets a worker run on a `TestClock` (`./testEffectRunner.ts`).
 * - `AppFiberScope` is **supervised**: a child of the runtime's layer scope;
 *   fibers forked into it with `Effect.forkIn` are interrupted *and awaited*
 *   by `closeScopeBounded` early in `dispose()`, while every dependency they
 *   might touch during finalization is still alive. Occupant: the stream
 *   engine (`StreamManager.superviseEngine`, Wave 4 PR 1) — one supervisor
 *   fiber per stream, forked at registration and living until the turn's
 *   completion settles; the stream's AbortSignal stays the cancellation
 *   transport and interruption
 *   routes through the user-stop path (`"system"` abort, partial committed,
 *   `completion` settled) before the close resolves. **Rule for occupants:**
 *   tolerate interruption at any suspension point, do not depend on resources
 *   torn down before step 2 below, and never fork long-lived I/O work through
 *   `EffectRunner` expecting shutdown to await it.
 *
 * ## Startup (`ServiceContainer.initializeCore()`, Wave 4 PR 3)
 *
 * The hard startup steps (`startupCoreSteps`: the initializations request
 * handling depends on, then agent-task recovery) run as one startup effect on
 * the runtime — `runtime.managed.runPromise(startupCoreEffect())`, a
 * root fiber on the built context, not a layer (I1 keeps layer bodies
 * synchronous, so asynchronous acquisition lives here). Each step is a Promise
 * thunk in `Effect.tryPromise` with an identity catch, bounded by
 * `Effect.timeoutOrElse(STARTUP_STEP_TIMEOUT_MS)` on the runtime's `Clock`
 * (tests inject a `TestClock` beneath the graph and drive the bound
 * deterministically). Contract: step names/order are the `stepDurationsMs`
 * keys of the completion log; the first failure or timeout rejects the facade
 * with the step's own error (identity — v4 `runPromise` rejects with the raw
 * failure) or a `StartupStepTimeoutError`, later steps do not run, and a
 * timed-out step keeps running as a plain promise (the timeout interrupts only
 * the wait; nothing observes the step's result afterwards). Every root
 * therefore runs the bounded `dispose()` before exiting on a rejected startup
 * (desktop before-quit race, `cli/server.ts` `main().catch`, ACP
 * `connectToInProcessServer` catch) so an abandoned step's work is cut off by
 * the same latches as a quit. Disposing the runtime does not interrupt an
 * in-flight startup fiber (root fibers are not scope children), matching the
 * promise chain it replaced. `runStartupHousekeeping()` stays a Promise
 * pipeline on purpose: its steps are already cancellable through the dispose
 * abort signal and non-fatal by policy, so a per-step timeout there would be a
 * policy change, not a lifecycle fix.
 *
 * ## Shutdown order (`ServiceContainer.dispose()`, one shared teardown behind
 * a latch so concurrent/repeated calls — the desktop's two `before-quit`
 * listeners, tests' dispose-then-shutdown — await the same sequence)
 *
 * 1. `backgroundProcessManager.beginShutdown()` — first; the latch that keeps
 *    persisted armed-monitor records from being erased by session teardown.
 *    Then (server mode) abort the background startup housekeeping, latch every
 *    chat session against further dispatch (`workspaceService.beginShutdown()`,
 *    which also disposes the transient chat-recovery sessions housekeeping
 *    scheduled), and only then bounded-join the housekeeping.
 * 2. `closeScopeBounded(appFiberScope, APP_FIBER_SCOPE_CLOSE_TIMEOUT_MS)` —
 *    aborts (`"system"`) and awaits every in-flight stream; a flowing stream
 *    settles within one chunk, a wedged provider (no chunks, ignores abort)
 *    hits the bound, warns, and the process still exits.
 * 3. The explicit sequence verbatim (`desktopBridgeServer.stop()` …
 *    `terminateAll()` … `timelineService.flush()` last), each step timed as a
 *    `[shutdown] <step> {ms}` debug line (`shutdownStep.ts`).
 * 4. `disposeAppRuntime(runtime, APP_RUNTIME_DISPOSE_TIMEOUT_MS)` — last; also
 *    re-closes `AppFiberScope` idempotently as a backstop.
 * Both bounded teardowns share `boundedTeardown` below: `Effect.uninterruptible`
 * shell, detached close fiber, `Effect.interruptible` join + `Effect.timeout`,
 * defects folded into `log.warn`, never rejects. Budget: the two bounds
 * (`APP_FIBER_SCOPE_CLOSE_TIMEOUT_MS` + `APP_RUNTIME_DISPOSE_TIMEOUT_MS`,
 * `src/constants/terminationTimeouts.ts`) must add up to less than the callers'
 * outer quit budgets (`desktop/main.ts` before-quit race, `cli/server.ts`
 * force-exit timer), which stay the last line of defense. The CLI roots
 * (`xum run`/`xum workflow`) mirror steps 1, 2 and 4 in
 * their best-effort cleanup lists (`cli/runCleanup.ts`). `shutdown()` never
 * touches the runtime or `AppFiberScope`. Crash paths (`uncaughtException`,
 * SIGKILL) run no finalizers; durable state must stay crash-safe without them.
 *
 * ## Cost of the Layer machinery (recorded per PR; R7/R8)
 *
 * `[startup] AppRuntime built` grew 4 ms (PR 1, one layer) → 11 ms (PR 3,
 * coarse core) → 18 → 23 ms (PR 4a/4b, 19 core layers + 8 stages + wiring) and
 * reads 16–24 ms for the whole graph in `xum server`. Cold `new
 * ServiceContainer(stores)` went 27 → 35 ms when the six desktop group layers
 * + three composition nodes replaced the imperative constructor (PR 5:
 * ≈ +8 ms cold / +0.3 ms warm for ~40 services; a `provideMerge`-only chain
 * costs the same, so the cost is Effect first-use per layer, not sibling
 * concurrency). `make typecheck` stayed flat (±4 %). Group layers, not
 * per-service layers, are therefore the right granularity for tails whose
 * teardown is hand-tuned anyway.
 *
 * ## Deliberately not done in Phase 11
 *
 * Startup as a Layer (would break I1's failure semantics; it became a
 * runtime-run effect instead, see "Startup"), layer finalizers for the existing
 * `dispose()` steps (I5), per-service optional
 * tags (optional cross-cutting services stay optional via `CoreOptionsTag`),
 * per-step timeouts for `runStartupHousekeeping()` (policy, see "Startup"). The
 * streamManager engine core became the `AppFiberScope` occupant in Wave 4 PR 1;
 * the pre-registration stream-start window (`pendingStreamStarts`) stays
 * unsupervised (nothing durable exists for it yet).
 */
import assert from "@/common/utils/assert";
import {
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Scheduler,
  Scope,
} from "effect";
import {
  APP_FIBER_SCOPE_CLOSE_TIMEOUT_MS,
  APP_RUNTIME_DISPOSE_TIMEOUT_MS,
} from "@/constants/terminationTimeouts";
import { log } from "@/node/services/log";

export interface AppRuntime<R> {
  /** The runtime that owns the layer scope. Composition roots only (see contract). */
  readonly managed: ManagedRuntime.ManagedRuntime<R, never>;
  /** The built service context; also the oRPC `"effect/context"`. */
  readonly context: Context.Context<R>;
  /** Resolve a service instance from the built context. */
  readonly get: <I extends R, S>(tag: Context.Key<I, S>) => S;
}

/**
 * Build the runtime for `layer` eagerly and synchronously. Throws (constructor
 * semantics) if the graph cannot be built without suspending or a layer body
 * throws.
 */
export function makeAppRuntime<R>(layer: Layer.Layer<R, never, never>): AppRuntime<R> {
  const startedAt = performance.now();
  const managed = ManagedRuntime.make(layer);
  // Subscription pulls must not inherit the eager build's scope, memo map or sync scheduler.
  // These artifacts are not declared app services in R (see the DI contract).
  const context = Context.omit(
    Scope.Scope,
    Layer.CurrentMemoMap,
    Scheduler.Scheduler
  )(managed.runSync(Effect.context<R>())) as Context.Context<R>;
  assert(
    managed.cachedContext !== undefined,
    "AppRuntime layer graph must build synchronously (see DI contract in di/appRuntime.ts)"
  );
  log.debug("[startup] AppRuntime built", { ms: Math.round(performance.now() - startedAt) });
  return {
    managed,
    context,
    get: (tag) => Context.get(context, tag),
  };
}

/**
 * Close the runtime's scope (interrupting fibers started through it and running
 * layer finalizers in reverse order), bounded by `timeoutMs`. Never rejects and
 * is idempotent: a second call finds the scope already closed and returns.
 *
 * The close runs in a detached fiber and the caller waits on its join, so a
 * hung finalizer cannot pin shutdown past the bound — the wait is interrupted,
 * the finalizer keeps running best-effort, and a warning is logged.
 */
export function disposeAppRuntime(
  runtime: ManagedRuntime.ManagedRuntime<never, never>,
  timeoutMs: number = APP_RUNTIME_DISPOSE_TIMEOUT_MS
): Promise<void> {
  return Effect.runPromise(
    boundedTeardown("AppRuntime", "disposed", runtime.disposeEffect, timeoutMs)
  );
}

/**
 * Close a runtime-owned scope (`AppFiberScope`), interrupting and awaiting the
 * fibers forked into it, bounded by `timeoutMs`. Same contract as
 * `disposeAppRuntime`: never rejects, idempotent (`Scope.close` on a closed
 * scope is a no-op), warns and returns at the bound if a fiber's finalization
 * hangs.
 */
export function closeScopeBounded(
  scope: Scope.Closeable,
  timeoutMs: number = APP_FIBER_SCOPE_CLOSE_TIMEOUT_MS
): Promise<void> {
  return Effect.runPromise(
    boundedTeardown("AppFiberScope", "closed", Scope.close(scope, Exit.void), timeoutMs)
  );
}

/**
 * Uninterruptible teardown shell around a bounded wait on `target`. The target
 * runs in a detached fiber and the caller waits on its join, so a hung
 * finalizer cannot pin shutdown past the bound — only the wait is
 * interruptible (so the timeout can win the race; house shape from #4038),
 * the target keeps running best-effort, and a warning is logged. Defects are
 * folded into a warning so the returned effect never fails.
 */
function boundedTeardown(
  subject: string,
  doneVerb: string,
  target: Effect.Effect<void>,
  timeoutMs: number
): Effect.Effect<void> {
  const startedAt = performance.now();
  return Effect.uninterruptible(
    Effect.gen(function* () {
      const closing = yield* Effect.forkDetach(target);
      yield* Effect.interruptible(
        Fiber.join(closing).pipe(Effect.timeout(Duration.millis(timeoutMs)))
      ).pipe(
        Effect.catchTag("TimeoutError", () =>
          Effect.sync(() => {
            log.warn(`[shutdown] ${subject} teardown timed out; finalizers continue best-effort`, {
              timeoutMs,
            });
          })
        )
      );
      log.debug(`[shutdown] ${subject} ${doneVerb}`, {
        ms: Math.round(performance.now() - startedAt),
      });
    }).pipe(
      Effect.catchDefect((defect) =>
        Effect.sync(() => {
          log.warn(`[shutdown] ${subject} teardown failed`, { error: defect });
        })
      )
    )
  );
}

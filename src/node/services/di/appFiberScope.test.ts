import { describe, expect, it, spyOn } from "bun:test";
import { Effect, Exit, Fiber, Layer, Scope } from "effect";
import { log } from "@/node/services/log";
import { AppFiberScopeLive, AppFiberScopeTag } from "./appFiberScope";
import { closeScopeBounded, disposeAppRuntime, makeAppRuntime } from "./appRuntime";
import { EffectRunnerLive, EffectRunnerTag } from "./effectRunner";

/** An interruptible I/O-style suspension that never resolves; records interruption. */
function hungIo(onInterrupt: () => void): Effect.Effect<void> {
  return Effect.callback<void>(() =>
    Effect.sync(() => {
      onInterrupt();
    })
  );
}

function buildSeams() {
  const app = makeAppRuntime(AppFiberScopeLive.pipe(Layer.provideMerge(EffectRunnerLive)));
  return {
    app,
    appFiberScope: app.get(AppFiberScopeTag),
    runner: app.get(EffectRunnerTag),
  };
}

describe("AppFiberScope", () => {
  it("closeScopeBounded interrupts and awaits an I/O-suspended fiber forked into it", async () => {
    const { app, appFiberScope } = buildSeams();
    const steps: string[] = [];
    const fiber = app.managed.runSync(
      Effect.forkIn(
        hungIo(() => steps.push("cancelled")).pipe(
          Effect.ensuring(Effect.sync(() => steps.push("finalized")))
        ),
        appFiberScope
      )
    );

    await closeScopeBounded(appFiberScope);

    // Interrupted (the cancel path ran) and awaited (its finalizer ran before
    // the close resolved), so shutdown can rely on the fiber being gone.
    expect(steps).toEqual(["cancelled", "finalized"]);
    expect(fiber.pollUnsafe()).toBeDefined();
    expect(Exit.isFailure(fiber.pollUnsafe()!)).toBe(true);
    await disposeAppRuntime(app.managed);
  });

  it("fibers forked through the EffectRunner are interrupted by neither close (unsupervised)", async () => {
    const { app, appFiberScope, runner } = buildSeams();
    let interrupted = false;
    const fiber = runner.runFork(
      hungIo(() => {
        interrupted = true;
      })
    );

    await closeScopeBounded(appFiberScope);
    await disposeAppRuntime(app.managed);

    // The runner is not a supervisor: its fibers belong to whoever forked them
    // (a worker's own scope with an explicit stop()), so dispose leaves them be.
    expect(interrupted).toBe(false);
    expect(fiber.pollUnsafe()).toBeUndefined();
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(interrupted).toBe(true);
  });

  it("disposeAppRuntime re-closes an already-closed AppFiberScope idempotently", async () => {
    const { app, appFiberScope } = buildSeams();
    let finalized = 0;
    app.managed.runSync(
      Scope.addFinalizer(
        appFiberScope,
        Effect.sync(() => {
          finalized += 1;
        })
      )
    );

    await closeScopeBounded(appFiberScope);
    expect(finalized).toBe(1);

    // The runtime's layer scope owns the child; closing the runtime afterwards
    // must neither throw nor run the child's finalizers a second time.
    await disposeAppRuntime(app.managed);
    expect(finalized).toBe(1);
    expect(app.managed.cachedContext).toBeUndefined();
  });

  it("runtime dispose alone closes the AppFiberScope (backstop for a missed explicit close)", async () => {
    const { app, appFiberScope } = buildSeams();
    let interrupted = false;
    app.managed.runSync(
      Effect.forkIn(
        hungIo(() => {
          interrupted = true;
        }),
        appFiberScope
      )
    );

    await disposeAppRuntime(app.managed);

    expect(interrupted).toBe(true);
    expect(appFiberScope.state._tag).toBe("Closed");
  });

  it("interrupts a fiber suspended on Effect.promise and awaits its onInterrupt finalizer before the close resolves", async () => {
    // The stream engine supervisor's shape (streamManager.ts superviseEngine):
    // a fiber that suspends on a plain Promise and finalizes through another
    // async Promise. The close must (1) interrupt the suspended wait without
    // settling the wrapped promise, (2) run the finalizer to completion, and
    // (3) resolve only afterwards.
    const { app, appFiberScope } = buildSeams();
    const steps: string[] = [];
    let resolveWork!: () => void;
    const work = new Promise<void>((resolve) => {
      resolveWork = resolve;
    });
    app.managed.runSync(
      Effect.forkIn(
        Effect.promise(() => work).pipe(
          Effect.onInterrupt(() =>
            Effect.uninterruptible(
              Effect.promise(async () => {
                steps.push("finalizer-start");
                await new Promise<void>((resolve) => setTimeout(resolve, 10));
                steps.push("finalizer-end");
              })
            )
          )
        ),
        appFiberScope,
        { startImmediately: true }
      )
    );

    await closeScopeBounded(appFiberScope);

    expect(steps).toEqual(["finalizer-start", "finalizer-end"]);
    // The wrapped promise itself is untouched by the interruption (the
    // occupant's own cancellation transport decides when it settles).
    let workSettled = false;
    void work.then(() => {
      workSettled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(workSettled).toBe(false);
    resolveWork();
    await disposeAppRuntime(app.managed);
  });

  it("a fiber forked with startImmediately into an already-closed scope still runs its onInterrupt finalizer", async () => {
    // Pins the rc.112 forkIn semantics the supervisor relies on for streams
    // that start mid-shutdown: the body runs synchronously up to its first
    // async boundary, the closed scope interrupts it right there, and the
    // interruption unwinds through onInterrupt — so such a stream is aborted
    // rather than left running unsupervised.
    const { app, appFiberScope } = buildSeams();
    await closeScopeBounded(appFiberScope);
    expect(appFiberScope.state._tag).toBe("Closed");

    const steps: string[] = [];
    const fiber = app.managed.runSync(
      Effect.forkIn(
        Effect.promise(() => {
          steps.push("body-started");
          return new Promise<void>(() => undefined);
        }).pipe(Effect.onInterrupt(() => Effect.sync(() => steps.push("interrupted")))),
        appFiberScope,
        { startImmediately: true }
      )
    );

    expect(steps).toEqual(["body-started", "interrupted"]);
    expect(fiber.pollUnsafe()).toBeDefined();
    expect(Exit.isFailure(fiber.pollUnsafe()!)).toBe(true);
    await disposeAppRuntime(app.managed);
  });

  it("closeScopeBounded returns at the timeout when a fiber cannot be interrupted, warning instead of rejecting", async () => {
    const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const { app, appFiberScope } = buildSeams();
      // Uninterruptible and never-resolving: the scope close can never finish.
      app.managed.runSync(Effect.forkIn(Effect.uninterruptible(Effect.never), appFiberScope));

      const startedAt = Date.now();
      await closeScopeBounded(appFiberScope, 50);

      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("timed out");
      // The runtime dispose then hits the same hung finalizer; keep it bounded too.
      await disposeAppRuntime(app.managed, 50);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

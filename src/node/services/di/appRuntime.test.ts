import { describe, expect, it, spyOn } from "bun:test";
import { Context, Effect, Layer, Scheduler, Scope } from "effect";
import { log } from "@/node/services/log";
import { disposeAppRuntime, makeAppRuntime } from "./appRuntime";

class ProbeA extends Context.Service<ProbeA, { readonly name: string }>()("test/ProbeA") {}
class ProbeB extends Context.Service<ProbeB, { readonly name: string }>()("test/ProbeB") {}

describe("makeAppRuntime", () => {
  it("builds a synchronous layer graph eagerly and caches the context", () => {
    const app = makeAppRuntime(Layer.succeed(ProbeA)({ name: "a" }));

    expect(app.managed.cachedContext).toBeDefined();
    expect(app.get(ProbeA).name).toBe("a");
    expect(Context.get(app.context, ProbeA)).toBe(app.get(ProbeA));
  });

  it("exports a context without build-fiber artifacts for subscription pulls", async () => {
    const app = makeAppRuntime(Layer.succeed(ProbeA)({ name: "a" }));
    try {
      for (const key of [Scope.Scope, Layer.CurrentMemoMap, Scheduler.Scheduler]) {
        expect(app.context.mapUnsafe.has(key.key)).toBe(false);
      }
    } finally {
      await disposeAppRuntime(app.managed);
    }
  });

  it("throws synchronously when a layer body suspends", () => {
    const asyncLayer = Layer.effect(
      ProbeA,
      Effect.promise(() => Promise.resolve({ name: "late" }))
    );

    expect(() => makeAppRuntime(asyncLayer)).toThrow();
  });

  it("propagates a throwing layer body as a synchronous throw", () => {
    const throwingLayer = Layer.sync(ProbeA, () => {
      throw new Error("constructor boom");
    });

    expect(() => makeAppRuntime(throwingLayer)).toThrow("constructor boom");
  });

  it("starts fibers synchronously after the eager build", () => {
    const app = makeAppRuntime(Layer.succeed(ProbeA)({ name: "a" }));
    let ran = false;

    app.managed.runFork(
      Effect.sync(() => {
        ran = true;
      })
    );

    // runFork on a built runtime is Effect.runForkWith(cachedContext): the body
    // executes before runFork returns, up to its first async boundary.
    expect(ran).toBe(true);
  });
});

describe("disposeAppRuntime", () => {
  it("runs layer finalizers in reverse acquisition order", async () => {
    const order: string[] = [];
    const release = (name: string) =>
      Effect.sync(() => {
        order.push(name);
      });
    const a = Layer.effect(
      ProbeA,
      Effect.acquireRelease(Effect.succeed({ name: "a" }), () => release("a"))
    );
    const b = Layer.effect(
      ProbeB,
      Effect.acquireRelease(Effect.succeed({ name: "b" }), () => release("b"))
    );
    // B is provided with A, so A is acquired first and must be released last.
    const app = makeAppRuntime(b.pipe(Layer.provideMerge(a)));

    await disposeAppRuntime(app.managed);

    expect(order).toEqual(["b", "a"]);
  });

  it("is idempotent", async () => {
    let released = 0;
    const app = makeAppRuntime(
      Layer.effect(
        ProbeA,
        Effect.acquireRelease(Effect.succeed({ name: "a" }), () =>
          Effect.sync(() => {
            released += 1;
          })
        )
      )
    );

    await disposeAppRuntime(app.managed);
    await disposeAppRuntime(app.managed);

    expect(released).toBe(1);
    expect(app.managed.cachedContext).toBeUndefined();
  });

  it("returns at the timeout when a finalizer hangs, warning instead of rejecting", async () => {
    const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const app = makeAppRuntime(
        Layer.effect(
          ProbeA,
          Effect.acquireRelease(Effect.succeed({ name: "a" }), () => Effect.never)
        )
      );

      const startedAt = Date.now();
      await disposeAppRuntime(app.managed, 50);

      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("timed out");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

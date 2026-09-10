/**
 * Behavioral tests for the Effect Stream subscription bridge (streamBridge.ts).
 *
 * These pin the lifecycle invariants the bridge introduces — guaranteed
 * listener teardown on every exit path (disconnect, consumer break, stream
 * error, mid-initialize abort) — plus the ordering/coalescing wire semantics
 * the oRPC subscription handlers rely on. Teardown-on-error was previously
 * unpinned; the remaining tests assert behavior (ordering, completion,
 * error propagation), not implementation literals.
 */
import { describe, expect, test } from "bun:test";
import { Context, Effect } from "effect";
import { TestClock } from "effect/testing";
import { disposeAppRuntime, makeAppRuntime } from "@/node/services/di/appRuntime";
import { EventEmitter } from "node:events";
import { subscriptionIterable, type SubscriptionEmit } from "./streamBridge";

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Collect up to `count` values, resolving early if the iterator completes. */
async function collect<T>(iterable: AsyncGenerator<T>, count: number): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
    if (values.length >= count) break;
  }
  return values;
}

describe.each([undefined, Context.empty()])("subscriptionIterable teardown (%p)", (context) => {
  test("listener count returns to baseline after client abort", async () => {
    const emitter = new EventEmitter();
    const controller = new AbortController();
    const iterable = subscriptionIterable<number>({
      context,
      signal: controller.signal,
      subscribe: (emit) => {
        emitter.on("value", emit.push);
        return () => emitter.off("value", emit.push);
      },
    });

    const consumed = (async () => {
      const values: number[] = [];
      for await (const value of iterable) values.push(value);
      return values;
    })();

    await waitFor(() => emitter.listenerCount("value") === 1);
    emitter.emit("value", 1);
    controller.abort();

    // Abort completes the generator normally (no throw) and detaches.
    await consumed;
    await iterable.return(undefined);
    await iterable.return(undefined);
    expect(emitter.listenerCount("value")).toBe(0);
  });

  test("consumer break (generator return) detaches the listener", async () => {
    const emitter = new EventEmitter();
    const iterable = subscriptionIterable<number>({
      context,
      subscribe: (emit) => {
        emitter.on("value", emit.push);
        return () => emitter.off("value", emit.push);
      },
    });

    const first = (async () => {
      for await (const value of iterable) return value;
      throw new Error("iterator ended without a value");
    })();
    await waitFor(() => emitter.listenerCount("value") === 1);
    emitter.emit("value", 42);
    expect(await first).toBe(42);
    await waitFor(() => emitter.listenerCount("value") === 0);
  });

  test("initialize failure detaches the listener and surfaces the error", async () => {
    const emitter = new EventEmitter();
    const boom = new Error("bootstrap failed");
    const iterable = subscriptionIterable<number>({
      context,
      subscribe: (emit) => {
        emitter.on("value", emit.push);
        return () => emitter.off("value", emit.push);
      },
      initialize: () => Promise.reject(boom),
    });

    try {
      await iterable.next();
      expect.unreachable("initialize failure must reject the subscription");
    } catch (error) {
      expect(error).toBe(boom);
    }
    expect(emitter.listenerCount("value")).toBe(0);
  });

  test("abort during a hung initialize still detaches the listener", async () => {
    const emitter = new EventEmitter();
    const controller = new AbortController();
    const iterable = subscriptionIterable<number>({
      context,
      signal: controller.signal,
      subscribe: (emit) => {
        emitter.on("value", emit.push);
        return () => emitter.off("value", emit.push);
      },
      initialize: () => new Promise<void>(() => undefined),
    });

    const consumed = collect(iterable, 1);
    await waitFor(() => emitter.listenerCount("value") === 1);
    controller.abort();
    expect(await consumed).toEqual([]);
    expect(emitter.listenerCount("value")).toBe(0);
  });

  test("take completes the stream and detaches immediately", async () => {
    const emitter = new EventEmitter();
    const iterable = subscriptionIterable<number>({
      context,
      subscribe: (emit) => {
        emitter.on("exit", emit.push);
        return () => emitter.off("exit", emit.push);
      },
      take: 1,
    });

    const consumed = collect(iterable, 2);
    await waitFor(() => emitter.listenerCount("exit") === 1);
    emitter.emit("exit", 7);
    expect(await consumed).toEqual([7]);
    expect(emitter.listenerCount("exit")).toBe(0);
  });

  test("pre-aborted signal never attaches the listener", async () => {
    const emitter = new EventEmitter();
    const controller = new AbortController();
    controller.abort();
    let subscribed = false;
    const iterable = subscriptionIterable<number>({
      context,
      signal: controller.signal,
      subscribe: (emit) => {
        subscribed = true;
        emitter.on("value", emit.push);
        return () => emitter.off("value", emit.push);
      },
    });
    expect(await collect(iterable, 1)).toEqual([]);
    expect(subscribed).toBe(false);
  });
});

describe("subscriptionIterable ordering and buffering", () => {
  test("synchronous burst from a foreign callsite is delivered in emit order", async () => {
    let emitHandle: SubscriptionEmit<number> | undefined;
    const iterable = subscriptionIterable<number>({
      subscribe: (emit) => {
        emitHandle = emit;
        return () => undefined;
      },
    });

    const consumed = collect(iterable, 3);
    await waitFor(() => emitHandle !== undefined);
    // Producer emits synchronously (EventEmitter-style): the values must land
    // in the buffer before push returns, preserving emit-after-write order.
    emitHandle?.push(1);
    emitHandle?.push(2);
    emitHandle?.push(3);
    expect(await consumed).toEqual([1, 2, 3]);
  });

  test("latest buffer coalesces values while the consumer is slow", async () => {
    let emitHandle: SubscriptionEmit<number> | undefined;
    const iterable = subscriptionIterable<number>({
      buffer: "latest",
      subscribe: (emit) => {
        emitHandle = emit;
        return () => undefined;
      },
    });

    // Force attach without consuming further, then burst before the next read.
    const first = iterable.next();
    await waitFor(() => emitHandle !== undefined);
    emitHandle?.push(1);
    expect((await first).value).toBe(1);
    emitHandle?.push(2);
    emitHandle?.push(3);
    emitHandle?.push(4);
    // An unconsumed snapshot is replaced, never queued: only the newest survives.
    expect((await iterable.next()).value).toBe(4);
    await iterable.return(undefined);
  });

  test("initial value is delivered before events buffered while it was computed", async () => {
    const app = makeAppRuntime(TestClock.layer());
    try {
      let emitHandle: SubscriptionEmit<string> | undefined;
      const iterable = subscriptionIterable<string>({
        context: app.context,
        subscribe: (emit) => {
          emitHandle = emit;
          return () => undefined;
        },
        initial: async () => {
          // Event fires between attach and snapshot completion — it must not be
          // lost, and it must arrive after the snapshot.
          emitHandle?.push("during-initial");
          await app.managed.runPromise(Effect.sleep(1));
          return "snapshot";
        },
      });

      const consumed = collect(iterable, 2);
      await app.managed.runPromise(TestClock.adjust(1));
      expect(await consumed).toEqual(["snapshot", "during-initial"]);
    } finally {
      await disposeAppRuntime(app.managed);
    }
  });

  test("emit.end drains buffered values, then onEnd error surfaces", async () => {
    const iterable = subscriptionIterable<number>({
      subscribe: (emit) => {
        emit.push(1);
        emit.push(2);
        emit.end();
        return () => undefined;
      },
      onEnd: () => {
        throw new Error("bootstrap error");
      },
    });

    const values: number[] = [];
    try {
      for await (const value of iterable) values.push(value);
      expect.unreachable("onEnd error must reject the subscription");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("bootstrap error");
    }
    expect(values).toEqual([1, 2]);
  });

  test("heartbeat values are injected while the subscription is idle", async () => {
    const app = makeAppRuntime(TestClock.layer());
    const controller = new AbortController();
    let detached = 0;
    const values: string[] = [];
    const intervalMs = 1_000;
    const iterable = subscriptionIterable<string>({
      context: app.context,
      signal: controller.signal,
      heartbeat: { value: "heartbeat", intervalMs },
      subscribe: () => () => {
        detached += 1;
      },
    });
    const consumed = (async () => {
      for await (const value of iterable) values.push(value);
    })();
    try {
      const startedAt = performance.now();
      await app.managed.runPromise(TestClock.adjust(3 * intervalMs));
      expect(values).toEqual(["heartbeat", "heartbeat", "heartbeat"]);
      expect(performance.now() - startedAt).toBeLessThan(50);
    } finally {
      controller.abort();
      await consumed;
      await iterable.return(undefined);
      await iterable.return(undefined);
      await disposeAppRuntime(app.managed);
    }
    expect(detached).toBe(1);
  });

  test("nothing runs until the consumer starts pulling", async () => {
    const app = makeAppRuntime(TestClock.layer());
    try {
      let subscribed = false;
      const iterable = subscriptionIterable<number>({
        context: app.context,
        subscribe: () => {
          subscribed = true;
          return () => undefined;
        },
      });
      await app.managed.runPromise(TestClock.adjust(10));
      expect(subscribed).toBe(false);
      await iterable.return(undefined);
    } finally {
      await disposeAppRuntime(app.managed);
    }
  });
});

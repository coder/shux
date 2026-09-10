/**
 * Effect Stream bridge for oRPC subscription procedures (Effect migration
 * Phase 9).
 *
 * Adapts the EventEmitter-style subscription seam (attach listener → push
 * events → detach) that `routerSubscriptions.ts` handlers use into an Effect
 * Stream pipeline, then re-exposes it as the `AsyncGenerator` wire shape oRPC
 * event-iterator procedures expect. Wire behavior (payload shapes, ordering,
 * completion/error semantics) is intentionally identical to the previous
 * `asyncIterableFromSubscription` seam.
 *
 * Design invariants:
 *
 * - **Foreign-callsite emissions**: producers fire from non-Effect contexts
 *   (EventEmitter callbacks, AI-SDK callbacks). `emit.push` is a synchronous
 *   `Queue.offerUnsafe` — the value lands in the buffer before `push` returns,
 *   with no fiber suspension between the producer's emit and the queue offer.
 *   This preserves emit-after-durable-write ordering guarantees (e.g. memory
 *   consolidation emits `statusChange` synchronously after its durable write;
 *   subscribers must observe events in exactly that order).
 * - **Guaranteed teardown**: listener detach runs via `Effect.acquireRelease`
 *   (one acquireRelease per resource), tied to the stream's scope. The scope
 *   closes on client disconnect (AbortSignal → iterator close → fiber
 *   interruption), on consumer `return()`, on stream failure, and on natural
 *   completion — so `off()`/`removeListener()` is guaranteed on every exit
 *   path.
 * - **Interruption posture**: subscription streams are interruptible by
 *   design. Client aborts interrupt the pull fiber at the next suspension
 *   point; there is no in-flight mutation to protect, only listener handles,
 *   which the scope finalizers release.
 * - **Defect folding**: bridge-internal failures (validate/subscribe throws,
 *   initialize/initial rejections, onEnd errors) fail the pull, which
 *   surfaces as a rejection of the consumer's `next()` — the same observable
 *   contract as the previous async-generator seam. Nothing escapes as an
 *   unhandled rejection.
 * - **Laziness**: nothing (not even `validate`) runs until the consumer's
 *   first `next()` call, matching async-generator semantics.
 */
import type { Cause, Context } from "effect";
import { Effect, Queue, Stream } from "effect";
import { SUBSCRIPTION_HEARTBEAT_INTERVAL_MS } from "@/common/utils/withQueueHeartbeat";

/** Producer-facing handle. Safe to call from any non-Effect callsite. */
export interface SubscriptionEmit<T> {
  /**
   * Enqueue a value synchronously. No-op after the subscription ended.
   * Never throws and never suspends.
   */
  push: (value: T) => void;
  /**
   * Gracefully complete the subscription: already-buffered values are still
   * delivered, then the stream ends (and `onEnd` runs, if provided).
   */
  end: () => void;
}

export interface SubscriptionStreamOptions<T> {
  /** Runtime references (notably Clock); omitted for the original global-runtime path. */
  context?: Context.Context<never>;
  signal?: AbortSignal;
  /** Runs first; a throw rejects the subscription before any resource is acquired. */
  validate?: () => void;
  /**
   * Attach the underlying listener(s); returns the detach thunk. Attach and
   * detach are wrapped in `Effect.acquireRelease`, so detach is guaranteed on
   * disconnect, error, interruption, and natural completion. Values pushed
   * synchronously during attach are buffered and delivered after `initial`.
   */
  subscribe: (emit: SubscriptionEmit<T>) => () => void;
  /**
   * Buffering strategy. `"all"` (default) is an unbounded FIFO. `"latest"`
   * coalesces: an unconsumed value is replaced by the newest one, so a slow
   * consumer never accumulates a backlog and never replays stale snapshots
   * (mirrors `createLatestValueQueue`).
   */
  buffer?: "all" | "latest";
  /**
   * Inject `value` into the queue every `intervalMs` (default
   * SUBSCRIPTION_HEARTBEAT_INTERVAL_MS) while the subscription is live.
   * The ticker starts after `initialize` completes — heartbeats cannot
   * interleave into a history replay — and stops with the stream's scope.
   */
  heartbeat?: { value: T; intervalMs?: number };
  /** Runs after attach, before any value is delivered. Pushes are buffered. */
  initialize?: (emit: SubscriptionEmit<T>) => void | Promise<void>;
  /**
   * Produce a value delivered before any buffered events (evaluated after
   * attach + `initialize`, so subscriptions cannot lose events that fire
   * while the initial snapshot is computed).
   */
  initial?: () => T | Promise<T>;
  /** Complete after delivering this many values (counting `initial`). */
  take?: number;
  /**
   * Runs when the queue completes gracefully via `emit.end`. A throw fails
   * the subscription (used to surface bootstrap errors to the client).
   */
  onEnd?: () => void | Promise<void>;
}

/**
 * Build the scoped Effect Stream for a subscription. The returned stream owns
 * the listener lifecycle: acquisition happens when the stream starts and every
 * finalizer runs when the stream ends, fails, or is interrupted.
 */
function subscriptionStream<T>(options: SubscriptionStreamOptions<T>): Stream.Stream<T> {
  return Stream.unwrap(
    Effect.gen(function* () {
      options.validate?.();

      const queue = yield* options.buffer === "latest"
        ? Queue.sliding<T, Cause.Done>(1)
        : Queue.unbounded<T, Cause.Done>();
      const emit: SubscriptionEmit<T> = {
        push: (value) => void Queue.offerUnsafe(queue, value),
        end: () => void Queue.endUnsafe(queue),
      };

      // Close the queue when the scope closes so late producer pushes become
      // no-ops (offerUnsafe returns false on a non-open queue).
      yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => Queue.endUnsafe(queue)));

      // Per-resource acquireRelease: listener detach is guaranteed on every
      // exit path (disconnect, error, interruption, completion).
      yield* Effect.acquireRelease(
        Effect.sync(() => options.subscribe(emit)),
        (unsubscribe) => Effect.sync(unsubscribe)
      );

      if (options.initialize) {
        const initialize = options.initialize;
        // Async thunk so synchronous throws follow the same rejection path.
        yield* Effect.promise(async () => initialize(emit));
      }

      let head: Stream.Stream<T> = Stream.empty;
      if (options.initial) {
        const initial = options.initial;
        const value = yield* Effect.promise(async () => initial());
        head = Stream.make(value);
      }

      if (options.heartbeat) {
        const heartbeat = options.heartbeat;
        // Scope-tied ticker fiber: interrupted with the stream. Started after
        // `initialize` so heartbeats never interleave into replayed history.
        yield* Effect.forkScoped(
          Effect.forever(
            Effect.flatMap(
              Effect.sleep(heartbeat.intervalMs ?? SUBSCRIPTION_HEARTBEAT_INTERVAL_MS),
              () => Queue.offer(queue, heartbeat.value)
            )
          )
        );
      }

      const onEnd = options.onEnd;
      let stream: Stream.Stream<T> = Stream.concat(head, Stream.fromQueue(queue));
      if (onEnd) {
        stream = Stream.concat(stream, Stream.fromEffectDrain(Effect.promise(async () => onEnd())));
      }
      if (options.take != null) {
        stream = Stream.take(stream, options.take);
      }
      return stream;
    })
  );
}

/**
 * Adapt a subscription to the AsyncGenerator wire shape oRPC expects, backed
 * by the Effect Stream above.
 *
 * Abort handling mirrors the previous seam: when `signal` aborts, the stream
 * iterator is closed, which interrupts the pull fiber and closes the scope
 * (running all release finalizers); the generator then completes normally.
 */
export function subscriptionIterable<T>(options: SubscriptionStreamOptions<T>): AsyncGenerator<T> {
  return (async function* () {
    if (options.signal?.aborted) return;

    const stream = subscriptionStream(options);
    const iterable = options.context
      ? Stream.toAsyncIterableWith(stream, options.context)
      : Stream.toAsyncIterable(stream);
    const iterator = iterable[Symbol.asyncIterator]();
    // `return()` memoizes its close promise, so the extra call in `finally`
    // awaits the same teardown instead of re-running it.
    const onAbort = () => void iterator.return?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    try {
      while (true) {
        const result = await iterator.next();
        if (result.done) return;
        yield result.value;
      }
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      await iterator.return?.();
    }
  })();
}

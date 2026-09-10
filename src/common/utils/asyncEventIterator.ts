/**
 * Create an async event queue that can be pushed to from event handlers.
 *
 * This is useful when events don't directly yield values but trigger
 * async state fetches.
 *
 * Usage:
 * ```ts
 * const queue = createAsyncEventQueue<State>();
 *
 * const onChange = async () => {
 *   queue.push(await fetchState());
 * };
 *
 * emitter.on('change', onChange);
 * try {
 *   yield* queue.iterate();
 * } finally {
 *   emitter.off('change', onChange);
 * }
 * ```
 */
export function createAsyncEventQueue<T>(): {
  push: (value: T) => void;
  iterate: () => AsyncGenerator<T>;
  end: () => void;
} {
  const queue: T[] = [];
  let resolveNext: ((value: T) => void) | null = null;
  let ended = false;

  const push = (value: T) => {
    if (ended) return;
    if (resolveNext) {
      const resolve = resolveNext;
      resolveNext = null;
      resolve(value);
    } else {
      queue.push(value);
    }
  };

  async function* iterate(): AsyncGenerator<T> {
    while (!ended) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }

      const value = await new Promise<T>((resolve) => {
        resolveNext = resolve;
      });

      // end() may have been called while we were waiting. Ensure we don't yield
      // a sentinel/invalid value back to consumers.
      if (ended) {
        return;
      }

      yield value;
    }
  }

  const end = () => {
    ended = true;
    // Wake up the iterator if it's waiting
    if (resolveNext) {
      // This will never be yielded since ended=true stops the loop
      resolveNext(undefined as T);
    }
  };

  return { push, iterate, end };
}

export interface AsyncEventQueue<T> {
  push: (value: T) => void;
  iterate: () => AsyncGenerator<T>;
  end: () => void;
}

interface SubscriptionOptions<T> {
  signal?: AbortSignal;
  validate?: () => void;
  subscribe: (push: (value: T) => void) => () => void;
  initialize?: (push: (value: T) => void) => void | Promise<void>;
  initial?: () => T | Promise<T>;
  queue?: AsyncEventQueue<T>;
  take?: number;
  onEnd?: () => void | Promise<void>;
}

/** Convert a callback subscription into an abortable AsyncIterable. */
export function asyncIterableFromSubscription<T>(
  options: SubscriptionOptions<T>
): AsyncGenerator<T> {
  return (async function* () {
    options.validate?.();
    if (options.signal?.aborted) return;

    const queue = options.queue ?? createAsyncEventQueue<T>();
    const unsubscribe = options.subscribe(queue.push);
    const aborted = Symbol("aborted");
    let resolveAbort: (() => void) | undefined;
    const abortPromise = new Promise<typeof aborted>((resolve) => {
      resolveAbort = () => resolve(aborted);
    });
    const onAbort = () => {
      queue.end();
      resolveAbort?.();
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    try {
      let yielded = 0;
      if (options.initialize) {
        const initialized = await Promise.race([
          Promise.resolve().then(() => options.initialize?.(queue.push)),
          abortPromise,
        ]);
        if (initialized === aborted) return;
      }
      if (options.initial) {
        const initial = await Promise.race([Promise.resolve().then(options.initial), abortPromise]);
        if (initial === aborted) return;
        yield initial;
        yielded++;
      }

      if (options.take != null && yielded >= options.take) return;
      for await (const value of queue.iterate()) {
        yield value;
        yielded++;
        if (options.take != null && yielded >= options.take) return;
      }
      await options.onEnd?.();
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      queue.end();
      unsubscribe();
    }
  })();
}

/**
 * Latest-value variant of createAsyncEventQueue: pushing replaces any unconsumed value
 * instead of appending. Use it for full-state snapshots where only the newest state
 * matters — a consumer slower than the producer then never accumulates an unbounded
 * backlog and never replays stale intermediate states; it simply sees the latest
 * snapshot on its next read.
 */
export function createLatestValueQueue<T>(): {
  push: (value: T) => void;
  iterate: () => AsyncGenerator<T>;
  end: () => void;
} {
  let slot: { value: T } | null = null;
  let resolveNext: ((value: T) => void) | null = null;
  let ended = false;

  const push = (value: T) => {
    if (ended) return;
    if (resolveNext) {
      const resolve = resolveNext;
      resolveNext = null;
      resolve(value);
    } else {
      // Replace, never append: an unconsumed older snapshot is disposable.
      slot = { value };
    }
  };

  async function* iterate(): AsyncGenerator<T> {
    while (!ended) {
      if (slot != null) {
        const { value } = slot;
        slot = null;
        yield value;
        continue;
      }

      const value = await new Promise<T>((resolve) => {
        resolveNext = resolve;
      });

      // end() may have been called while we were waiting. Ensure we don't yield
      // a sentinel/invalid value back to consumers.
      if (ended) {
        return;
      }

      yield value;
    }
  }

  const end = () => {
    ended = true;
    // Wake up the iterator if it's waiting
    if (resolveNext) {
      // This will never be yielded since ended=true stops the loop
      resolveNext(undefined as T);
    }
  };

  return { push, iterate, end };
}

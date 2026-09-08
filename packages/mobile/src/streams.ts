import { useSyncExternalStore } from "react";
import { isAuthenticationError } from "./api";
import { linkedAbortController } from "./useConnection";

// Each HTTP subscription is an independent long-lived response, so each one heals
// on its own: a lost stream retries with capped, jittered backoff while unary calls
// keep working. Nothing here is shared with the server, so a cellular handoff costs
// only the streams that were open at that moment.
export const STREAM_RETRY_MIN_MS = 1_000;
export const STREAM_RETRY_MAX_MS = 30_000;

const wakers = new Set<() => void>();
/** Skip pending backoff, e.g. when the app returns to the foreground. */
export function wakeStreams(): void {
  for (const wake of [...wakers]) wake();
}

const reconnecting = new Set<object>();
const healthListeners = new Set<() => void>();
function setReconnecting(stream: object, value: boolean) {
  const before = reconnecting.size > 0;
  if (value) reconnecting.add(stream);
  else reconnecting.delete(stream);
  if (reconnecting.size > 0 !== before) for (const listener of [...healthListeners]) listener();
}
/** True while any subscription in the app is waiting to reconnect. */
export function useStreamsReconnecting(): boolean {
  return useSyncExternalStore(
    (listener) => {
      healthListeners.add(listener);
      return () => healthListeners.delete(listener);
    },
    () => reconnecting.size > 0
  );
}

function backoff(attempt: number): number {
  const cap = Math.min(STREAM_RETRY_MAX_MS, STREAM_RETRY_MIN_MS * 2 ** attempt);
  return STREAM_RETRY_MIN_MS + Math.random() * (cap - STREAM_RETRY_MIN_MS);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      wakers.delete(done);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    wakers.add(done);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Interleave several subscriptions into one. When any of them ends or fails the merged
 * stream does too, so a watch over the group reopens them together and re-reads the
 * snapshot they jointly guard exactly once. The survivors are not closed here: a
 * generator blocked in `next()` cannot be returned, so the sources must share the
 * attempt signal that `watch` aborts after every attempt.
 */
export async function* merge<T>(sources: AsyncIterable<T>[]): AsyncGenerator<T> {
  const iterators = sources.map((source) => source[Symbol.asyncIterator]());
  const advance = (index: number) => iterators[index].next().then((result) => ({ index, result }));
  const pending = iterators.map((_, index) => advance(index));
  while (true) {
    const { index, result } = await Promise.race(pending);
    if (result.done) return;
    yield result.value;
    pending[index] = advance(index);
  }
}

export interface WatchOptions<T> {
  signal: AbortSignal;
  /** Open one attempt. `retries` counts consecutive reopen attempts since the last stable stream. */
  open: (attempt: { signal: AbortSignal; retries: number }) => Promise<AsyncIterable<T>>;
  /** The subscription is registered; read any snapshot it guards here. */
  onOpen?: () => void;
  onEvent: (event: T) => void;
  /** The stream ended or failed; a retry is scheduled. */
  onLost?: (cause: unknown) => void;
}

/**
 * Consume a subscription until `signal` aborts, reopening it whenever it drops.
 * Resolves on abort; rejects only when the server rejects the credential, which no
 * retry can fix.
 */
export async function watch<T>(options: WatchOptions<T>): Promise<void> {
  const stream = {};
  let retries = 0;
  try {
    while (!options.signal.aborted) {
      const attempt = linkedAbortController(options.signal);
      let openedAt: number | null = null;
      let cause: unknown;
      try {
        const events = await options.open({ signal: attempt.signal, retries });
        if (options.signal.aborted) return;
        openedAt = Date.now();
        setReconnecting(stream, false);
        options.onOpen?.();
        for await (const event of events) {
          if (options.signal.aborted) return;
          options.onEvent(event);
        }
        cause = new Error("Stream ended.");
      } catch (error) {
        cause = error;
      } finally {
        attempt.abort();
      }
      if (options.signal.aborted) return;
      if (isAuthenticationError(cause)) throw cause;
      // A stream that lived through a whole backoff window was healthy; flapping ones keep escalating.
      if (openedAt !== null && Date.now() - openedAt >= STREAM_RETRY_MAX_MS) retries = 0;
      setReconnecting(stream, true);
      options.onLost?.(cause);
      await sleep(backoff(retries++), options.signal);
    }
  } finally {
    setReconnecting(stream, false);
  }
}

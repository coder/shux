import { useSyncExternalStore } from "react";
import type { ServerChangeEvent } from "../../../src/common/orpc/schemas/api";
import { isAuthenticationError, type MobileClient } from "./api";
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

interface ChangeConsumer {
  signal: AbortSignal;
  onOpen?: () => void;
  onEvent: (event: ServerChangeEvent) => void;
  onLost?: () => void;
}
interface SharedChanges {
  consumers: Set<ChangeConsumer>;
  controller: AbortController;
  open: boolean;
  settled: Promise<void>;
}
const sharedChanges = new WeakMap<object, SharedChanges>();

/**
 * Config, provider, policy and workspace-metadata changes all arrive on one
 * server stream, shared by every consumer of the same client while any is mounted.
 * Browsers and mobile URLSession cap HTTP/1.1 connections per host at about six, so
 * with the conversation stream this leaves the unary calls that read the changed
 * snapshots room to run. Resolves when `signal` aborts; rejects only when the
 * credential is rejected.
 */
export function watchServerChanges(
  client: Pick<MobileClient, "server">,
  consumer: ChangeConsumer
): Promise<void> {
  if (consumer.signal.aborted) return Promise.resolve();
  let shared = sharedChanges.get(client);
  if (!shared) {
    const controller = new AbortController();
    const created: SharedChanges = {
      consumers: new Set(),
      controller,
      open: false,
      settled: watch<ServerChangeEvent>({
        signal: controller.signal,
        open: (attempt) => client.server.onChanged(undefined, { signal: attempt.signal }),
        onOpen: () => {
          created.open = true;
          for (const each of [...created.consumers]) each.onOpen?.();
        },
        onEvent: (event) => {
          for (const each of [...created.consumers]) each.onEvent(event);
        },
        onLost: () => {
          created.open = false;
          for (const each of [...created.consumers]) each.onLost?.();
        },
      }).finally(() => {
        if (sharedChanges.get(client) === created) sharedChanges.delete(client);
      }),
    };
    shared = created;
    sharedChanges.set(client, shared);
  }
  const owner = shared;
  owner.consumers.add(consumer);
  // Joining an already registered subscription: the snapshot can be read right away.
  if (owner.open) consumer.onOpen?.();
  return new Promise<void>((resolve, reject) => {
    const leave = () => {
      owner.consumers.delete(consumer);
      if (owner.consumers.size === 0) {
        // Release synchronously: a remounting consumer must start a fresh stream, not
        // join this aborted one before its watch has settled.
        if (sharedChanges.get(client) === owner) sharedChanges.delete(client);
        owner.controller.abort();
      }
      resolve();
    };
    consumer.signal.addEventListener("abort", leave, { once: true });
    owner.settled.catch((cause: unknown) => {
      if (!owner.consumers.has(consumer)) return;
      consumer.signal.removeEventListener("abort", leave);
      owner.consumers.delete(consumer);
      reject(cause);
    });
  });
}

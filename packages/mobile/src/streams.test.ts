import "./testDom";
import { afterEach, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { ORPCError } from "@orpc/client";
import {
  STREAM_RETRY_MAX_MS,
  useStreamsReconnecting,
  wakeStreams,
  watch,
  watchServerChanges,
} from "./streams";
import type { MobileClient } from "./api";
import type { ServerChangeEvent } from "../../../src/common/orpc/schemas/api";

afterEach(cleanup);

function source<T>() {
  const attempts: Array<{
    signal: AbortSignal;
    retries: number;
    emit: (event: T) => void;
    end: () => void;
    fail: (cause: unknown) => void;
  }> = [];
  let rejectNext: unknown = null;
  return {
    attempts,
    rejectOpen(cause: unknown) {
      rejectNext = cause;
    },
    open: async (attempt: { signal: AbortSignal; retries: number }): Promise<AsyncIterable<T>> => {
      if (rejectNext) {
        const cause = rejectNext;
        rejectNext = null;
        throw cause;
      }
      return new ReadableStream<T>({
        start(controller) {
          let done = false;
          const finish = (cause?: unknown) => {
            if (done) return;
            done = true;
            if (cause === undefined) controller.close();
            else controller.error(cause);
          };
          attempts.push({
            signal: attempt.signal,
            retries: attempt.retries,
            emit: (event) => controller.enqueue(event),
            end: () => finish(),
            fail: finish,
          });
          attempt.signal.addEventListener("abort", () => finish(), { once: true });
        },
      }).values();
    },
  };
}

async function settled() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

test("a dropped stream reopens with escalating retries, re-runs onOpen, and stays live after abort", async () => {
  const stream = source<string>();
  const lifetime = new AbortController();
  const log: string[] = [];
  const done = watch<string>({
    signal: lifetime.signal,
    open: stream.open,
    onOpen: () => log.push("open"),
    onEvent: (event) => log.push(event),
    onLost: () => log.push("lost"),
  });
  await settled();
  expect(stream.attempts).toHaveLength(1);
  stream.attempts[0].emit("a");
  await settled();
  stream.attempts[0].end();
  await settled();
  expect(log).toEqual(["open", "a", "lost"]);
  // The retry timer is pending; the wake bus replaces waiting out the backoff.
  expect(stream.attempts).toHaveLength(1);
  wakeStreams();
  await settled();
  expect(stream.attempts).toHaveLength(2);
  expect(stream.attempts[1].retries).toBe(1);
  expect(stream.attempts[0].signal.aborted).toBe(true);
  stream.attempts[1].fail(new Error("network"));
  await settled();
  wakeStreams();
  await settled();
  expect(stream.attempts[2].retries).toBe(2);
  expect(log).toEqual(["open", "a", "lost", "open", "lost", "open"]);
  lifetime.abort();
  await done;
  expect(stream.attempts[2].signal.aborted).toBe(true);
  wakeStreams();
  await settled();
  expect(stream.attempts).toHaveLength(3);
});

test("a stream that stayed healthy for a full backoff window resets escalation", async () => {
  const stream = source<string>();
  const lifetime = new AbortController();
  const now = Date.now;
  let clock = now();
  Date.now = () => clock;
  try {
    const done = watch<string>({ signal: lifetime.signal, open: stream.open, onEvent: () => {} });
    await settled();
    stream.attempts[0].end();
    await settled();
    wakeStreams();
    await settled();
    expect(stream.attempts[1].retries).toBe(1);
    stream.attempts[1].fail(new Error("flap"));
    await settled();
    wakeStreams();
    await settled();
    expect(stream.attempts[2].retries).toBe(2);
    clock += STREAM_RETRY_MAX_MS;
    stream.attempts[2].fail(new Error("network"));
    await settled();
    wakeStreams();
    await settled();
    expect(stream.attempts[3].retries).toBe(1);
    lifetime.abort();
    await done;
  } finally {
    Date.now = now;
  }
});

test("a rejected credential ends the watch instead of retrying, whether at open or mid-stream", async () => {
  for (const phase of ["open", "stream"] as const) {
    const stream = source<string>();
    const lifetime = new AbortController();
    const lost: unknown[] = [];
    const done = watch<string>({
      signal: lifetime.signal,
      open: stream.open,
      onEvent: () => {},
      onLost: (cause) => lost.push(cause),
    });
    await settled();
    const cause = new ORPCError("UNAUTHORIZED");
    if (phase === "open") {
      stream.attempts[0].end();
      await settled();
      stream.rejectOpen(cause);
      wakeStreams();
    } else {
      stream.attempts[0].fail(cause);
    }
    expect(await done.catch((error: unknown) => error)).toBe(cause);
    expect(lost).toEqual(phase === "open" ? [expect.any(Error)] : []);
    expect(stream.attempts).toHaveLength(1);
    lifetime.abort();
  }
});

test("health reports reconnecting while any watch waits and clears once all are open or ended", async () => {
  const health = renderHook(() => useStreamsReconnecting());
  const first = source<string>();
  const second = source<string>();
  const lifetime = new AbortController();
  const watches = Promise.all(
    [first, second].map((stream) =>
      watch<string>({ signal: lifetime.signal, open: stream.open, onEvent: () => {} })
    )
  );
  await act(settled);
  expect(health.result.current).toBe(false);
  await act(async () => {
    first.attempts[0].end();
    second.attempts[0].end();
    await settled();
  });
  expect(health.result.current).toBe(true);
  await act(async () => {
    wakeStreams();
    await settled();
  });
  expect(health.result.current).toBe(false);
  await act(async () => {
    first.attempts[1].end();
    await settled();
  });
  expect(health.result.current).toBe(true);
  await act(async () => {
    lifetime.abort();
    await watches;
  });
  expect(health.result.current).toBe(false);
});

function changesClient() {
  const stream = source<ServerChangeEvent>();
  const client = {
    server: {
      onChanged: (_input: undefined, options: { signal?: AbortSignal }) =>
        stream.open({ signal: options.signal!, retries: 0 }),
    },
  } as unknown as Pick<MobileClient, "server">;
  return { client, stream };
}

test("consumers share one change stream per client; it opens with the first and closes with the last", async () => {
  const { client, stream } = changesClient();
  const log: string[] = [];
  const consumer = (name: string) => {
    const controller = new AbortController();
    const done = watchServerChanges(client, {
      signal: controller.signal,
      onOpen: () => log.push(`${name}:open`),
      onEvent: (event) => log.push(`${name}:${event.type}`),
      onLost: () => log.push(`${name}:lost`),
    });
    return { controller, done };
  };
  const a = consumer("a");
  await settled();
  expect(stream.attempts).toHaveLength(1);
  // A late joiner reads its snapshot immediately: the subscription is already registered.
  const b = consumer("b");
  await settled();
  expect(stream.attempts).toHaveLength(1);
  stream.attempts[0].emit({ type: "policy" });
  await settled();
  expect(log).toEqual(["a:open", "b:open", "a:policy", "b:policy"]);
  a.controller.abort();
  await a.done;
  stream.attempts[0].emit({ type: "config" });
  await settled();
  expect(stream.attempts[0].signal.aborted).toBe(false);
  expect(log.slice(-1)).toEqual(["b:config"]);
  stream.attempts[0].end();
  await settled();
  expect(log.slice(-1)).toEqual(["b:lost"]);
  b.controller.abort();
  await b.done;
  expect(stream.attempts[0].signal.aborted).toBe(true);
  // A new consumer after everyone left starts a fresh stream rather than joining a dead one.
  const c = consumer("c");
  await settled();
  expect(stream.attempts).toHaveLength(2);
  c.controller.abort();
  await c.done;
});

test("a rejected credential on the shared stream rejects every attached consumer once", async () => {
  const { client, stream } = changesClient();
  const controllers = [new AbortController(), new AbortController()];
  const outcomes = controllers.map((controller) =>
    watchServerChanges(client, { signal: controller.signal, onEvent: () => {} }).then(
      () => "resolved",
      (cause: unknown) => (cause instanceof ORPCError ? cause.code : "other")
    )
  );
  await settled();
  stream.attempts[0].fail(new ORPCError("UNAUTHORIZED"));
  expect(await Promise.all(outcomes)).toEqual(["UNAUTHORIZED", "UNAUTHORIZED"]);
  const retry = new AbortController();
  const again = watchServerChanges(client, { signal: retry.signal, onEvent: () => {} });
  await settled();
  expect(stream.attempts).toHaveLength(2);
  retry.abort();
  await again;
});

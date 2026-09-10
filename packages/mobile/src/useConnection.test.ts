import "./testDom";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createORPCClient } from "@orpc/client";
import type { MobileClient } from "./api";
import type { Connection } from "./screens/ConnectScreen";
import { linkedAbortController, useConnection } from "./useConnection";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function resource(replacement: Promise<Connection>) {
  const closed: boolean[] = [];
  const attempts: AbortSignal[] = [];
  const connection: Connection = {
    endpoint: "https://server.example",
    client: createORPCClient<MobileClient>({
      call: async () => {
        throw new Error("No RPC expected in connection lifecycle test");
      },
    }),
    close() {
      closed.push(true);
    },
    reconnect(options) {
      if (!options?.signal) throw new Error("Reconnect must have an abort signal");
      attempts.push(options.signal);
      return replacement;
    },
  };
  return { connection, closed, attempts };
}

afterEach(cleanup);

describe("mobile connection replacement", () => {
  test("aborts old operations immediately and replaces the actual client only after reconnect succeeds", async () => {
    const next = deferred<Connection>();
    const original = resource(next.promise);
    const replacement = resource(new Promise(() => {}));
    const view = renderHook(() => useConnection(original.connection));
    const oldSignal = view.result.current.signal;
    let pending!: Promise<void>;
    act(() => {
      pending = view.result.current.reconnect();
    });
    expect(oldSignal.aborted).toBe(true);
    expect(view.result.current.ready).toBe(false);
    expect(view.result.current.connection.client).toBe(original.connection.client);
    act(() => {
      view.result.current.reconnect();
    });
    expect(original.attempts).toHaveLength(1);
    await act(async () => {
      next.resolve(replacement.connection);
      await pending;
    });
    expect(view.result.current.connection.client).toBe(replacement.connection.client);
    expect(view.result.current.signal.aborted).toBe(false);
    expect(view.result.current.ready).toBe(true);
    const activeSignal = view.result.current.signal;
    view.unmount();
    expect(activeSignal.aborted).toBe(true);
    expect(replacement.closed).toHaveLength(1);
  });

  test("failed reconnect stays read-only and an explicit retry can recover", async () => {
    const next = deferred<Connection>();
    const original = resource(next.promise);
    const view = renderHook(() => useConnection(original.connection));
    await act(async () => {
      const pending = view.result.current.reconnect();
      next.reject(new Error("offline"));
      await pending;
    });
    expect(view.result.current.ready).toBe(false);
    expect(view.result.current.error).toBe("offline");
    const recovered = resource(new Promise(() => {}));
    original.connection.reconnect = () => Promise.resolve(recovered.connection);
    await act(async () => {
      await view.result.current.reconnect();
    });
    expect(view.result.current.connection).toBe(recovered.connection);
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.ready).toBe(true);
  });

  for (const ending of ["disconnect", "unmount"] as const) {
    test(`late reconnect cannot resurrect a session after ${ending}`, async () => {
      const next = deferred<Connection>();
      const original = resource(next.promise);
      const replacement = resource(new Promise(() => {}));
      const view = renderHook(() => useConnection(original.connection));
      let pending!: Promise<void>;
      act(() => {
        pending = view.result.current.reconnect();
      });
      act(() => {
        if (ending === "disconnect") view.result.current.cancel();
        else view.unmount();
      });
      expect(original.attempts[0].aborted).toBe(true);
      await act(async () => {
        await view.result.current.reconnect();
      });
      expect(original.attempts).toHaveLength(1);
      await act(async () => {
        next.resolve(replacement.connection);
        await pending;
      });
      expect(replacement.closed).toHaveLength(1);
      expect(view.result.current.connection).toBe(original.connection);
      expect(view.result.current.ready).toBe(false);
    });
  }
});

test("a connection abort cancels linked requests, but a workspace switch only cancels its own request", () => {
  const connection = new AbortController();
  const oldWorkspace = linkedAbortController(connection.signal);
  const nextWorkspace = linkedAbortController(connection.signal);
  oldWorkspace.abort();
  expect(connection.signal.aborted).toBe(false);
  expect(nextWorkspace.signal.aborted).toBe(false);
  connection.abort();
  expect(nextWorkspace.signal.aborted).toBe(true);
  expect(linkedAbortController(connection.signal).signal.aborted).toBe(true);
});

import { describe, expect, spyOn, test } from "bun:test";
import { ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/node";
import { createServer } from "node:http";
import { z } from "zod";
import { once } from "node:events";
import assert from "node:assert/strict";
import { connect } from "./api";
import { connect as connectPreview } from "./connection.web";
import type { WorkspaceChatMessage } from "./transcript";

async function expectFailure(promise: Promise<unknown>, message?: string): Promise<void> {
  const error = await promise.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  if (message) expect(String(error)).toContain(message);
}

async function serverFixture(stallProbe = false) {
  const token = "private token/+?";
  let calls = 0;
  let mutations = 0;
  const requests: Array<{ url: string | undefined; authorization: string | undefined }> = [];
  const subscriptions: Array<{ aborted: () => boolean }> = [];
  let onSubscribe: () => void = () => undefined;
  const subscribed = new Promise<void>((resolve) => {
    onSubscribe = resolve;
  });
  const procedure = os.$context<{ authenticated: boolean }>().use(({ context, next }) => {
    if (!context.authenticated) throw new ORPCError("UNAUTHORIZED");
    return next();
  });
  const router = {
    workspace: {
      list: procedure.handler(async ({ signal }) => {
        calls++;
        if (stallProbe)
          await new Promise<void>((resolve) => {
            if (signal?.aborted) resolve();
            else signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        return [];
      }),
      interruptStream: procedure.input(z.object({ workspaceId: z.string() })).handler(() => {
        mutations++;
        throw new ORPCError("INTERNAL_SERVER_ERROR");
      }),
      onChat: procedure
        .input(z.object({ workspaceId: z.string(), mode: z.object({ type: z.literal("full") }) }))
        .handler(async function* ({ input, signal }): AsyncGenerator<WorkspaceChatMessage> {
          subscriptions.push({ aborted: () => signal?.aborted === true });
          onSubscribe();
          yield Promise.resolve<WorkspaceChatMessage>({
            type: "message",
            id: "one",
            role: "user",
            parts: [{ type: "text", text: "hello" }],
          });
          yield { type: "caught-up", replay: "full" };
          if (input.workspaceId === "open-ended")
            await new Promise<void>((resolve) => {
              signal?.addEventListener("abort", () => resolve(), { once: true });
            });
        }),
    },
  };
  const handler = new RPCHandler(router);
  const httpServer = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    handler
      .handle(request, response, {
        prefix: "/proxy/orpc",
        context: { authenticated: request.headers.authorization === `Bearer ${token}` },
      })
      .then(({ matched }) => {
        if (!matched) {
          response.statusCode = 404;
          response.end();
        }
      })
      .catch(() => {
        response.statusCode = 500;
        response.end();
      });
  });
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const address = httpServer.address();
  assert(address && typeof address !== "string", "Test server must bind a TCP port");
  return {
    endpoint: `http://127.0.0.1:${address.port}/proxy`,
    token,
    requests,
    subscriptions,
    subscribed,
    calls: () => calls,
    mutations: () => mutations,
    [Symbol.asyncDispose]: async () => {
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        if (!httpServer.listening) resolve();
        else httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe("mobile HTTP connection", () => {
  test("runtime signals check cancellation and preserve a propagated abort reason", () => {
    const controller = new AbortController();
    expect(() => controller.signal.throwIfAborted()).not.toThrow();
    controller.abort();
    expect(() => controller.signal.throwIfAborted()).toThrow();

    const combined = AbortSignal.any([controller.signal]);
    expect(combined.reason).toBeDefined();
    let thrown: unknown;
    try {
      combined.throwIfAborted();
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBe(combined.reason);
  });

  test("authenticates the probe and streams oRPC events over HTTP through a proxy prefix", async () => {
    await using server = await serverFixture();
    const connection = await connect(`${server.endpoint}/`, server.token);
    expect(connection.endpoint).toBe(server.endpoint);
    expect(server.calls()).toBe(1);
    expect(server.requests).toEqual([
      { url: "/proxy/orpc/workspace/list", authorization: `Bearer ${server.token}` },
    ]);

    const events: WorkspaceChatMessage[] = [];
    const subscription = await connection.client.workspace.onChat({
      workspaceId: "w",
      mode: { type: "full" },
    });
    for await (const event of subscription) events.push(event);
    expect(events.map((event) => event.type)).toEqual(["message", "caught-up"]);
    // The bearer travels only in the Authorization header, never in a URL.
    expect(server.requests.map((request) => request.url)).toEqual([
      "/proxy/orpc/workspace/list",
      "/proxy/orpc/workspace/onChat",
    ]);
    for (const request of server.requests) {
      expect(request.url).not.toContain(encodeURIComponent(server.token));
      expect(request.authorization).toBe(`Bearer ${server.token}`);
    }

    connection.close();
    connection.close();
    await expectFailure(connection.client.workspace.list(), "Connection closed.");
    expect(server.calls()).toBe(1);
  });

  test("aborting one subscription ends only that stream; unary calls stay usable", async () => {
    await using server = await serverFixture();
    const connection = await connect(server.endpoint, server.token);
    const controller = new AbortController();
    const subscription = await connection.client.workspace.onChat(
      { workspaceId: "open-ended", mode: { type: "full" } },
      { signal: controller.signal }
    );
    await server.subscribed;
    const events: WorkspaceChatMessage[] = [];
    const consumed = (async () => {
      for await (const event of subscription) events.push(event);
    })().catch((cause: unknown) => cause);
    while (events.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(server.subscriptions[0].aborted()).toBe(false);
    controller.abort();
    // The client releases the stream immediately. (Bun's fetch keeps the pooled
    // socket open after abort, so the server-side abort is not observable here;
    // browsers and expo/fetch close the connection, which Node reports as close.)
    expect(await consumed).toBeInstanceOf(Error);
    expect(await connection.client.workspace.list()).toEqual([]);
    connection.close();
  });

  test("does not retry a failed mutation or dispatch mutations after close", async () => {
    await using server = await serverFixture();
    const connection = await connect(server.endpoint, server.token);
    await expectFailure(connection.client.workspace.interruptStream({ workspaceId: "w" }));
    expect(server.mutations()).toBe(1);
    connection.close();
    await expectFailure(
      connection.client.workspace.interruptStream({ workspaceId: "w" }),
      "Connection closed."
    );
    expect(server.mutations()).toBe(1);
  });

  test("rejects bad auth without exposing the token or URL", async () => {
    await using server = await serverFixture();
    const secret = "wrong-secret";
    const error = await connect(server.endpoint, secret).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("rejected this token");
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain(server.endpoint);
    expect(server.calls()).toBe(0);
  });

  test.each([404, 500])(
    "HTTP %s from the probe is a generic connection failure",
    async (status) => {
      await using server = await serverFixture();
      const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(server.token, { status })
      );
      try {
        const failure = await connect(server.endpoint, server.token).catch(
          (cause: unknown) => cause
        );
        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).not.toContain(server.token);
        expect(String(failure)).not.toContain(server.endpoint);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        fetchMock.mockRestore();
      }
    }
  );

  test("cancellation aborts a pending authenticated probe", async () => {
    await using server = await serverFixture(true);
    const controller = new AbortController();
    const pending = connect(server.endpoint, server.token, { signal: controller.signal });
    while (server.calls() === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort("secret cancellation reason");
    await expectFailure(pending, "Connection cancelled.");
    expect(server.calls()).toBe(1);
  });

  test("an already aborted signal never sends a request", async () => {
    await using server = await serverFixture();
    const cancelled = new AbortController();
    cancelled.abort();
    await expectFailure(
      connect(server.endpoint, server.token, { signal: cancelled.signal }),
      "cancelled"
    );
    expect(server.requests).toHaveLength(0);
  });

  test("a stalled authenticated probe times out", async () => {
    await using server = await serverFixture(true);
    const originalTimeout = globalThis.setTimeout;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(
      Object.assign((...args: Parameters<typeof setTimeout>) => {
        const [callback, delay, ...callbackArgs] = args;
        // Fire the connect deadline immediately; leave every other timer alone.
        return originalTimeout(callback, delay === 10_000 ? 0 : delay, ...callbackArgs);
      }, originalTimeout)
    );
    try {
      await expectFailure(connect(server.endpoint, server.token), "Connection timed out.");
    } finally {
      timer.mockRestore();
    }
  });

  test("explicit reconnect re-probes with the same bearer without replaying a failed mutation", async () => {
    await using server = await serverFixture();
    const first = await connect(server.endpoint, server.token);
    await expectFailure(first.client.workspace.interruptStream({ workspaceId: "w" }));
    first.close();
    const second = await first.reconnect();
    expect(server.calls()).toBe(2);
    expect(server.mutations()).toBe(1);
    expect(await second.client.workspace.list()).toEqual([]);
    second.close();
  });
});

test("non-loopback HTTP is rejected before any request even with saved credentials", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Network must not be reached")
  );
  try {
    for (const endpoint of [
      "http://10.0.0.2:3000/prefix",
      "http://192.168.1.2",
      "http://172.16.0.1",
      "http://169.254.1.2",
      "http://[fd00::1]",
      "http://[fe80::1]",
      "http://server.local",
    ]) {
      const saved = { endpoint, token: "private token/+?" };
      await expectFailure(connect(saved.endpoint, saved.token), "HTTPS");
      await expectFailure(connectPreview(saved.endpoint, saved.token), "HTTPS");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    fetchMock.mockRestore();
  }
});

import { describe, expect, test } from "bun:test";
import { ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/websocket";
import { z } from "zod";
import { once } from "node:events";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { connect } from "./api";
import type { WorkspaceChatMessage } from "./transcript";

async function expectFailure(promise: Promise<unknown>, message?: string): Promise<void> {
  const error = await promise.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  if (message) expect(String(error)).toContain(message);
}

async function serverFixture(stallProbe = false) {
  const token = "private token/+?";
  let calls = 0;
  let upgrades = 0;
  let mutations = 0;
  let onOpen: () => void = () => undefined;
  let onClose: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    onOpen = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    onClose = resolve;
  });
  const procedure = os.$context<{ authenticated: boolean }>().use(({ context, next }) => {
    if (!context.authenticated) throw new ORPCError("UNAUTHORIZED");
    return next();
  });
  const handler = new RPCHandler({
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
        .handler(async function* (): AsyncGenerator<WorkspaceChatMessage> {
          yield Promise.resolve<WorkspaceChatMessage>({
            type: "message",
            id: "one",
            role: "user",
            parts: [{ type: "text", text: "hello" }],
          });
          yield { type: "caught-up", replay: "full" };
        }),
    },
  });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/proxy/orpc/ws" });
  server.on("connection", (socket, request) => {
    upgrades++;
    const url = new URL(request.url ?? "", "http://localhost");
    handler.upgrade(socket, {
      context: { authenticated: url.searchParams.get("token") === token },
    });
    socket.once("close", onClose);
    onOpen();
  });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string", "Test server must bind a TCP port");
  return {
    endpoint: `http://127.0.0.1:${address.port}/proxy`,
    token,
    opened,
    closed,
    calls: () => calls,
    upgrades: () => upgrades,
    mutations: () => mutations,
    [Symbol.asyncDispose]: async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe("mobile WebSocket connection", () => {
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

  test("authenticates unary probe and streams actual oRPC events through a proxy prefix", async () => {
    await using server = await serverFixture();
    const connection = await connect(`${server.endpoint}/`, server.token);
    try {
      expect(connection.endpoint).toBe(server.endpoint);
      expect(server.calls()).toBe(1);
      const events: WorkspaceChatMessage[] = [];
      const subscription = await connection.client.workspace.onChat({
        workspaceId: "w",
        mode: { type: "full" },
      });
      for await (const event of subscription) events.push(event);
      expect(events.map((event) => event.type)).toEqual(["message", "caught-up"]);
      expect(server.upgrades()).toBe(1);
    } finally {
      connection.close();
      connection.close();
    }
    await server.closed;
    await expectFailure(connection.client.workspace.list());
    expect(server.upgrades()).toBe(1);
    expect(server.calls()).toBe(1);
  });

  test("does not retry a failed mutation or dispatch mutations after close", async () => {
    await using server = await serverFixture();
    const connection = await connect(server.endpoint, server.token);
    try {
      await expectFailure(connection.client.workspace.interruptStream({ workspaceId: "w" }));
      expect(server.mutations()).toBe(1);
    } finally {
      connection.close();
    }
    await server.closed;
    await expectFailure(
      connection.client.workspace.interruptStream({ workspaceId: "w" }),
      "Connection closed."
    );
    expect(server.mutations()).toBe(1);
    expect(server.upgrades()).toBe(1);
  });

  test("rejects bad auth without exposing token or URL and closes its socket", async () => {
    await using server = await serverFixture();
    const secret = "wrong-secret";
    const error = await connect(server.endpoint, secret).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain(server.endpoint);
    await server.closed;
    expect(server.calls()).toBe(0);
  });

  test("cancellation closes the socket before the WebSocket handshake completes", async () => {
    let onRequest: (request: Request) => void = () => undefined;
    const requested = new Promise<Request>((resolve) => {
      onRequest = resolve;
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        onRequest(request);
        return new Promise<Response>((resolve) => {
          request.signal.addEventListener(
            "abort",
            () => resolve(new Response(null, { status: 503 })),
            { once: true }
          );
        });
      },
    });
    try {
      const controller = new AbortController();
      const pending = connect(`http://127.0.0.1:${server.port}`, "secret", {
        signal: controller.signal,
      });
      const request = await requested;
      const disconnected = new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      controller.abort();
      await expectFailure(pending, "Connection cancelled.");
      await disconnected;
    } finally {
      await server.stop(true);
    }
  });

  test("cancellation closes a pending authenticated probe", async () => {
    await using server = await serverFixture(true);
    const controller = new AbortController();
    const pending = connect(server.endpoint, server.token, { signal: controller.signal });
    await server.opened;
    controller.abort("secret cancellation reason");
    await expectFailure(pending, "Connection cancelled.");
    await server.closed;
  });

  test("already aborted signal never opens a socket; lifetime abort closes a connected one", async () => {
    await using server = await serverFixture();
    const cancelled = new AbortController();
    cancelled.abort();
    await expectFailure(
      connect(server.endpoint, server.token, { signal: cancelled.signal }),
      "cancelled"
    );
    expect(server.upgrades()).toBe(0);
    const lifetime = new AbortController();
    const connection = await connect(server.endpoint, server.token, { signal: lifetime.signal });
    lifetime.abort();
    await server.closed;
    connection.close();
    expect(server.upgrades()).toBe(1);
  });

  test("a stalled authenticated RPC probe times out and closes its socket", async () => {
    await using server = await serverFixture(true);
    await expectFailure(connect(server.endpoint, server.token), "Connection timed out.");
    await server.closed;
    expect(server.upgrades()).toBe(1);
  }, 15_000);
});

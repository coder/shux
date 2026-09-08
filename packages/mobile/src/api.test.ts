import { describe, expect, spyOn, test } from "bun:test";
import { ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/websocket";
import { RPCHandler as HTTPHandler } from "@orpc/server/node";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { once } from "node:events";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { connect } from "./api";
import {
  ORPC_WS_PROTOCOL,
  ORPC_WS_TICKET_PREFIX,
  ORPC_WS_TICKET_TTL_MS,
} from "../../../src/common/constants/webSocketAuth";
import type { WorkspaceChatMessage } from "./transcript";

async function expectFailure(promise: Promise<unknown>, message?: string): Promise<void> {
  const error = await promise.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  if (message) expect(String(error)).toContain(message);
}

async function serverFixture(
  stallProbe = false,
  selectProtocol: (protocols: Set<string>) => string | false = () => ORPC_WS_PROTOCOL
) {
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
  const tickets = new Set<string>();
  const mintRequests: Array<{ url: string | undefined; authorization: string | undefined }> = [];
  const handshakes: Array<{ url: string | undefined; protocols: string | undefined }> = [];
  const router = {
    serverAuth: {
      issueWebSocketTicket: procedure.handler(() => {
        const ticket = randomBytes(32).toString("hex");
        tickets.add(ticket);
        return { ticket, expiresAtMs: Date.now() + ORPC_WS_TICKET_TTL_MS };
      }),
    },
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
  };
  const handler = new RPCHandler(router);
  const httpHandler = new HTTPHandler(router);
  const httpServer = createServer((request, response) => {
    mintRequests.push({ url: request.url, authorization: request.headers.authorization });
    httpHandler
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
  const server = new WebSocketServer({
    server: httpServer,
    path: "/proxy/orpc/ws",
    handleProtocols: selectProtocol,
    verifyClient: ({ req }: { req: IncomingMessage }) => {
      const protocols = req.headers["sec-websocket-protocol"]?.split(/,\s*/);
      const ticket = protocols
        ?.find((value) => value.startsWith(ORPC_WS_TICKET_PREFIX))
        ?.slice(ORPC_WS_TICKET_PREFIX.length);
      handshakes.push({ url: req.url, protocols: req.headers["sec-websocket-protocol"] });
      return (
        req.url === "/proxy/orpc/ws" &&
        protocols?.includes(ORPC_WS_PROTOCOL) === true &&
        ticket !== undefined &&
        tickets.delete(ticket)
      );
    },
  });
  server.on("connection", (socket) => {
    upgrades++;
    handler.upgrade(socket, { context: { authenticated: true } });
    socket.once("close", onClose);
    onOpen();
  });
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const address = httpServer.address();
  assert(address && typeof address !== "string", "Test server must bind a TCP port");
  return {
    endpoint: `http://127.0.0.1:${address.port}/proxy`,
    token,
    mintRequests,
    handshakes,
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
      await new Promise<void>((resolve, reject) => {
        // Bun can stop listening here after terminating an upgraded connection.
        httpServer.closeAllConnections();
        if (!httpServer.listening) resolve();
        else httpServer.close((error) => (error ? reject(error) : resolve()));
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
      expect(server.mintRequests).toEqual([
        {
          url: "/proxy/orpc/serverAuth/issueWebSocketTicket",
          authorization: `Bearer ${server.token}`,
        },
      ]);
      expect(server.handshakes[0].url).toBe("/proxy/orpc/ws");
      expect(server.handshakes[0].protocols).not.toContain(server.token);

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

  test("rejects a ticket-echo protocol even when the server answers the auth probe", async () => {
    await using server = await serverFixture(
      false,
      (protocols) =>
        [...protocols].find((protocol) => protocol.startsWith(ORPC_WS_TICKET_PREFIX)) ?? false
    );
    const OriginalWebSocket = globalThis.WebSocket;
    // Bun's ws fixture always selects the first offer on the wire, even when
    // handleProtocols selects another. Offer the same protocols ticket-first to
    // exercise a real ticket-echo handshake and probe rather than mock its result.
    class TicketFirstSocket extends OriginalWebSocket {
      constructor(url: string, protocols?: string | string[]) {
        assert(Array.isArray(protocols));
        super(url, [...protocols].reverse());
      }
    }
    Object.assign(globalThis, { WebSocket: TicketFirstSocket });
    try {
      const result = await connect(server.endpoint, server.token).catch((cause: unknown) => cause);
      expect(result).toBeInstanceOf(Error);
      expect(server.calls()).toBe(1);
      expect(server.upgrades()).toBe(1);
      const ticket = server.handshakes[0].protocols
        ?.split(/,\s*/)
        .find((protocol) => protocol.startsWith(ORPC_WS_TICKET_PREFIX))
        ?.slice(ORPC_WS_TICKET_PREFIX.length);
      expect(ticket).toBeDefined();
      expect(String(result)).not.toContain(ticket!);
      expect(String(result)).not.toContain(server.token);
      expect(String(result)).not.toContain(server.endpoint);
      await server.closed;
    } finally {
      Object.assign(globalThis, { WebSocket: OriginalWebSocket });
    }
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

  test("rejects bad auth without exposing token or URL or opening a socket", async () => {
    await using server = await serverFixture();
    const secret = "wrong-secret";
    const error = await connect(server.endpoint, secret).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain(server.endpoint);
    expect(server.upgrades()).toBe(0);
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
        if (new URL(request.url).pathname === "/orpc/serverAuth/issueWebSocketTicket") {
          return Response.json({
            json: { ticket: "a".repeat(64), expiresAtMs: Date.now() + ORPC_WS_TICKET_TTL_MS },
          });
        }
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

  test("explicit reconnect mints a fresh ticket without replaying a failed mutation", async () => {
    await using server = await serverFixture();
    const first = await connect(server.endpoint, server.token);
    await expectFailure(first.client.workspace.interruptStream({ workspaceId: "w" }));
    first.close();
    const second = await first.reconnect();
    try {
      expect(server.mintRequests).toHaveLength(2);
      expect(server.handshakes).toHaveLength(2);
      expect(server.handshakes[0].protocols).not.toBe(server.handshakes[1].protocols);
      expect(server.mutations()).toBe(1);
    } finally {
      second.close();
    }
  });

  test.each(["cancel", "timeout"] as const)(
    "%s bounds ticket acquisition even when fetch ignores abort",
    async (action) => {
      await using server = await serverFixture();
      let finishFetch!: (response: Response) => void;
      let requested!: () => void;
      const started = new Promise<void>((resolve) => {
        requested = resolve;
      });
      const response = new Promise<Response>((resolve) => {
        finishFetch = resolve;
      });
      let requestSignal: AbortSignal | undefined;
      const originalTimeout = globalThis.setTimeout;
      let expire!: () => void;
      const timer = spyOn(globalThis, "setTimeout").mockImplementation(
        Object.assign((...args: Parameters<typeof setTimeout>) => {
          const [callback, delay, ...callbackArgs] = args;
          if (delay === 10_000) expire = () => callback(...callbackArgs);
          return originalTimeout(...args);
        }, originalTimeout)
      );
      const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign((...args: Parameters<typeof fetch>) => {
          requestSignal = args[1]?.signal ?? undefined;
          requested();
          return response;
        }, globalThis.fetch)
      );
      try {
        const controller = new AbortController();
        const pending = connect(server.endpoint, server.token, { signal: controller.signal });
        await started;
        if (action === "cancel") controller.abort("private cancellation reason");
        else expire();
        await expectFailure(
          pending,
          action === "cancel" ? "Connection cancelled." : "Connection timed out."
        );
        expect(requestSignal?.aborted).toBe(true);
        finishFetch(
          Response.json({
            json: { ticket: "a".repeat(64), expiresAtMs: Date.now() + ORPC_WS_TICKET_TTL_MS },
          })
        );
        await response;
        await Promise.resolve();
        expect(server.handshakes).toHaveLength(0);
      } finally {
        fetchMock.mockRestore();
        timer.mockRestore();
      }
    }
  );

  test("cancellation closes a late native handshake that could not close while connecting", async () => {
    const OriginalWebSocket = globalThis.WebSocket;
    let opened!: (socket: PendingSocket) => void;
    const constructed = new Promise<PendingSocket>((resolve) => {
      opened = resolve;
    });
    class PendingSocket extends EventTarget {
      readyState = 0;
      binaryType = "blob";
      closes = 0;
      constructor() {
        super();
        opened(this);
      }
      close() {
        this.closes++;
        if (this.readyState === 0) throw new Error("Cannot close pending native handshake");
        this.readyState = 3;
        this.dispatchEvent(new Event("close"));
      }
      send() {
        throw new Error("Cancelled socket must not dispatch RPCs");
      }
    }
    Object.assign(globalThis, { WebSocket: PendingSocket });
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        json: { ticket: "a".repeat(64), expiresAtMs: Date.now() + ORPC_WS_TICKET_TTL_MS },
      })
    );
    try {
      const controller = new AbortController();
      const pending = connect("http://localhost", "private token/+?", {
        signal: controller.signal,
      });
      const lateSocket = await constructed;
      controller.abort();
      await expectFailure(pending, "Connection cancelled.");
      expect(lateSocket.closes).toBe(1);
      lateSocket.readyState = 1;
      lateSocket.dispatchEvent(new Event("open"));
      expect(lateSocket.closes).toBe(2);
      expect(lateSocket.readyState).toBe(3);
    } finally {
      Object.assign(globalThis, { WebSocket: OriginalWebSocket });
      fetchMock.mockRestore();
    }
  });

  test.each([401, 404, 500])(
    "ticket HTTP %s fails closed without an insecure upgrade or credential-bearing error",
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
        expect(server.handshakes).toHaveLength(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        fetchMock.mockRestore();
      }
    }
  );

  test("a stalled authenticated RPC probe times out and closes its socket", async () => {
    await using server = await serverFixture(true);
    await expectFailure(connect(server.endpoint, server.token), "Connection timed out.");
    await server.closed;
    expect(server.upgrades()).toBe(1);
  }, 15_000);
});

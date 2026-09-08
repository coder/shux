import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createORPCClient } from "@orpc/client";
import { RPCLink as HTTPRPCLink } from "@orpc/client/fetch";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
import { createRouterClient, type RouterClient } from "@orpc/server";
import { WebSocket } from "ws";
import type { ORPCContext } from "./context";
import { router, type AppRouter } from "./router";
import { authorizeWebSocketTicketHeaders } from "./authMiddleware";
import { createOrpcServer } from "./server";
import { log } from "@/node/services/log";
import {
  ORPC_WS_PROTOCOL,
  ORPC_WS_TICKET_PREFIX,
  ORPC_WS_TICKET_TTL_MS,
} from "@/common/constants/webSocketAuth";

const MASTER = "private token/+?";
const COOKIE = "mux_session=cookie-session";
afterEach(() => mock.restore());

async function fixture(authToken: string | undefined = MASTER) {
  let sessionValid = true;
  const server = await createOrpcServer({
    host: "127.0.0.1",
    port: 0,
    authToken,
    context: {
      serverService: { getSshHost: () => "authenticated", isShuttingDown: () => false },
      serverAuthService: {
        validateSessionToken: () => Promise.resolve(sessionValid ? { sessionId: "session" } : null),
      },
    } as unknown as ORPCContext,
  });
  return {
    ...server,
    revokeSession() {
      sessionValid = false;
    },
    client(
      headers: Record<string, string> = { Authorization: `Bearer ${MASTER}` },
      prefix: "" | `/${string}` = ""
    ) {
      return createORPCClient<RouterClient<AppRouter>>(
        new HTTPRPCLink({ origin: server.baseUrl, url: `${prefix}/orpc`, headers })
      );
    },
    [Symbol.asyncDispose]: () => server.close(),
  };
}

async function connect(url: string, protocols?: string[], headers?: Record<string, string>) {
  const ws = new WebSocket(url, protocols, { headers });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    ws.once("close", () => reject(new Error("Connection closed")));
  });
  return {
    ws,
    client: createORPCClient<RouterClient<AppRouter>>(
      new WebSocketRPCLink({ connect: () => ws, reconnect: { enabled: false } })
    ),
  };
}
async function expectRejected(request: Promise<unknown>, code?: string): Promise<void> {
  try {
    await request;
  } catch (error) {
    if (code) expect(error).toMatchObject({ code });
    return;
  }
  throw new Error("Expected request rejection");
}

function protocols(ticket: string) {
  return [ORPC_WS_PROTOCOL, `${ORPC_WS_TICKET_PREFIX}${ticket}`];
}

test("authenticated HTTP mint authorizes one clean-URL connection and negotiates no secret", async () => {
  await using server = await fixture();
  const issued = await server.client().serverAuth.issueWebSocketTicket();
  expect(issued.expiresAtMs).toBeGreaterThan(Date.now());
  const connection = await connect(server.wsUrl, protocols(issued.ticket));
  expect(connection.ws.protocol).toBe(ORPC_WS_PROTOCOL);
  expect(await connection.client.server.getSshHost()).toBe("authenticated");
  await expectRejected(connection.client.serverAuth.issueWebSocketTicket(), "UNAUTHORIZED");
  await expectRejected(connect(server.wsUrl, protocols(issued.ticket)));
  expect(await connection.client.server.getSshHost()).toBe("authenticated");
});

test("cookie identity cannot mint master tickets and stays subject to revocation", async () => {
  await using server = await fixture();
  const credentials: Array<Record<string, string>> = [
    {},
    { Cookie: COOKIE },
    { Authorization: "Bearer wrong", Cookie: COOKIE },
  ];
  for (const headers of credentials) {
    await expectRejected(server.client(headers).serverAuth.issueWebSocketTicket(), "UNAUTHORIZED");
  }
  const cookie = await connect(server.wsUrl, undefined, { Cookie: COOKIE });
  expect(await cookie.client.server.getSshHost()).toBe("authenticated");
  server.revokeSession();
  await expectRejected(cookie.client.server.getSshHost(), "UNAUTHORIZED");
});

test("auth-disabled servers cannot mint a master ticket", async () => {
  await using server = await fixture("");
  await expectRejected(server.client().serverAuth.issueWebSocketTicket(), "UNAUTHORIZED");
});

test("unknown, malformed and expired new-format tickets never fall back to ambient auth", async () => {
  await using server = await fixture();
  const issued = await server.client().serverAuth.issueWebSocketTicket();
  const headers = { Authorization: `Bearer ${MASTER}`, Cookie: COOKIE };
  for (const offered of [
    protocols("0".repeat(64)),
    protocols("bad"),
    [ORPC_WS_PROTOCOL],
    protocols(issued.ticket).reverse(),
  ]) {
    await expectRejected(
      connect(`${server.wsUrl}?token=${encodeURIComponent(MASTER)}`, offered, headers)
    );
  }
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now + ORPC_WS_TICKET_TTL_MS);
  await expectRejected(connect(server.wsUrl, protocols(issued.ticket), headers));
  clock.mockRestore();
});

test("origin, path and server audience rejections do not consume a valid ticket", async () => {
  await using server = await fixture();
  await using other = await fixture();
  const issued = await server.client().serverAuth.issueWebSocketTicket();
  await expectRejected(
    connect(server.wsUrl, protocols(issued.ticket), { Origin: "https://evil.example" })
  );
  await expectRejected(
    connect(server.wsUrl.replace("/orpc/ws", "/other"), protocols(issued.ticket))
  );
  await expectRejected(connect(other.wsUrl, protocols(issued.ticket)));
  const valid = await connect(server.wsUrl, protocols(issued.ticket));
  expect(await valid.client.server.getSshHost()).toBe("authenticated");
});

test("legacy Authorization, query and raw subprotocol clients retain their authentication", async () => {
  await using server = await fixture("legacy-token");
  for (const input of [
    { url: server.wsUrl, offered: undefined, headers: { Authorization: "Bearer legacy-token" } },
    { url: `${server.wsUrl}?token=legacy-token`, offered: undefined, headers: undefined },
    { url: server.wsUrl, offered: ["legacy-token", "other"], headers: undefined },
  ]) {
    const legacy = await connect(input.url, input.offered, input.headers);
    expect(legacy.ws.protocol).toBe(input.offered?.[0] ?? "");
    expect(await legacy.client.server.getSshHost()).toBe("authenticated");
  }
});

test("app-proxy HTTP issuance and WebSocket redemption preserve prefix support", async () => {
  await using server = await fixture();
  const prefix = "/@owner/workspace/apps/xum";
  const issued = await server.client(undefined, prefix).serverAuth.issueWebSocketTicket();
  const connection = await connect(
    server.wsUrl.replace("/orpc/ws", `${prefix}/orpc/ws`),
    protocols(issued.ticket)
  );
  expect(await connection.client.server.getSshHost()).toBe("authenticated");
});

test("rejected-origin logs contain neither legacy query credentials nor ticket protocols", async () => {
  await using server = await fixture();
  const warn = spyOn(log, "warn").mockImplementation(() => undefined);
  const issued = await server.client().serverAuth.issueWebSocketTicket();
  await expectRejected(
    connect(`${server.wsUrl}?token=${encodeURIComponent(MASTER)}`, protocols(issued.ticket), {
      Origin: "https://evil.example",
    })
  );
  const logged = JSON.stringify(warn.mock.calls);
  expect(logged).not.toContain(MASTER);
  expect(logged).not.toContain(encodeURIComponent(MASTER));
  expect(logged).not.toContain(issued.ticket);
  expect(warn).toHaveBeenCalled();
});

test("ticket issuance requires HTTP POST and is never cacheable", async () => {
  await using server = await fixture();
  const endpoint = `${server.baseUrl}/orpc/serverAuth/issueWebSocketTicket`;
  const headers = { Authorization: `Bearer ${MASTER}`, "Content-Type": "application/json" };
  const response = await fetch(endpoint, { method: "POST", headers, body: "{}" });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const get = await fetch(endpoint, { headers });
  expect(get.status).toBe(401);
  const legacy = await connect(server.wsUrl, undefined, { Authorization: `Bearer ${MASTER}` });
  await expectRejected(legacy.client.serverAuth.issueWebSocketTicket(), "UNAUTHORIZED");
});

test("ticket authority is object identity, never forgeable by matching headers", async () => {
  const headers = { authorization: "Bearer invalid" };
  authorizeWebSocketTicketHeaders(headers);
  const context = {
    headers,
    serverService: { isShuttingDown: () => false, getSshHost: () => "authenticated" },
  } as unknown as ORPCContext;
  const authorized = createRouterClient(router(MASTER), { context });
  expect(await authorized.server.getSshHost()).toBe("authenticated");
  const forged = createRouterClient(router(MASTER), {
    context: { ...context, headers: { ...headers } },
  });
  await expectRejected(forged.server.getSshHost(), "UNAUTHORIZED");
});

test("a rejected WebSocket handshake after the ticket peek does not consume it", async () => {
  await using server = await fixture();
  const issued = await server.client().serverAuth.issueWebSocketTicket();
  server.wsServer.options.verifyClient = () => false;
  await expectRejected(connect(server.wsUrl, protocols(issued.ticket)));
  server.wsServer.options.verifyClient = undefined;
  const accepted = await connect(server.wsUrl, protocols(issued.ticket));
  expect(await accepted.client.server.getSshHost()).toBe("authenticated");
});

test("two upgrades that both peek the same ticket emit only one authorized connection", async () => {
  await using server = await fixture();
  const issued = await server.client().serverAuth.issueWebSocketTicket();
  const pending: Array<(accepted: boolean) => void> = [];
  let ready!: () => void;
  const bothPeeked = new Promise<void>((resolve) => {
    ready = resolve;
  });
  server.wsServer.options.verifyClient = (_info: unknown, done: (accepted: boolean) => void) => {
    pending.push(done);
    if (pending.length === 2) ready();
  };
  let acceptedConnections = 0;
  server.wsServer.on("connection", () => {
    acceptedConnections++;
  });
  const attempts = Promise.allSettled([
    connect(server.wsUrl, protocols(issued.ticket)),
    connect(server.wsUrl, protocols(issued.ticket)),
  ]);
  await bothPeeked;
  pending.forEach((done) => done(true));
  await attempts;
  expect(acceptedConnections).toBe(1);
  await expectRejected(connect(server.wsUrl, protocols(issued.ticket)));
});

import { createORPCClient } from "@orpc/client";
import type { Client, ClientContext } from "@orpc/client";
import type { AnySchema, InferSchemaInput, InferSchemaOutput } from "@orpc/contract";
import { RPCLink } from "@orpc/client/websocket";
import type * as schemas from "../../../src/common/orpc/schemas/api";
import {
  ORPC_WS_PROTOCOL,
  ORPC_WS_TICKET_PREFIX,
} from "../../../src/common/constants/webSocketAuth";
import {
  requestWebSocketTicket,
  WebSocketTicketError,
} from "../../../src/common/orpc/webSocketTicket";
import { normalizeEndpoint } from "./endpoint";

// Infer the wire contract without importing the Node router's implementation
// graph into a native TypeScript program (Expo and Node declare different globals).
type SchemaClient<T> = T extends {
  input: infer I extends AnySchema;
  output: infer O extends AnySchema;
}
  ? Client<ClientContext, InferSchemaInput<I>, InferSchemaOutput<O>, Error>
  : { [K in keyof T]: SchemaClient<T[K]> };
export type MobileClient = SchemaClient<
  Pick<typeof schemas, "projects" | "workspace" | "providers" | "agents" | "config" | "policy">
>;
export interface MobileConnection {
  client: MobileClient;
  endpoint: string;
  close: () => void;
  reconnect: (options?: { signal?: AbortSignal }) => Promise<MobileConnection>;
}

const CONNECT_TIMEOUT_MS = 10_000;

/**
 * One owned socket for both authenticated unary RPC and subscriptions. Reconnect
 * is explicit: never retry a mutation, and reset chat before a new full replay.
 * The signal owns the connection lifetime, including the pending handshake.
 */
export async function connect(
  endpoint: string,
  token: string,
  options: { signal?: AbortSignal } = {}
): Promise<MobileConnection> {
  const normalized = normalizeEndpoint(endpoint);
  if (!token.trim()) throw new Error("Enter a server token.");
  if (options.signal?.aborted) throw new Error("Connection cancelled.");

  const probe = new AbortController();
  let socket: WebSocket | undefined;
  let closed = false;
  let timedOut = false;
  const closeSocket = () => {
    if (!socket) return;
    const ownedSocket = socket;
    try {
      if (ownedSocket.readyState < 2) ownedSocket.close();
    } catch {
      // Some native implementations cannot close a pending handshake. Do not
      // let a late open outlive cancellation of the connection that owns it.
      ownedSocket.addEventListener("open", () => ownedSocket.close(), { once: true });
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    options.signal?.removeEventListener("abort", close);
    socket?.removeEventListener("close", close);
    probe.abort();
    closeSocket();
  };
  options.signal?.addEventListener("abort", close, { once: true });
  // One deadline covers both the HTTP mint and the authenticated socket probe.
  const timeout = setTimeout(() => {
    timedOut = true;
    close();
  }, CONNECT_TIMEOUT_MS);

  try {
    const { ticket } = await requestWebSocketTicket(normalized, token, probe.signal);
    probe.signal.throwIfAborted();
    const url = new URL(`${normalized}/orpc/ws`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    // Never put the reusable bearer in URLs or protocols; every reconnect mints
    // a fresh, short-lived single-use ticket through authenticated HTTP instead.
    socket = new WebSocket(url.toString(), [ORPC_WS_PROTOCOL, ORPC_WS_TICKET_PREFIX + ticket]);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("close", close);
    if (closed) {
      closeSocket();
      throw new Error("Connection closed.");
    }
    const client = createORPCClient<MobileClient>(
      new RPCLink({
        connect: () => {
          if (closed || !socket) throw new Error("Connection closed.");
          return socket;
        },
        reconnect: { enabled: false },
        // The adapter retains its peer after close; reject before it can queue a
        // call that will never receive a response (or replay a mutation).
        interceptors: [
          (options) => {
            if (closed) throw new Error("Connection closed.");
            return options.next();
          },
        ],
      })
    );
    // An open handshake alone does not prove RPC authentication succeeded.
    await client.workspace.list(undefined, { signal: probe.signal });
    if (closed) throw new Error("Connection closed.");
    // A ticket is an upgrade credential, never the negotiated application protocol.
    if (socket.protocol !== ORPC_WS_PROTOCOL) throw new Error("Connection protocol rejected.");
    return {
      client,
      close,
      endpoint: normalized,
      reconnect: (options) => connect(normalized, token, options),
    };
  } catch (error) {
    close();
    if (options.signal?.aborted) throw new Error("Connection cancelled.");
    if (timedOut) throw new Error("Connection timed out.");
    if (error instanceof WebSocketTicketError) throw error;
    throw new Error("Unable to connect. Check the server address and token.");
  } finally {
    clearTimeout(timeout);
  }
}

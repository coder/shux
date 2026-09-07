import { createORPCClient } from "@orpc/client";
import type { Client, ClientContext } from "@orpc/client";
import type { AnySchema, InferSchemaInput, InferSchemaOutput } from "@orpc/contract";
import { RPCLink } from "@orpc/client/websocket";
import type * as schemas from "../../../src/common/orpc/schemas/api";
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

  const url = new URL(`${normalized}/orpc/ws`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token.trim());
  let socket: WebSocket;
  try {
    socket = new WebSocket(url.toString());
    socket.binaryType = "arraybuffer";
  } catch {
    // Native WebSocket errors may include the credential-bearing URL.
    throw new Error("Unable to open a connection to the server.");
  }

  const probe = new AbortController();
  let closed = false;
  let timedOut = false;
  const close = () => {
    if (closed) return;
    closed = true;
    options.signal?.removeEventListener("abort", close);
    socket.removeEventListener("close", close);
    probe.abort();
    try {
      if (socket.readyState < 2) socket.close();
    } catch {
      // Some native implementations throw when closing a pending handshake.
      // Still close if that handshake subsequently succeeds.
      socket.addEventListener("open", () => socket.close(), { once: true });
    }
  };
  socket.addEventListener("close", close);
  options.signal?.addEventListener("abort", close, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    close();
  }, CONNECT_TIMEOUT_MS);

  try {
    const client = createORPCClient<MobileClient>(
      new RPCLink({
        connect: () => {
          if (closed) throw new Error("Connection closed.");
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
    return {
      client,
      close,
      endpoint: normalized,
      reconnect: (options) => connect(normalized, token, options),
    };
  } catch {
    close();
    if (options.signal?.aborted) throw new Error("Connection cancelled.");
    if (timedOut) throw new Error("Connection timed out.");
    throw new Error("Unable to connect. Check the server address and token.");
  } finally {
    clearTimeout(timeout);
  }
}

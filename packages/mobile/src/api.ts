import { createORPCClient, ORPCError } from "@orpc/client";
import type { Client, ClientContext } from "@orpc/client";
import type { AnySchema, InferSchemaInput, InferSchemaOutput } from "@orpc/contract";
import { RPCLink } from "@orpc/client/fetch";
import type * as schemas from "../../../src/common/orpc/schemas/api";
import { normalizeEndpoint } from "./endpoint";
import { transportFetch } from "./transportFetch";

// Infer the wire contract without importing the Node router's implementation
// graph into a native TypeScript program (Expo and Node declare different globals).
type SchemaClient<T> = T extends {
  input: infer I extends AnySchema;
  output: infer O extends AnySchema;
}
  ? Client<ClientContext, InferSchemaInput<I>, InferSchemaOutput<O>, Error>
  : { [K in keyof T]: SchemaClient<T[K]> };
export type MobileClient = SchemaClient<
  Pick<
    typeof schemas,
    "projects" | "workspace" | "providers" | "agents" | "config" | "policy" | "server"
  >
>;
export interface MobileConnection {
  client: MobileClient;
  endpoint: string;
  close: () => void;
  reconnect: (options?: { signal?: AbortSignal }) => Promise<MobileConnection>;
}

const CONNECT_TIMEOUT_MS = 10_000;

/** A rejected bearer is terminal for the session; every other failure may be retried. */
export function isAuthenticationError(cause: unknown): boolean {
  return (
    cause instanceof ORPCError && (cause.code === "UNAUTHORIZED" || cause.code === "FORBIDDEN")
  );
}

/**
 * Stateless HTTP transport: every call is its own request, and every subscription is
 * its own streamed response. Nothing survives a network change except the bearer, so
 * cellular handoffs cost only the requests that were in flight. Mutations are never
 * retried; subscriptions heal themselves (see streams.ts).
 */
export async function connect(
  endpoint: string,
  token: string,
  options: { signal?: AbortSignal } = {}
): Promise<MobileConnection> {
  const normalized = normalizeEndpoint(endpoint);
  if (!token.trim()) throw new Error("Enter a server token.");
  if (options.signal?.aborted) throw new Error("Connection cancelled.");
  const base = new URL(normalized);
  let closed = false;
  const client = createORPCClient<MobileClient>(
    new RPCLink({
      origin: base.origin,
      url: `/${[...base.pathname.split("/").filter(Boolean), "orpc"].join("/")}`,
      // The bearer travels only in this header, over HTTPS (or same-device loopback).
      headers: { Authorization: `Bearer ${token}` },
      fetch: (url, init) =>
        transportFetch(url, { ...init, credentials: "omit", redirect: "error", cache: "no-store" }),
      interceptors: [
        (options) => {
          // Disconnect must not let a late React effect dispatch a mutation.
          if (closed) throw new Error("Connection closed.");
          return options.next();
        },
      ],
    })
  );

  // One deadline covers the authenticated probe; the signal owns cancellation.
  const probe = new AbortController();
  let timedOut = false;
  const cancel = () => probe.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    probe.abort();
  }, CONNECT_TIMEOUT_MS);
  try {
    // Reachability alone proves nothing; an authenticated RPC must succeed.
    await client.workspace.list(undefined, { signal: probe.signal });
  } catch (cause) {
    if (options.signal?.aborted) throw new Error("Connection cancelled.");
    if (timedOut) throw new Error("Connection timed out.");
    if (isAuthenticationError(cause)) throw new Error("The server rejected this token.");
    throw new Error("Unable to connect. Check the server address and token.");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancel);
  }
  return {
    client,
    endpoint: normalized,
    close: () => {
      closed = true;
    },
    reconnect: (options) => connect(normalized, token, options),
  };
}

import { createORPCClient } from "@orpc/client";
import type { Client, ClientContext } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { InferSchemaInput, InferSchemaOutput } from "@orpc/contract";
import type { serverAuth } from "./schemas/api";
import { ORPC_WS_TICKET_PATTERN } from "../constants/webSocketAuth";

type TicketProcedure = typeof serverAuth.issueWebSocketTicket;
type WebSocketTicket = InferSchemaOutput<TicketProcedure["output"]>;
type TicketClient = Record<
  "serverAuth",
  {
    issueWebSocketTicket: Client<
      ClientContext,
      InferSchemaInput<TicketProcedure["input"]>,
      WebSocketTicket,
      Error
    >;
  }
>;
type TicketErrorReason = "authentication" | "unsupported" | "transient" | "cancelled";
const errorMessages: Record<TicketErrorReason, string> = {
  authentication: "Server authentication is required. Check your token.",
  unsupported: "This server does not support secure WebSocket tickets. Update the server.",
  transient: "Unable to obtain a secure connection ticket. Try connecting again.",
  cancelled: "Connection cancelled.",
};

export class WebSocketTicketError extends Error {
  constructor(readonly reason: TicketErrorReason) {
    super(errorMessages[reason]);
    this.name = "WebSocketTicketError";
  }
}

/** Exchange a bearer over HTTP only. The caller owns the deadline and the resulting socket. */
export async function requestWebSocketTicket(
  baseUrl: string,
  bearerToken: string,
  signal: AbortSignal
): Promise<WebSocketTicket> {
  if (signal.aborted) throw new WebSocketTicketError("cancelled");
  let cancel!: () => void;
  // Native/custom fetch implementations may ignore abort. Settle the caller anyway,
  // and never retain the abort reason or an upstream error that could contain credentials.
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new WebSocketTicketError("cancelled"));
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    const base = new URL(baseUrl);
    if (
      !/^https?:$/.test(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    ) {
      throw new WebSocketTicketError("transient");
    }
    const rpcPath = `${base.pathname.replace(/\/+$/, "")}/orpc`;
    const client = createORPCClient<TicketClient>(
      new RPCLink({
        origin: base.origin,
        url: `/${rpcPath.slice(1)}`,
        method: "POST",
        headers: { Authorization: `Bearer ${bearerToken}` },
        fetch: async (url, init) => {
          if (signal.aborted) throw new WebSocketTicketError("cancelled");
          const response = await fetch(url, {
            ...init,
            credentials: "omit",
            redirect: "error",
            cache: "no-store",
          });
          if (response.status === 401) throw new WebSocketTicketError("authentication");
          if ([404, 405, 501].includes(response.status))
            throw new WebSocketTicketError("unsupported");
          if (!response.ok) throw new WebSocketTicketError("transient");
          return response;
        },
      })
    );
    const result: unknown = await Promise.race([
      client.serverAuth.issueWebSocketTicket(undefined, { signal }),
      cancelled,
    ]);
    if (signal.aborted) throw new WebSocketTicketError("cancelled");
    if (
      !result ||
      typeof result !== "object" ||
      !("ticket" in result) ||
      typeof result.ticket !== "string" ||
      !ORPC_WS_TICKET_PATTERN.test(result.ticket) ||
      !("expiresAtMs" in result) ||
      typeof result.expiresAtMs !== "number" ||
      !Number.isFinite(result.expiresAtMs)
    ) {
      throw new WebSocketTicketError("transient");
    }
    return { ticket: result.ticket, expiresAtMs: result.expiresAtMs };
  } catch (error) {
    if (signal.aborted) throw new WebSocketTicketError("cancelled");
    if (error instanceof WebSocketTicketError) throw error;
    throw new WebSocketTicketError("transient");
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

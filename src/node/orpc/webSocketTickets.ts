import { randomBytes } from "node:crypto";
import type { WebSocketTicket } from "@/common/orpc/types";
import {
  ORPC_WS_PROTOCOL,
  ORPC_WS_TICKET_PREFIX,
  ORPC_WS_TICKET_TTL_MS,
  ORPC_WS_TICKET_MAX_PENDING,
  ORPC_WS_TICKET_PATTERN,
} from "@/common/constants/webSocketAuth";

/** Owned by one HTTP server: no bridge scopes, bearer material, or persistence. */
export class WebSocketTicketStore {
  private readonly tickets = new Map<string, number>();
  private disposed = false;

  mint(): WebSocketTicket | null {
    if (this.disposed) return null;
    const now = Date.now();
    for (const [ticket, expiry] of this.tickets) {
      if (expiry <= now) this.tickets.delete(ticket);
    }
    if (this.tickets.size >= ORPC_WS_TICKET_MAX_PENDING) return null;
    let ticket: string;
    do {
      ticket = randomBytes(32).toString("hex");
    } while (this.tickets.has(ticket));
    const expiresAtMs = now + ORPC_WS_TICKET_TTL_MS;
    this.tickets.set(ticket, expiresAtMs);
    return { ticket, expiresAtMs };
  }

  isValid(ticket: string): boolean {
    if (!ORPC_WS_TICKET_PATTERN.test(ticket)) return false;
    const expiry = this.tickets.get(ticket);
    return expiry !== undefined && Date.now() < expiry;
  }

  /** Synchronous consume is the authorization point, not the earlier handshake peek. */
  consume(ticket: string): boolean {
    const valid = this.isValid(ticket);
    this.tickets.delete(ticket);
    return valid;
  }

  dispose(): void {
    this.disposed = true;
    this.tickets.clear();
  }
}

type TicketProtocols =
  | { type: "legacy" }
  | { type: "invalid" }
  | { type: "ticket"; ticket: string };

export function parseWebSocketTicketProtocols(
  header: string | string[] | undefined
): TicketProtocols {
  const protocols = (Array.isArray(header) ? header.join(",") : (header ?? ""))
    .split(",")
    .map((value) => value.trim());
  if (
    !protocols.some(
      (value) => value === ORPC_WS_PROTOCOL || value.startsWith(ORPC_WS_TICKET_PREFIX)
    )
  )
    return { type: "legacy" };
  if (
    protocols.length !== 2 ||
    protocols[0] !== ORPC_WS_PROTOCOL ||
    !protocols[1].startsWith(ORPC_WS_TICKET_PREFIX)
  )
    return { type: "invalid" };
  const ticket = protocols[1].slice(ORPC_WS_TICKET_PREFIX.length);
  return ORPC_WS_TICKET_PATTERN.test(ticket) ? { type: "ticket", ticket } : { type: "invalid" };
}

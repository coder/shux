/** General oRPC upgrade credentials: never put the server bearer in the URL. */
export const ORPC_WS_PROTOCOL = "xum.orpc.v1";
export const ORPC_WS_TICKET_PREFIX = "xum.orpc.ticket.v1.";
export const ORPC_WS_TICKET_TTL_MS = 30_000;
export const ORPC_WS_TICKET_MAX_PENDING = 256;
export const ORPC_WS_TICKET_PATTERN = /^[a-f0-9]{64}$/;

import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
  ORPC_WS_PROTOCOL,
  ORPC_WS_TICKET_PREFIX,
  ORPC_WS_TICKET_TTL_MS,
  ORPC_WS_TICKET_MAX_PENDING,
} from "@/common/constants/webSocketAuth";
import { parseWebSocketTicketProtocols, WebSocketTicketStore } from "./webSocketTickets";

afterEach(() => mock.restore());

test("tickets expire at their deadline and two successful peeks authorize only one consumption", () => {
  const clock = spyOn(Date, "now").mockReturnValue(1000);
  const store = new WebSocketTicketStore();
  const first = store.mint()!;
  expect(first.expiresAtMs).toBe(1000 + ORPC_WS_TICKET_TTL_MS);
  expect(store.isValid(first.ticket)).toBe(true);
  expect(store.isValid(first.ticket)).toBe(true);
  expect(store.consume(first.ticket)).toBe(true);
  expect(store.consume(first.ticket)).toBe(false);
  const expired = store.mint()!;
  clock.mockReturnValue(expired.expiresAtMs);
  expect(store.isValid(expired.ticket)).toBe(false);
  expect(store.consume(expired.ticket)).toBe(false);
  expect(store.consume("unknown")).toBe(false);
});

test("tickets are bounded, reclaimed after expiry, and scoped to a live server store", () => {
  const clock = spyOn(Date, "now").mockReturnValue(1000);
  const store = new WebSocketTicketStore();
  const other = new WebSocketTicketStore();
  const tickets = Array.from({ length: ORPC_WS_TICKET_MAX_PENDING }, () => store.mint()!);
  expect(new Set(tickets.map(({ ticket }) => ticket)).size).toBe(tickets.length);
  expect(store.mint()).toBeNull();
  expect(other.consume(tickets[0].ticket)).toBe(false);
  expect(store.isValid(tickets[0].ticket)).toBe(true);
  clock.mockReturnValue(tickets[0].expiresAtMs);
  const renewed = store.mint()!;
  expect(renewed).not.toBeNull();
  store.dispose();
  expect(store.consume(renewed.ticket)).toBe(false);
  expect(store.mint()).toBeNull();
});

test("only a correctly ordered application/ticket pair uses ticket authentication", () => {
  const ticket = new WebSocketTicketStore().mint()!.ticket;
  const credential = `${ORPC_WS_TICKET_PREFIX}${ticket}`;
  expect(parseWebSocketTicketProtocols(`${ORPC_WS_PROTOCOL}, ${credential}`)).toEqual({
    type: "ticket",
    ticket,
  });
  for (const header of [
    ORPC_WS_PROTOCOL,
    credential,
    `${credential}, ${ORPC_WS_PROTOCOL}`,
    `${ORPC_WS_PROTOCOL}, ${credential}, extra`,
    `${ORPC_WS_PROTOCOL}, ${ORPC_WS_TICKET_PREFIX}bad`,
    `${ORPC_WS_PROTOCOL}, ${ORPC_WS_TICKET_PREFIX}${`A${ticket.slice(1)}`}`,
    `${ORPC_WS_PROTOCOL}, ${credential}, ${credential}`,
  ])
    expect(parseWebSocketTicketProtocols(header)).toEqual({ type: "invalid" });
  expect(parseWebSocketTicketProtocols(undefined)).toEqual({ type: "legacy" });
  expect(parseWebSocketTicketProtocols("legacy-token, other")).toEqual({ type: "legacy" });
});

import { describe, expect, test } from "bun:test";

import { createMuxMessage, type MuxMessageMetadata } from "@/common/types/message";
import { buildDisplayedMessagesForMessage } from "./displayedMessageBuilder";

function buildUserRow(muxMetadata: MuxMessageMetadata) {
  const message = createMuxMessage("wake-1", "user", "A background bash monitor matched output.", {
    historySequence: 1,
    synthetic: true,
    uiVisible: true,
    muxMetadata,
  });
  const displayed = buildDisplayedMessagesForMessage({
    message,
    hasActiveStream: false,
    isContextBoundaryMessage: () => false,
  });
  expect(displayed).toHaveLength(1);
  const row = displayed[0];
  if (row?.type !== "user") throw new Error(`expected user row, got ${row?.type}`);
  return row;
}

describe("buildDisplayedMessagesForMessage bash monitor wake metadata", () => {
  test("surfaces well-formed wake records for inline event rendering", () => {
    const row = buildUserRow({
      type: "bash-monitor-wake",
      records: [
        { kind: "match", displayName: "Dev Server", filter: "error|ready", filterExclude: false },
      ],
    });
    expect(row.bashMonitorWake?.records).toHaveLength(1);
    expect(row.bashMonitorWake?.records[0]?.displayName).toBe("Dev Server");
  });

  test("surfaces terminal settlement metadata on wake records", () => {
    const row = buildUserRow({
      type: "bash-monitor-wake",
      records: [
        {
          kind: "match",
          displayName: "Checks Watch",
          filter: "ready",
          filterExclude: false,
          terminal: { status: "exited", exitCode: 1 },
        },
      ],
    });
    expect(row.bashMonitorWake?.records[0]?.terminal).toEqual({ status: "exited", exitCode: 1 });
  });

  // Self-healing for the optional terminal field: an invalid shape drops the
  // field, not the record, so the wake still renders with its base summary.
  test.each([
    ["bad status", { status: "vanished" }],
    ["non-numeric exitCode", { status: "exited", exitCode: "one" }],
    ["non-object terminal", "exited"],
  ])("drops an invalid terminal shape (%s) but keeps the record", (_label, terminal) => {
    const row = buildUserRow({
      type: "bash-monitor-wake",
      records: [
        {
          kind: "match",
          displayName: "Dev Server",
          filter: "ready",
          filterExclude: false,
          terminal,
        },
      ],
    } as unknown as MuxMessageMetadata);
    expect(row.bashMonitorWake?.records).toHaveLength(1);
    expect(row.bashMonitorWake?.records[0]?.terminal).toBeUndefined();
  });

  // Same self-healing contract for the stale settlement of a re-armed processId: a malformed
  // staleTerminal must not reach the card's settlement summary (it would lose its description
  // instead of falling back to the base summary); a valid sibling field survives.
  test("drops an invalid staleTerminal shape but keeps the record and a valid terminal", () => {
    const row = buildUserRow({
      type: "bash-monitor-wake",
      records: [
        {
          kind: "match",
          displayName: "Dev Server",
          filter: "ready",
          filterExclude: false,
          terminal: { status: "exited", exitCode: 0 },
          staleTerminal: { status: "vanished" },
        },
      ],
    } as unknown as MuxMessageMetadata);
    expect(row.bashMonitorWake?.records).toHaveLength(1);
    expect(row.bashMonitorWake?.records[0]?.staleTerminal).toBeUndefined();
    expect(row.bashMonitorWake?.records[0]?.terminal).toEqual({ status: "exited", exitCode: 0 });
  });

  test("surfaces a valid staleTerminal so re-armed settlements summarize as settlements", () => {
    const row = buildUserRow({
      type: "bash-monitor-wake",
      records: [
        {
          kind: "match",
          displayName: "Checks Watch",
          filter: "ready",
          filterExclude: false,
          staleTerminal: { status: "exited", exitCode: 1 },
        },
      ],
    });
    expect(row.bashMonitorWake?.records[0]?.staleTerminal).toEqual({
      status: "exited",
      exitCode: 1,
    });
  });

  // muxMetadata is z.any() across the oRPC boundary, so corrupted chat.jsonl
  // lines can carry the wake type without valid records. The builder must fall
  // back to plain full-text rendering instead of crashing the transcript.
  test.each([
    ["missing records", { type: "bash-monitor-wake" }],
    ["non-array records", { type: "bash-monitor-wake", records: "oops" }],
    ["empty records", { type: "bash-monitor-wake", records: [] }],
    ["malformed record entry", { type: "bash-monitor-wake", records: [null, { kind: "match" }] }],
  ])("falls back to full-text rendering for %s", (_label, malformed) => {
    const row = buildUserRow(malformed as unknown as MuxMessageMetadata);
    expect(row.bashMonitorWake).toBeUndefined();
    expect(row.content).toBe("A background bash monitor matched output.");
  });
});

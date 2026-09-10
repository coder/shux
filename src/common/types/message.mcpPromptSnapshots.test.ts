import { describe, expect, test } from "bun:test";
import {
  createMuxMessage,
  filterOrphanedMcpPromptSnapshots,
  sanitizeMcpPromptRefs,
} from "./message";
import type { MuxMessage } from "./message";

function snapshot(id: string, invokingMessageId?: string, promptName = "review"): MuxMessage {
  return createMuxMessage(id, "user", `Expanded ${promptName}`, {
    historySequence: 0,
    synthetic: true,
    mcpPromptSnapshot: {
      serverName: "coder",
      promptName,
      commandKey: `mcp__coder__${promptName}`,
      ...(invokingMessageId !== undefined ? { invokingMessageId } : {}),
    },
  });
}

function invokingUser(id: string, promptNames: string[]): MuxMessage {
  return createMuxMessage(id, "user", "Using MCP prompt", {
    historySequence: 0,
    muxMetadata: {
      type: "normal",
      mcpPromptRefs: promptNames.map((promptName) => ({
        serverName: "coder",
        promptName,
        commandKey: `mcp__coder__${promptName}`,
        source: "slash" as const,
      })),
    },
  });
}

describe("filterOrphanedMcpPromptSnapshots", () => {
  test("keeps snapshots whose invoking user row is present", () => {
    const messages = [snapshot("snap-1", "user-1"), invokingUser("user-1", ["review"])];
    expect(filterOrphanedMcpPromptSnapshots(messages)).toEqual(messages);
  });

  test("drops a snapshot whose invoking user row was never persisted", () => {
    const assistant = createMuxMessage("assistant-1", "assistant", "done", {
      historySequence: 0,
    });
    const messages = [invokingUser("user-1", []), assistant, snapshot("snap-1", "user-never")];
    expect(filterOrphanedMcpPromptSnapshots(messages).map((m) => m.id)).toEqual([
      "user-1",
      "assistant-1",
    ]);
  });

  test("drops a crash orphan even when a later turn references the same prompt", () => {
    const messages = [
      snapshot("orphan-snap", "user-crashed"),
      invokingUser("user-later", ["review"]),
    ];
    expect(filterOrphanedMcpPromptSnapshots(messages).map((m) => m.id)).toEqual(["user-later"]);
  });

  test("drops a snapshot whose invoking id points at a row without a matching ref", () => {
    const unrelated = createMuxMessage("user-unrelated", "user", "Plain message", {
      historySequence: 0,
    });
    const messages = [snapshot("snap-1", "user-unrelated"), unrelated];
    expect(filterOrphanedMcpPromptSnapshots(messages).map((m) => m.id)).toEqual(["user-unrelated"]);
  });

  test("drops a snapshot whose invoking id points at a different prompt's turn", () => {
    const messages = [snapshot("snap-1", "user-1", "review"), invokingUser("user-1", ["status"])];
    expect(filterOrphanedMcpPromptSnapshots(messages).map((m) => m.id)).toEqual(["user-1"]);
  });

  test("drops legacy snapshots without an invoking id", () => {
    const messages = [snapshot("snap-legacy"), invokingUser("user-1", ["review"])];
    expect(filterOrphanedMcpPromptSnapshots(messages).map((m) => m.id)).toEqual(["user-1"]);
  });

  test("keeps other synthetic rows with a corrupted snapshot field, stripped", () => {
    const fileSnapshotRow = createMuxMessage("file-snap-1", "user", "File contents", {
      historySequence: 0,
      synthetic: true,
      fileAtMentionSnapshot: ["@src/foo.ts"],
    });
    (fileSnapshotRow.metadata as Record<string, unknown>).mcpPromptSnapshot = null;

    const result = filterOrphanedMcpPromptSnapshots([fileSnapshotRow]);
    expect(result.map((m) => m.id)).toEqual(["file-snap-1"]);
    expect(result[0].metadata?.fileAtMentionSnapshot).toEqual(["@src/foo.ts"]);
    expect("mcpPromptSnapshot" in (result[0].metadata ?? {})).toBe(false);
  });

  test("drops a corrupted expansion row identified by its snapshot message id", () => {
    const corrupted = createMuxMessage("mcp-prompt-snapshot-123-abc", "user", "Expanded", {
      historySequence: 0,
      synthetic: true,
    });
    (corrupted.metadata as Record<string, unknown>).mcpPromptSnapshot = null;

    expect(filterOrphanedMcpPromptSnapshots([corrupted])).toEqual([]);
  });

  test("drops a prefixed expansion row whose snapshot field is entirely absent", () => {
    const corrupted = createMuxMessage("mcp-prompt-snapshot-456-def", "user", "Expanded", {
      historySequence: 0,
      synthetic: true,
    });

    expect(
      filterOrphanedMcpPromptSnapshots([corrupted, invokingUser("user-1", ["review"])]).map(
        (m) => m.id
      )
    ).toEqual(["user-1"]);
  });

  test("drops a prefixed expansion row with no metadata at all", () => {
    const bare = createMuxMessage("mcp-prompt-snapshot-789-ghi", "user", "Expanded");

    expect(filterOrphanedMcpPromptSnapshots([bare])).toEqual([]);
  });

  test("keeps ordinary rows with a corrupted snapshot field, stripped", () => {
    const authored = createMuxMessage("user-authored", "user", "Real user text", {
      historySequence: 0,
    });
    (authored.metadata as Record<string, unknown>).mcpPromptSnapshot = null;
    const assistant = createMuxMessage("assistant-1", "assistant", "Model reply", {
      historySequence: 0,
    });
    (assistant.metadata as Record<string, unknown>).mcpPromptSnapshot = { bogus: true };

    const result = filterOrphanedMcpPromptSnapshots([authored, assistant]);
    expect(result.map((m) => m.id)).toEqual(["user-authored", "assistant-1"]);
    expect(result.every((m) => !("mcpPromptSnapshot" in (m.metadata ?? {})))).toBe(true);
  });

  test("drops raw rows whose snapshot field is present but malformed", () => {
    // Raw chat.jsonl rows bypass the oRPC sanitizer, so the request-side
    // filter must treat a present-but-invalid field as corruption.
    const corruptRow = (id: string, snapshotValue: unknown): MuxMessage => {
      const message = createMuxMessage(id, "user", "Expanded review", {
        historySequence: 0,
        synthetic: true,
      });
      (message.metadata as Record<string, unknown>).mcpPromptSnapshot = snapshotValue;
      return message;
    };
    const messages = [
      corruptRow("mcp-prompt-snapshot-1-null", null),
      corruptRow("mcp-prompt-snapshot-2-shape", { serverName: 42, promptName: "review" }),
      snapshot("snap-valid", "user-1"),
      invokingUser("user-1", ["review"]),
    ];
    expect(filterOrphanedMcpPromptSnapshots(messages).map((m) => m.id)).toEqual([
      "snap-valid",
      "user-1",
    ]);
  });

  test("keeps multiple snapshots correlated to the same turn", () => {
    const messages = [
      snapshot("snap-1", "user-1", "review"),
      snapshot("snap-2", "user-1", "status"),
      invokingUser("user-1", ["review", "status"]),
    ];
    expect(filterOrphanedMcpPromptSnapshots(messages)).toEqual(messages);
  });
});

describe("sanitizeMcpPromptRefs arguments", () => {
  const baseRef = {
    serverName: "coder",
    promptName: "review",
    commandKey: "mcp__coder__review",
    source: "slash" as const,
  };

  test("keeps a valid string-record arguments field", () => {
    const refs = sanitizeMcpPromptRefs([{ ...baseRef, arguments: { path: "src" } }]);
    expect(refs).toEqual([{ ...baseRef, arguments: { path: "src" } }]);
  });

  test("drops malformed arguments but keeps the reference identity", () => {
    const malformedArgumentsValues: unknown[] = ["path", { path: 1 }, [1], 42, null];

    for (const malformed of malformedArgumentsValues) {
      const refs = sanitizeMcpPromptRefs([{ ...baseRef, arguments: malformed }]);
      expect(refs).toEqual([baseRef]);
    }
  });

  test("drops references with empty or invalid identity strings", () => {
    const invalidIdentities: unknown[] = [
      { serverName: "", promptName: "", commandKey: "", source: "slash" },
      { ...baseRef, serverName: "" },
      { ...baseRef, promptName: "" },
      { ...baseRef, commandKey: "not-an-mcp-key" },
    ];
    expect(sanitizeMcpPromptRefs(invalidIdentities)).toEqual([]);
    expect(sanitizeMcpPromptRefs([baseRef])).toEqual([baseRef]);
  });
});

import { describe, expect, it } from "bun:test";
import {
  collectRejectedTurnRowIds,
  createMuxMessage,
  excludeRejectedTurnRows,
  filterPreStreamRejectedRows,
  findUnansweredRoutedTurnRow,
} from "./message";

describe("collectRejectedTurnRowIds", () => {
  const rows = [
    createMuxMessage("u-earlier", "user", "earlier prompt", { timestamp: 1 }),
    createMuxMessage("snap-skill", "user", "skill body", {
      timestamp: 2,
      synthetic: true,
      agentSkillSnapshot: { skillName: "done", scope: "project", sha256: "x" },
    }),
    createMuxMessage("snap-mcp", "user", "prompt expansion", {
      timestamp: 3,
      synthetic: true,
      mcpPromptSnapshot: { serverName: "srv", promptName: "p", commandKey: "srv:p" },
    }),
    createMuxMessage("u-rejected", "user", "refused prompt", { timestamp: 4 }),
    createMuxMessage("a-later", "assistant", "later answer", { timestamp: 5 }),
    createMuxMessage("u-later", "user", "later prompt", { timestamp: 6 }),
  ];

  it("expands a turn key to its user row and the contiguous synthetic snapshot prefix", () => {
    // A durable repair record only names the user row; the repository content
    // rides the snapshot rows persisted immediately before it.
    expect([...collectRejectedTurnRowIds(rows, ["u-rejected"])].sort()).toEqual([
      "snap-mcp",
      "snap-skill",
      "u-rejected",
    ]);
  });

  it("stops at the first non-snapshot row and passes non-turn ids through unchanged", () => {
    // "u-later" is preceded by an assistant row: nothing to expand. Quarantined
    // assistant ids and already-truncated keys stay excluded as given.
    expect([...collectRejectedTurnRowIds(rows, ["u-later", "a-later", "gone"])].sort()).toEqual([
      "a-later",
      "gone",
      "u-later",
    ]);
  });
});

describe("excludeRejectedTurnRows", () => {
  it("drops stamped turns (unstamped snapshot prefix included) and quarantined turns", () => {
    // A side channel must see neither the refused prompts nor the repository
    // content that rode in with them — whether the turn's stamp landed only on
    // its user row or never landed at all (quarantined key).
    const rows = [
      createMuxMessage("snap-stamped-turn", "user", "project skill body", {
        timestamp: 1,
        synthetic: true,
        agentSkillSnapshot: { skillName: "done", scope: "project", sha256: "x" },
      }),
      createMuxMessage("u-stamped", "user", "refused prompt", {
        timestamp: 2,
        preStreamRejected: true,
      }),
      createMuxMessage("a-kept", "assistant", "kept answer", { timestamp: 3 }),
      createMuxMessage("snap-quarantined-turn", "user", "prompt expansion", {
        timestamp: 4,
        synthetic: true,
        mcpPromptSnapshot: { serverName: "srv", promptName: "p", commandKey: "srv:p" },
      }),
      createMuxMessage("u-quarantined", "user", "unstamped refusal", { timestamp: 5 }),
      createMuxMessage("u-kept", "user", "later prompt", { timestamp: 6 }),
    ];
    expect(excludeRejectedTurnRows(rows, ["u-quarantined"]).map((row) => row.id)).toEqual([
      "a-kept",
      "u-kept",
    ]);
  });
});

describe("filterPreStreamRejectedRows", () => {
  it("drops every stamped row, assistant partials included", () => {
    // A refused turn's surviving partial can be committed as an assistant row
    // (a fork commits the source's partial) and stamped there; its tool output
    // can hold the refused project content, so the stamp must exclude it from
    // requests regardless of role.
    const rows = [
      createMuxMessage("u-kept", "user", "kept prompt", { timestamp: 1 }),
      createMuxMessage("a-stamped", "assistant", "refused partial output", {
        timestamp: 2,
        preStreamRejected: true,
      }),
      createMuxMessage("u-stamped", "user", "refused prompt", {
        timestamp: 3,
        preStreamRejected: true,
      }),
      createMuxMessage("a-kept", "assistant", "kept answer", { timestamp: 4 }),
    ];
    expect(filterPreStreamRejectedRows(rows).map((row) => row.id)).toEqual(["u-kept", "a-kept"]);
    expect(excludeRejectedTurnRows(rows, []).map((row) => row.id)).toEqual(["u-kept", "a-kept"]);
  });
});

describe("findUnansweredRoutedTurnRow", () => {
  const routedRetry = {
    model: "anthropic:claude-haiku-4-5",
    agentId: "exec",
    routedProjectConsent: true,
  };

  it("looks past synthetic notification rows appended after the routed user row", () => {
    // A stream appends a <system-file-update> notification (synthetic user row)
    // after the turn's own user row; it must not read as a newer, unrouted turn.
    const rows = [
      createMuxMessage("u-routed", "user", "Use skill done", {
        timestamp: 1,
        retrySendOptions: routedRetry,
      }),
      createMuxMessage(
        "sys-file-update",
        "user",
        "<system-file-update>x changed</system-file-update>",
        {
          timestamp: 2,
          synthetic: true,
        }
      ),
    ];
    expect(findUnansweredRoutedTurnRow(rows)?.id).toBe("u-routed");
    // A committed reply settles it.
    expect(
      findUnansweredRoutedTurnRow([
        ...rows,
        createMuxMessage("a-routed", "assistant", "done", { timestamp: 3 }),
      ])
    ).toBeUndefined();
  });

  it("is not settled by an interrupted partial or a failed reply", () => {
    // A Retry replays the turn in both cases, and a routed turn's consent gate
    // can refuse it then; only a reply that ran to completion settles it.
    const routed = createMuxMessage("u-routed", "user", "Use skill done", {
      timestamp: 1,
      retrySendOptions: routedRetry,
    });
    expect(
      findUnansweredRoutedTurnRow([
        routed,
        createMuxMessage("a-interrupted", "assistant", "partial output", {
          timestamp: 2,
          partial: true,
        }),
      ])?.id
    ).toBe("u-routed");
    expect(
      findUnansweredRoutedTurnRow([
        routed,
        createMuxMessage("a-failed", "assistant", "some output", {
          timestamp: 2,
          error: "provider exploded",
        }),
      ])?.id
    ).toBe("u-routed");
    expect(
      findUnansweredRoutedTurnRow([
        routed,
        createMuxMessage("a-done", "assistant", "finished", { timestamp: 2 }),
      ])
    ).toBeUndefined();
  });

  it("treats a synthetic compaction request as the turn it is", () => {
    // Synthetic rows that START a turn carry retry options like any resumable
    // turn and are found; an unrouted latest turn yields nothing.
    const rows = [
      createMuxMessage("u-plain", "user", "plain prompt", { timestamp: 1 }),
      createMuxMessage("compact-request", "user", "Summarize", {
        timestamp: 2,
        synthetic: true,
        retrySendOptions: routedRetry,
      }),
    ];
    expect(findUnansweredRoutedTurnRow(rows)?.id).toBe("compact-request");
    expect(
      findUnansweredRoutedTurnRow([
        createMuxMessage("u-unrouted", "user", "plain", {
          timestamp: 3,
          retrySendOptions: { model: "anthropic:claude-haiku-4-5", agentId: "exec" },
        }),
      ])
    ).toBeUndefined();
  });
});

import { describe, expect, it } from "bun:test";

import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { renderAgentSkillSnapshotText } from "@/common/utils/agentSkills/skillSnapshot";

import {
  COMPACTION_SUMMARY_WITHHELD_MESSAGE,
  extractLoadedSkillSnapshotsFromMessages,
  PROJECT_SKILL_CONTENT_WITHHELD_MESSAGE,
  PROJECT_SKILL_TEXT_WITHHELD_MESSAGE,
  PROJECT_SKILL_TURN_WITHHELD_MESSAGE,
  withholdProjectSkillContentFromRequest,
  redactProjectSkillToolResults,
  rowCarriesProjectSkillContent,
  messagesCarryProjectSkillContent,
} from "./loadedSkillSnapshots";

function createAgentSkillReadToolMessage(args: {
  id: string;
  skillName: string;
  body: string;
  scope?: "project" | "global" | "built-in";
}): MuxMessage {
  const scope = args.scope ?? "project";
  return {
    id: args.id,
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolCallId: `tool-${args.id}`,
        toolName: "agent_skill_read",
        state: "output-available",
        input: { name: args.skillName },
        output: {
          success: true,
          skill: {
            scope,
            directoryName: args.skillName,
            frontmatter: {
              name: args.skillName,
              description: `${args.skillName} description`,
            },
            body: args.body,
          },
        },
      },
    ],
    metadata: {
      timestamp: Date.now(),
    },
  };
}

function createSyntheticSkillSnapshotMessage(args: {
  id: string;
  skillName: string;
  body: string;
  scope?: "project" | "global" | "built-in";
}): MuxMessage {
  const scope = args.scope ?? "project";
  return createMuxMessage(
    args.id,
    "user",
    renderAgentSkillSnapshotText({
      name: args.skillName,
      scope,
      body: args.body,
    }),
    {
      synthetic: true,
      agentSkillSnapshot: {
        skillName: args.skillName,
        scope,
        sha256: `${args.id}-sha`,
        frontmatterYaml: `name: ${args.skillName}\ndescription: ${args.skillName} description`,
      },
    }
  );
}

describe("extractLoadedSkillSnapshotsFromMessages", () => {
  it("extracts snapshots from nested agent_skill_read records inside code_execution", () => {
    // Exclusive PTC: skill reads happen as nested xum.agent_skill_read calls,
    // so the snapshot must be recovered from the code_execution record.
    const nestedMessage: MuxMessage = {
      id: "nested",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "tool-nested",
          toolName: "code_execution",
          state: "output-available",
          input: { code: "..." },
          output: {
            success: true,
            toolCalls: [
              {
                toolName: "agent_skill_read",
                args: { name: "nested-skill" },
                result: {
                  success: true,
                  skill: {
                    scope: "project",
                    directoryName: "nested-skill",
                    frontmatter: { name: "nested-skill", description: "nested description" },
                    body: "Nested body",
                  },
                },
              },
              // Failed and kernel-compacted records (no full result) yield nothing.
              { toolName: "agent_skill_read", args: { name: "failed-skill" }, error: "denied" },
              { toolName: "agent_skill_read", args: { name: "kernel-skill" }, ok: true, bytes: 9 },
              // Contradictory untrusted row: explicit ok:false is authoritative
              // failure even when a schema-valid result rides alongside (r18).
              {
                toolName: "agent_skill_read",
                args: { name: "contradictory-skill" },
                ok: false,
                result: {
                  success: true,
                  skill: {
                    scope: "project",
                    directoryName: "contradictory-skill",
                    frontmatter: {
                      name: "contradictory-skill",
                      description: "contradictory description",
                    },
                    body: "Contradictory body",
                  },
                },
              },
              { toolName: "bash", args: { script: "true" }, result: { success: true } },
            ],
          },
        },
      ],
    };

    const snapshots = extractLoadedSkillSnapshotsFromMessages([nestedMessage]);
    expect(snapshots.map((snapshot) => snapshot.name)).toEqual(["nested-skill"]);
    expect(snapshots[0].body).toContain("Nested body");
  });

  it("dedupes by scope/name and keeps the latest read order", () => {
    const snapshots = extractLoadedSkillSnapshotsFromMessages([
      createAgentSkillReadToolMessage({
        id: "alpha-old",
        skillName: "alpha-skill",
        body: "Old alpha body",
      }),
      createAgentSkillReadToolMessage({
        id: "beta",
        skillName: "beta-skill",
        body: "Beta body",
        scope: "global",
      }),
      createAgentSkillReadToolMessage({
        id: "alpha-new",
        skillName: "alpha-skill",
        body: "New alpha body",
      }),
    ]);

    expect(snapshots.map((snapshot) => `${snapshot.scope}:${snapshot.name}`)).toEqual([
      "global:beta-skill",
      "project:alpha-skill",
    ]);
    expect(snapshots[1]?.body).toContain("New alpha body");
  });

  it("falls back to synthetic slash-command snapshots when no tool output exists", () => {
    const snapshots = extractLoadedSkillSnapshotsFromMessages([
      createSyntheticSkillSnapshotMessage({
        id: "slash-react-effects",
        skillName: "react-effects",
        body: "Avoid unnecessary useEffect calls.",
      }),
    ]);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.name).toBe("react-effects");
    expect(snapshots[0]?.body).toContain("Avoid unnecessary useEffect calls.");
    expect(snapshots[0]?.sha256).toBeTruthy();
  });

  it("lets a later agent_skill_read output override an earlier synthetic snapshot", () => {
    const snapshots = extractLoadedSkillSnapshotsFromMessages([
      createSyntheticSkillSnapshotMessage({
        id: "slash-test-skill",
        skillName: "test-skill",
        body: "Old synthetic body",
      }),
      createAgentSkillReadToolMessage({
        id: "tool-test-skill",
        skillName: "test-skill",
        body: "New tool body",
      }),
    ]);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.body).toContain("New tool body");
  });
});

describe("project skill content in persisted tool results", () => {
  function nestedRecordsMessage(records: unknown[]): MuxMessage {
    return {
      id: "nested",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "tool-nested",
          toolName: "code_execution",
          state: "output-available",
          input: { code: "..." },
          output: { success: true, toolCalls: records },
        },
      ],
    };
  }
  const projectResult = (name: string, body: string) => ({
    success: true,
    skill: {
      scope: "project",
      directoryName: name,
      frontmatter: { name, description: `${name} description` },
      body,
    },
  });

  it("counts a retained project skill even when the nested record is marked failed", () => {
    // The snapshot extractor drops a contradictory `ok: false` record as a
    // failed call; the confidentiality scan must not — the retained body
    // would still leave for the class provider.
    const message = nestedRecordsMessage([
      {
        toolName: "agent_skill_read",
        args: { name: "contradictory-skill" },
        ok: false,
        result: projectResult("contradictory-skill", "Contradictory body"),
      },
    ]);
    expect(extractLoadedSkillSnapshotsFromMessages([message])).toHaveLength(0);
    expect(rowCarriesProjectSkillContent(message)).toBe(true);

    const [redacted] = redactProjectSkillToolResults([message]);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("Contradictory body");
    expect(serialized).toContain(PROJECT_SKILL_CONTENT_WITHHELD_MESSAGE);
    // The redaction copies; history rows are untouched.
    expect(JSON.stringify(message)).toContain("Contradictory body");
  });

  it("ignores global skills and non-skill tool results, and keeps them intact", () => {
    const message: MuxMessage = {
      ...createAgentSkillReadToolMessage({
        id: "global-read",
        skillName: "team-style",
        body: "Global body",
        scope: "global",
      }),
    };
    const bashOnly = nestedRecordsMessage([
      { toolName: "bash", args: { script: "true" }, result: { success: true } },
    ]);
    expect(rowCarriesProjectSkillContent(message)).toBe(false);
    expect(rowCarriesProjectSkillContent(bashOnly)).toBe(false);
    expect(redactProjectSkillToolResults([message, bashOnly])).toEqual([message, bashOnly]);
  });

  it("detects direct project results and synthetic snapshot rows alike", () => {
    const direct = createAgentSkillReadToolMessage({
      id: "direct-read",
      skillName: "repo-conventions",
      body: "Direct body",
    });
    const synthetic = createSyntheticSkillSnapshotMessage({
      id: "synthetic",
      skillName: "repo-conventions",
      body: "Synthetic body",
    });
    expect(rowCarriesProjectSkillContent(direct)).toBe(true);
    expect(rowCarriesProjectSkillContent(synthetic)).toBe(true);
    const [redactedDirect] = redactProjectSkillToolResults([direct]);
    expect(JSON.stringify(redactedDirect)).not.toContain("Direct body");
    expect(rowCarriesProjectSkillContent(redactedDirect)).toBe(false);
  });

  it("treats a provenance-stamped compaction summary as project content and withholds its text", () => {
    // The summary is ordinary assistant text that may quote a project skill a
    // summarized turn loaded; only the stamp identifies it. The request copy
    // withholds the text but keeps the row — it marks the context boundary.
    const stamped = createMuxMessage("summary", "assistant", "Summary quoting the PROJECT BODY", {
      compacted: "user",
      compactionBoundary: true,
      carriesProjectSkillContent: true,
    });
    const plain = createMuxMessage("summary-plain", "assistant", "Summary of ordinary chat", {
      compacted: "user",
      compactionBoundary: true,
      carriesProjectSkillContent: false,
    });
    expect(rowCarriesProjectSkillContent(stamped)).toBe(true);
    expect(rowCarriesProjectSkillContent(plain)).toBe(false);
    const [redacted, untouched] = redactProjectSkillToolResults([stamped, plain]);
    expect(JSON.stringify(redacted)).not.toContain("PROJECT BODY");
    expect(JSON.stringify(redacted)).toContain(COMPACTION_SUMMARY_WITHHELD_MESSAGE);
    expect(redacted.metadata).toEqual(stamped.metadata);
    expect(untouched).toBe(plain);
  });

  it("withholds the prose of a row whose project skill output was withheld", () => {
    // The stream persists the tool result and the prose that follows it in one
    // assistant row, and the prose can be the model's copy of the output.
    const tainted = createAgentSkillReadToolMessage({
      id: "tainted",
      skillName: "repo-conventions",
      body: "PROJECT BODY",
    });
    tainted.parts = [
      { type: "reasoning", text: "I will quote the PROJECT BODY" },
      ...tainted.parts,
      { type: "text", text: "Here it is verbatim: PROJECT BODY" },
    ];
    const clean = createMuxMessage("clean", "assistant", "Unrelated prose stays", {
      timestamp: 2,
    });
    const [redacted, untouched] = redactProjectSkillToolResults([tainted, clean]);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("PROJECT BODY");
    expect(serialized).toContain(PROJECT_SKILL_TEXT_WITHHELD_MESSAGE);
    expect(redacted.parts.some((part) => part.type === "reasoning")).toBe(false);
    // The tool call/result pairing the provider requires survives.
    expect(redacted.parts.some((part) => part.type === "dynamic-tool")).toBe(true);
    expect(untouched).toBe(clean);
  });

  it("treats a legacy result-less nested skill-file read as project content unless it failed", () => {
    // Pre-stamp kernel-mode history compacted nested agent_skill_read_file
    // records to {toolName, ok, bytes}: the content may have been copied into
    // the outer result or console and its scope is unknown. A failed call
    // retained nothing.
    const legacy = (record: Record<string, unknown>) =>
      nestedRecordsMessage([
        { toolName: "agent_skill_read_file", args: { name: "repo" }, ...record },
      ]);
    expect(rowCarriesProjectSkillContent(legacy({ ok: true, bytes: 120 }))).toBe(true);
    expect(rowCarriesProjectSkillContent(legacy({ bytes: 120 }))).toBe(true);
    expect(rowCarriesProjectSkillContent(legacy({ ok: false, bytes: 0 }))).toBe(false);
    expect(rowCarriesProjectSkillContent(legacy({ error: "denied" }))).toBe(false);
    // A retained global result is still recognized as clean.
    expect(
      rowCarriesProjectSkillContent(
        legacy({ result: { success: true, skillScope: "global", content: "x" } })
      )
    ).toBe(false);
    const [redacted] = redactProjectSkillToolResults([legacy({ ok: true, bytes: 120 })]);
    expect(JSON.stringify(redacted)).toContain(PROJECT_SKILL_CONTENT_WITHHELD_MESSAGE);
  });

  it("withholds a tainted code_execution output whole, stamped or nested", () => {
    // The guest can copy a nested project skill result into the return value
    // or console output, and kernel-mode compaction can drop the nested record
    // itself: the execution's provenance stamp classifies the output, and the
    // redaction replaces it whole (shape kept, pairing intact).
    const codeExecutionRow = (output: Record<string, unknown>): MuxMessage => ({
      id: "exec",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "tool-exec",
          toolName: "code_execution",
          state: "output-available",
          input: { code: "..." },
          output,
        },
      ],
    });
    const stampedOnly = codeExecutionRow({
      success: true,
      result: "copied: PROJECT BODY",
      consoleOutput: [{ level: "log", args: ["PROJECT BODY again"], timestamp: 1 }],
      toolCalls: [],
      duration_ms: 3,
      carriesProjectSkillContent: true,
    });
    const nestedWithCopy = codeExecutionRow({
      success: true,
      result: "copied: PROJECT BODY",
      toolCalls: [
        {
          toolName: "agent_skill_read",
          args: { name: "repo-conventions" },
          result: projectResult("repo-conventions", "PROJECT BODY"),
        },
      ],
      consoleOutput: [],
      duration_ms: 3,
    });
    const clean = codeExecutionRow({
      success: true,
      result: "plain",
      toolCalls: [],
      consoleOutput: [],
      duration_ms: 1,
    });
    expect(rowCarriesProjectSkillContent(stampedOnly)).toBe(true);
    expect(rowCarriesProjectSkillContent(nestedWithCopy)).toBe(true);
    expect(rowCarriesProjectSkillContent(clean)).toBe(false);
    for (const tainted of [stampedOnly, nestedWithCopy]) {
      const [redacted] = redactProjectSkillToolResults([tainted]);
      const serialized = JSON.stringify(redacted);
      expect(serialized).not.toContain("PROJECT BODY");
      expect(serialized).toContain(PROJECT_SKILL_CONTENT_WITHHELD_MESSAGE);
      const part = redacted.parts[0];
      expect(part.type === "dynamic-tool" && part.toolCallId).toBe("tool-exec");
      // Still classified after redaction, so a later scan agrees.
      expect(rowCarriesProjectSkillContent(redacted)).toBe(true);
    }
    expect(redactProjectSkillToolResults([clean])[0]).toBe(clean);
  });

  it("withholds the assistant rows of a project skill invocation's turn along with its snapshot", () => {
    // A slash-skill snapshot is its own user row; the reply to that turn can
    // quote it in prose, tool arguments or tool results. Dropping the snapshot
    // alone would leave the copies, so the whole turn's assistant rows go.
    const rows: MuxMessage[] = [
      createSyntheticSkillSnapshotMessage({
        id: "snap-project",
        skillName: "repo-conventions",
        body: "PROJECT BODY",
      }),
      createMuxMessage("u-invoke", "user", "Use skill repo-conventions", { timestamp: 1 }),
      {
        id: "a-reply",
        role: "assistant",
        parts: [
          { type: "text", text: "Applying: PROJECT BODY" },
          {
            type: "dynamic-tool",
            toolCallId: "edit-1",
            toolName: "file_edit_replace_string",
            state: "output-available",
            input: { path: "x", new_string: "PROJECT BODY" },
            output: { success: true },
          },
        ],
      },
      createMuxMessage("u-next", "user", "Now something else", { timestamp: 2 }),
      // The follow-up's request still carried the snapshot in context, so its
      // reply can restate the skill: withheld as well.
      createMuxMessage("a-next", "assistant", "Follow-up reply also goes", { timestamp: 3 }),
    ];
    const withheld = withholdProjectSkillContentFromRequest(rows);
    expect(withheld.map((row) => row.id)).toEqual(["u-invoke", "a-reply", "u-next", "a-next"]);
    const serialized = JSON.stringify(withheld);
    expect(serialized).not.toContain("PROJECT BODY");
    expect(serialized).not.toContain("Follow-up reply also goes");
    expect(serialized).toContain(PROJECT_SKILL_TURN_WITHHELD_MESSAGE);
    // History rows are untouched; a global snapshot's turn is left alone.
    expect(JSON.stringify(rows)).toContain("PROJECT BODY");
    const globalTurn = withholdProjectSkillContentFromRequest([
      createSyntheticSkillSnapshotMessage({
        id: "snap-global",
        skillName: "team-style",
        body: "GLOBAL BODY",
        scope: "global",
      }),
      createMuxMessage("u-global", "user", "Use skill team-style", { timestamp: 4 }),
      createMuxMessage("a-global", "assistant", "Applying: GLOBAL BODY", { timestamp: 5 }),
    ]);
    expect(JSON.stringify(globalTurn)).toContain("Applying: GLOBAL BODY");
    expect(globalTurn).toHaveLength(3);
  });

  it("keeps the project turn's taint across a synthetic notification row", () => {
    // A <system-file-update> notification (synthetic user row) can sit between
    // the invoking user row and its reply; it is part of the turn, not a new
    // one, so the reply stays withheld.
    const withheld = withholdProjectSkillContentFromRequest([
      createSyntheticSkillSnapshotMessage({
        id: "snap-project",
        skillName: "repo-conventions",
        body: "PROJECT BODY",
      }),
      createMuxMessage("u-invoke", "user", "Use skill repo-conventions", { timestamp: 1 }),
      createMuxMessage(
        "sys-file-update",
        "user",
        "<system-file-update>x.ts changed</system-file-update>",
        { timestamp: 2, synthetic: true }
      ),
      createMuxMessage("a-reply", "assistant", "Applying: PROJECT BODY", { timestamp: 3 }),
      createMuxMessage("u-next", "user", "Next", { timestamp: 4 }),
      createMuxMessage("a-next", "assistant", "Follow-up reply also goes", { timestamp: 5 }),
    ]);
    const serialized = JSON.stringify(withheld);
    expect(serialized).not.toContain("PROJECT BODY");
    expect(serialized).toContain(PROJECT_SKILL_TURN_WITHHELD_MESSAGE);
    expect(serialized).not.toContain("Follow-up reply also goes");
    expect(withheld.map((row) => row.id)).toEqual([
      "u-invoke",
      "sys-file-update",
      "a-reply",
      "u-next",
      "a-next",
    ]);
  });

  it("withholds the reply of a repeated project skill invocation whose snapshot deduplicated", () => {
    // A second invocation of the same project skill persists no snapshot row
    // (recent-snapshot dedupe), so the invoking row's own skill metadata marks
    // the turn; its reply can quote the reused skill just as well.
    const withheld = withholdProjectSkillContentFromRequest([
      createSyntheticSkillSnapshotMessage({
        id: "snap-first",
        skillName: "repo-conventions",
        body: "PROJECT BODY",
      }),
      createMuxMessage("u-first", "user", "Use skill repo-conventions", {
        timestamp: 1,
        muxMetadata: {
          type: "agent-skill",
          rawCommand: "/repo-conventions",
          skillName: "repo-conventions",
          scope: "project",
        },
      }),
      createMuxMessage("a-first", "assistant", "Applying: PROJECT BODY", { timestamp: 2 }),
      createMuxMessage("u-second", "user", "Use skill repo-conventions again", {
        timestamp: 3,
        muxMetadata: {
          type: "agent-skill",
          rawCommand: "/repo-conventions",
          skillName: "repo-conventions",
          scope: "project",
        },
      }),
      createMuxMessage("a-second", "assistant", "Again: PROJECT BODY", { timestamp: 4 }),
      createMuxMessage("u-plain", "user", "Something else", { timestamp: 5 }),
      createMuxMessage("a-plain", "assistant", "Follow-up reply also goes", { timestamp: 6 }),
    ]);
    const serialized = JSON.stringify(withheld);
    expect(serialized).not.toContain("PROJECT BODY");
    expect(serialized).not.toContain("Follow-up reply also goes");
    expect(withheld.map((row) => row.id)).toEqual([
      "u-first",
      "a-first",
      "u-second",
      "a-second",
      "u-plain",
      "a-plain",
    ]);
  });

  it("withholds every assistant row generated after project content entered the segment", () => {
    // Rows BEFORE the project content stay (their requests never carried it);
    // a project skill read through a tool taints the segment from that row on,
    // so an ordinary later turn's reply — which could summarize the still
    // present instructions — is withheld too. A global-only segment is untouched.
    const before = createMuxMessage("a-before", "assistant", "Earlier reply stays", {
      timestamp: 1,
    });
    const read = createAgentSkillReadToolMessage({
      id: "a-read",
      skillName: "repo-conventions",
      body: "PROJECT BODY",
    });
    const rows: MuxMessage[] = [
      createMuxMessage("u-before", "user", "Hello", { timestamp: 0 }),
      before,
      createMuxMessage("u-read", "user", "Read the conventions", { timestamp: 2 }),
      read,
      createMuxMessage("u-after", "user", "Summarize what you know", { timestamp: 3 }),
      createMuxMessage("a-after", "assistant", "Summary: PROJECT BODY", { timestamp: 4 }),
    ];
    const withheld = withholdProjectSkillContentFromRequest(rows);
    expect(withheld[1]).toBe(before);
    const serialized = JSON.stringify(withheld);
    expect(serialized).toContain("Earlier reply stays");
    expect(serialized).not.toContain("PROJECT BODY");
    expect(serialized).toContain(PROJECT_SKILL_TURN_WITHHELD_MESSAGE);
    const globalOnly = [
      createSyntheticSkillSnapshotMessage({
        id: "snap-global",
        skillName: "team-style",
        body: "GLOBAL BODY",
        scope: "global",
      }),
      createMuxMessage("u-global", "user", "Use skill team-style", { timestamp: 5 }),
      createMuxMessage("a-global", "assistant", "Applying: GLOBAL BODY", { timestamp: 6 }),
      createMuxMessage("u-later", "user", "Later", { timestamp: 7 }),
      createMuxMessage("a-later", "assistant", "Later reply stays", { timestamp: 8 }),
    ];
    expect(JSON.stringify(withholdProjectSkillContentFromRequest(globalOnly))).toContain(
      "Later reply stays"
    );
  });

  it("withholds sibling tool calls of a tainted assistant row", () => {
    // The step that read the project skill can invoke another tool with the
    // copied content in its arguments (or get it back in the result); both
    // calls persist in one row. Every non-skill tool part of a tainted row
    // loses its input and output; ids keep the call/result pairing.
    const tainted = createAgentSkillReadToolMessage({
      id: "tainted",
      skillName: "repo-conventions",
      body: "PROJECT BODY",
    });
    tainted.parts = [
      ...tainted.parts,
      {
        type: "dynamic-tool",
        toolCallId: "edit-1",
        toolName: "file_edit_replace_string",
        state: "output-available",
        input: { path: "x", new_string: "PROJECT BODY" },
        output: { success: true, echoed: "PROJECT BODY" },
      },
      // A sibling code_execution with NO nested skill read of its own: the
      // guest code, return value and console can all hold the copy.
      {
        type: "dynamic-tool",
        toolCallId: "exec-1",
        toolName: "code_execution",
        state: "output-available",
        input: { code: "print('PROJECT BODY')" },
        output: {
          success: true,
          result: "PROJECT BODY",
          toolCalls: [],
          consoleOutput: ["PROJECT BODY"],
          duration_ms: 3,
        },
      },
    ];
    const [redacted] = redactProjectSkillToolResults([tainted]);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("PROJECT BODY");
    const sibling = redacted.parts.find(
      (part) => part.type === "dynamic-tool" && part.toolCallId === "edit-1"
    );
    expect(sibling?.type === "dynamic-tool" && sibling.toolName).toBe("file_edit_replace_string");
    const execution = redacted.parts.find(
      (part) => part.type === "dynamic-tool" && part.toolCallId === "exec-1"
    );
    expect(execution?.type === "dynamic-tool" && execution.toolName).toBe("code_execution");
    expect(
      execution?.type === "dynamic-tool" &&
        execution.state === "output-available" &&
        (execution.output as { success?: unknown }).success
    ).toBe(false);
  });

  it("counts a deduplicated project skill invocation as project provenance", () => {
    // The repeated invocation persisted no snapshot row of its own, yet its
    // reply can quote the skill: summaries distilled from the turn (and the
    // routed request scan) must classify it like the withholding tracker does.
    const invocation = (id: string, scope: "project" | "global", timestamp: number) =>
      createMuxMessage(id, "user", "Using skill repo-conventions", {
        timestamp,
        muxMetadata: {
          type: "agent-skill",
          rawCommand: "/repo-conventions",
          skillName: "repo-conventions",
          scope,
        },
      });
    const reply = createMuxMessage("a-dedup", "assistant", "Applying the conventions", {
      timestamp: 2,
    });
    expect(rowCarriesProjectSkillContent(invocation("u-project", "project", 1))).toBe(false);
    expect(messagesCarryProjectSkillContent([invocation("u-project", "project", 1), reply])).toBe(
      true
    );
    expect(messagesCarryProjectSkillContent([invocation("u-global", "global", 3), reply])).toBe(
      false
    );
  });

  it("treats an unstamped legacy summary as project content, a summary stamped clean as clean", () => {
    // Summaries persisted before provenance was tracked have no stamp; their
    // text may quote a project skill, so across the trust boundary they are
    // unknown and withheld like a stamped one. Compaction and branch summaries
    // alike.
    const legacyCompaction = createMuxMessage("legacy-compaction", "assistant", "Older summary", {
      compacted: "user",
      compactionBoundary: true,
    });
    const legacyBranch = createMuxMessage("legacy-branch", "assistant", "Branch summary text", {
      synthetic: true,
      muxMetadata: { type: "branch-summary" },
    });
    const cleanBranch = createMuxMessage("clean-branch", "assistant", "Branch summary text", {
      synthetic: true,
      carriesProjectSkillContent: false,
      muxMetadata: { type: "branch-summary" },
    });
    // /refine's proposal and audit rows are summaries of the distilled
    // transcript too: markerless (legacy) ones are unknown, stamped ones tell.
    const legacyRefine = createMuxMessage("legacy-refine", "assistant", "Refine summary text", {
      synthetic: true,
      muxMetadata: { type: "refine-summary" },
    });
    const cleanRefine = createMuxMessage("clean-refine", "assistant", "Refine summary text", {
      synthetic: true,
      carriesProjectSkillContent: false,
      muxMetadata: { type: "refine-summary" },
    });
    const ordinary = createMuxMessage("ordinary", "assistant", "Just an answer", { timestamp: 1 });
    expect(rowCarriesProjectSkillContent(legacyCompaction)).toBe(true);
    expect(rowCarriesProjectSkillContent(legacyBranch)).toBe(true);
    expect(rowCarriesProjectSkillContent(cleanBranch)).toBe(false);
    expect(rowCarriesProjectSkillContent(legacyRefine)).toBe(true);
    expect(rowCarriesProjectSkillContent(cleanRefine)).toBe(false);
    expect(rowCarriesProjectSkillContent(ordinary)).toBe(false);
    const redacted = redactProjectSkillToolResults([legacyCompaction, legacyBranch, cleanBranch]);
    expect(JSON.stringify(redacted[0])).not.toContain("Older summary");
    expect(JSON.stringify(redacted[1])).not.toContain("Branch summary text");
    expect(redacted[2]).toBe(cleanBranch);
  });

  function skillFileReadMessage(id: string, result: Record<string, unknown>): MuxMessage {
    return {
      id,
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: `tool-${id}`,
          toolName: "agent_skill_read_file",
          state: "output-available",
          input: { name: "repo-conventions", filePath: "references/style.md" },
          output: result,
        },
      ],
    };
  }

  it("treats a project skill's referenced file (and an untagged legacy read) as project content", () => {
    // agent_skill_read_file persists arbitrary referenced-file content; the
    // skill's scope rides on the result so the scan can tell it apart.
    // Results written before the tag existed carry no provenance and fail closed.
    const projectFile = skillFileReadMessage("project-file", {
      success: true,
      file_size: 12,
      modifiedTime: "2026-01-01T00:00:00.000Z",
      lines_read: 1,
      content: "1\tPROJECT FILE BODY",
      skillScope: "project",
    });
    const legacyFile = skillFileReadMessage("legacy-file", {
      success: true,
      file_size: 11,
      modifiedTime: "2026-01-01T00:00:00.000Z",
      lines_read: 1,
      content: "1\tLEGACY BODY",
    });
    const globalFile = skillFileReadMessage("global-file", {
      success: true,
      file_size: 11,
      modifiedTime: "2026-01-01T00:00:00.000Z",
      lines_read: 1,
      content: "1\tGLOBAL BODY",
      skillScope: "global",
    });
    expect(rowCarriesProjectSkillContent(projectFile)).toBe(true);
    expect(rowCarriesProjectSkillContent(legacyFile)).toBe(true);
    expect(rowCarriesProjectSkillContent(globalFile)).toBe(false);

    const redacted = JSON.stringify(
      redactProjectSkillToolResults([projectFile, legacyFile, globalFile])
    );
    expect(redacted).not.toContain("PROJECT FILE BODY");
    expect(redacted).not.toContain("LEGACY BODY");
    expect(redacted).toContain("GLOBAL BODY");
  });
});

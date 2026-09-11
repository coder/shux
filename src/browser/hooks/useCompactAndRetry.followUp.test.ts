import { describe, expect, test } from "bun:test";
import { buildFollowUpFromSource } from "./useCompactAndRetry";
import type { DisplayedUserMessage } from "@/common/types/message";

function userMessage(overrides: Partial<DisplayedUserMessage>): DisplayedUserMessage {
  return {
    type: "user",
    id: "user-1",
    historyId: "user-1",
    content: "Fix the bug",
    historySequence: 1,
    ...overrides,
  };
}

describe("buildFollowUpFromSource", () => {
  test("rebuilds the transformed invocation text for a slash MCP prompt turn", () => {
    const followUp = buildFollowUpFromSource(
      userMessage({
        content: "/mcp__coder__review src security",
        mcpPromptRefs: [
          {
            serverName: "coder",
            promptName: "review",
            commandKey: "mcp__coder__review",
            source: "slash",
            arguments: { path: "src", focus: "security" },
          },
        ],
      })
    );

    expect(followUp.text).toBe("Using MCP prompt coder/review: src security");
    expect(followUp.muxMetadata?.mcpPromptRefs).toHaveLength(1);
    // Metadata keeps the follow-up row editable as the original slash invocation.
    const metadata = followUp.muxMetadata;
    if (metadata?.type !== "normal") throw new Error("expected normal metadata");
    expect(metadata.rawCommand).toBe("/mcp__coder__review src security");
    expect(metadata.commandPrefix).toBe("/mcp__coder__review");
  });

  test("rebuilds a slash MCP prompt turn whose content has leading whitespace", () => {
    const followUp = buildFollowUpFromSource(
      userMessage({
        content: "  /mcp__coder__review src security",
        mcpPromptRefs: [
          {
            serverName: "coder",
            promptName: "review",
            commandKey: "mcp__coder__review",
            source: "slash",
            arguments: { path: "src", focus: "security" },
          },
        ],
      })
    );

    expect(followUp.text).toBe("Using MCP prompt coder/review: src security");
    const metadata = followUp.muxMetadata;
    if (metadata?.type !== "normal") throw new Error("expected normal metadata");
    expect(metadata.rawCommand).toBe("  /mcp__coder__review src security");
  });

  test("keeps plain user content unchanged", () => {
    const followUp = buildFollowUpFromSource(userMessage({ content: "Fix the bug" }));
    expect(followUp.text).toBe("Fix the bug");
    expect(followUp.muxMetadata).toBeUndefined();
  });

  test("preserves inline skill refs alongside slash MCP prompt refs", () => {
    const followUp = buildFollowUpFromSource(
      userMessage({
        content: "/mcp__coder__review src",
        mcpPromptRefs: [
          {
            serverName: "coder",
            promptName: "review",
            commandKey: "mcp__coder__review",
            source: "slash",
          },
        ],
        agentSkillRefs: [{ skillName: "tdd", scope: "global", source: "inline" }],
        agentSkill: { skillName: "mcp__coder__review", scope: "built-in" },
      })
    );

    expect(followUp.muxMetadata?.mcpPromptRefs).toHaveLength(1);
    expect(followUp.muxMetadata?.agentSkillRefs).toEqual([
      { skillName: "tdd", scope: "global", source: "inline" },
    ]);
  });

  test("rebuilds the model-facing invocation text for a composed one-shot skill turn", () => {
    // dispatchPendingFollowUp sends text verbatim (no slash parsing): the
    // retry must stream the same payload the original send did, not the
    // displayed raw command — while the overrides and metadata survive.
    const followUp = buildFollowUpFromSource(
      userMessage({
        content: "/haiku+0 /done finish",
        commandPrefix: "/haiku+0 /done",
        agentSkill: { skillName: "done", scope: "global", arguments: "finish" },
        agentSkillRefs: [{ skillName: "done", scope: "global", source: "slash" }],
      })
    );

    expect(followUp.text).toBe("Using skill done: finish");
    // parseCommand canonicalizes the "haiku" alias.
    expect(followUp.model).toBe("anthropic:claude-haiku-4-5");
    expect(followUp.skipSkillModelRouting).toBe(true);
    // The raw numeric index rides along even with an explicit model: dispatch
    // resolves it against the model that actually streams (a provider mapping
    // can change during a long compaction); the level here is the fallback.
    expect(followUp.oneShotThinkingIndex).toBe(0);
    expect(followUp.thinkingLevel).toBe("off");
    expect(followUp.muxMetadata?.type).toBe("agent-skill");
    if (followUp.muxMetadata?.type === "agent-skill") {
      expect(followUp.muxMetadata.rawCommand).toBe("/haiku+0 /done finish");
      expect(followUp.muxMetadata.commandPrefix).toBe("/haiku+0 /done");
    }
  });

  test("keeps generated attached-files notices through the skill text rebuild", () => {
    // Staged attachments are deliberately absent from fileParts: dropping
    // the notice would silently lose the file and its workspace path. Only
    // the GENERATED notice format counts — an <attached-files> example
    // inside the user's own argument text is already restored by the
    // argument rebuild and must not be appended a second time.
    const generatedNotice =
      "<attached-files>\n" +
      "The user attached file(s) that were saved into the workspace filesystem. These are not native model attachments; use filesystem tools such as `bash`, `file_read`, or archive tools to inspect them if needed.\n" +
      "\n" +
      "- `data.csv` (`text/csv`, 12 B): `.xum/user-attachments/data.csv`\n" +
      "</attached-files>";
    const userExample = "<attached-files>not generated</attached-files>";
    const followUp = buildFollowUpFromSource(
      userMessage({
        content: `/done finish ${userExample}\n${generatedNotice}`,
        agentSkill: { skillName: "done", scope: "global", arguments: `finish ${userExample}` },
        agentSkillRefs: [{ skillName: "done", scope: "global", source: "slash" }],
      })
    );

    expect(followUp.text).toBe(`Using skill done: finish ${userExample}\n${generatedNotice}`);
  });

  test("rebuilds argument-less skill invocations with the bare form", () => {
    const followUp = buildFollowUpFromSource(
      userMessage({
        content: "/done",
        agentSkill: { skillName: "done", scope: "global", arguments: "" },
        agentSkillRefs: [{ skillName: "done", scope: "global", source: "slash" }],
      })
    );

    expect(followUp.text).toBe("Use skill done");
  });

  test("does not duplicate the slash skill ref when preserving displayed refs", () => {
    const followUp = buildFollowUpFromSource(
      userMessage({
        content: "/tdd strict",
        agentSkill: { skillName: "tdd", scope: "global", arguments: "strict" },
        agentSkillRefs: [{ skillName: "tdd", scope: "global", source: "slash" }],
      })
    );

    expect(followUp.muxMetadata?.type).toBe("agent-skill");
    expect(followUp.muxMetadata?.agentSkillRefs).toEqual([
      { skillName: "tdd", scope: "global", source: "slash" },
    ]);
  });

  test("keeps inline-only MCP prompt turns unchanged", () => {
    const followUp = buildFollowUpFromSource(
      userMessage({
        content: "Check $mcp__coder__review please",
        mcpPromptRefs: [
          {
            serverName: "coder",
            promptName: "review",
            commandKey: "mcp__coder__review",
            source: "inline",
          },
        ],
      })
    );
    expect(followUp.text).toBe("Check $mcp__coder__review please");
    expect(followUp.muxMetadata?.mcpPromptRefs).toHaveLength(1);
  });
});

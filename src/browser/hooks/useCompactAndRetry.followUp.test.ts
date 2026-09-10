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

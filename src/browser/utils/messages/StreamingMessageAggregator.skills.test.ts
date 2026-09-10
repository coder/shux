import { describe, expect, it } from "bun:test";
import type { AgentSkillScope } from "@/common/types/agentSkill";
import {
  createMuxMessage,
  type AgentSkillReference,
  type DisplayedUserMessage,
  type MCPPromptReference,
} from "@/common/types/message";
import { StreamingMessageAggregator } from "./StreamingMessageAggregator";

const TEST_CREATED_AT = "2024-01-01T00:00:00.000Z";
const WORKSPACE_ID = "test-workspace";

const createAggregator = () => new StreamingMessageAggregator(TEST_CREATED_AT);

const startStream = (aggregator: StreamingMessageAggregator, messageId = "msg-1") => {
  aggregator.handleStreamStart({
    type: "stream-start",
    workspaceId: WORKSPACE_ID,
    messageId,
    historySequence: 1,
    model: "test-model",
    startTime: 0,
  });
};

const emitSkillReadResult = (
  aggregator: StreamingMessageAggregator,
  {
    messageId = "msg-1",
    toolCallId,
    skillName,
    result,
  }: {
    messageId?: string;
    toolCallId: string;
    skillName: string;
    result: unknown;
  }
) => {
  aggregator.handleToolCallStart({
    type: "tool-call-start",
    workspaceId: WORKSPACE_ID,
    messageId,
    toolCallId,
    toolName: "agent_skill_read",
    args: { name: skillName },
    tokens: 10,
    timestamp: 0,
  });
  aggregator.handleToolCallEnd({
    type: "tool-call-end",
    workspaceId: WORKSPACE_ID,
    messageId,
    toolCallId,
    toolName: "agent_skill_read",
    result,
    timestamp: 0,
  });
};

const emitSuccessfulSkillRead = (
  aggregator: StreamingMessageAggregator,
  {
    messageId,
    toolCallId,
    skillName,
    description = "A skill",
    scope = "project",
  }: {
    messageId?: string;
    toolCallId: string;
    skillName: string;
    description?: string;
    scope?: AgentSkillScope;
  }
) => {
  emitSkillReadResult(aggregator, {
    messageId,
    toolCallId,
    skillName,
    result: {
      success: true,
      skill: {
        scope,
        directoryName: skillName,
        frontmatter: {
          name: skillName,
          description,
        },
        body: "# Content",
      },
    },
  });
};

const emitFailedSkillRead = (
  aggregator: StreamingMessageAggregator,
  {
    messageId,
    toolCallId,
    skillName,
    error,
  }: {
    messageId?: string;
    toolCallId: string;
    skillName: string;
    error: string;
  }
) => {
  emitSkillReadResult(aggregator, {
    messageId,
    toolCallId,
    skillName,
    result: { success: false, error },
  });
};

const createSkillSnapshotMessage = ({
  id = "snapshot-1",
  skillName = "pull-requests",
  scope = "project",
  historySequence,
  body = "# Content",
  frontmatterYaml,
}: {
  id?: string;
  skillName?: string;
  scope?: AgentSkillScope;
  historySequence?: number;
  body?: string;
  frontmatterYaml?: string;
}) =>
  createMuxMessage(
    id,
    "user",
    `<agent-skill name="${skillName}" scope="${scope}">\n${body}\n</agent-skill>`,
    {
      ...(historySequence !== undefined ? { historySequence } : {}),
      timestamp: 0,
      synthetic: true,
      agentSkillSnapshot: {
        skillName,
        scope,
        sha256: "deadbeef",
        ...(frontmatterYaml !== undefined ? { frontmatterYaml } : {}),
      },
    }
  );

const createSkillInvocationMessage = ({
  id = "invoke-1",
  skillName = "pull-requests",
  scope = "project",
  historySequence,
}: {
  id?: string;
  skillName?: string;
  scope?: AgentSkillScope;
  historySequence: number;
}) => {
  const command = `/${skillName}`;
  return createMuxMessage(id, "user", command, {
    historySequence,
    timestamp: 0,
    muxMetadata: {
      type: "agent-skill",
      rawCommand: command,
      commandPrefix: command,
      skillName,
      scope,
    },
  });
};

const createInlineSkillMessage = ({
  id = "inline-1",
  content = "Use inline skills",
  historySequence,
  refs,
}: {
  id?: string;
  content?: string;
  historySequence: number;
  refs: AgentSkillReference[];
}) =>
  createMuxMessage(id, "user", content, {
    historySequence,
    timestamp: 0,
    muxMetadata: {
      type: "normal",
      agentSkillRefs: refs,
    },
  });

const getSingleDisplayedUserMessage = (
  aggregator: StreamingMessageAggregator
): DisplayedUserMessage => {
  const displayed = aggregator.getDisplayedMessages();
  expect(displayed).toHaveLength(1);

  const message = displayed[0];
  if (message?.type !== "user") {
    throw new Error("Expected displayed user message");
  }

  return message;
};

describe("Loaded skills tracking", () => {
  it("returns empty array when no skills loaded", () => {
    const aggregator = createAggregator();
    expect(aggregator.getLoadedSkills()).toEqual([]);
  });

  it("tracks skills from successful agent_skill_read tool calls", () => {
    const aggregator = createAggregator();
    startStream(aggregator);
    emitSuccessfulSkillRead(aggregator, {
      toolCallId: "tc-1",
      skillName: "tests",
      description: "Testing doctrine and conventions",
    });

    expect(aggregator.getLoadedSkills()).toEqual([
      {
        name: "tests",
        description: "Testing doctrine and conventions",
        scope: "project",
      },
    ]);
  });

  it("tracks skills from agentSkillSnapshot messages via handleMessage", () => {
    const aggregator = createAggregator();
    const snapshot = createSkillSnapshotMessage({ skillName: "pull-requests" });

    aggregator.handleMessage({ ...snapshot, type: "message" });

    expect(aggregator.getLoadedSkills()).toEqual([
      {
        name: "pull-requests",
        description: "(loaded via /pull-requests)",
        scope: "project",
      },
    ]);
  });

  it("tracks skills from agentSkillSnapshot during loadHistoricalMessages replay", () => {
    const aggregator = createAggregator();
    const snapshot = createSkillSnapshotMessage({ skillName: "pull-requests", historySequence: 1 });

    aggregator.loadHistoricalMessages([snapshot]);

    expect(aggregator.getLoadedSkills()).toEqual([
      {
        name: "pull-requests",
        description: "(loaded via /pull-requests)",
        scope: "project",
      },
    ]);
  });

  it("deduplicates skills by name", () => {
    const aggregator = createAggregator();
    startStream(aggregator);

    for (let index = 0; index < 2; index++) {
      emitSuccessfulSkillRead(aggregator, {
        toolCallId: `tc-${index}`,
        skillName: "tests",
        description: "Testing doctrine",
      });
    }

    expect(aggregator.getLoadedSkills()).toHaveLength(1);
  });

  it("tracks multiple different skills", () => {
    const aggregator = createAggregator();
    startStream(aggregator);

    const skillDefs = [
      { name: "tests", description: "Testing skill", scope: "project" as const },
      { name: "pull-requests", description: "PR guidelines", scope: "project" as const },
      { name: "xum-docs", description: "Documentation", scope: "built-in" as const },
    ];

    for (const [index, skill] of skillDefs.entries()) {
      emitSuccessfulSkillRead(aggregator, {
        toolCallId: `tc-${index}`,
        skillName: skill.name,
        description: skill.description,
        scope: skill.scope,
      });
    }

    const skills = aggregator.getLoadedSkills();
    expect(skills).toHaveLength(3);
    expect(skills.map((skill) => skill.name).sort()).toEqual([
      "pull-requests",
      "tests",
      "xum-docs",
    ]);
  });

  it("ignores failed agent_skill_read calls for loadedSkills", () => {
    const aggregator = createAggregator();
    startStream(aggregator);
    emitFailedSkillRead(aggregator, {
      toolCallId: "tc-1",
      skillName: "nonexistent",
      error: "Skill not found",
    });

    expect(aggregator.getLoadedSkills()).toEqual([]);
  });

  it("returns stable array reference for memoization", () => {
    const aggregator = createAggregator();
    startStream(aggregator);
    emitSuccessfulSkillRead(aggregator, {
      toolCallId: "tc-1",
      skillName: "tests",
      description: "Testing",
    });

    const ref1 = aggregator.getLoadedSkills();
    const ref2 = aggregator.getLoadedSkills();
    expect(ref1).toBe(ref2);
  });

  it("clears skills on loadHistoricalMessages replay", () => {
    const aggregator = createAggregator();
    startStream(aggregator);
    emitSuccessfulSkillRead(aggregator, {
      toolCallId: "tc-1",
      skillName: "tests",
      description: "Testing",
    });

    expect(aggregator.getLoadedSkills()).toHaveLength(1);

    aggregator.loadHistoricalMessages([]);
    expect(aggregator.getLoadedSkills()).toEqual([]);
  });
});

describe("Skill load error tracking", () => {
  it("returns empty array when no errors", () => {
    const aggregator = createAggregator();
    expect(aggregator.getSkillLoadErrors()).toEqual([]);
  });

  it("tracks failed agent_skill_read calls", () => {
    const aggregator = createAggregator();
    startStream(aggregator);
    emitFailedSkillRead(aggregator, {
      toolCallId: "tc-1",
      skillName: "nonexistent",
      error: "Agent skill not found: nonexistent",
    });

    expect(aggregator.getSkillLoadErrors()).toEqual([
      { name: "nonexistent", error: "Agent skill not found: nonexistent" },
    ]);
  });

  it("deduplicates errors by skill name", () => {
    const aggregator = createAggregator();
    startStream(aggregator);
    emitFailedSkillRead(aggregator, {
      toolCallId: "tc-1",
      skillName: "broken",
      error: "Parse error",
    });
    emitFailedSkillRead(aggregator, {
      toolCallId: "tc-2",
      skillName: "broken",
      error: "Parse error",
    });

    expect(aggregator.getSkillLoadErrors()).toHaveLength(1);
  });

  it("updates error message on subsequent failure", () => {
    const aggregator = createAggregator();
    startStream(aggregator);
    emitFailedSkillRead(aggregator, {
      toolCallId: "tc-1",
      skillName: "broken",
      error: "First error",
    });
    emitFailedSkillRead(aggregator, {
      toolCallId: "tc-2",
      skillName: "broken",
      error: "Second error",
    });

    expect(aggregator.getSkillLoadErrors()).toEqual([{ name: "broken", error: "Second error" }]);
  });

  it("clears error when skill later loads successfully", () => {
    const aggregator = createAggregator();
    startStream(aggregator);
    emitFailedSkillRead(aggregator, {
      toolCallId: "tc-1",
      skillName: "flaky",
      error: "Temporary failure",
    });

    expect(aggregator.getSkillLoadErrors()).toHaveLength(1);

    emitSuccessfulSkillRead(aggregator, {
      toolCallId: "tc-2",
      skillName: "flaky",
    });

    expect(aggregator.getSkillLoadErrors()).toEqual([]);
    expect(aggregator.getLoadedSkills()).toHaveLength(1);
  });

  it("replaces loaded skill with error on later failure", () => {
    const aggregator = createAggregator();
    startStream(aggregator);
    emitSuccessfulSkillRead(aggregator, {
      toolCallId: "tc-1",
      skillName: "flaky-skill",
    });

    expect(aggregator.getLoadedSkills()).toHaveLength(1);
    expect(aggregator.getSkillLoadErrors()).toEqual([]);

    emitFailedSkillRead(aggregator, {
      toolCallId: "tc-2",
      skillName: "flaky-skill",
      error: "SKILL.md is missing",
    });

    expect(aggregator.getSkillLoadErrors()).toEqual([
      { name: "flaky-skill", error: "SKILL.md is missing" },
    ]);
    expect(aggregator.getLoadedSkills()).toEqual([]);
  });

  it("clears errors on loadHistoricalMessages replay", () => {
    const aggregator = createAggregator();
    startStream(aggregator);
    emitFailedSkillRead(aggregator, {
      toolCallId: "tc-1",
      skillName: "broken",
      error: "Error",
    });

    expect(aggregator.getSkillLoadErrors()).toHaveLength(1);

    aggregator.loadHistoricalMessages([]);
    expect(aggregator.getSkillLoadErrors()).toEqual([]);
  });

  it("returns stable array reference for memoization", () => {
    const aggregator = createAggregator();
    startStream(aggregator);
    emitFailedSkillRead(aggregator, {
      toolCallId: "tc-1",
      skillName: "broken",
      error: "Error",
    });

    const ref1 = aggregator.getSkillLoadErrors();
    const ref2 = aggregator.getSkillLoadErrors();
    expect(ref1).toBe(ref2);
  });

  it("tracks errors from historical tool calls", () => {
    const aggregator = createAggregator();

    aggregator.loadHistoricalMessages([
      createMuxMessage("msg-1", "assistant", "", undefined, [
        {
          type: "dynamic-tool",
          toolCallId: "tc-1",
          toolName: "agent_skill_read",
          input: { name: "missing-skill" },
          state: "output-available",
          output: { success: false, error: "Agent skill not found: missing-skill" },
        },
      ]),
    ]);

    expect(aggregator.getSkillLoadErrors()).toEqual([
      { name: "missing-skill", error: "Agent skill not found: missing-skill" },
    ]);
  });
});

describe("Agent skill snapshot association", () => {
  it("attaches agentSkillSnapshot content to the subsequent invocation message", () => {
    const aggregator = createAggregator();
    const snapshot = createSkillSnapshotMessage({
      historySequence: 1,
      frontmatterYaml: "name: pull-requests\ndescription: PR guidelines",
    });
    const invocation = createSkillInvocationMessage({ historySequence: 2 });

    aggregator.loadHistoricalMessages([snapshot, invocation]);

    const displayed = aggregator.getDisplayedMessages();
    expect(displayed).toHaveLength(1);

    const message = displayed[0];
    if (message?.type !== "user") {
      throw new Error("Expected displayed user message");
    }

    expect(message.agentSkill).toEqual({
      skillName: "pull-requests",
      scope: "project",
      snapshot: {
        frontmatterYaml: "name: pull-requests\ndescription: PR guidelines",
        body: "# Content",
      },
    });
  });

  it("attaches MCP prompt snapshots to slash and inline invocation surfaces", () => {
    const aggregator = createAggregator();
    const snapshot = createMuxMessage("prompt-snapshot", "user", "Expanded prompt body", {
      historySequence: 1,
      timestamp: 0,
      synthetic: true,
      mcpPromptSnapshot: {
        serverName: "coder",
        promptName: "review",
        commandKey: "mcp__coder__review",
        invokingMessageId: "prompt-slash",
      },
    });
    const slash = createMuxMessage("prompt-slash", "user", "Using MCP prompt coder/review", {
      historySequence: 2,
      timestamp: 0,
      muxMetadata: {
        type: "normal",
        rawCommand: "/mcp__coder__review",
        commandPrefix: "/mcp__coder__review",
        mcpPromptRefs: [
          {
            serverName: "coder",
            promptName: "review",
            commandKey: "mcp__coder__review",
            source: "slash",
          },
        ],
        agentSkillRefs: [{ skillName: "tdd", scope: "global", source: "inline" }],
      },
    });
    const inlineSnapshot = createMuxMessage("prompt-snapshot-2", "user", "Expanded prompt body", {
      historySequence: 3,
      timestamp: 0,
      synthetic: true,
      mcpPromptSnapshot: {
        serverName: "coder",
        promptName: "review",
        commandKey: "mcp__coder__review",
        invokingMessageId: "prompt-inline",
      },
    });
    const inline = createMuxMessage("prompt-inline", "user", "Use $mcp__coder__review", {
      historySequence: 4,
      timestamp: 0,
      muxMetadata: {
        type: "normal",
        mcpPromptRefs: [
          {
            serverName: "coder",
            promptName: "review",
            commandKey: "mcp__coder__review",
            source: "inline",
          },
        ],
      },
    });

    aggregator.loadHistoricalMessages([snapshot, slash, inlineSnapshot, inline]);
    const displayed = aggregator.getDisplayedMessages();
    expect(displayed).toHaveLength(2);
    const slashMessage = displayed[0];
    const inlineMessage = displayed[1];
    if (slashMessage?.type !== "user" || inlineMessage?.type !== "user") {
      throw new Error("Expected displayed user messages");
    }
    expect(slashMessage.agentSkill?.snapshot?.body).toBe("Expanded prompt body");
    expect(slashMessage.mcpPromptRefs).toEqual(slash.metadata?.muxMetadata?.mcpPromptRefs);
    expect(slashMessage.agentSkillRefs).toEqual([
      { skillName: "tdd", scope: "global", source: "inline" },
    ]);
    expect(inlineMessage.mcpPromptRefs).toEqual(inline.metadata?.muxMetadata?.mcpPromptRefs);
    expect(inlineMessage.inlineSkillSnapshots?.mcp__coder__review?.snapshot.body).toBe(
      "Expanded prompt body"
    );
  });

  it("filters malformed persisted refs instead of crashing aggregation", () => {
    const aggregator = createAggregator();
    // Simulates corrupted chat.jsonl rows; muxMetadata persists untyped.
    const corruptMcpRefs: unknown = [null, {}, { serverName: "coder" }, 42];
    const corruptSkillRefs: unknown = [null, { skillName: "tdd" }];
    const corrupted = createMuxMessage("prompt-corrupted", "user", "Corrupted refs", {
      historySequence: 1,
      timestamp: 0,
      muxMetadata: {
        type: "normal",
        mcpPromptRefs: corruptMcpRefs as MCPPromptReference[],
        agentSkillRefs: corruptSkillRefs as AgentSkillReference[],
      },
    });
    const mixedRefs: unknown = [
      null,
      {
        serverName: "coder",
        promptName: "review",
        commandKey: "mcp__coder__review",
        source: "slash",
      },
    ];
    const valid = createMuxMessage("prompt-valid", "user", "Using MCP prompt coder/review", {
      historySequence: 2,
      timestamp: 0,
      muxMetadata: {
        type: "normal",
        mcpPromptRefs: mixedRefs as MCPPromptReference[],
      },
    });

    aggregator.loadHistoricalMessages([corrupted, valid]);
    const displayed = aggregator.getDisplayedMessages();
    expect(displayed).toHaveLength(2);

    const corruptedMessage = displayed[0];
    const validMessage = displayed[1];
    if (corruptedMessage?.type !== "user" || validMessage?.type !== "user") {
      throw new Error("Expected displayed user messages");
    }
    expect(corruptedMessage.mcpPromptRefs).toBeUndefined();
    expect(validMessage.mcpPromptRefs).toHaveLength(1);
  });

  it("does not attach an older turn's prompt snapshot when materialization failed", () => {
    const aggregator = createAggregator();
    const promptRef = {
      serverName: "coder",
      promptName: "review",
      commandKey: "mcp__coder__review",
      source: "slash" as const,
    };
    const snapshot = createMuxMessage("prompt-snapshot", "user", "Expanded prompt body", {
      historySequence: 1,
      timestamp: 0,
      synthetic: true,
      mcpPromptSnapshot: {
        serverName: "coder",
        promptName: "review",
        commandKey: "mcp__coder__review",
        invokingMessageId: "prompt-first",
      },
    });
    const first = createMuxMessage("prompt-first", "user", "Using MCP prompt coder/review", {
      historySequence: 2,
      timestamp: 0,
      muxMetadata: {
        type: "normal",
        rawCommand: "/mcp__coder__review",
        commandPrefix: "/mcp__coder__review",
        mcpPromptRefs: [promptRef],
      },
    });
    const second = createMuxMessage("prompt-second", "user", "Using MCP prompt coder/review", {
      historySequence: 3,
      timestamp: 0,
      muxMetadata: {
        type: "normal",
        rawCommand: "/mcp__coder__review",
        commandPrefix: "/mcp__coder__review",
        mcpPromptRefs: [promptRef],
      },
    });

    aggregator.loadHistoricalMessages([snapshot, first, second]);
    const displayed = aggregator.getDisplayedMessages();
    const firstMessage = displayed[0];
    const secondMessage = displayed[1];
    if (firstMessage?.type !== "user" || secondMessage?.type !== "user") {
      throw new Error("Expected displayed user messages");
    }
    expect(firstMessage.agentSkill?.snapshot?.body).toBe("Expanded prompt body");
    expect(secondMessage.agentSkill?.snapshot).toBeUndefined();
  });

  it("does not attach a crash-orphaned snapshot to a later same-prompt turn", () => {
    const aggregator = createAggregator();
    const orphan = createMuxMessage("orphan-snapshot", "user", "Stale expansion", {
      historySequence: 1,
      timestamp: 0,
      synthetic: true,
      mcpPromptSnapshot: {
        serverName: "coder",
        promptName: "review",
        commandKey: "mcp__coder__review",
        invokingMessageId: "user-crashed",
      },
    });
    const later = createMuxMessage("prompt-later", "user", "Use $mcp__coder__review", {
      historySequence: 2,
      timestamp: 0,
      muxMetadata: {
        type: "normal",
        mcpPromptRefs: [
          {
            serverName: "coder",
            promptName: "review",
            commandKey: "mcp__coder__review",
            source: "inline" as const,
          },
        ],
      },
    });

    aggregator.loadHistoricalMessages([orphan, later]);
    const displayed = aggregator.getDisplayedMessages();
    const laterMessage = displayed[0];
    if (laterMessage?.type !== "user") throw new Error("Expected displayed user message");
    expect(laterMessage.inlineSkillSnapshots).toBeUndefined();
    expect(laterMessage.agentSkill).toBeUndefined();
  });

  it("uses the latest snapshot available at each invocation turn", () => {
    const aggregator = createAggregator();
    const firstFrontmatter = "name: pull-requests\ndescription: First";
    const secondFrontmatter = "name: pull-requests\ndescription: Second";
    const firstSnapshot = createSkillSnapshotMessage({
      id: "snapshot-1",
      historySequence: 1,
      body: "# First",
      frontmatterYaml: firstFrontmatter,
    });
    const firstInvocation = createSkillInvocationMessage({
      id: "invoke-1",
      historySequence: 2,
    });
    const secondSnapshot = createSkillSnapshotMessage({
      id: "snapshot-2",
      historySequence: 3,
      body: "# Second",
      frontmatterYaml: secondFrontmatter,
    });
    const secondInvocation = createSkillInvocationMessage({
      id: "invoke-2",
      historySequence: 4,
    });

    aggregator.loadHistoricalMessages([
      firstSnapshot,
      firstInvocation,
      secondSnapshot,
      secondInvocation,
    ]);

    const displayed = aggregator.getDisplayedMessages();
    expect(displayed).toHaveLength(2);

    const [firstMessage, secondMessage] = displayed;
    if (firstMessage?.type !== "user" || secondMessage?.type !== "user") {
      throw new Error("Expected displayed user messages");
    }

    expect(firstMessage.agentSkill?.snapshot).toEqual({
      frontmatterYaml: firstFrontmatter,
      body: "# First",
    });
    expect(secondMessage.agentSkill?.snapshot).toEqual({
      frontmatterYaml: secondFrontmatter,
      body: "# Second",
    });
  });

  it("attaches prior snapshots for multiple inline skill refs", () => {
    const aggregator = createAggregator();
    const deepReviewSnapshot = createSkillSnapshotMessage({
      id: "snapshot-deep-review",
      skillName: "deep-review",
      scope: "global",
      historySequence: 1,
      body: "# Deep review",
      frontmatterYaml: "name: deep-review\ndescription: Review deeply",
    });
    const tddSnapshot = createSkillSnapshotMessage({
      id: "snapshot-tdd",
      skillName: "tdd",
      scope: "project",
      historySequence: 2,
      body: "# TDD",
      frontmatterYaml: "name: tdd\ndescription: Test-first changes",
    });
    const invocation = createInlineSkillMessage({
      historySequence: 3,
      content: "Use $deep-review and $tdd",
      refs: [
        { skillName: "deep-review", scope: "global", source: "inline" },
        { skillName: "tdd", scope: "project", source: "inline" },
      ],
    });

    aggregator.loadHistoricalMessages([deepReviewSnapshot, tddSnapshot, invocation]);

    const message = getSingleDisplayedUserMessage(aggregator);
    expect(Object.keys(message.inlineSkillSnapshots ?? {}).sort()).toEqual(["deep-review", "tdd"]);
    expect(message.inlineSkillSnapshots?.["deep-review"]).toEqual({
      skillName: "deep-review",
      scope: "global",
      snapshot: {
        frontmatterYaml: "name: deep-review\ndescription: Review deeply",
        body: "# Deep review",
      },
    });
    expect(message.inlineSkillSnapshots?.tdd).toEqual({
      skillName: "tdd",
      scope: "project",
      snapshot: {
        frontmatterYaml: "name: tdd\ndescription: Test-first changes",
        body: "# TDD",
      },
    });
  });

  it("collapses repeated inline refs for the same skill", () => {
    const aggregator = createAggregator();
    const snapshot = createSkillSnapshotMessage({
      id: "snapshot-tdd",
      skillName: "tdd",
      scope: "project",
      historySequence: 1,
      body: "# TDD",
    });
    const invocation = createInlineSkillMessage({
      historySequence: 2,
      content: "Use $tdd and $tdd again",
      refs: [
        { skillName: "tdd", scope: "project", source: "inline" },
        { skillName: "tdd", scope: "project", source: "inline" },
      ],
    });

    aggregator.loadHistoricalMessages([snapshot, invocation]);

    const message = getSingleDisplayedUserMessage(aggregator);
    expect(Object.keys(message.inlineSkillSnapshots ?? {})).toEqual(["tdd"]);
    expect(message.inlineSkillSnapshots?.tdd).toEqual({
      skillName: "tdd",
      scope: "project",
      snapshot: { frontmatterYaml: undefined, body: "# TDD" },
    });
  });

  it("invalidates slash skill display cache when snapshot body changes without sha change", () => {
    const aggregator = createAggregator();
    const snapshot = createSkillSnapshotMessage({
      id: "snapshot-tdd",
      skillName: "tdd",
      scope: "project",
      historySequence: 1,
      body: "# TDD v1",
      frontmatterYaml: "name: tdd\ndescription: Test-first changes",
    });
    const invocation = createSkillInvocationMessage({
      id: "invoke-tdd",
      skillName: "tdd",
      scope: "project",
      historySequence: 2,
    });

    aggregator.addMessage(snapshot);
    aggregator.addMessage(invocation);
    const firstMessage = getSingleDisplayedUserMessage(aggregator);
    expect(firstMessage.agentSkill?.snapshot?.body).toBe("# TDD v1");

    aggregator.addMessage(
      createSkillSnapshotMessage({
        id: "snapshot-tdd",
        skillName: "tdd",
        scope: "project",
        historySequence: 1,
        body: "# TDD v2",
        frontmatterYaml: "name: tdd\ndescription: Test-first changes",
      })
    );

    const secondMessage = getSingleDisplayedUserMessage(aggregator);
    expect(secondMessage.agentSkill?.snapshot?.body).toBe("# TDD v2");
    expect(secondMessage).not.toBe(firstMessage);
  });

  it("invalidates inline skill display cache when snapshot body or frontmatter changes", () => {
    const aggregator = createAggregator();
    const snapshot = createSkillSnapshotMessage({
      id: "snapshot-tdd",
      skillName: "tdd",
      scope: "project",
      historySequence: 1,
      body: "# TDD v1",
      frontmatterYaml: "name: tdd\ndescription: Test-first changes v1",
    });
    const invocation = createInlineSkillMessage({
      historySequence: 2,
      content: "Use $tdd",
      refs: [{ skillName: "tdd", scope: "project", source: "inline" }],
    });

    aggregator.addMessage(snapshot);
    aggregator.addMessage(invocation);
    const firstMessage = getSingleDisplayedUserMessage(aggregator);
    expect(firstMessage.inlineSkillSnapshots?.tdd?.snapshot).toEqual({
      frontmatterYaml: "name: tdd\ndescription: Test-first changes v1",
      body: "# TDD v1",
    });

    aggregator.addMessage(
      createSkillSnapshotMessage({
        id: "snapshot-tdd",
        skillName: "tdd",
        scope: "project",
        historySequence: 1,
        body: "# TDD v2",
        frontmatterYaml: "name: tdd\ndescription: Test-first changes v2",
      })
    );

    const secondMessage = getSingleDisplayedUserMessage(aggregator);
    expect(secondMessage.inlineSkillSnapshots?.tdd?.snapshot).toEqual({
      frontmatterYaml: "name: tdd\ndescription: Test-first changes v2",
      body: "# TDD v2",
    });
    expect(secondMessage).not.toBe(firstMessage);
  });

  it("omits inline refs that do not have an available snapshot", () => {
    const aggregator = createAggregator();
    const invocation = createInlineSkillMessage({
      historySequence: 1,
      content: "Use $missing-skill",
      refs: [{ skillName: "missing-skill", scope: "project", source: "inline" }],
    });

    aggregator.loadHistoricalMessages([invocation]);

    const message = getSingleDisplayedUserMessage(aggregator);
    expect(message.inlineSkillSnapshots).toBeUndefined();
  });

  it("keeps slash and inline skill snapshots in separate display fields", () => {
    const aggregator = createAggregator();
    const slashSnapshot = createSkillSnapshotMessage({
      id: "snapshot-pull-requests",
      skillName: "pull-requests",
      scope: "project",
      historySequence: 1,
      body: "# PR workflow",
      frontmatterYaml: "name: pull-requests\ndescription: PR workflow",
    });
    const inlineSnapshot = createSkillSnapshotMessage({
      id: "snapshot-tdd",
      skillName: "tdd",
      scope: "global",
      historySequence: 2,
      body: "# TDD global",
      frontmatterYaml: "name: tdd\ndescription: Test-first changes",
    });
    const command = "/pull-requests use $tdd";
    const invocation = createMuxMessage("mixed-invoke", "user", command, {
      historySequence: 3,
      timestamp: 0,
      muxMetadata: {
        type: "agent-skill",
        rawCommand: command,
        commandPrefix: "/pull-requests",
        skillName: "pull-requests",
        scope: "project",
        agentSkillRefs: [
          { skillName: "pull-requests", scope: "project", source: "slash" },
          { skillName: "tdd", scope: "global", source: "inline" },
        ],
      },
    });

    aggregator.loadHistoricalMessages([slashSnapshot, inlineSnapshot, invocation]);

    const message = getSingleDisplayedUserMessage(aggregator);
    expect(message.agentSkill).toEqual({
      skillName: "pull-requests",
      scope: "project",
      snapshot: {
        frontmatterYaml: "name: pull-requests\ndescription: PR workflow",
        body: "# PR workflow",
      },
    });
    expect(message.inlineSkillSnapshots).toEqual({
      tdd: {
        skillName: "tdd",
        scope: "global",
        snapshot: {
          frontmatterYaml: "name: tdd\ndescription: Test-first changes",
          body: "# TDD global",
        },
      },
    });
  });
});

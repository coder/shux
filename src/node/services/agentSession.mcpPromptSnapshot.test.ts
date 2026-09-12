import { describe, expect, mock, spyOn, test } from "bun:test";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Err, Ok } from "@/common/types/result";
import type { AIService } from "@/node/services/aiService";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import {
  createAgentSessionHarness,
  createStartedTurnHandle,
} from "@/node/services/agentSession.testHarness";

function promptMetadata() {
  return {
    type: "normal" as const,
    rawCommand: "/mcp__coder__review src",
    commandPrefix: "/mcp__coder__review",
    mcpPromptRefs: [
      {
        serverName: "coder",
        promptName: "review",
        commandKey: "mcp__coder__review",
        source: "slash" as const,
        arguments: { path: "src" },
      },
    ],
  };
}

describe("AgentSession MCP prompt snapshots", () => {
  test("persists the materialized prompt before the user row", async () => {
    const getPrompt = mock(() =>
      Promise.resolve({ text: "Expanded prompt", description: "Review code" })
    );
    const harness = await createAgentSessionHarness({
      workspaceId: "workspace",
      mcpServerManager: { getPrompt } as unknown as MCPServerManager,
      captureEvents: true,
    });

    try {
      const result = await harness.session.sendMessage("Using MCP prompt coder/review: src", {
        model: "anthropic:claude-3-5-sonnet-latest",
        agentId: "exec",
        muxMetadata: promptMetadata(),
      });
      expect(result.success).toBe(true);

      const history = await harness.historyService.getLastMessages("workspace", 10);
      expect(history.success).toBe(true);
      if (!history.success) throw new Error(history.error);
      expect(history.data).toHaveLength(2);
      expect(history.data[0]?.metadata?.mcpPromptSnapshot).toEqual({
        serverName: "coder",
        promptName: "review",
        commandKey: "mcp__coder__review",
        invokingMessageId: history.data[1]?.id ?? "",
        description: "Review code",
      });
      expect(history.data[0]?.parts.find((part) => part.type === "text")?.text).toBe(
        "Expanded prompt"
      );
      expect(getPrompt).toHaveBeenCalledWith(
        "workspace",
        "coder",
        "review",
        { path: "src" },
        undefined
      );

      // The live transcript must also emit the snapshot before the user row.
      const emittedIds = harness.events
        .filter((event) => "id" in event)
        .map((event) => (event as { id: string }).id);
      const snapshotId = history.data[0]?.id ?? "";
      const userId = history.data[1]?.id ?? "";
      expect(emittedIds.indexOf(snapshotId)).toBeGreaterThanOrEqual(0);
      expect(emittedIds.indexOf(snapshotId)).toBeLessThan(emittedIds.indexOf(userId));
    } finally {
      await harness.session.dispose();
      await harness.cleanup();
    }
  });

  test("materializes independent prompt refs concurrently while preserving order", async () => {
    let resolveFirst: ((value: { text: string }) => void) | undefined;
    const getPrompt = mock((_workspaceId: string, _serverName: string, promptName: string) => {
      if (promptName === "first") {
        return new Promise<{ text: string }>((resolve) => {
          resolveFirst = resolve;
        });
      }
      resolveFirst?.({ text: "First prompt" });
      return Promise.resolve({ text: "Second prompt" });
    });
    const harness = await createAgentSessionHarness({
      workspaceId: "workspace",
      mcpServerManager: { getPrompt } as unknown as MCPServerManager,
    });

    try {
      const result = await harness.session.sendMessage("Use both prompts", {
        model: "anthropic:claude-3-5-sonnet-latest",
        agentId: "exec",
        muxMetadata: {
          type: "normal",
          mcpPromptRefs: [
            {
              serverName: "coder",
              promptName: "first",
              commandKey: "mcp__coder__first",
              source: "inline",
            },
            {
              serverName: "coder",
              promptName: "second",
              commandKey: "mcp__coder__second",
              source: "inline",
            },
          ],
        },
      });
      expect(result.success).toBe(true);
      expect(getPrompt).toHaveBeenCalledTimes(2);

      const history = await harness.historyService.getLastMessages("workspace", 10);
      expect(history.success).toBe(true);
      if (!history.success) throw new Error(history.error);
      expect(
        history.data
          .filter((message) => message.metadata?.mcpPromptSnapshot)
          .map((message) => message.metadata?.mcpPromptSnapshot?.promptName)
      ).toEqual(["first", "second"]);
    } finally {
      await harness.session.dispose();
      await harness.cleanup();
    }
  });

  test("fails the send visibly when a slash-selected prompt cannot expand", async () => {
    const harness = await createAgentSessionHarness({
      workspaceId: "workspace",
      mcpServerManager: {
        getPrompt: mock(() => Promise.reject(new Error("server unavailable"))),
      } as unknown as MCPServerManager,
    });

    try {
      const result = await harness.session.sendMessage("Using MCP prompt coder/review: src", {
        model: "anthropic:claude-3-5-sonnet-latest",
        agentId: "exec",
        muxMetadata: promptMetadata(),
      });
      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected slash prompt send to fail");
      expect(result.error.type).toBe("unknown");
      expect(JSON.stringify(result.error)).toContain("Cannot expand MCP prompt 'coder/review'");

      const history = await harness.historyService.getLastMessages("workspace", 10);
      expect(history.success).toBe(true);
      if (!history.success) throw new Error(history.error);
      expect(history.data).toHaveLength(0);
    } finally {
      await harness.session.dispose();
      await harness.cleanup();
    }
  });

  test("publishes no snapshot rows when manual trigger acceptance fails", async () => {
    const getPrompt = mock(() => Promise.resolve({ text: "Expanded prompt" }));
    const harness = await createAgentSessionHarness({
      workspaceId: "workspace",
      mcpServerManager: { getPrompt } as unknown as MCPServerManager,
    });

    try {
      const acceptance = spyOn(
        harness.historyService,
        "acceptCompactionReplacement"
      ).mockResolvedValueOnce(Err("disk full"));

      const result = await harness.session.sendMessage("Using MCP prompt coder/review: src", {
        model: "anthropic:claude-3-5-sonnet-latest",
        agentId: "exec",
        muxMetadata: promptMetadata(),
      });
      expect(result.success).toBe(false);
      acceptance.mockRestore();

      const history = await harness.historyService.getLastMessages("workspace", 10);
      expect(history.success).toBe(true);
      if (!history.success) throw new Error(history.error);
      expect(history.data).toHaveLength(0);
    } finally {
      await harness.session.dispose();
      await harness.cleanup();
    }
  });

  test("drops failed inline prompt refs without blocking the user message", async () => {
    const harness = await createAgentSessionHarness({
      workspaceId: "workspace",
      mcpServerManager: {
        getPrompt: mock(() => Promise.reject(new Error("server unavailable"))),
      } as unknown as MCPServerManager,
    });

    try {
      const base = promptMetadata();
      const metadata = {
        ...base,
        mcpPromptRefs: [{ ...base.mcpPromptRefs[0], source: "inline" as const }],
      };
      const result = await harness.session.sendMessage("Check $mcp__coder__review please", {
        model: "anthropic:claude-3-5-sonnet-latest",
        agentId: "exec",
        muxMetadata: metadata,
      });
      expect(result.success).toBe(true);

      const history = await harness.historyService.getLastMessages("workspace", 10);
      expect(history.success).toBe(true);
      if (!history.success) throw new Error(history.error);
      expect(history.data).toHaveLength(1);
      expect(history.data[0]?.metadata?.mcpPromptSnapshot).toBeUndefined();
    } finally {
      await harness.session.dispose();
      await harness.cleanup();
    }
  });

  test("excludes crash-orphaned snapshots from provider requests", async () => {
    const streamMessage = mock((_args: { messages: MuxMessage[] }) =>
      Promise.resolve(Ok(createStartedTurnHandle(harness.session.closingSignal)))
    );
    const harness = await createAgentSessionHarness({
      workspaceId: "workspace",
      aiServiceOverrides: {
        streamMessage: streamMessage as unknown as AIService["streamMessage"],
      },
    });

    try {
      await harness.historyService.appendToHistory(
        "workspace",
        createMuxMessage("orphan-snap", "user", "Expanded prompt", {
          historySequence: 0,
          synthetic: true,
          mcpPromptSnapshot: {
            serverName: "coder",
            promptName: "review",
            commandKey: "mcp__coder__review",
          },
        })
      );

      const result = await harness.session.sendMessage("Unrelated message", {
        model: "anthropic:claude-3-5-sonnet-latest",
        agentId: "exec",
      });
      expect(result.success).toBe(true);

      expect(streamMessage.mock.calls).toHaveLength(1);
      const requestMessages = streamMessage.mock.calls[0][0].messages;
      expect(requestMessages.length).toBeGreaterThan(0);
      expect(requestMessages.map((message) => message.id)).not.toContain("orphan-snap");
    } finally {
      await harness.session.dispose();
      await harness.cleanup();
    }
  });

  test("truncates edits starting from the preceding prompt snapshot", async () => {
    const harness = await createAgentSessionHarness({ workspaceId: "workspace" });

    try {
      const snapshotId = "mcp-prompt-snapshot-0";
      const userMessageId = "user-0";
      await harness.historyService.appendToHistory(
        "workspace",
        createMuxMessage(snapshotId, "user", "Expanded prompt", {
          historySequence: 0,
          synthetic: true,
          mcpPromptSnapshot: {
            serverName: "coder",
            promptName: "review",
            commandKey: "mcp__coder__review",
          },
        })
      );
      await harness.historyService.appendToHistory(
        "workspace",
        createMuxMessage(userMessageId, "user", "Using MCP prompt coder/review: src", {
          historySequence: 1,
          muxMetadata: promptMetadata(),
        })
      );

      const truncateAfterMessage = spyOn(harness.historyService, "truncateAfterMessage");
      const result = await harness.session.sendMessage("edited", {
        model: "anthropic:claude-3-5-sonnet-latest",
        agentId: "exec",
        editMessageId: userMessageId,
      });

      expect(result.success).toBe(true);
      expect(truncateAfterMessage.mock.calls).toHaveLength(1);
      expect(truncateAfterMessage.mock.calls[0][1]).toBe(snapshotId);
    } finally {
      await harness.session.dispose();
      await harness.cleanup();
    }
  });
});

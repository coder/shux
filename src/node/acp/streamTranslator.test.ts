import { describe, expect, mock, test } from "bun:test";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { StreamTranslator } from "@/node/acp/streamTranslator";
import { createMuxMessage } from "@/common/types/message";
import type { WorkspaceChatMessage } from "@/common/orpc/types";

async function replayThrough(events: WorkspaceChatMessage[]): Promise<unknown[]> {
  const sessionUpdate = mock(() => Promise.resolve(undefined));
  const translator = new StreamTranslator({ sessionUpdate } as unknown as AgentSideConnection);
  async function* stream(): AsyncIterable<WorkspaceChatMessage> {
    for (const event of events) yield await Promise.resolve(event);
  }
  await translator.consumeAndForward("session", stream());
  return sessionUpdate.mock.calls.map((call) => (call as unknown[])[0]);
}

describe("StreamTranslator MCP prompt replay", () => {
  test("replays the authored slash command instead of the transformed prompt text", async () => {
    const userMessage = createMuxMessage("user-1", "user", "Using MCP prompt coder/review: src", {
      muxMetadata: {
        type: "normal",
        rawCommand: "/mcp__coder__review src",
        commandPrefix: "/mcp__coder__review",
        mcpPromptRefs: [
          {
            serverName: "coder",
            promptName: "review",
            commandKey: "mcp__coder__review",
            source: "slash",
            arguments: { path: "src" },
          },
        ],
      },
    });

    const updates = await replayThrough([{ ...userMessage, type: "message" }]);

    expect(updates).toEqual([
      {
        sessionId: "session",
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "/mcp__coder__review src" },
        },
      },
    ]);
  });

  test("suppresses synthetic MCP prompt snapshot rows", async () => {
    const snapshotMessage = createMuxMessage("mcp-prompt-snapshot-1", "user", "Expanded prompt", {
      synthetic: true,
      mcpPromptSnapshot: {
        serverName: "coder",
        promptName: "review",
        commandKey: "mcp__coder__review",
      },
    });

    const updates = await replayThrough([{ ...snapshotMessage, type: "message" }]);

    expect(updates).toEqual([]);
  });
});

import { describe, expect, mock, test } from "bun:test";

import { createMuxMessage, type MuxMessage, type MuxMessageMetadata } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import type { AIService, StreamMessageOptions } from "@/node/services/aiService";

import { inheritOpenWorkspaceTurnMetadata } from "./agentSession";
import { createAgentSessionHarness, createStartedTurnHandle } from "./agentSession.testHarness";

const correlation = {
  type: "workspace-turn-task",
  taskHandleId: "wst_handle",
  ownerWorkspaceId: "parentworkspace",
  turnId: "turn",
} as const;

function turnPrompt(id: string): MuxMessage {
  return createMuxMessage(id, "user", "Delegated prompt", { muxMetadata: correlation });
}

function cutAssistant(id: string): MuxMessage {
  return createMuxMessage(id, "assistant", "Working...", {
    finishReason: "tool-calls",
    muxMetadata: correlation,
  });
}

function wake(id: string): MuxMessage {
  return createMuxMessage(id, "user", "A background bash monitor matched output.", {
    muxMetadata: { type: "bash-monitor-wake", records: [] },
  });
}

describe("inheritOpenWorkspaceTurnMetadata", () => {
  test("wake after a queue-cut correlated assistant inherits the turn correlation", () => {
    const messages = [turnPrompt("prompt"), cutAssistant("cut"), wake("wake")];
    expect(inheritOpenWorkspaceTurnMetadata(messages)).toEqual(correlation);
  });

  test("chained wake continuations keep inheriting through inherited assistants", () => {
    const messages = [
      turnPrompt("prompt"),
      cutAssistant("cut1"),
      wake("wake1"),
      cutAssistant("cut2"),
      wake("wake2"),
    ];
    expect(inheritOpenWorkspaceTurnMetadata(messages)).toEqual(correlation);
  });

  test("a correlated assistant that finished with stop closes the turn", () => {
    const messages = [
      turnPrompt("prompt"),
      createMuxMessage("final", "assistant", "Final report", {
        finishReason: "stop",
        muxMetadata: correlation,
      }),
      wake("wake"),
    ];
    expect(inheritOpenWorkspaceTurnMetadata(messages)).toBeUndefined();
  });

  test("a manual user prompt supersedes the open turn", () => {
    const messages = [
      turnPrompt("prompt"),
      cutAssistant("cut"),
      createMuxMessage("manual", "user", "User takes over"),
      wake("wake"),
    ];
    expect(inheritOpenWorkspaceTurnMetadata(messages)).toBeUndefined();
  });

  test("an uncorrelated assistant closes the chain", () => {
    const messages = [
      createMuxMessage("plain", "assistant", "Unrelated turn", { finishReason: "tool-calls" }),
      wake("wake"),
    ];
    expect(inheritOpenWorkspaceTurnMetadata(messages)).toBeUndefined();
  });

  test("a partial correlated assistant does not leave the turn open", () => {
    const messages = [
      turnPrompt("prompt"),
      createMuxMessage("partial", "assistant", "Crashed mid-work", {
        finishReason: "tool-calls",
        partial: true,
        muxMetadata: correlation,
      }),
      wake("wake"),
    ];
    expect(inheritOpenWorkspaceTurnMetadata(messages)).toBeUndefined();
  });

  test("empty history yields no correlation", () => {
    expect(inheritOpenWorkspaceTurnMetadata([])).toBeUndefined();
  });

  test("a compaction summary stamped with the turn correlation re-opens the chain", () => {
    // On-send compaction consumed the wake: post-compaction history starts at
    // the summary, which carries the pre-compaction correlation stamp.
    const messages = [
      createMuxMessage("summary", "assistant", "Compacted context", {
        finishReason: "stop",
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: {
            text: "wake follow-up",
            model: "anthropic:claude-sonnet-4-5",
            agentId: "exec",
            workspaceTurnMetadata: correlation,
          },
        },
      }),
      wake("wake"),
    ];
    expect(inheritOpenWorkspaceTurnMetadata(messages)).toEqual(correlation);
  });

  test("an unstamped compaction summary closes the chain", () => {
    const messages = [
      createMuxMessage("summary", "assistant", "Compacted context", {
        finishReason: "stop",
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: {
            text: "unrelated follow-up",
            model: "anthropic:claude-sonnet-4-5",
            agentId: "exec",
          },
        },
      }),
      wake("wake"),
    ];
    expect(inheritOpenWorkspaceTurnMetadata(messages)).toBeUndefined();
  });
});

describe("AgentSession workspace-turn correlation inheritance", () => {
  async function sendAfterQueueCut(sendOptions: {
    muxMetadata?: MuxMessageMetadata;
  }): Promise<StreamMessageOptions["muxMetadata"]> {
    let streamedMuxMetadata: StreamMessageOptions["muxMetadata"];
    const streamMessage = mock((opts: StreamMessageOptions) => {
      streamedMuxMetadata = opts.muxMetadata;
      return Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)));
    });
    const { session, cleanup, historyService } = await createAgentSessionHarness({
      workspaceId: "workspace-turn-inheritance",
      aiServiceOverrides: {
        streamMessage: streamMessage as unknown as AIService["streamMessage"],
      },
    });
    try {
      // Seed a delegated turn that was cut at a tool boundary by a queued dispatch.
      await historyService.appendToHistory(
        "workspace-turn-inheritance",
        turnPrompt("delegated-prompt")
      );
      await historyService.appendToHistory("workspace-turn-inheritance", cutAssistant("cut"));

      const result = await session.sendMessage("continuation", {
        model: "anthropic:claude-sonnet-4-5",
        agentId: "exec",
        ...(sendOptions.muxMetadata != null ? { muxMetadata: sendOptions.muxMetadata } : {}),
      });
      expect(result.success).toBe(true);
      expect(streamMessage.mock.calls).toHaveLength(1);
      return streamedMuxMetadata;
    } finally {
      await session.dispose();
      await cleanup();
    }
  }

  test("bash-monitor-wake continuation streams inherit the open turn correlation", async () => {
    const streamed = await sendAfterQueueCut({
      muxMetadata: { type: "bash-monitor-wake", records: [] },
    });
    expect(streamed).toEqual(correlation);
  });

  test("manual user messages after a queue cut do not inherit the correlation", async () => {
    const streamed = await sendAfterQueueCut({});
    expect(streamed).toBeUndefined();
  });

  test("workspace-turn correlation persists in startup retry options", async () => {
    const workspaceId = "workspace-turn-retry-metadata";
    const { session, cleanup, historyService } = await createAgentSessionHarness({
      workspaceId,
    });
    try {
      const result = await session.sendMessage(
        "Nested terminal report",
        {
          model: "anthropic:claude-sonnet-4-5",
          agentId: "exec",
          muxMetadata: correlation,
        },
        { synthetic: true, agentInitiated: true }
      );
      expect(result.success).toBe(true);

      const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(historyResult.success).toBe(true);
      if (!historyResult.success) throw new Error("history read failed");
      const userMessage = historyResult.data.find(
        (message) =>
          message.role === "user" &&
          message.parts.some(
            (part) => part.type === "text" && part.text === "Nested terminal report"
          )
      );
      expect(userMessage?.metadata?.retrySendOptions).toMatchObject({
        muxMetadata: correlation,
      });
    } finally {
      await session.dispose();
      await cleanup();
    }
  });

  test("on-send compaction consuming a wake stamps the correlation on the follow-up", async () => {
    const workspaceId = "workspace-turn-compaction-stamp";
    const { session, cleanup, historyService } = await createAgentSessionHarness({
      workspaceId,
    });
    try {
      await historyService.appendToHistory(workspaceId, turnPrompt("delegated-prompt"));
      await historyService.appendToHistory(workspaceId, cutAssistant("cut"));

      // Force the on-send compaction divert for the wake continuation.
      const internals = session as unknown as { compactionMonitor: unknown };
      internals.compactionMonitor = {
        checkBeforeSend: mock(() => ({
          shouldShowWarning: true,
          shouldForceCompact: true,
          usagePercentage: 99,
          thresholdPercentage: 85,
        })),
        checkMidStream: mock(() => false),
        resetForNewStream: mock(() => undefined),
        setThreshold: mock(() => undefined),
        getThreshold: mock(() => 0.85),
      };

      const result = await session.sendMessage(
        "monitor wake",
        {
          model: "anthropic:claude-sonnet-4-5",
          agentId: "exec",
          muxMetadata: { type: "bash-monitor-wake", records: [] },
        },
        { agentInitiated: true }
      );
      expect(result.success).toBe(true);

      const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(historyResult.success).toBe(true);
      if (!historyResult.success) throw new Error("history read failed");
      const compactionRequest = historyResult.data.find(
        (message) => message.metadata?.muxMetadata?.type === "compaction-request"
      );
      const requestMeta = compactionRequest?.metadata?.muxMetadata;
      if (requestMeta?.type !== "compaction-request") {
        throw new Error("expected a persisted compaction request");
      }
      expect(requestMeta.parsed.followUpContent?.agentInitiated).toBe(true);
      expect(requestMeta.parsed.followUpContent?.workspaceTurnMetadata).toEqual(correlation);
    } finally {
      await session.dispose();
      await cleanup();
    }
  });
});

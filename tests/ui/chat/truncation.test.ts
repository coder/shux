/**
 * UI integration test for chat truncation behavior.
 * Verifies a generic hidden-history indicator is surfaced and assistant meta rows remain intact.
 */

import "../dom";
import { waitFor } from "@testing-library/react";

import { createTestEnvironment, cleanupTestEnvironment, preloadTestModules } from "../../ipc/setup";
import {
  cleanupTempGitRepo,
  createTempGitRepo,
  generateBranchName,
  trustProject,
} from "../../ipc/helpers";
import { detectDefaultTrunkBranch } from "@/node/git";
import { HistoryService } from "@/node/services/historyService";
import { MAX_HISTORY_HIDDEN_SEGMENTS } from "@/browser/utils/messages/transcriptTruncationPlan";
import { createMuxMessage } from "@/common/types/message";

import { installDom } from "../dom";
import { renderApp } from "../renderReviewPanel";
import { cleanupView, setupWorkspaceView } from "../helpers";

async function waitForWorkspaceChatToRender(container: HTMLElement): Promise<void> {
  await waitFor(
    () => {
      const messageWindow = container.querySelector('[data-testid="message-window"]');
      if (!messageWindow) {
        throw new Error("Workspace chat view not rendered yet");
      }
    },
    { timeout: 30_000 }
  );
}

async function seedHistoryWithToolCalls(
  historyService: HistoryService,
  workspaceId: string,
  pairCount: number
): Promise<void> {
  for (let i = 0; i < pairCount; i++) {
    const userMessage = createMuxMessage(`user-${i}`, "user", `user-${i}`);
    const toolMessage = {
      id: `assistant-tool-${i}`,
      role: "assistant" as const,
      parts: [
        { type: "reasoning" as const, text: `thinking-${i}` },
        {
          type: "dynamic-tool" as const,
          toolCallId: `tool-${i}`,
          toolName: "bash",
          state: "output-available" as const,
          input: { script: "echo test" },
          output: { success: true },
        },
      ],
    };
    const assistantMessage = createMuxMessage(`assistant-${i}`, "assistant", `assistant-${i}`);

    const userResult = await historyService.appendToHistory(workspaceId, userMessage);
    if (!userResult.success) {
      throw new Error(`Failed to append user history: ${userResult.error}`);
    }

    const toolResult = await historyService.appendToHistory(workspaceId, toolMessage);
    if (!toolResult.success) {
      throw new Error(`Failed to append tool history: ${toolResult.error}`);
    }

    const assistantResult = await historyService.appendToHistory(workspaceId, assistantMessage);
    if (!assistantResult.success) {
      throw new Error(`Failed to append assistant history: ${assistantResult.error}`);
    }
  }
}

describe("Chat truncation UI", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("shows a generic hidden indicator and preserves assistant meta rows", async () => {
    const env = await createTestEnvironment();
    const repoPath = await createTempGitRepo();
    await trustProject(env, repoPath);
    const cleanupDom = installDom();
    let view: ReturnType<typeof renderApp> | undefined;
    let workspaceId: string | undefined;

    try {
      const trunkBranch = await detectDefaultTrunkBranch(repoPath);
      const branchName = generateBranchName("ui-truncation");

      const createResult = await env.orpc.workspace.create({
        projectPath: repoPath,
        branchName,
        trunkBranch,
      });

      if (!createResult.success) {
        throw new Error(`Failed to create workspace: ${createResult.error}`);
      }

      workspaceId = createResult.metadata.id;

      const historyService = new HistoryService(env.config);
      const pairCount = 33;
      await seedHistoryWithToolCalls(historyService, workspaceId, pairCount);

      view = renderApp({ apiClient: env.orpc, metadata: createResult.metadata });
      await setupWorkspaceView(view, createResult.metadata, workspaceId);
      await waitForWorkspaceChatToRender(view.container);

      // Must match MAX_DISPLAYED_MESSAGES in StreamingMessageAggregator.ts
      const maxDisplayedMessages = 64;
      const totalDisplayedMessages = pairCount * 4;
      const oldDisplayedMessages = totalDisplayedMessages - maxDisplayedMessages;
      const oldPairs = oldDisplayedMessages / 4;
      const expectedHiddenCount = oldPairs * 3;

      const indicators = await waitFor(
        () => {
          const nodes = Array.from(
            view?.container.querySelectorAll('[data-testid="chat-message"]') ?? []
          ).filter((node) => node.textContent?.match(/some messages are hidden for performance/i));
          if (nodes.length === 0) {
            throw new Error("Truncation indicator not found");
          }
          return nodes;
        },
        // Full integration runs can hydrate the seeded transcript slower than
        // Testing Library's default 1s wait, even though the chat window exists.
        { timeout: 30_000 }
      );

      expect(indicators).toHaveLength(MAX_HISTORY_HIDDEN_SEGMENTS);

      const sumIndicatorCounts = (pattern: RegExp): number => {
        return indicators.reduce((sum, node) => {
          const match = node.textContent?.match(pattern);
          return sum + (match ? Number(match[1]) : 0);
        }, 0);
      };

      expect(sumIndicatorCounts(/(\d+)\s+messages? hidden/i)).toBe(expectedHiddenCount);
      expect(sumIndicatorCounts(/(\d+)\s+tool call/i)).toBe(oldPairs);
      expect(sumIndicatorCounts(/(\d+)\s+thinking block/i)).toBe(oldPairs);
      expect(view.getAllByRole("button", { name: /load all/i })).toHaveLength(
        MAX_HISTORY_HIDDEN_SEGMENTS
      );

      const messageBlocks = Array.from(
        view.container.querySelectorAll('[data-testid="chat-message"]')
      );
      const hiddenIndicatorCount = messageBlocks.filter((node) =>
        node.textContent?.match(/some messages are hidden for performance/i)
      ).length;
      expect(hiddenIndicatorCount).toBe(MAX_HISTORY_HIDDEN_SEGMENTS);
      const indicatorIndex = messageBlocks.findIndex((node) =>
        node.textContent?.match(/some messages are hidden for performance/i)
      );
      expect(indicatorIndex).toBeGreaterThan(0);
      // The earliest marker still appears at the first omission seam: after user-0's turn
      // (which the workspace creation card follows) and before user-1.
      const rowsBeforeIndicator = messageBlocks
        .slice(0, indicatorIndex)
        .map((node) => node.textContent ?? "");
      expect(rowsBeforeIndicator.some((text) => text.includes("user-0"))).toBe(true);
      expect(rowsBeforeIndicator.some((text) => text.includes("user-1"))).toBe(false);
      expect(messageBlocks[indicatorIndex + 1]?.textContent).toContain("user-1");

      // Verify assistant meta rows survive in the recent (non-truncated) section.
      // assistant-0 is now in the old section and gets omitted; pick a visible one instead.
      const firstRecentPairIndex = oldPairs;
      const assistantText = view.getByText(`assistant-${firstRecentPairIndex}`);
      const messageBlock = assistantText.closest("[data-message-block]");
      expect(messageBlock).toBeTruthy();
      expect(messageBlock?.querySelector("[data-message-meta]")).not.toBeNull();
    } finally {
      if (view) {
        await cleanupView(view, cleanupDom);
      } else {
        cleanupDom();
      }

      if (workspaceId) {
        try {
          await env.orpc.workspace.remove({ workspaceId, options: { force: true } });
        } catch {
          // Best effort cleanup.
        }
      }

      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(repoPath);
    }
  }, 60_000);
});

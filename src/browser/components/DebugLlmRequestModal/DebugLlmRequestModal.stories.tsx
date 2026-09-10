import { userEvent, waitFor } from "@storybook/test";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import type { DebugLlmRequestSnapshot } from "@/common/types/debugLlmRequest";
import type { AppStory } from "@/browser/stories/meta.js";
import { PIXEL_DUAL_THEME, appMeta, AppWithMocks } from "@/browser/stories/meta.js";
import { createOnChatAdapter } from "@/browser/stories/helpers/chatSetup";
import {
  collapseLeftSidebar,
  collapseRightSidebar,
  selectWorkspace,
} from "@/browser/stories/helpers/uiState";
import { createUserMessage } from "@/browser/stories/mocks/messages";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import {
  STABLE_TIMESTAMP,
  createWorkspace,
  groupWorkspacesByProject,
} from "@/browser/stories/mocks/workspaces";

const meta = {
  ...appMeta,
  title: "Components/DebugLlmRequestModal",
};

export default meta;

const createDebugLlmRequestSnapshot = (workspaceId: string): DebugLlmRequestSnapshot => ({
  capturedAt: STABLE_TIMESTAMP - 45000,
  workspaceId,
  messageId: "assistant-debug-1",
  model: "anthropic:claude-3-5-sonnet-20241022",
  providerName: "anthropic",
  thinkingLevel: "medium",
  mode: "exec",
  agentId: "exec",
  maxOutputTokens: 2048,
  systemMessage:
    "You are Xum, a focused coding agent. Follow the user’s instructions and keep answers short.",
  messages: [
    {
      role: "user",
      content: "We hit a rate limit while refactoring. Summarize the plan and retry.",
    },
    {
      role: "assistant",
      content: "Here’s a concise summary and the next steps to resume safely.",
    },
    {
      role: "tool",
      name: "write_summary",
      content: "Summarized 3 tasks, trimmed history, and queued a retry.",
    },
  ],
  response: {
    capturedAt: STABLE_TIMESTAMP - 44000,
    metadata: {
      model: "anthropic:claude-3-5-sonnet-20241022",
      usage: {
        inputTokens: 123,
        outputTokens: 456,
        totalTokens: 579,
      },
      duration: 1234,
      systemMessageTokens: 42,
    },
    parts: [
      {
        type: "text",
        text: "Here’s a concise summary and the next steps to resume safely.",
        timestamp: STABLE_TIMESTAMP - 44000,
      },
      {
        type: "dynamic-tool",
        toolCallId: "tool-1",
        toolName: "write_summary",
        state: "output-available",
        input: { tasks: 3 },
        output: { ok: true },
        timestamp: STABLE_TIMESTAMP - 43950,
      },
    ],
  },
});

// Integration: story renders full app with debug snapshot + chat error to trigger the Debug LLM Request modal.
export const DebugLlmRequestModal: AppStory = {
  parameters: {
    pixel: { matrix: PIXEL_DUAL_THEME },
  },
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        const workspaceId = "ws-debug-request";

        const workspaces = [
          createWorkspace({ id: workspaceId, name: "debug", projectName: "my-app" }),
        ];
        selectWorkspace(workspaces[0]);
        collapseRightSidebar();

        const chatHandlers = new Map([
          [
            workspaceId,
            (callback: (event: WorkspaceChatMessage) => void) => {
              setTimeout(() => {
                callback(
                  createUserMessage("msg-1", "Can you summarize what just happened?", {
                    historySequence: 1,
                    timestamp: STABLE_TIMESTAMP - 100000,
                  })
                );
                callback({ type: "caught-up" });
                callback({
                  type: "stream-error",
                  messageId: "error-msg",
                  error: "Rate limit exceeded. Please wait before making more requests.",
                  errorType: "rate_limit",
                });
              }, 50);
              // eslint-disable-next-line @typescript-eslint/no-empty-function
              return () => {};
            },
          ],
        ]);

        const lastLlmRequestSnapshots = new Map([
          [workspaceId, createDebugLlmRequestSnapshot(workspaceId)],
        ]);

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
          onChat: createOnChatAdapter(chatHandlers),
          lastLlmRequestSnapshots,
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitFor(() => {
      const debugButton = canvasElement.querySelector(
        'button[aria-label="Open last LLM request debug modal"]'
      );
      if (!debugButton) throw new Error("Debug button not found");
    });

    const debugButton = canvasElement.querySelector(
      'button[aria-label="Open last LLM request debug modal"]'
    );
    if (!debugButton) {
      throw new Error("Debug button not found");
    }
    await userEvent.click(debugButton);

    await waitFor(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog?.textContent?.includes("Last LLM request")) {
        throw new Error("Debug modal did not open");
      }
    });
  },
};

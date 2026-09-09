import { expect, userEvent, waitFor, within } from "@storybook/test";
import { createMuxMessage } from "@/common/types/message";
import { createContextBudgetRejectedMessage } from "@/common/utils/messages/contextBudgetRejection";
import { EXPERIMENT_IDS, getExperimentKey } from "@/common/constants/experiments";
import { getAutoCompactionThresholdKey, getModelKey } from "@/common/constants/storage";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { NARROW_VIEWPORT_MAX_WIDTH_PX } from "@/constants/layout";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { collapseLeftSidebar, expandLeftSidebar } from "./helpers/uiState";
import { createAssistantMessage } from "./mocks/messages";
import { STABLE_TIMESTAMP } from "./mocks/workspaces";
import { waitForScrollStabilization } from "./storyPlayHelpers.js";

export default { ...appMeta, title: "App/TokenBudget" };

const WORKSPACE_ID = "ws-token-budget";
const MODEL = "google:gemini-3.1-flash-lite";
const WARNING =
  "Save the objective and next steps to workspace/context-notes.md (up to 8 KiB) if writable.";
const FINAL_FLUSH =
  "Last step in this context window: write workspace/context-notes.md in a single memory call.";
const LEAD_IN = "Model-only instructions for retrieving earlier context windows.";

function setupTokenBudgetStory(inputTokens = 2400) {
  collapseLeftSidebar();
  updatePersistedState(getExperimentKey(EXPERIMENT_IDS.TOKEN_BUDGET), true);
  updatePersistedState(getExperimentKey(EXPERIMENT_IDS.CONTINUOUS_COMPACTION), false);
  updatePersistedState(getExperimentKey(EXPERIMENT_IDS.RLM), false);
  updatePersistedState(getModelKey(WORKSPACE_ID), MODEL);
  updatePersistedState(getAutoCompactionThresholdKey(MODEL), 70);
  const history = [
    createMuxMessage("earlier", "user", "Keep the migration reversible.", {
      historySequence: 1,
      timestamp: STABLE_TIMESTAMP - 40_000,
    }),
    createMuxMessage("warning", "user", WARNING, {
      historySequence: 2,
      timestamp: STABLE_TIMESTAMP - 30_000,
      synthetic: true,
      uiVisible: true,
      muxMetadata: { type: "context-budget-warning", contextTokens: 650_000, maxTokens: 1_000_000 },
    }),
    createMuxMessage("final-flush", "user", FINAL_FLUSH, {
      historySequence: 3,
      timestamp: STABLE_TIMESTAMP - 25_000,
      synthetic: true,
      uiVisible: true,
      muxMetadata: {
        type: "context-budget-warning",
        contextTokens: 690_000,
        maxTokens: 1_000_000,
        final: true,
      },
    }),
    createMuxMessage("rollover", "assistant", "", {
      historySequence: 4,
      timestamp: STABLE_TIMESTAMP - 20_000,
      contextBoundaryKind: "reset",
      muxMetadata: {
        type: "context-window-rollover",
        rolloverId: "rollover",
        reason: "on-send",
        previousWindowId: "w:0",
        flushOpportunity: true,
        contextTokens: 700_000,
        maxTokens: 1_000_000,
      },
    }),
    createMuxMessage("lead-in", "user", LEAD_IN, {
      historySequence: 5,
      timestamp: STABLE_TIMESTAMP - 10_000,
      synthetic: true,
      muxMetadata: { type: "context-window-lead-in", rolloverId: "rollover" },
    }),
    createMuxMessage("next", "user", "Continue with the regression tests.", {
      historySequence: 6,
      timestamp: STABLE_TIMESTAMP,
    }),
    createMuxMessage("budget-continue", "user", "Continue", {
      historySequence: 7,
      timestamp: STABLE_TIMESTAMP,
      synthetic: true,
      uiVisible: false,
      muxMetadata: { type: "normal", contextBudgetContinuation: true },
    }),
  ];
  return setupSimpleChatStory({
    workspaceId: WORKSPACE_ID,
    workspaceName: "token-budget",
    messages: [
      ...history.map((message) => ({ ...message, type: "message" as const })),
      createAssistantMessage("retrieval", "I'll retrieve the earlier decision before continuing.", {
        historySequence: 8,
        timestamp: STABLE_TIMESTAMP,
        model: MODEL,
        contextUsage: { inputTokens, outputTokens: 100 },
        toolCalls: [
          {
            type: "dynamic-tool",
            toolName: "session_history",
            toolCallId: "history-read",
            input: { action: "list_windows" },
            state: "output-available",
            output: {
              success: true,
              windows: [{ windowId: "w:0", boundaryKind: "root" }],
              exhausted: true,
              skipped_oversized_rows: 0,
            },
          },
        ],
      }),
    ],
  });
}

export const Rollover: AppStory = {
  render: () => <AppWithMocks setup={setupTokenBudgetStory} />,
  globals: { viewport: { value: "tokenBudgetDesktop", isRotated: false } },
  parameters: {
    ...appMeta.parameters,
    viewport: {
      options: {
        tokenBudgetDesktop: {
          name: "Desktop",
          styles: { width: "1900px", height: "1080px" },
          type: "desktop",
        },
      },
    },
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["desktop"] } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const boundary = await canvas.findByRole("separator", { name: "Context window rollover" });
    const earlier = await canvas.findByText("Keep the migration reversible.");
    const next = await canvas.findByText("Continue with the regression tests.");
    await expect(
      earlier.compareDocumentPosition(boundary) & Node.DOCUMENT_POSITION_FOLLOWING
    ).not.toBe(0);
    await expect(
      boundary.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING
    ).not.toBe(0);
    await expect(canvas.queryByText(LEAD_IN)).not.toBeInTheDocument();
    await expect(canvas.queryByText("Continue", { exact: true })).not.toBeInTheDocument();
    await expect(canvas.queryByText(WARNING)).not.toBeInTheDocument();
    const warning = await canvas.findByRole("button", { name: /Context budget warning/ });
    await userEvent.click(warning);
    await waitFor(() => expect(canvas.getByText(WARNING)).toBeVisible());
    await userEvent.click(warning);
    await expect(canvas.queryByText(FINAL_FLUSH)).not.toBeInTheDocument();
    const finalFlush = await canvas.findByRole("button", {
      name: /Context window ending: notes flush/,
    });
    await expect(
      finalFlush.compareDocumentPosition(boundary) & Node.DOCUMENT_POSITION_FOLLOWING
    ).not.toBe(0);
    await userEvent.click(finalFlush);
    await waitFor(() => expect(canvas.getByText(FINAL_FLUSH)).toBeVisible());
    await userEvent.click(finalFlush);
    const tool = await canvas.findByText("session_history", { exact: true });
    await userEvent.click(tool);
    await expect(await canvas.findByText("Arguments", { exact: true })).toBeVisible();
    await expect(await canvas.findByText("Result", { exact: true })).toBeVisible();
    await userEvent.click(tool);
    await waitForScrollStabilization(canvasElement);

    const frame = canvasElement.querySelector("[data-token-budget-phone]");
    if (frame) {
      await expect(frame.getBoundingClientRect().width).toBe(375);
      // CI's test-runner ignores story viewport globals; the Pixel/manager phone viewport
      // activates the app's narrow media rules, while the wrapper pins its container width.
      if (window.innerWidth <= NARROW_VIEWPORT_MAX_WIDTH_PX) {
        await expect(boundary.getBoundingClientRect().right).toBeLessThanOrEqual(
          frame.getBoundingClientRect().right
        );
        await expect(warning.getBoundingClientRect().right).toBeLessThanOrEqual(
          frame.getBoundingClientRect().right
        );
      }
    }
  },
};

export const Phone375: AppStory = {
  ...Rollover,
  globals: { viewport: { value: "mobile1", isRotated: false } },
  decorators: [
    (Story) => (
      <div data-token-budget-phone style={{ width: 375, height: 667 }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...appMeta.parameters,
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } },
  },
};

export const RejectedTail: AppStory = {
  ...Rollover,
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        return setupSimpleChatStory({
          workspaceId: "ws-token-budget-rejected",
          messages: [
            {
              ...createMuxMessage("completed-request", "user", "Run the regression tests.", {
                historySequence: 1,
                timestamp: STABLE_TIMESTAMP - 20_000,
              }),
              type: "message",
            },
            createAssistantMessage("completed-response", "The regression tests passed.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 10_000,
              model: MODEL,
            }),
            {
              ...createContextBudgetRejectedMessage(
                createMuxMessage("rejected-tail", "user", "An oversized request was rejected.", {
                  historySequence: 3,
                  timestamp: STABLE_TIMESTAMP,
                })
              ),
              type: "message",
            },
          ],
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(async () => {
      await expect(canvas.getByText("An oversized request was rejected.")).toBeVisible();
      await expect(canvas.getByText("The regression tests passed.")).toBeVisible();
    });
    await expect(canvas.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
    await expect(canvas.getByRole("textbox")).toBeEnabled();
    await waitForScrollStabilization(canvasElement);
  },
};

export const RejectedTailPhone375: AppStory = {
  ...Phone375,
  render: RejectedTail.render,
  play: RejectedTail.play,
};

export const ContextSettings: AppStory = {
  ...Rollover,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = await canvas.findByRole("button", { name: /^Context usage:/ });
    await userEvent.click(button);
    const page = within(canvasElement.ownerDocument.body);
    const dialog = await page.findByRole("dialog");
    await expect(within(dialog).getByText(/Rolls over by 75%/)).toBeVisible();
    await expect(within(dialog).getByText("Idle compaction", { exact: true })).toBeVisible();
    await expect(within(dialog).getByText("/compact", { exact: true })).toBeVisible();
  },
};

export const ContextSettingsPhone375: AppStory = {
  ...Phone375,
  play: ContextSettings.play,
};

export const ExperimentSettings: AppStory = {
  ...Rollover,
  render: () => (
    <AppWithMocks
      setup={() => {
        const client = setupTokenBudgetStory();
        expandLeftSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(
        canvas.queryByTestId("settings-button") ??
          canvas.queryByRole("button", { name: "Open sidebar menu" })
      ).not.toBeNull()
    );
    if (!canvas.queryByTestId("settings-button")) {
      await userEvent.click(canvas.getByRole("button", { name: "Open sidebar menu" }));
    }
    await userEvent.click(await canvas.findByTestId("settings-button"));
    await userEvent.click(await canvas.findByRole("button", { name: "Experiments" }));
    const toggle = await canvas.findByRole("switch", {
      name: "Toggle Token-budget context windows",
    });
    toggle.scrollIntoView({ block: "center" });
    await expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    await expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    await expect(toggle).toBeChecked();
  },
};

export const ExperimentSettingsPhone375: AppStory = {
  ...Phone375,
  render: ExperimentSettings.render,
  play: ExperimentSettings.play,
};

export const HighUsage: AppStory = {
  ...Rollover,
  render: () => <AppWithMocks setup={() => setupTokenBudgetStory(650_000)} />,
};

export const HighUsagePhone375: AppStory = {
  ...Phone375,
  render: HighUsage.render,
};

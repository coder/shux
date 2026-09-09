import { expect, userEvent, within } from "@storybook/test";
import { getAutoExpandPrefsKey } from "@/common/constants/storage";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { PhoneSubagentReportDecorator } from "./helpers/subagentReportStory";
import { collapseLeftSidebar, collapseRightSidebar } from "./helpers/uiState";
import { createAssistantMessage } from "./mocks/messages";
import { createWorkspace, STABLE_TIMESTAMP } from "./mocks/workspaces";

const WORKSPACE_ID = "ws-code-execution-spacing";
const REVIEWER_ID = "code-execution-reviewer";

function setupNestedToolsStory() {
  collapseLeftSidebar();
  collapseRightSidebar();
  updatePersistedState(getAutoExpandPrefsKey(WORKSPACE_ID), {});
  return setupSimpleChatStory({
    workspaceId: WORKSPACE_ID,
    workspaceName: "nested-tool-spacing",
    projectName: "mux",
    messages: [
      createAssistantMessage("nested-tools", "", {
        historySequence: 1,
        timestamp: STABLE_TIMESTAMP,
        toolCalls: [
          {
            type: "dynamic-tool",
            toolCallId: "code-execution",
            toolName: "code_execution",
            state: "output-available",
            input: { code: "mux.file_read({ path: 'src/config.ts' });" },
            output: { success: true, toolCalls: [], consoleOutput: [] },
            nestedCalls: [
              {
                toolCallId: "nested-report",
                toolName: "agent_report",
                state: "output-available",
                input: {
                  title: "Layout review",
                  reportMarkdown: "The tool cards should stay inside the code execution border.",
                },
                output: { success: true },
              },
              {
                toolCallId: "nested-read",
                toolName: "file_read",
                state: "output-available",
                input: { path: "src/config.ts" },
                output: {
                  success: true,
                  lines_read: 1,
                  file_size: 24,
                  content: "1\tconst debug = false;",
                },
              },
              {
                toolCallId: "nested-message",
                toolName: "task_send_message",
                state: "output-available",
                input: {
                  task_id: REVIEWER_ID,
                  message:
                    "Check both collapsed and expanded cards at phone widths.\n\nInspect src/browser/features/Tools/Shared/NestedToolsContainer.tsx for spacing shared by all nested tools.",
                },
                output: { status: "reactivated", taskId: REVIEWER_ID },
              },
            ],
          },
        ],
      }),
    ],
    additionalWorkspaces: [
      createWorkspace({
        id: REVIEWER_ID,
        name: "reviewer",
        title: "Reviewer",
        projectName: "mux",
        parentWorkspaceId: WORKSPACE_ID,
        taskStatus: "running",
      }),
    ],
  });
}

export default {
  ...appMeta,
  title: "App/CodeExecution",
};

export const NestedTools: AppStory = {
  render: () => <AppWithMocks setup={setupNestedToolsStory} />,
  globals: { viewport: { value: "desktop", isRotated: false } },
  parameters: { pixel: { matrix: { viewports: ["laptop"] } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole("button", { name: "Message to Reviewer" });
    const frame = canvas.getByRole("group", { name: "Code Execution" });
    const legend = frame.querySelector("legend")!;
    const tools = frame.querySelector(":scope > div")!;
    await expect(tools.children).toHaveLength(3);

    const checkSpacing = async () => {
      const bounds = frame.getBoundingClientRect();
      let previousBottom = legend.getBoundingClientRect().bottom;
      // Assert rendered geometry, not utility classes: every tool (including an
      // unbordered file read) needs its own clearance from the shared border.
      for (const card of tools.children) {
        const rect = card.getBoundingClientRect();
        await expect(rect.left - bounds.left).toBeGreaterThanOrEqual(8);
        await expect(bounds.right - rect.right).toBeGreaterThanOrEqual(8);
        await expect(rect.top - previousBottom).toBeGreaterThanOrEqual(8);
        await expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
        previousBottom = rect.bottom;
      }
      await expect(bounds.bottom - previousBottom).toBeGreaterThanOrEqual(8);
      await expect(frame.scrollWidth).toBeLessThanOrEqual(frame.clientWidth);
    };

    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await checkSpacing();
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
    await checkSpacing();
  },
};

export const NestedToolsPhone: AppStory = {
  ...NestedTools,
  globals: { viewport: { value: "mobile1", isRotated: false } },
  // Keep the narrow-container regression active in the desktop-sized test-runner too.
  decorators: [PhoneSubagentReportDecorator],
  parameters: { pixel: { matrix: { viewports: ["phone"] } } },
  play: async (context) => {
    await expect(context.parameters.pixel).toMatchObject({ matrix: { viewports: ["phone"] } });
    await NestedTools.play?.(context);
    const frame = within(context.canvasElement).getByRole("group", { name: "Code Execution" });
    await expect(frame.getBoundingClientRect().width).toBeLessThan(390);
  },
};

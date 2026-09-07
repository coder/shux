import { expect, userEvent, within } from "@storybook/test";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { collapseLeftSidebar } from "./helpers/uiState";
import { blurActiveElement, waitForChatInputAutofocusDone } from "./storyPlayHelpers";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getModelKey, getReasoningModeKey, getThinkingLevelKey } from "@/common/constants/storage";

export default { ...appMeta, title: "App/Astra Pro" };

const workspaceId = "ws-astra-pro";

export const CoderGateway: AppStory = {
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } } },
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        updatePersistedState(getModelKey(workspaceId), "coder:openai/gpt-6-astra");
        updatePersistedState(getThinkingLevelKey(workspaceId), "high");
        updatePersistedState(getReasoningModeKey(workspaceId), "standard");
        return setupSimpleChatStory({
          workspaceId,
          messages: [],
          routePriority: ["coder"],
          providersConfig: {
            coder: {
              apiKeySet: false,
              isEnabled: true,
              isConfigured: true,
              models: ["openai/gpt-6-astra"],
            },
          },
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const root = document.getElementById("storybook-root") ?? canvasElement;
    const canvas = within(root);
    await waitForChatInputAutofocusDone(root);
    blurActiveElement();
    const trigger = canvas.getByRole("button", { name: /Thinking:/ });
    await userEvent.click(trigger);
    const pro = canvas.getByRole("button", { name: /Pro mode/ });
    await expect(pro).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(pro);
    await expect(pro).toHaveAttribute("aria-pressed", "true");
    await expect(readPersistedState(getReasoningModeKey(workspaceId), "standard")).toBe("pro");
    await expect(trigger).toHaveAccessibleName("Thinking: high, pro mode");
    // Keyboard activation must also disable Pro without changing reasoning effort.
    pro.focus();
    await userEvent.keyboard(" ");
    await expect(pro).toHaveAttribute("aria-pressed", "false");
    await expect(trigger).toHaveAccessibleName("Thinking: high");
    await userEvent.click(pro);
    const menu = canvas.getByRole("listbox", { name: "Reasoning effort" });
    await expect(menu.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    await expect(menu.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
  },
};

export const Desktop: AppStory = {
  ...CoderGateway,
  globals: { viewport: { value: "desktop", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["laptop"] } } },
  play: async (context) => CoderGateway.play!(context),
};

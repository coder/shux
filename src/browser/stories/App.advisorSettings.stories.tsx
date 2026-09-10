import { expect, userEvent, waitFor, within } from "@storybook/test";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { expandLeftSidebar } from "./helpers/uiState";
import { setupSettingsStory } from "@/browser/features/Settings/Sections/settingsStoryUtils";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { APIClient } from "@/browser/contexts/API";

export default { ...appMeta, title: "App/AdvisorSettings" };

function setupAdvisorSettings() {
  expandLeftSidebar();
  const client = setupSettingsStory({
    experiments: { [EXPERIMENT_IDS.ADVISOR_TOOL]: true },
    providersConfig: {
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
    },
  });
  const advisorSettings: Pick<
    Awaited<ReturnType<APIClient["config"]["getConfig"]>>,
    "advisorModelString" | "advisorThinkingLevel" | "advisorReasoningMode"
  > = {
    advisorModelString: "openai:gpt-6-astra",
    advisorThinkingLevel: "low",
    advisorReasoningMode: "standard",
  };
  const getConfig = client.config.getConfig;
  const saveConfig = client.config.saveConfig;
  client.config.getConfig = async () => ({ ...(await getConfig()), ...advisorSettings });
  client.config.saveConfig = async (input) => {
    if (input.advisorModelString !== undefined)
      advisorSettings.advisorModelString = input.advisorModelString;
    if (input.advisorThinkingLevel !== undefined)
      advisorSettings.advisorThinkingLevel = input.advisorThinkingLevel;
    if (input.advisorReasoningMode !== undefined)
      advisorSettings.advisorReasoningMode = input.advisorReasoningMode;
    await saveConfig(input);
  };
  return client;
}

async function exerciseAdvisorMode(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByTestId("settings-button", {}, { timeout: 10000 }));
  await userEvent.click(await canvas.findByRole("button", { name: "Experiments" }));
  const trigger = await canvas.findByRole("button", { name: "Reasoning" });
  await expect(trigger).toHaveTextContent("Low");
  trigger.scrollIntoView({ block: "center" });
  await userEvent.click(trigger);
  const mode = canvas.getByRole("button", { name: /Pro mode/ });
  await expect(mode).toHaveAttribute("aria-pressed", "false");
  await expect(canvas.queryByRole("option", { name: "Off" })).toBeNull();
  await expect(canvas.queryByRole("button", { name: /Fast mode/ })).toBeNull();
  await userEvent.click(mode);
  await expect(mode).toHaveAttribute("aria-pressed", "true");
  await userEvent.click(canvas.getByRole("option", { name: "Max" }));
  await expect(trigger).toHaveTextContent("Max");
  await expect(trigger).toHaveTextContent("PRO");
  await waitFor(() => expect(mode).toHaveAttribute("aria-pressed", "true"));
  const menu = canvas.getByRole("listbox", { name: "Reasoning effort" });
  await expect(menu.getBoundingClientRect().right).toBeLessThanOrEqual(
    trigger.getBoundingClientRect().right
  );
  // The test runner ignores viewport globals, so bounds apply only to the pinned phone render.
  if (window.innerWidth < 768) {
    await expect(menu.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    await expect(trigger.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  }
}

export const Desktop: AppStory = {
  globals: { viewport: { value: "desktop", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["desktop"] } } },
  render: () => <AppWithMocks setup={setupAdvisorSettings} />,
  play: async ({ canvasElement }) => exerciseAdvisorMode(canvasElement),
};

export const Tablet: AppStory = {
  ...Desktop,
  globals: { viewport: { value: "tablet", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["tablet"] } } },
  play: async ({ canvasElement }) => exerciseAdvisorMode(canvasElement),
};

export const Phone: AppStory = {
  ...Desktop,
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } } },
  play: async ({ canvasElement }) => exerciseAdvisorMode(canvasElement),
};

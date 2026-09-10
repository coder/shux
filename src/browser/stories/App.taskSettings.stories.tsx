import { expect, userEvent, within } from "@storybook/test";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { expandLeftSidebar } from "./helpers/uiState";
import { setupSettingsStory } from "@/browser/features/Settings/Sections/settingsStoryUtils";

export default {
  ...appMeta,
  title: "App/TaskSettings",
};

function setupTaskSettings() {
  expandLeftSidebar();
  return setupSettingsStory({
    // A global Pro default must not make the unknown calling chat look Pro.
    agentAiDefaults: {
      exec: { modelString: "openai:gpt-5.6-sol", thinkingLevel: "high", reasoningMode: "pro" },
    },
    providersConfig: {
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
    },
  });
}

async function exerciseInheritance(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByTestId("settings-button", {}, { timeout: 10000 }));
  await userEvent.click(await canvas.findByRole("button", { name: "Agents" }));
  const card = await canvas.findByRole("group", { name: "Exec defaults" });
  const controls = within(card);
  const trigger = controls.getByRole("button", { name: "Reasoning" });
  await userEvent.click(trigger);
  const mode = controls.getByRole("button", { name: /Pro mode/ });
  await expect(mode).toHaveAttribute("aria-pressed", "mixed");
  await expect(controls.queryByRole("button", { name: /Fast mode/ })).toBeNull();
  const levels = within(controls.getByRole("listbox", { name: "Reasoning effort" }));
  await userEvent.click(levels.getByRole("option", { name: "Max" }));
  await expect(mode).toHaveAttribute("aria-pressed", "mixed");
  await expect(trigger).toHaveTextContent("Max");
  await userEvent.click(mode);
  await expect(mode).toHaveAttribute("aria-pressed", "true");
  await userEvent.click(mode);
  await expect(mode).toHaveAttribute("aria-pressed", "false");
  await expect(trigger).toHaveTextContent("STANDARD");
  await userEvent.click(levels.getByRole("option", { name: "Use calling chat’s Exec" }));
  await expect(mode).toHaveAttribute("aria-pressed", "mixed");
  card.scrollIntoView({ block: "start" });

  // The test-runner ignores viewport globals/Pixel matrices. Check narrow bounds
  // only in the real phone viewport, not its desktop-sized test-runner window.
  if (window.innerWidth < 768) {
    const menu = controls.getByRole("listbox", { name: "Reasoning effort" });
    await expect(card.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    await expect(menu.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    await expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
  }
}

export const Desktop: AppStory = {
  globals: { viewport: { value: "desktop", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["desktop"] } } },
  render: () => <AppWithMocks setup={setupTaskSettings} />,
  play: async ({ canvasElement }) => exerciseInheritance(canvasElement),
};

export const Phone: AppStory = {
  ...Desktop,
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } } },
  play: async ({ canvasElement }) => exerciseInheritance(canvasElement),
};

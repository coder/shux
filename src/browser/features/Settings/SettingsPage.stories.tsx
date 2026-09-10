import { appMeta, AppWithMocks, type AppStory } from "@/browser/stories/meta.js";
import { waitFor, within, userEvent } from "@storybook/test";
import { setupSettingsStory } from "./Sections/settingsStoryUtils.js";

export default {
  ...appMeta,
  title: "Settings/SettingsPage",
};

const BASE_SECTION_LABELS = [
  "General",
  "Agents",
  "Providers",
  "Models",
  "MCP",
  "Secrets",
  "Security",
  "Server Access",
  "Layouts",
  "Runtimes",
  "Experiments",
  "Keybinds",
  "Backup",
] as const;

type BaseSectionLabel = (typeof BASE_SECTION_LABELS)[number];
type SectionNavLabel = BaseSectionLabel;

const SECTION_CONTENT_MATCHERS: Record<BaseSectionLabel, RegExp> = {
  General: /Theme/i,
  Agents: /Max Parallel Agent Tasks/i,
  Providers: /Configure API keys and endpoints for AI providers|API Key/i,
  Models: /Custom Models|Built-in Models/i,
  MCP: /MCP Servers/i,
  Secrets: /Secrets are stored in/i,
  Security: /Project Trust/i,
  "Server Access": /Server access sessions/i,
  Layouts: /Layout Slots|Add layout/i,
  Runtimes: /Default runtime/i,
  Experiments: /Experimental features that are still in development/i,
  Keybinds: /Open agent picker/i,
  Backup: /Settings backup/i,
};

async function openSettings(canvasElement: HTMLElement): Promise<void> {
  const canvas = within(canvasElement);

  const settingsButton = await canvas.findByTestId("settings-button", {}, { timeout: 10000 });
  await userEvent.click(settingsButton);
}

async function clickSectionButton(
  canvasElement: HTMLElement,
  sectionLabel: SectionNavLabel
): Promise<void> {
  const canvas = within(canvasElement);

  // Desktop + mobile settings nav buttons can both exist in the test DOM.
  const sectionButtons = await canvas.findAllByRole("button", {
    name: new RegExp(`^${sectionLabel}$`, "i"),
  });
  const sectionButton = sectionButtons[0];
  if (!sectionButton) {
    throw new Error(`Settings section button not found for ${sectionLabel}`);
  }

  await userEvent.click(sectionButton);
}

async function assertSectionBodyRendered(
  canvasElement: HTMLElement,
  sectionLabel: BaseSectionLabel
): Promise<void> {
  const canvas = within(canvasElement);
  const sectionContentMatcher = SECTION_CONTENT_MATCHERS[sectionLabel];

  await waitFor(
    () => {
      if (canvas.queryAllByText(sectionContentMatcher).length === 0) {
        throw new Error(`Expected ${sectionLabel} section content to render.`);
      }
    },
    { timeout: 2500 }
  );
}

export const SectionsSmoke: AppStory = {
  render: () => <AppWithMocks setup={() => setupSettingsStory({})} />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettings(canvasElement);

    for (const sectionLabel of BASE_SECTION_LABELS) {
      await clickSectionButton(canvasElement, sectionLabel);
      await assertSectionBodyRendered(canvasElement, sectionLabel);
    }
  },
};

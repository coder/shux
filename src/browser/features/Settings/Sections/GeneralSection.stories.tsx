import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { lightweightMeta } from "@/browser/stories/meta.js";
import {
  DEFAULT_TERMINAL_BADGE_CONFIG,
  TERMINAL_BADGE_CONFIG_KEY,
  type TerminalBadgeConfig,
} from "@/common/constants/storage";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { within } from "@storybook/test";
import { GeneralSection } from "./GeneralSection.js";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/GeneralSection",
  component: GeneralSection,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const General: Story = {
  render: () => (
    <SettingsSectionStory setup={() => setupSettingsStory({})}>
      <GeneralSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByText(/^Theme$/i);
    await canvas.findByText(/^Terminal Font$/i);
    await canvas.findByText(/^Terminal Font Size$/i);
  },
};

export const TerminalBadgeEnabledPhone: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() => {
        const client = setupSettingsStory({});
        // Seed after the story reset so the enabled-only badge rows render;
        // the phone Pixel snapshot guards their narrow-width wrapping.
        updatePersistedState<TerminalBadgeConfig>(TERMINAL_BADGE_CONFIG_KEY, {
          ...DEFAULT_TERMINAL_BADGE_CONFIG,
          enabled: true,
        });
        return client;
      }}
    >
      <GeneralSection />
    </SettingsSectionStory>
  ),
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: {
    pixel: { matrix: { viewports: ["phone"] } },
    docs: {
      description: {
        story:
          "Pins the phone-width contract for the enabled badge settings rows (template/position/opacity/font size), which only render when the badge is on.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Static contract: the enabled-only rows must be present, otherwise the
    // phone snapshot would silently capture the collapsed (disabled) UI.
    await canvas.findByLabelText("Terminal Badge Template");
    await canvas.findByLabelText("Terminal Badge Opacity");
    await canvas.findByLabelText("Terminal Badge Font Size");
  },
};

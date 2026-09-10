import { expect, waitFor, within } from "@storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { DEFAULT_GOAL_DEFAULTS } from "@/constants/goals";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ExperimentsSection } from "./ExperimentsSection.js";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/ExperimentsSection",
  component: ExperimentsSection,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Experiments: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          // Seed the parent off explicitly so the "sub-experiments hidden"
          // assertion does not rely on the experiment's default value.
          experiments: { [EXPERIMENT_IDS.MEMORY]: false },
        })
      }
    >
      <ExperimentsSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Memory sub-experiments are nested under Agent Memory, so with the parent
    // off they must not appear anywhere in the list.
    await canvas.findByLabelText("Toggle Agent Memory");
    await expect(canvas.queryByLabelText("Toggle Memory Intuition")).toBeNull();
    await expect(canvas.queryByLabelText("Toggle Memory Hot Set")).toBeNull();
    await expect(canvas.queryByLabelText("Toggle Memory Consolidation")).toBeNull();
  },
};

export const MemorySettingsEnabled: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          experiments: { [EXPERIMENT_IDS.MEMORY]: true },
        })
      }
    >
      <ExperimentsSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // With Agent Memory enabled, the sub-experiment toggles render in the
    // nested panel under the parent row.
    await canvas.findByLabelText("Toggle Memory Intuition");
    await canvas.findByLabelText("Toggle Memory Hot Set");
    await canvas.findByLabelText("Toggle Memory Consolidation");
  },
};

export const ExperimentsToggleOn: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          experiments: { [EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING]: true },
        })
      }
    >
      <ExperimentsSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // With PTC enabled, the RLM Mode sub-experiment renders in the nested
    // panel under the parent row.
    await canvas.findByLabelText("Toggle RLM Mode");
  },
};

export const HeartbeatSettingsEnabled: Story = {
  // Goals graduated to GA, so they no longer appear in the Experiments
  // panel at all (configuration lives in the Goal tab's
  // `GoalDefaultsSection`). Heartbeat defaults still render inline here.
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          experiments: {
            [EXPERIMENT_IDS.WORKSPACE_HEARTBEATS]: true,
          },
          goalDefaults: {
            ...DEFAULT_GOAL_DEFAULTS,
            defaultBudgetCents: 350,
            defaultTurnCap: 8,
          },
          heartbeatDefaultIntervalMs: 45 * 60_000,
          heartbeatDefaultPrompt: "Review pending work before continuing.",
        })
      }
    >
      <ExperimentsSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Goal defaults no longer render inline — they live in the Goal tab.
    await expect(canvas.queryByLabelText("Default goal budget in dollars")).toBeNull();
    await expect(canvas.queryByLabelText("Default goal turn cap")).toBeNull();

    // Heartbeat defaults still render inline.
    const heartbeatThresholdInput = await canvas.findByLabelText(
      "Default heartbeat threshold in minutes"
    );
    await waitFor(() => expect(heartbeatThresholdInput).toHaveValue(45));

    const heartbeatPrompt = await canvas.findByLabelText("Default heartbeat prompt");
    await waitFor(() =>
      expect(heartbeatPrompt).toHaveValue("Review pending work before continuing.")
    );
  },
};

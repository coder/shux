import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "@storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { createWorkspace, groupWorkspacesByProject } from "@/browser/stories/mocks/workspaces";
import { selectWorkspace } from "@/browser/stories/helpers/uiState";
import { InstructionsSection } from "./InstructionsSection.js";
import { SettingsSectionStory } from "./settingsStoryUtils.js";

const PROJECT_PATH_A = "/Users/test/my-app";
const PROJECT_PATH_B = "/Users/test/other-app";

function setupInstructionsStory(customInstructions?: string) {
  const workspaces = [
    createWorkspace({
      id: "ws-instructions-a",
      name: "main",
      projectName: "my-app",
      projectPath: PROJECT_PATH_A,
    }),
    createWorkspace({
      id: "ws-instructions-b",
      name: "main",
      projectName: "other-app",
      projectPath: PROJECT_PATH_B,
    }),
  ];

  selectWorkspace(workspaces[0]);

  const projects = groupWorkspacesByProject(workspaces);
  const projectA = projects.get(PROJECT_PATH_A);
  if (projectA && customInstructions) {
    projectA.customInstructions = customInstructions;
  }

  return createMockORPCClient({ workspaces, projects });
}

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/InstructionsSection",
  component: InstructionsSection,
};

export default meta;
type Story = StoryObj<typeof meta>;

function renderInstructionsSection(setup: () => ReturnType<typeof createMockORPCClient>) {
  return (
    <SettingsSectionStory setup={setup}>
      <div className="bg-background p-6">
        <InstructionsSection />
      </div>
    </SettingsSectionStory>
  );
}

export const Empty: Story = {
  render: () => renderInstructionsSection(() => setupInstructionsStory()),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByText(/Custom instructions are appended to the system prompt/i);
    await canvas.findByRole("textbox", { name: /Project custom instructions/i });
  },
};

export const WithSavedInstructions: Story = {
  render: () =>
    renderInstructionsSection(() =>
      setupInstructionsStory(
        "Always run the full test suite before committing.\nPrefer small, reviewable changes."
      )
    ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByDisplayValue(/Always run the full test suite before committing/i);
  },
};

export const DirtyDraftEnablesSave: Story = {
  render: () => renderInstructionsSection(() => setupInstructionsStory()),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const textarea = await canvas.findByRole("textbox", {
      name: /Project custom instructions/i,
    });
    // Projects load asynchronously; until one is selected the textarea is
    // disabled and userEvent.type would silently no-op (flaked in Pixel).
    await waitFor(() => expect(textarea).toBeEnabled());
    await userEvent.type(textarea, "Never commit directly to main.");

    const saveButton = await canvas.findByRole("button", { name: /^Save$/i });
    await waitFor(() => expect(saveButton).toBeEnabled());
  },
};

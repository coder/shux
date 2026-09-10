import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "@storybook/test";

import { lightweightMeta } from "@/browser/stories/meta.js";
import type { WorkspaceStackInfo } from "@/common/types/links";
import { PRStackBadge } from "./PRStackBadge";

const STACK: WorkspaceStackInfo = {
  trunk: "main",
  branches: [
    {
      branch: "mike/stack-foundation",
      isCurrent: false,
      needsRebase: false,
      pr: {
        number: 28051,
        url: "https://github.com/coder/mux/pull/28051",
        state: "MERGED",
        title: "feat: add the stack foundation",
      },
    },
    {
      branch: "mike/stack-store",
      isCurrent: false,
      needsRebase: false,
      pr: {
        number: 28052,
        url: "https://github.com/coder/mux/pull/28052",
        state: "OPEN",
        title: "feat: cache stack metadata for visible workspaces",
      },
    },
    {
      branch: "mike/stack-menu",
      isCurrent: true,
      needsRebase: false,
      pr: {
        number: 28053,
        url: "https://github.com/coder/mux/pull/28053",
        state: "OPEN",
        title: "feat: add a pull request stack dropdown with long titles",
        isDraft: true,
      },
    },
    {
      branch: "mike/stack-responsive",
      isCurrent: false,
      needsRebase: true,
      pr: {
        number: 28054,
        url: "https://github.com/coder/mux/pull/28054",
        state: "OPEN",
        title: "fix: keep the stack menu inside narrow viewports",
      },
    },
    {
      branch: "mike/stack-submit",
      isCurrent: false,
      needsRebase: false,
    },
    {
      branch: "mike/stack-queue",
      isCurrent: false,
      needsRebase: false,
      pr: {
        number: 28056,
        url: "https://github.com/coder/mux/pull/28056",
        state: "QUEUED",
        title: "feat: finish stack awareness",
      },
    },
  ],
};

const meta = {
  ...lightweightMeta,
  title: "App/Header/PRStackBadge",
  component: PRStackBadge,
} satisfies Meta<typeof PRStackBadge>;

export default meta;

type Story = StoryObj<typeof meta>;

async function openStackMenu(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "View stack with 6 branches" }));
}

export const SixLayerStack: Story = {
  args: {
    stack: STACK,
    menuDirection: "down",
  },
  render: (args) => (
    <div className="bg-background min-h-96 p-6">
      <div className="flex justify-end">
        <PRStackBadge {...args} />
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => openStackMenu(canvasElement),
};

export const PhoneWidth: Story = {
  args: {
    stack: STACK,
    menuDirection: "down",
  },
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: {
    pixel: {
      matrix: { viewports: ["phone"] },
    },
  },
  render: (args) => (
    <div className="bg-background min-h-96 w-full p-2">
      <div className="flex justify-end">
        <PRStackBadge {...args} />
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => openStackMenu(canvasElement),
};

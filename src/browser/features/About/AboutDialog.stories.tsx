import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "@storybook/test";
import type { UpdateStatus } from "@/common/orpc/types";
import { APIProvider } from "@/browser/contexts/API";
import { AboutDialogProvider, useAboutDialog } from "@/browser/contexts/AboutDialogContext";
import { Button } from "@/browser/components/Button/Button";
import { lightweightMeta } from "@/browser/stories/meta";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { AboutDialog } from "./AboutDialog";

function OpenAbout() {
  const about = useAboutDialog();
  return (
    <>
      <Button onClick={about.open}>Open About</Button>
      <AboutDialog />
    </>
  );
}

function ServerUpdateStory(props: { status: UpdateStatus }) {
  const [client] = useState(() =>
    createMockORPCClient({ updateStatus: props.status, updateChannel: "nightly" })
  );
  return (
    <APIProvider client={client}>
      <AboutDialogProvider>
        <OpenAbout />
      </AboutDialogProvider>
    </APIProvider>
  );
}

const meta = {
  ...lightweightMeta,
  title: "Features/About/Server updates",
  component: ServerUpdateStory,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Open About" }));
  },
} satisfies Meta<typeof ServerUpdateStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Unsupported: Story = {
  args: {
    status: {
      type: "unsupported",
      reason: "Server updates require a supervisor configured to restart after exit",
    },
  },
  play: async (context) => {
    await meta.play(context);
    const dialog = await within(document.body).findByRole("dialog");
    await expect(
      within(dialog).queryByRole("button", { name: "Install & restart" })
    ).not.toBeInTheDocument();
    await expect(
      within(dialog).queryByRole("button", { name: "Check for Updates" })
    ).not.toBeInTheDocument();
  },
};

export const Downloading: Story = {
  args: { status: { type: "downloading", percent: null } },
  play: async (context) => {
    await meta.play(context);
    const dialog = await within(document.body).findByRole("dialog");
    await expect(within(dialog).getByRole("button", { name: "Check for Updates" })).toBeDisabled();
  },
};

export const BlockedPhone: Story = {
  args: {
    status: {
      type: "install-blocked",
      info: { version: "0.28.4-next.123.g123456789" },
      blockers: [
        { kind: "pending-turns", count: 2 },
        { kind: "terminals", count: 1 },
      ],
    },
  },
  parameters: { pixel: { matrix: { viewports: ["phone"] } } },
  globals: { viewport: { value: "mobile1", isRotated: false } },
  play: async (context) => {
    await meta.play(context);
    const dialog = await within(document.body).findByRole("dialog");
    const retry = within(dialog).getByRole("button", { name: "Install & restart" });
    await expect(retry).toBeEnabled();
    await expect(within(dialog).getByRole("status")).toBeVisible();
    if (window.innerWidth <= 440) {
      await expect(dialog.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
      await expect(retry.getBoundingClientRect().right).toBeLessThanOrEqual(
        dialog.getBoundingClientRect().right
      );
    }
  },
};

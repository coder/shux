import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, mocked, userEvent, waitFor, within } from "storybook/test";
import { useState, type ComponentProps } from "react";
import { ForceDeleteModal } from "./ForceDeleteModal";

const descendants = [
  { workspaceId: "child-review", title: "Review child", active: false },
  { workspaceId: "child-build", title: "Build child", active: false },
];

const meta = {
  title: "Components/ForceDeleteModal",
  component: ForceDeleteModal,
  args: {
    isOpen: true,
    workspaceId: "parent",
    error: "Descendant confirmation required",
    descendants,
    onClose: fn(),
    onForceDelete: fn<ComponentProps<typeof ForceDeleteModal>["onForceDelete"]>(() =>
      Promise.resolve({ success: true })
    ),
  },
  render: function StatefulDialog(args) {
    const [open, setOpen] = useState(true);
    return (
      <ForceDeleteModal
        {...args}
        isOpen={open}
        onClose={() => {
          args.onClose();
          setOpen(false);
        }}
      />
    );
  },
} satisfies Meta<typeof ForceDeleteModal>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ExplicitScope: Story = {
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement.ownerDocument.body);
    const dialog = await page.findByRole("dialog");
    const scope = within(dialog).getByRole("region", { name: "Descendant workspaces" });
    await expect(within(scope).getAllByRole("listitem")).toHaveLength(2);
    await expect(args.onForceDelete).not.toHaveBeenCalled();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete Workspace and Descendants" })
    );
    await waitFor(() =>
      expect(args.onForceDelete).toHaveBeenCalledWith("parent", ["child-review", "child-build"])
    );
    await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument());
    await expect(args.onClose).toHaveBeenCalledTimes(1);
  },
};

export const ActiveDescendantBlocksShortcut: Story = {
  args: { descendants: [{ ...descendants[0], active: true }] },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement.ownerDocument.body);
    const dialog = await page.findByRole("dialog");
    await expect(within(dialog).getAllByRole("button")).toHaveLength(1);
    dialog.focus();
    await userEvent.keyboard("y");
    await expect(args.onForceDelete).not.toHaveBeenCalled();
    await expect(args.onClose).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument());
  },
};

export const RetryRefreshesScope: Story = {
  beforeEach: ({ args }) => {
    mocked(args.onForceDelete)
      .mockResolvedValueOnce({
        success: false,
        error: "New descendants need confirmation",
        descendants: [descendants[1]],
      })
      .mockResolvedValue({ success: true });
  },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement.ownerDocument.body);
    const dialog = await page.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete Workspace and Descendants" })
    );
    await expect(await page.findByText("New descendants need confirmation")).toBeVisible();
    await expect(args.onClose).not.toHaveBeenCalled();
    await expect(within(dialog).getAllByRole("listitem")).toHaveLength(1);
    await expect(page.queryByText(descendants[0].title)).not.toBeInTheDocument();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete Workspace and Descendants" })
    );
    await expect(args.onForceDelete).toHaveBeenNthCalledWith(1, "parent", [
      "child-review",
      "child-build",
    ]);
    await expect(args.onForceDelete).toHaveBeenNthCalledWith(2, "parent", ["child-build"]);
    await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument());
  },
};

export const RetryBecomesBlocked: Story = {
  beforeEach: ({ args }) => {
    mocked(args.onForceDelete).mockResolvedValue({
      success: false,
      error: "Child starts running",
      descendants: [{ ...descendants[0], active: true }],
    });
  },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement.ownerDocument.body);
    const dialog = await page.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete Workspace and Descendants" })
    );
    await expect(await page.findByText("Child starts running")).toBeVisible();
    await expect(within(dialog).getAllByRole("button")).toHaveLength(1);
    dialog.focus();
    await userEvent.keyboard("y");
    await expect(args.onForceDelete).toHaveBeenCalledTimes(1);
    await expect(args.onClose).not.toHaveBeenCalled();
  },
};

export const RejectedRetryRemainsVisible: Story = {
  beforeEach: ({ args }) => {
    mocked(args.onForceDelete).mockRejectedValue(new Error("Transport unavailable"));
  },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement.ownerDocument.body);
    const dialog = await page.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete Workspace and Descendants" })
    );
    await expect(await page.findByText("Transport unavailable")).toBeVisible();
    await expect(within(dialog).getAllByRole("listitem")).toHaveLength(2);
    await expect(
      within(dialog).getByRole("button", { name: "Delete Workspace and Descendants" })
    ).toBeEnabled();
    await expect(args.onClose).not.toHaveBeenCalled();
  },
};

export const Phone: Story = {
  globals: { viewport: { value: "phone390", isRotated: false } },
  parameters: { pixel: { matrix: { viewports: ["phone"] } } },
  args: {
    descendants: [
      {
        workspaceId: "child-" + "long-id-".repeat(16),
        title: "A long descendant title that must wrap inside the deletion dialog",
        active: false,
      },
    ],
  },
  play: async ({ canvasElement, parameters, globals }) => {
    await expect(parameters).toMatchObject({ pixel: { matrix: { viewports: ["phone"] } } });
    await expect(globals).toMatchObject({ viewport: { value: "phone390" } });
    const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog");
    if (window.innerWidth <= 390) {
      await expect(dialog.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
      await expect(dialog.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
      await expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
      const button = within(dialog).getByRole("button", {
        name: "Delete Workspace and Descendants",
      });
      await expect(button).toBeVisible();
      await expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
      await expect(within(button).getByText("Y")).not.toBeVisible();
    }
  },
};

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "@storybook/test";
import { InitMessage } from "@/browser/features/Messages/InitMessage";
import { STABLE_TIMESTAMP } from "@/browser/stories/mocks/workspaces";
import { lightweightMeta } from "@/browser/stories/meta.js";
import type { DisplayedMessage } from "@/common/types/message";

type WorkspaceInitMessage = Extract<DisplayedMessage, { type: "workspace-init" }>;

const RUNNING_MESSAGE: WorkspaceInitMessage = {
  type: "workspace-init",
  id: "workspace-init",
  historySequence: -1,
  status: "running",
  hookPath: "/home/user/projects/my-app",
  lines: [
    { line: "Preparing workspace", isError: false, step: true },
    { line: "Creating git worktree", isError: false, step: true },
    { line: "Preparing worktree (new branch 'feature')", isError: false },
    { line: "Checking out files", isError: false, step: true },
    { line: "HEAD is now at 1234567 Add application", isError: false },
  ],
  progress: { label: "Updating files", percent: 87 },
  exitCode: null,
  timestamp: STABLE_TIMESTAMP,
  durationMs: null,
};

const SUCCESS_MESSAGE: WorkspaceInitMessage = {
  ...RUNNING_MESSAGE,
  status: "success",
  lines: [
    ...RUNNING_MESSAGE.lines,
    { line: "Running init hook: .xum/init", isError: false, step: true },
    { line: "Dependencies installed", isError: false },
  ],
  progress: null,
  exitCode: 0,
  durationMs: 3000,
};

const ERROR_MESSAGE: WorkspaceInitMessage = {
  ...SUCCESS_MESSAGE,
  status: "error",
  lines: [...SUCCESS_MESSAGE.lines, { line: "Package installation failed", isError: true }],
  exitCode: 1,
};

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Messages/Init",
  component: InitMessage,
  render: (args) => (
    <div className="bg-background flex min-h-screen items-start p-6">
      <div className="w-full max-w-2xl min-w-0">
        <InitMessage {...args} />
      </div>
    </div>
  ),
} satisfies Meta<typeof InitMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Running: Story = {
  args: { message: RUNNING_MESSAGE },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "87");
    await expect(canvas.getAllByLabelText("Completed")).toHaveLength(2);
    await expect(canvas.getByLabelText("In progress")).toBeVisible();
    const details = canvas.getByRole("button", { name: "More details" });
    await expect(details).toHaveAttribute("aria-expanded", "false");
    await expect(canvas.queryByText(RUNNING_MESSAGE.hookPath)).not.toBeInTheDocument();
    await userEvent.click(details);
    await expect(canvas.getByText(RUNNING_MESSAGE.hookPath)).toBeVisible();
    await expect(canvas.getByText(RUNNING_MESSAGE.lines[2].line)).toBeVisible();
    await userEvent.click(details);
  },
};

export const RunningWithoutProgress: Story = {
  args: { message: { ...RUNNING_MESSAGE, progress: null } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("progressbar")).not.toBeInTheDocument();
    await expect(canvas.getByLabelText("In progress")).toBeVisible();
  },
};

export const InitHookSuccess: Story = {
  args: { message: SUCCESS_MESSAGE },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const header = canvas.getByRole("button", { name: /Workspace created/ });
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(canvas.queryByRole("list")).not.toBeInTheDocument();
    await userEvent.click(header);
    await expect(canvas.getByText("Dependencies installed")).toBeVisible();
    await expect(canvas.getAllByLabelText("Completed")).toHaveLength(4);
    await userEvent.click(header);
    await expect(canvas.queryByText("Dependencies installed")).not.toBeInTheDocument();
  },
};

export const InitHookError: Story = {
  args: { message: ERROR_MESSAGE },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: /Workspace setup failed/ })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    await expect(canvas.getByRole("button", { name: "More details" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    await expect(canvas.getByText("Package installation failed")).toHaveClass(
      "text-init-output-error-text"
    );
    await expect(canvas.getByLabelText("Failed")).toBeVisible();
  },
};

export const LegacySuccess: Story = {
  args: {
    message: {
      ...SUCCESS_MESSAGE,
      lines: SUCCESS_MESSAGE.lines.map(({ line, isError }) => ({ line, isError })),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /Workspace created/ }));
    await expect(canvas.getByText("Dependencies installed")).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "More details" })).not.toBeInTheDocument();
    await expect(canvas.queryByRole("list")).not.toBeInTheDocument();
  },
};

export const RunningPhone: Story = {
  ...Running,
  args: {
    message: {
      ...RUNNING_MESSAGE,
      lines: [
        ...RUNNING_MESSAGE.lines,
        {
          line: "Checking out files for a workspace with a very long descriptive branch name",
          isError: false,
          step: true,
        },
      ],
    },
  },
  decorators: [
    (Story) => (
      <div data-testid="init-phone" style={{ width: 375, maxWidth: "100%" }}>
        <Story />
      </div>
    ),
  ],
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: { pixel: { matrix: { viewports: ["phone"] } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const frame = canvas.getByTestId("init-phone");
    const progress = canvas.getByRole("progressbar");
    await expect(frame.getBoundingClientRect().width).toBeLessThanOrEqual(375);
    await expect(frame.scrollWidth).toBeLessThanOrEqual(frame.clientWidth);
    await expect(progress.getBoundingClientRect().width).toBeGreaterThan(0);
    await expect(progress.getBoundingClientRect().right).toBeLessThanOrEqual(
      frame.getBoundingClientRect().right
    );
    const percent = canvas.getByText("87%");
    await expect(percent.getBoundingClientRect().right).toBeLessThanOrEqual(
      frame.getBoundingClientRect().right
    );
  },
};

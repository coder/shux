import type { ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "@storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { ConcurrentLocalWarningDecoration } from "./ConcurrentLocalWarning.js";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Components/ConcurrentLocalWarning",
  component: ConcurrentLocalWarningDecoration,
  play: async ({ canvasElement }) => checkComposerLayout(canvasElement),
} satisfies Meta<typeof ConcurrentLocalWarningDecoration>;

export default meta;

type Story = StoryObj<typeof meta>;

async function checkComposerLayout(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const status = canvas.getByRole("status");
  const label = status.querySelector("span")!;
  const composer = canvas.getByTestId("concurrency-composer");
  const input = canvas.getByTestId("concurrency-input");
  await expect(status).toBeVisible();
  await expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
  await expect(getComputedStyle(label).fontVariantNumeric).toContain("tabular-nums");
  await expect(status.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    input.getBoundingClientRect().top
  );
  await expect(status.getBoundingClientRect().right).toBeLessThanOrEqual(
    composer.getBoundingClientRect().right
  );
}

function renderComposerDecoration(args: ComponentProps<typeof ConcurrentLocalWarningDecoration>) {
  return (
    <div
      data-testid="concurrency-composer"
      className="bg-surface-primary text-light flex h-[360px] flex-col"
    >
      <div className="min-h-0 flex-1 overflow-hidden p-4">
        <div className="mx-auto max-w-4xl space-y-4 text-sm">
          <div className="ml-auto max-w-[70%] rounded-lg border border-[var(--color-user-border)] bg-[var(--color-user-surface)] px-3 py-2">
            Can you keep working while I ask another agent to inspect the same checkout?
          </div>
          <div className="border-border bg-background-secondary text-muted rounded-lg border px-3 py-2">
            I&apos;ll continue here, but there is another local workspace actively running in this
            project directory.
          </div>
        </div>
      </div>
      {/* Keep the warning in the composer decoration lane so appended transcript rows do not
          insert above it and trigger bottom-lock correction flashes. */}
      <ConcurrentLocalWarningDecoration {...args} />
      <div
        data-testid="concurrency-input"
        className="border-border bg-surface-primary border-t px-4 py-3"
      >
        <div className="border-border bg-background-secondary text-muted mx-auto max-w-4xl rounded-lg border px-3 py-2 text-sm">
          Ask Xum anything...
        </div>
      </div>
    </div>
  );
}

export const ComposerDecoration: Story = {
  args: {
    agentCount: 1,
  },
  render: renderComposerDecoration,
  tags: ["concurrent-local-warning"],
  parameters: {
    docs: {
      description: {
        story:
          "Shows the concurrent local-agent warning pinned in the composer decoration lane, above the input and outside the transcript scroll flow.",
      },
    },
  },
};

export const MultipleAgents: Story = {
  ...ComposerDecoration,
  args: { agentCount: 3 },
};

export const PhoneComposerDecoration: Story = {
  args: {
    agentCount: 12,
  },
  render: renderComposerDecoration,
  decorators: [
    (Story) => (
      <div style={{ width: 390, maxWidth: "100%" }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement, parameters }) => {
    await checkComposerLayout(canvasElement);
    await expect(parameters).toMatchObject({
      pixel: { matrix: { viewports: expect.arrayContaining(["phone"]) } },
    });
    await expect(
      within(canvasElement).getByTestId("concurrency-composer").getBoundingClientRect().width
    ).toBe(390);
  },
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: {
    pixel: { matrix: { viewports: ["phone"] } },
    docs: {
      description: {
        story:
          "Pins the phone-width visual contract so the warning stays a single aligned decoration row without pushing the composer off-screen.",
      },
    },
  },
};

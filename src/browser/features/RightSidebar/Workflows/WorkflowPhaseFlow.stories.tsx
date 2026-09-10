import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "@storybook/test";

import { ThemeProvider } from "@/browser/contexts/ThemeContext";

import { WorkflowPhaseFlow, type WorkflowPhaseFlowNode } from "./WorkflowPhaseFlow";

const meta = {
  title: "Features/RightSidebar/WorkflowPhaseFlow",
  component: WorkflowPhaseFlow,
  parameters: {
    layout: "centered",
    backgrounds: { default: "dark" },
    viewport: {
      options: {
        // Mirrors Pixel's named `phone` viewport (390px) so local inspection and
        // CI snapshots exercise the same width.
        phone390: {
          name: "Phone 390",
          styles: { width: "390px", height: "844px" },
          type: "mobile",
        },
      },
    },
  },
  decorators: [
    // Width tracks the viewport (capped at the sidebar's ~430px) so the
    // viewport-pinned MobileNarrow variant exercises real wrap behavior.
    (Story) => (
      <ThemeProvider forcedTheme="dark">
        <div className="bg-background text-foreground border-border w-[min(430px,90vw)] rounded-xl border p-4">
          <Story />
        </div>
      </ThemeProvider>
    ),
  ],
} satisfies Meta<typeof WorkflowPhaseFlow>;

export default meta;
type Story = StoryObj<typeof meta>;

const DECLARED_NODES: WorkflowPhaseFlowNode[] = [
  { name: "scope", label: "Scope", lifecycle: "pending", description: "Pick research angles" },
  { name: "search-fetch", label: "Search & Fetch", lifecycle: "pending", parallel: true },
  { name: "verify", label: "Verify", lifecycle: "pending", parallel: true },
  { name: "synthesize", label: "Synthesize", lifecycle: "pending" },
];

function withLifecycles(
  lifecycles: Array<WorkflowPhaseFlowNode["lifecycle"]>
): WorkflowPhaseFlowNode[] {
  return DECLARED_NODES.map((node, index) => ({
    ...node,
    lifecycle: lifecycles[index] ?? node.lifecycle,
  }));
}

/** Pre-run preview: every declared phase pending. */
export const PreRunAllPending: Story = {
  args: { nodes: DECLARED_NODES, provenance: "declared" },
};

/** Mid-run: phase 2 running, later phases pending, plus a dynamic detour phase. */
export const MidRunWithDynamicPhase: Story = {
  args: {
    nodes: [
      { ...DECLARED_NODES[0], lifecycle: "completed" },
      { ...DECLARED_NODES[1], lifecycle: "completed" },
      {
        name: "recover-fetch",
        label: "recover-fetch",
        lifecycle: "completed",
        description: "Observed phase the script did not declare",
      },
      { ...DECLARED_NODES[2], lifecycle: "running" },
      { ...DECLARED_NODES[3], lifecycle: "pending" },
    ],
    provenance: "declared",
    onPhaseSelect: () => undefined,
  },
};

/** Loop re-entry: an earlier phase is running again after later phases were visited. */
export const LoopReentry: Story = {
  args: {
    nodes: withLifecycles(["completed", "running", "completed", "pending"]),
    provenance: "declared",
  },
};

/** Completed run where a declared phase was never visited. */
export const CompletedWithSkippedPhase: Story = {
  args: {
    nodes: withLifecycles(["completed", "completed", "skipped", "completed"]),
    provenance: "declared",
  },
};

/** Failed run: failing phase marked, tail not reached. */
export const FailedRun: Story = {
  args: {
    nodes: withLifecycles(["completed", "failed", "not-reached", "not-reached"]),
    provenance: "declared",
  },
};

/** Interrupted run: latest phase paused, tail not reached. */
export const InterruptedRun: Story = {
  args: {
    nodes: withLifecycles(["completed", "interrupted", "not-reached", "not-reached"]),
    provenance: "declared",
  },
};

/** Inferred rail: provenance hint visible, terminal-unvisited phases stay neutral. */
export const InferredRail: Story = {
  args: {
    nodes: [
      { name: "scope", label: "scope", lifecycle: "completed" },
      { name: "audit", label: "audit", lifecycle: "not-visited" },
      { name: "load-findings", label: "load-findings", lifecycle: "completed" },
      { name: "report", label: "report", lifecycle: "completed" },
    ],
    provenance: "inferred",
  },
};

/** Narrow-container wrap behavior at phone width. */
export const MobileNarrow: Story = {
  globals: {
    viewport: { value: "phone390", isRotated: false },
  },
  parameters: {
    pixel: {
      matrix: { viewports: ["phone"] },
    },
  },
  // Static contract: the pinned Pixel variant and the local viewport must stay
  // paired, or this story silently snapshots the wrong width.
  play: async ({ parameters, globals }) => {
    await expect(parameters).toMatchObject({ pixel: { matrix: { viewports: ["phone"] } } });
    await expect(globals).toMatchObject({ viewport: { value: "phone390" } });
  },
  args: {
    nodes: [
      { ...DECLARED_NODES[0], lifecycle: "completed" },
      { ...DECLARED_NODES[1], lifecycle: "running" },
      { ...DECLARED_NODES[2], lifecycle: "pending" },
      { ...DECLARED_NODES[3], lifecycle: "pending" },
      {
        name: "long-tail-phase-name-that-truncates",
        label: "long-tail-phase-name-that-truncates",
        lifecycle: "pending",
      },
    ],
    provenance: "declared",
  },
};

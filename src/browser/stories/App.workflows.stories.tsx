import { wrapAsyncIterator } from "@orpc/shared";
import { expect, userEvent, waitFor, within } from "@storybook/test";

import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getDefaultRightSidebarLayoutState } from "@/browser/utils/rightSidebarLayout";
import { EXPERIMENT_IDS, getExperimentKey } from "@/common/constants/experiments";
import {
  LEFT_SIDEBAR_COLLAPSED_KEY,
  RIGHT_SIDEBAR_COLLAPSED_KEY,
  RIGHT_SIDEBAR_TAB_KEY,
  RIGHT_SIDEBAR_WIDTH_KEY,
  getRightSidebarLayoutKey,
} from "@/common/constants/storage";
import type { WorkflowRunRecord, WorkflowRunStreamEvent } from "@/common/types/workflow";
import { createAsyncMessageQueue } from "@/common/utils/asyncMessageQueue";

import { setupSimpleChatStory } from "./helpers/chatSetup";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { waitForChatInputAutofocusDone } from "./storyPlayHelpers.js";

export default {
  ...appMeta,
  title: "App/Workflows",
  beforeEach: () => () => {
    updatePersistedState(getExperimentKey(EXPERIMENT_IDS.DYNAMIC_WORKFLOWS), undefined);
  },
  parameters: {
    ...appMeta.parameters,
    viewport: {
      options: {
        phone390: {
          name: "Phone 390",
          styles: { width: "390px", height: "844px" },
          type: "mobile",
        },
        laptop1200: {
          name: "Laptop 1200",
          styles: { width: "1200px", height: "900px" },
          type: "desktop",
        },
      },
    },
  },
};

const WORKSPACE_ID = "ws-planned-stages";
const CREATED_AT = "2026-05-29T12:00:00.000Z";
const STARTED_AT = "2026-05-29T12:00:02.000Z";
const UPDATED_AT = "2026-05-29T12:00:08.000Z";
const COMPLETED_AT = "2026-05-29T12:00:18.000Z";
const CONTRACT = "Restore structured workflow-stage presentation without changing execution.";
const STAGES = [
  {
    name: "foundation",
    role: "Implementation engineer",
    brief:
      "Build the presentation seam while retaining the original workflow arguments. " +
      "Keep the runtime phase stream authoritative: planned work is not proof of execution. ".repeat(
        5
      ) +
      "Foundation acceptance: every original input remains available.",
  },
  {
    name: "verification",
    role: "Independent reviewer",
    brief:
      "Exercise recognized stages, unsupported shapes, duplicate names, and long content. " +
      "Verify that no planned stage acquires an inferred execution status. ".repeat(5) +
      "Verification acceptance: malformed arrays fall back as a whole.",
  },
  {
    name: "delivery",
    role: "Release coordinator",
    brief:
      "Review the full application at desktop and phone widths before delivering the change. " +
      "Keep the contract readable and retain access to raw arguments and full briefs. ".repeat(5) +
      "Delivery acceptance: capture the final visual evidence.",
  },
];

const RUN: WorkflowRunRecord = {
  id: "wfr_planned_stages_story",
  workspaceId: WORKSPACE_ID,
  workflow: {
    name: "staged-implementation",
    description: "Implement, verify, and deliver a bounded change",
    scope: "project",
    sourceKind: "inline",
    executable: true,
  },
  source: "export default function workflow() { return null; }",
  sourceHash: "sha256:planned-stages-story",
  args: { contract: CONTRACT, stages: STAGES },
  status: "running",
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  events: [
    { sequence: 1, type: "status", at: CREATED_AT, status: "running" },
    { sequence: 2, type: "phase", at: STARTED_AT, name: "foundation" },
    {
      sequence: 3,
      type: "task",
      at: STARTED_AT,
      stepId: "implement-presentation",
      taskId: "task_planned_stages_implementation",
      status: "started",
      title: "Implement stage presentation",
    },
  ],
  steps: [
    {
      stepId: "implement-presentation",
      inputHash: "sha256:planned-stages-implementation",
      status: "started",
      taskId: "task_planned_stages_implementation",
      startedAt: STARTED_AT,
    },
  ],
};

// Each story owns its feed; updates use the real snapshot/run-changed protocol rather
// than replacing React props or adding a product-only API for the interaction test.
function createWorkflowFixture(initialRun: WorkflowRunRecord, sidebarWidth = 480) {
  let currentRun = initialRun;
  const listeners = new Set<(event: WorkflowRunStreamEvent) => void>();

  return {
    publish(run: WorkflowRunRecord) {
      currentRun = run;
      for (const listener of listeners) listener({ type: "run-changed", run });
    },
    setup: () => {
      currentRun = initialRun;
      const client = setupSimpleChatStory({
        workspaceId: WORKSPACE_ID,
        workspaceName: "stage-presentation",
        projectName: "mux",
        messages: [
          createUserMessage("stages-user", CONTRACT, {
            historySequence: 1,
            timestamp: Date.parse(CREATED_AT),
          }),
          createAssistantMessage(
            "stages-assistant",
            "The workflow is available in the Workflows panel. Its launch plan is separate from the live step stream.",
            { historySequence: 2, timestamp: Date.parse(STARTED_AT) }
          ),
        ],
      });
      updatePersistedState(getExperimentKey(EXPERIMENT_IDS.DYNAMIC_WORKFLOWS), true);
      updatePersistedState(LEFT_SIDEBAR_COLLAPSED_KEY, true);
      updatePersistedState(RIGHT_SIDEBAR_COLLAPSED_KEY, false);
      updatePersistedState(RIGHT_SIDEBAR_TAB_KEY, "workflows");
      updatePersistedState(RIGHT_SIDEBAR_WIDTH_KEY, sidebarWidth);
      updatePersistedState(
        getRightSidebarLayoutKey(WORKSPACE_ID),
        getDefaultRightSidebarLayoutState("workflows")
      );
      client.workflows.listScripts = () => Promise.resolve([]);
      client.workflows.listRuns = () => Promise.resolve([]);
      client.workflows.getRun = () => Promise.resolve(currentRun);
      client.workflows.subscribe = (_input, options) => {
        const queue = createAsyncMessageQueue<WorkflowRunStreamEvent>();
        listeners.add(queue.push);
        queue.push({ type: "snapshot", runs: [currentRun] });
        const signal = options?.signal;
        signal?.addEventListener("abort", queue.end, { once: true });
        if (signal?.aborted) queue.end();
        async function* iterate() {
          try {
            yield* queue.iterate();
          } finally {
            listeners.delete(queue.push);
            signal?.removeEventListener("abort", queue.end);
          }
        }
        return Promise.resolve(wrapAsyncIterator(iterate(), {}));
      };
      return client;
    },
  };
}

const COMPLETED_RUN: WorkflowRunRecord = {
  ...RUN,
  status: "completed",
  updatedAt: COMPLETED_AT,
  events: [
    ...RUN.events,
    {
      sequence: 4,
      type: "task",
      at: COMPLETED_AT,
      stepId: "implement-presentation",
      taskId: "task_planned_stages_implementation",
      status: "completed",
      title: "Implement stage presentation",
    },
    { sequence: 5, type: "status", at: COMPLETED_AT, status: "completed" },
  ],
  steps: RUN.steps.map((step) => ({ ...step, status: "completed", completedAt: COMPLETED_AT })),
};
const noPhaseFixture = createWorkflowFixture({
  ...RUN,
  events: [{ sequence: 1, type: "status", at: CREATED_AT, status: "running" }],
  steps: [],
});
const completedFixture = createWorkflowFixture(COMPLETED_RUN);
const liveFixture = createWorkflowFixture(RUN);
const LONG_STAGES = [
  {
    name: `foundation-${"unbroken".repeat(30)}`,
    role: `reviewer-${"unbroken".repeat(25)}`,
    brief: "brief-without-whitespace-".repeat(40),
    reviewMetadata: { approvalsRequired: 2, preserveUnknownFields: true },
  },
  STAGES[1],
  STAGES[2],
];
const NARROW_SIDEBAR_WIDTH = 340;
const narrowFixture = createWorkflowFixture(
  { ...RUN, args: { contract: CONTRACT, stages: LONG_STAGES } },
  NARROW_SIDEBAR_WIDTH
);
const MALFORMED_STAGES = [STAGES[0], { name: "unsupported", role: 7 }, STAGES[2]];
const malformedFixture = createWorkflowFixture({
  ...RUN,
  args: { contract: CONTRACT, stages: MALFORMED_STAGES },
});

async function expectCompactStages(
  canvasElement: HTMLElement,
  stages: Array<{ name: string; role: string }>
) {
  const label = await within(canvasElement).findByText("Planned stages", { selector: "span" });
  const summary = label.closest("summary");
  const details = summary?.closest("details");
  if (!summary || !details) throw new Error("Planned stages must use a native disclosure");
  await waitFor(() => expect(summary).toBeVisible());
  await expect(details).not.toHaveAttribute("open");
  const list = within(details).getByRole("list", { hidden: true });
  await expect(list).not.toBeVisible();
  for (const [index, stage] of stages.entries()) {
    await expect(within(summary).getByText(stage.name, { exact: false })).toBeVisible();
    await expect(within(list).getByText(stage.role, { exact: true })).not.toBeVisible();
    await expect(
      within(details).getByRole("button", {
        name: `Open Stage ${index + 1}: ${stage.name} in full view`,
      })
    ).not.toBeVisible();
  }
  return summary;
}

async function expectPlannedStages(
  canvasElement: HTMLElement,
  stages: Array<{ name: string; role: string }>
) {
  const list = await within(canvasElement).findByRole("list", { name: "Planned stages" });
  await waitFor(() => expect(list).toBeVisible());
  await expect(list.tagName).toBe("OL");
  const items = within(list).getAllByRole("listitem");
  await expect(items).toHaveLength(stages.length);
  for (const [index, stage] of stages.entries()) {
    await expect(within(items[index]).getByText(stage.name, { exact: true })).toBeVisible();
    await expect(within(items[index]).getByText(stage.role, { exact: true })).toBeVisible();
  }
  await expect(within(list).queryByText(/^(running|completed|pending)$/i)).not.toBeInTheDocument();
  return list;
}

async function expectRawStages(canvasElement: HTMLElement, stages: unknown[]) {
  const canvas = within(canvasElement);
  const summary = canvas.getByText("Original argument", { selector: "summary" });
  // user-event does not emulate native summary keyboard activation; dogfood covers Enter/Space.
  await expect(summary.parentElement).not.toHaveAttribute("open");
  summary.focus();
  await expect(summary).toHaveFocus();
  await userEvent.click(summary);
  await expect(summary.parentElement).toHaveAttribute("open");
  await userEvent.click(canvas.getByRole("button", { name: "Open Argument: stages in full view" }));
  const page = within(canvasElement.ownerDocument.body);
  const dialog = await page.findByRole("dialog", { name: "Argument: stages" });
  const json = within(dialog).getByText((text) => text.startsWith("[")).textContent;
  await expect(JSON.parse(json ?? "null")).toEqual(stages);
  await userEvent.click(within(dialog).getByRole("button", { name: /^Close$/ }));
  await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument());
  summary.focus();
  await expect(summary).toHaveFocus();
  await userEvent.click(summary);
  await expect(summary.parentElement).not.toHaveAttribute("open");
}

const runningFixture = createWorkflowFixture(RUN);

export const PlannedStages: AppStory = {
  globals: { viewport: { value: "laptop1200", isRotated: false } },
  parameters: { pixel: { matrix: { viewports: ["laptop"] } } },
  render: () => <AppWithMocks setup={runningFixture.setup} />,
  play: async ({ canvasElement }) => {
    await waitForChatInputAutofocusDone(canvasElement);
    const summary = await expectCompactStages(canvasElement, STAGES);
    await userEvent.click(summary);
    await expectPlannedStages(canvasElement, STAGES);
    await userEvent.click(summary);
    await expectCompactStages(canvasElement, STAGES);
    const canvas = within(canvasElement);
    await expect(canvas.getByText("0/1 steps")).toBeVisible();
    await expect(canvas.getByText("Step stream")).toBeVisible();
    const phase = canvas.getByRole("button", { name: /^foundation/ });
    await expect(phase).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(phase);
    await expect(canvas.getByText("Implement stage presentation")).toBeVisible();
  },
};

export const PlannedStagesExpanded: AppStory = {
  ...PlannedStages,
  play: async ({ canvasElement }) => {
    await waitForChatInputAutofocusDone(canvasElement);
    const summary = await expectCompactStages(canvasElement, STAGES);
    await userEvent.click(summary);
    await expectPlannedStages(canvasElement, STAGES);
  },
};

export const PlannedStagesPhone: AppStory = {
  ...PlannedStages,
  globals: { viewport: { value: "phone390", isRotated: false } },
  parameters: { pixel: { matrix: { viewports: ["phone"] } } },
  play: async ({ canvasElement, parameters, globals }) => {
    await waitForChatInputAutofocusDone(canvasElement);
    const canvas = within(canvasElement);
    await expect(parameters).toMatchObject({ pixel: { matrix: { viewports: ["phone"] } } });
    await expect(globals).toMatchObject({ viewport: { value: "phone390" } });
    await waitFor(() =>
      expect(canvas.getByRole("log", { name: "Conversation transcript" })).toBeVisible()
    );
    const sidebar = canvasElement.querySelector('[aria-label="Workspace insights"]');
    await expect(sidebar).toBeInTheDocument();
    // The real app hides this whole panel on phones. The test-runner does not
    // apply viewport globals, so only assert hidden at an actual phone width.
    if (window.innerWidth <= 390 || canvasElement.getBoundingClientRect().width <= 390) {
      await expect(sidebar).not.toBeVisible();
      await expect(canvas.queryByRole("list", { name: "Planned stages" })).not.toBeInTheDocument();
    } else {
      await expect(sidebar).toBeVisible();
    }
  },
};

export const PlannedStagesBeforeExecution: AppStory = {
  ...PlannedStages,
  render: () => <AppWithMocks setup={noPhaseFixture.setup} />,
  play: async ({ canvasElement }) => {
    await waitForChatInputAutofocusDone(canvasElement);
    const summary = await expectCompactStages(canvasElement, STAGES);
    await userEvent.click(summary);
    await expectPlannedStages(canvasElement, STAGES);
    const canvas = within(canvasElement);
    await expect(canvas.getByText("0/0 steps")).toBeVisible();
    await expect(canvas.getByText("No steps yet.")).toBeVisible();
    await expect(canvas.queryByRole("button", { name: /^foundation/ })).not.toBeInTheDocument();
  },
};

export const PlannedStagesCompleted: AppStory = {
  ...PlannedStages,
  render: () => <AppWithMocks setup={completedFixture.setup} />,
  play: async ({ canvasElement }) => {
    await waitForChatInputAutofocusDone(canvasElement);
    const summary = await expectCompactStages(canvasElement, STAGES);
    await userEvent.click(summary);
    await expectPlannedStages(canvasElement, STAGES);
    await expect(within(canvasElement).getByText("1/1 steps")).toBeVisible();
    await expect(
      within(canvasElement).queryByRole("button", { name: "Interrupt" })
    ).not.toBeInTheDocument();
  },
};

export const PlannedStagesNarrowSidebar: AppStory = {
  ...PlannedStages,
  render: () => <AppWithMocks setup={narrowFixture.setup} />,
  play: async ({ canvasElement, parameters, globals }) => {
    await waitForChatInputAutofocusDone(canvasElement);
    const summary = await expectCompactStages(canvasElement, LONG_STAGES);
    await expect(parameters).toMatchObject({ pixel: { matrix: { viewports: ["laptop"] } } });
    await expect(globals).toMatchObject({ viewport: { value: "laptop1200" } });
    const sidebar = within(canvasElement).getByRole("complementary", {
      name: "Workspace insights",
    });
    const expectNoOverflow = async (content: HTMLElement) => {
      await waitFor(async () => {
        await expect(sidebar.getBoundingClientRect().width).toBe(NARROW_SIDEBAR_WIDTH);
        await expect(content.getBoundingClientRect().right).toBeLessThanOrEqual(
          sidebar.getBoundingClientRect().right
        );
        await expect(content.scrollWidth).toBeLessThanOrEqual(content.clientWidth);
      });
    };
    await expectNoOverflow(summary);
    await userEvent.click(summary);
    const list = await expectPlannedStages(canvasElement, LONG_STAGES);
    await expectNoOverflow(list);
    await expectRawStages(canvasElement, LONG_STAGES);
    await userEvent.click(summary);
    await expectCompactStages(canvasElement, LONG_STAGES);
    await expectNoOverflow(summary);
    within(canvasElement).getByText(RUN.workflow.name, { exact: true }).scrollIntoView();
  },
};

export const PlannedStagesMalformedFallback: AppStory = {
  ...PlannedStages,
  render: () => <AppWithMocks setup={malformedFixture.setup} />,
  play: async ({ canvasElement }) => {
    await waitForChatInputAutofocusDone(canvasElement);
    const canvas = within(canvasElement);
    const fullView = await canvas.findByRole("button", {
      name: "Open Argument: stages in full view",
    });
    await expect(canvas.queryByRole("list", { name: "Planned stages" })).not.toBeInTheDocument();
    await expect(
      canvas.queryByText("Original argument", { selector: "summary" })
    ).not.toBeInTheDocument();
    await userEvent.click(fullView);
    const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog", {
      name: "Argument: stages",
    });
    const json = within(dialog).getByText((text) => text.startsWith("[")).textContent;
    await expect(JSON.parse(json ?? "null")).toEqual(MALFORMED_STAGES);
    await userEvent.click(within(dialog).getByRole("button", { name: /^Close$/ }));
  },
};

export const PlannedStagesLiveUpdates: AppStory = {
  ...PlannedStages,
  render: () => <AppWithMocks setup={liveFixture.setup} />,
  play: async ({ canvasElement }) => {
    await waitForChatInputAutofocusDone(canvasElement);
    const canvas = within(canvasElement);
    const summary = await expectCompactStages(canvasElement, STAGES);
    liveFixture.publish({ ...RUN, updatedAt: COMPLETED_AT });
    await waitFor(() => expect(canvas.getByText("18s elapsed")).toBeVisible());
    await expectCompactStages(canvasElement, STAGES);
    await userEvent.click(summary);
    const list = await expectPlannedStages(canvasElement, STAGES);
    await expect(canvas.getByText("0/1 steps")).toBeVisible();
    const expand = within(list).getByRole("button", { name: "Show more of Stage 1: foundation" });
    expand.focus();
    await userEvent.keyboard(" ");
    await expect(expand).toHaveAttribute("aria-expanded", "true");
    await expect(within(list).getByText(STAGES[0].brief, { exact: true })).toBeVisible();
    await userEvent.keyboard(" ");
    await expect(expand).toHaveAttribute("aria-expanded", "false");

    const fullView = within(list).getByRole("button", {
      name: "Open Stage 1: foundation in full view",
    });
    await userEvent.click(fullView);
    const page = within(canvasElement.ownerDocument.body);
    const dialog = await page.findByRole("dialog", { name: "Stage 1: foundation" });
    await expect(within(dialog).getByText(STAGES[0].brief, { exact: true })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(fullView).toHaveFocus());
    await expectRawStages(canvasElement, STAGES);

    await userEvent.click(canvas.getByRole("button", { name: /^foundation/ }));
    await expect(canvas.getByText("Implement stage presentation")).toBeVisible();
    const plannedText = list.textContent;
    liveFixture.publish(COMPLETED_RUN);
    await waitFor(() => expect(canvas.getByText("1/1 steps")).toBeVisible());
    await expect(canvas.queryByRole("button", { name: "Interrupt" })).not.toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: /^foundation/ })).toHaveTextContent("1/1");
    await expect(list.textContent).toBe(plannedText);
    await expect(summary.closest("details")).toHaveAttribute("open");
    await expectPlannedStages(canvasElement, STAGES);
  },
};

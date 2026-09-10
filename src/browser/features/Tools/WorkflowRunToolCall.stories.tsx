import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fireEvent, waitFor, within } from "@storybook/test";

import type { WorkflowRunRecord } from "@/common/types/workflow";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { APIContext } from "@/browser/contexts/API";
import { WorkflowRunToolCall } from "@/browser/features/Tools/WorkflowRunToolCall";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { STRUCTURED_WORKFLOW_REPORT_PLACEHOLDER_MARKDOWN } from "@/common/constants/workflowReports";
import { lightweightMeta } from "@/browser/stories/meta.js";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/WorkflowRun",
  component: WorkflowRunToolCall,
} satisfies Meta<typeof WorkflowRunToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

const DEEP_RESEARCH_SCRIPT_PATH = "skill://deep-research/workflow.js";

export const CompletedDeepResearch: Story = {
  args: {
    args: {
      script_path: DEEP_RESEARCH_SCRIPT_PATH,
      args: { topic: "workflow run cards" },
      run_in_background: false,
    },
    status: "completed",
    result: {
      status: "completed",
      runId: "wfr_story",
      result: {
        reportMarkdown:
          "# Deep Research\n\nWorkflow run cards should show phases, tasks, and final synthesis.",
        structuredOutput: { confidence: "medium", gaps: ["Dogfood in full app"] },
      },
      run: {
        id: "wfr_story",
        workspaceId: "workspace-1",
        workflow: {
          name: "deep-research",
          description: "Deep research",
          scope: "built-in",
          sourcePath: DEEP_RESEARCH_SCRIPT_PATH,
          requestedScriptPath: DEEP_RESEARCH_SCRIPT_PATH,
          canonicalScriptPath: DEEP_RESEARCH_SCRIPT_PATH,
          sourceKind: "skill",
          sourceHash: "sha256:story",
          executable: true,
        },
        source: "export default function workflow() { return null; }",
        sourceHash: "sha256:story",
        args: { topic: "workflow run cards" },
        status: "completed",
        createdAt: "2026-05-29T00:00:00.000Z",
        updatedAt: "2026-05-29T00:00:02.000Z",
        events: [
          { sequence: 1, type: "status", at: "2026-05-29T00:00:00.000Z", status: "running" },
          { sequence: 2, type: "phase", at: "2026-05-29T00:00:00.000Z", name: "scope" },
          {
            sequence: 3,
            type: "action",
            at: "2026-05-29T00:00:00.250Z",
            stepId: "git-status",
            name: "git.status",
            status: "started",
            effect: "read",
            sourcePath: "actions/git.ts",
            sourceHash: "sha256:git",
            details: { cwd: "/repo", input: { porcelain: true } },
          },
          {
            sequence: 4,
            type: "action",
            at: "2026-05-29T00:00:00.500Z",
            stepId: "git-status",
            name: "git.status",
            status: "completed",
            effect: "read",
            sourcePath: "actions/git.ts",
            sourceHash: "sha256:git",
            details: { stdout: "clean", durationMs: 12 },
          },
          {
            sequence: 5,
            type: "agent-step",
            at: "2026-05-29T00:00:00.750Z",
            stepId: "scope-topic",
            inputHash: "sha256:scope-topic",
            status: "reserving",
            title: "Scope topic",
            details: { agentId: "explore", isolation: "none" },
          },
          {
            sequence: 6,
            type: "task",
            at: "2026-05-29T00:00:01.000Z",
            stepId: "scope-topic",
            taskId: "task_scope",
            status: "completed",
          },
          {
            sequence: 7,
            type: "phase",
            at: "2026-05-29T00:00:01.000Z",
            name: "adversarial-verification",
          },
          { sequence: 8, type: "status", at: "2026-05-29T00:00:02.000Z", status: "completed" },
        ],
        steps: [],
      },
    },
  },
};

const foregroundDiscoveryRun: WorkflowRunRecord = {
  id: "wfr_story_foreground",
  workspaceId: "workspace-1",
  workflow: {
    name: "deep-research",
    description: "Deep research",
    scope: "built-in" as const,
    sourcePath: DEEP_RESEARCH_SCRIPT_PATH,
    requestedScriptPath: DEEP_RESEARCH_SCRIPT_PATH,
    canonicalScriptPath: DEEP_RESEARCH_SCRIPT_PATH,
    sourceKind: "skill" as const,
    sourceHash: "sha256:story-foreground",
    executable: true,
  },
  source: "export default function workflow() { return null; }",
  sourceHash: "sha256:story-foreground",
  args: { topic: "workflow run cards" },
  status: "running" as const,
  createdAt: "2026-05-29T00:00:01.000Z",
  updatedAt: "2026-05-29T00:00:02.000Z",
  events: [
    {
      sequence: 1,
      type: "status" as const,
      at: "2026-05-29T00:00:01.000Z",
      status: "running" as const,
    },
    { sequence: 2, type: "phase" as const, at: "2026-05-29T00:00:02.000Z", name: "scope" },
  ],
  steps: [],
};

const interruptedForegroundDiscoveryRun: WorkflowRunRecord = {
  ...foregroundDiscoveryRun,
  status: "interrupted" as const,
  updatedAt: "2026-05-29T00:00:03.000Z",
  events: [
    ...foregroundDiscoveryRun.events,
    {
      sequence: 3,
      type: "status" as const,
      at: "2026-05-29T00:00:03.000Z",
      status: "interrupted" as const,
    },
  ],
};

const resumedForegroundDiscoveryRun: WorkflowRunRecord = {
  ...foregroundDiscoveryRun,
  updatedAt: "2026-05-29T00:00:04.000Z",
  events: [
    ...interruptedForegroundDiscoveryRun.events,
    {
      sequence: 4,
      type: "status" as const,
      at: "2026-05-29T00:00:04.000Z",
      status: "running" as const,
    },
  ],
};

function createTaskWorkspaceMetadata(workspaceId: string): FrontendWorkspaceMetadata {
  return {
    id: workspaceId,
    name: workspaceId,
    title: workspaceId,
    projectPath: "/repo",
    projectName: "repo",
    namedWorkspacePath: `/repo/${workspaceId}`,
    createdAt: "2026-05-29T00:00:00.000Z",
    runtimeConfig: { type: "local", srcBaseDir: "/tmp/mux-src" },
  };
}

const TASK_ACTIONS_SCRIPT_PATH = "./workflows/implementation.js";

const taskActionsRun: WorkflowRunRecord = {
  id: "wfr_story_task_actions",
  workspaceId: "workspace-1",
  workflow: {
    name: "implementation",
    description: "Implementation workflow",
    scope: "project" as const,
    sourcePath: TASK_ACTIONS_SCRIPT_PATH,
    requestedScriptPath: TASK_ACTIONS_SCRIPT_PATH,
    canonicalScriptPath: TASK_ACTIONS_SCRIPT_PATH,
    sourceKind: "workspace-file" as const,
    sourceHash: "sha256:story-task-actions",
    executable: true,
  },
  source: "export default function workflow() { return null; }",
  sourceHash: "sha256:story-task-actions",
  args: { topic: "workflow task actions" },
  status: "running" as const,
  createdAt: "2026-05-29T00:00:00.000Z",
  updatedAt: "2026-05-29T00:00:02.000Z",
  events: [
    {
      sequence: 1,
      type: "status" as const,
      at: "2026-05-29T00:00:00.000Z",
      status: "running" as const,
    },
    { sequence: 2, type: "phase" as const, at: "2026-05-29T00:00:00.000Z", name: "implementation" },
    {
      sequence: 3,
      type: "task" as const,
      at: "2026-05-29T00:00:01.000Z",
      stepId: "summarize-source-15",
      taskId: "7b1a07d84d",
      status: "completed",
      // Human title is 1-based while the step id is 0-based; rows show the title.
      title: "Summarize source 16",
    },
    {
      sequence: 4,
      type: "task" as const,
      at: "2026-05-29T00:00:02.000Z",
      stepId: "extract-claims",
      taskId: "a36921beca",
      status: "started",
    },
  ],
  steps: [
    {
      stepId: "summarize-source-15",
      inputHash: "sha256:summarize",
      status: "completed" as const,
      taskId: "7b1a07d84d",
      startedAt: "2026-05-29T00:00:01.000Z",
      completedAt: "2026-05-29T00:00:02.000Z",
      result: {
        reportMarkdown: "## Summary report\n\nCompleted task report body.",
        structuredOutput: {
          summary: "Source 16 is ready for downstream extraction.",
          confidence: "high",
          citations: 3,
        },
      },
    },
    {
      stepId: "extract-claims",
      inputHash: "sha256:extract",
      status: "started" as const,
      taskId: "a36921beca",
      startedAt: "2026-05-29T00:00:02.000Z",
    },
  ],
};

function WorkflowTaskActionsStory(props: Parameters<typeof WorkflowRunToolCall>[0]) {
  const [openedTaskId, setOpenedTaskId] = useState<string | null>(null);

  useEffect(() => {
    const workspaceStore = useWorkspaceStoreRaw();
    workspaceStore.syncWorkspaces(
      new Map([
        ["7b1a07d84d", createTaskWorkspaceMetadata("7b1a07d84d")],
        ["a36921beca", createTaskWorkspaceMetadata("a36921beca")],
      ])
    );
    workspaceStore.setNavigateToWorkspace((workspaceId) => {
      setOpenedTaskId(workspaceId);
    });
    return () => {
      workspaceStore.setNavigateToWorkspace(() => undefined);
      workspaceStore.syncWorkspaces(new Map());
    };
  }, []);

  return (
    <div className="space-y-2">
      <WorkflowRunToolCall {...props} />
      <div className="text-muted text-xs" aria-live="polite">
        Last opened task: {openedTaskId ?? "none"}
      </div>
    </div>
  );
}

function ForegroundWorkflowAPIProvider(props: { children: ReactNode }) {
  const currentRunRef = useRef(foregroundDiscoveryRun);
  const [, setRenderVersion] = useState(0);
  const setCurrentRun = (run: WorkflowRunRecord) => {
    currentRunRef.current = run;
    setRenderVersion((version) => version + 1);
  };

  const foregroundWorkflowApi = {
    workflows: {
      listRuns: () => Promise.resolve([currentRunRef.current]),
      getRun: () => Promise.resolve(currentRunRef.current),
      interrupt: () => {
        setCurrentRun(interruptedForegroundDiscoveryRun);
        return Promise.resolve(interruptedForegroundDiscoveryRun);
      },
      resume: () => {
        setCurrentRun(resumedForegroundDiscoveryRun);
        return Promise.resolve({
          runId: foregroundDiscoveryRun.id,
          status: "running",
          result: null,
        });
      },
    },
  };

  return (
    <APIContext.Provider
      value={{
        status: "connected",
        api: foregroundWorkflowApi as never,
        error: null,
        authenticate: () => undefined,
        retry: () => undefined,
      }}
    >
      {props.children}
    </APIContext.Provider>
  );
}

const taskActionsProps = {
  args: {
    script_path: TASK_ACTIONS_SCRIPT_PATH,
    args: { topic: "workflow task actions" },
    run_in_background: true,
  },
  status: "completed" as const,
  result: {
    status: "running" as const,
    runId: "wfr_story_task_actions",
    result: null,
    run: taskActionsRun,
  },
} satisfies Parameters<typeof WorkflowRunToolCall>[0];

export const TaskActions: Story = {
  render: (args) => <WorkflowTaskActionsStory {...taskActionsProps} {...args} />,
  args: taskActionsProps,
};

const structuredOnlyTaskReportProps = {
  args: {
    script_path: TASK_ACTIONS_SCRIPT_PATH,
    args: { topic: "structured-only workflow task" },
    run_in_background: true,
  },
  status: "completed" as const,
  result: {
    status: "running" as const,
    runId: "wfr_story_structured_only_task",
    result: null,
    run: {
      ...taskActionsRun,
      id: "wfr_story_structured_only_task",
      events: [
        { sequence: 1, type: "phase" as const, at: "2026-05-29T00:00:00.000Z", name: "scope" },
        {
          sequence: 2,
          type: "task" as const,
          at: "2026-05-29T00:00:01.000Z",
          stepId: "scope-research-angles",
          taskId: "cb803680e1",
          status: "completed",
          title: "Scope research angles",
        },
        {
          sequence: 3,
          type: "log" as const,
          at: "2026-05-29T00:00:01.500Z",
          message: "Scoped research angles",
        },
      ],
      steps: [
        {
          stepId: "scope-research-angles",
          inputHash: "sha256:scope-research-angles",
          status: "completed" as const,
          taskId: "cb803680e1",
          startedAt: "2026-05-29T00:00:00.000Z",
          completedAt: "2026-05-29T00:00:01.000Z",
          result: {
            reportMarkdown: STRUCTURED_WORKFLOW_REPORT_PLACEHOLDER_MARKDOWN,
            structuredOutput: {
              summary: "Research angles scoped for downstream agents.",
              followUpCount: 3,
            },
          },
        },
      ],
    },
  },
} satisfies Parameters<typeof WorkflowRunToolCall>[0];

export const StructuredOnlyTaskReport: Story = {
  args: structuredOnlyTaskReportProps,
};

export const RunningForegroundDiscovered: Story = {
  render: (args) => (
    <ForegroundWorkflowAPIProvider>
      <WorkflowRunToolCall
        {...args}
        workspaceId="workspace-1"
        startedAt={Date.parse("2026-05-29T00:00:00.500Z")}
      />
    </ForegroundWorkflowAPIProvider>
  ),
  args: {
    args: {
      script_path: DEEP_RESEARCH_SCRIPT_PATH,
      args: { topic: "workflow run cards" },
      run_in_background: false,
    },
    status: "executing",
  },
};

export const RunningBackgroundWithRun: Story = {
  render: (args) => (
    <ForegroundWorkflowAPIProvider>
      <WorkflowRunToolCall {...args} />
    </ForegroundWorkflowAPIProvider>
  ),
  args: {
    args: {
      script_path: DEEP_RESEARCH_SCRIPT_PATH,
      args: { topic: "workflow run cards" },
      run_in_background: true,
    },
    status: "completed",
    result: {
      status: "running",
      runId: "wfr_story_foreground",
      result: null,
      run: foregroundDiscoveryRun,
    },
  },
};

export const LiveRunningTimeline: Story = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: {
    pixel: { matrix: { viewports: ["phone"] } },
  },
  render: (args) => (
    <div data-testid="live-workflow-card" style={{ width: 360 }}>
      <WorkflowRunToolCall {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // "implementation" is both the workflow name (header + script card spans) and the
    // phase label; only the phase disclosure is a button, so query by role.
    await fireEvent.click(await canvas.findByRole("button", { name: /implementation/ }));
    await canvas.findByText("Summarize source 16");
    await canvas.findByText("extract-claims");
    const container = canvas.getByTestId("live-workflow-card");
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
    if (container.scrollWidth > container.clientWidth + 1) {
      throw new Error(
        `Workflow card overflowed its ${container.clientWidth}px container by ` +
          `${container.scrollWidth - container.clientWidth}px`
      );
    }
  },
  args: {
    ...taskActionsProps,
    status: "executing",
  },
};

/**
 * Narrow-container regression: a long workflow name must truncate instead of
 * starving the collapsed header's progress summary. No API provider, so the
 * static run record renders without polling. The dynamic-workflows experiment
 * is off in this lightweight story and the run is still running, so the card
 * mounts expanded — the play collapses it via the header toggle so the
 * snapshot pins the collapsed narrow header this story exists to cover.
 */
export const RunningNarrowLongName: Story = {
  render: (args) => (
    <div data-testid="narrow-workflow-card" style={{ width: 360 }}>
      <WorkflowRunToolCall {...args} />
    </div>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);
    // The expanded body repeats the workflow name, so take the header instance
    // (first in DOM order) — clicking it bubbles to the ToolHeader toggle.
    const [name] = await canvas.findAllByText(
      "deep-research-competitive-landscape-and-pricing-teardown"
    );
    await fireEvent.click(name);
    // Collapsed header must keep the progress summary (the run's active phase)
    // visible next to the truncated long name.
    await waitFor(() => canvas.getByText("scope"));
    const container = canvasElement.querySelector('[data-testid="narrow-workflow-card"]');
    if (!(container instanceof HTMLElement)) {
      throw new Error("Narrow workflow story container not found");
    }
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
    if (container.scrollWidth > container.clientWidth + 1) {
      throw new Error(
        `Workflow card overflowed its ${container.clientWidth}px container by ` +
          `${container.scrollWidth - container.clientWidth}px`
      );
    }
  },
  args: {
    args: {
      script_path: DEEP_RESEARCH_SCRIPT_PATH,
      args: { topic: "workflow run cards" },
      run_in_background: true,
    },
    status: "completed",
    result: {
      status: "running",
      runId: "wfr_story_foreground",
      result: null,
      run: {
        ...foregroundDiscoveryRun,
        workflow: {
          ...foregroundDiscoveryRun.workflow,
          name: "deep-research-competitive-landscape-and-pricing-teardown",
        },
      },
    },
  },
};

const nestedChildRun: WorkflowRunRecord = {
  id: "wfr_child_story",
  workspaceId: "workspace-1",
  workflow: {
    name: "implementation-loop",
    description: "Implementation loop",
    scope: "global" as const,
    requestedScriptPath: "skill://implementation-loop/workflow.js",
    canonicalScriptPath: "skill://implementation-loop/workflow.js",
    sourceKind: "skill" as const,
    sourceHash: "sha256:nested-child",
    executable: true,
  },
  source: "export default function workflow() { return null; }",
  sourceHash: "sha256:nested-child",
  args: { target: "coder/mux#3546" },
  parentWorkflow: {
    runId: "wfr_nested_parent_story",
    stepId: "implementation-loop",
    inputHash: "sha256:nested-child-input",
    depth: 0,
  },
  status: "running" as const,
  createdAt: "2026-05-29T00:00:00.000Z",
  updatedAt: "2026-05-29T00:00:04.000Z",
  events: [
    {
      sequence: 1,
      type: "status" as const,
      at: "2026-05-29T00:00:00.000Z",
      status: "running" as const,
    },
    { sequence: 2, type: "phase" as const, at: "2026-05-29T00:00:01.000Z", name: "fetch-context" },
    {
      sequence: 3,
      type: "task" as const,
      at: "2026-05-29T00:00:01.500Z",
      stepId: "fetch-issue-context",
      taskId: "task_context",
      status: "completed",
      title: "Fetch issue context",
    },
    { sequence: 4, type: "phase" as const, at: "2026-05-29T00:00:03.000Z", name: "implementation" },
    {
      sequence: 5,
      type: "task" as const,
      at: "2026-05-29T00:00:03.500Z",
      stepId: "implement",
      taskId: "task_implement",
      status: "started",
      title: "Implement nested slice",
    },
  ],
  steps: [
    {
      stepId: "fetch-issue-context",
      inputHash: "sha256:context",
      status: "completed" as const,
      taskId: "task_context",
      startedAt: "2026-05-29T00:00:01.500Z",
      completedAt: "2026-05-29T00:00:02.500Z",
      result: { reportMarkdown: "Fetched issue context." },
    },
    {
      stepId: "implement",
      inputHash: "sha256:implement",
      status: "started" as const,
      taskId: "task_implement",
      startedAt: "2026-05-29T00:00:03.500Z",
    },
  ],
};

const nestedParentRun: WorkflowRunRecord = {
  id: "wfr_nested_parent_story",
  workspaceId: "workspace-1",
  workflow: {
    name: "issue-implementation-loop",
    description: "Issue implementation loop",
    scope: "global" as const,
    requestedScriptPath: "skill://issue-implementation-loop/workflow.js",
    canonicalScriptPath: "skill://issue-implementation-loop/workflow.js",
    sourceKind: "skill" as const,
    sourceHash: "sha256:nested-parent",
    executable: true,
  },
  source: "export default function workflow() { return null; }",
  sourceHash: "sha256:nested-parent",
  args: { issue: 3546 },
  status: "running" as const,
  createdAt: "2026-05-29T00:00:00.000Z",
  updatedAt: "2026-05-29T00:00:04.000Z",
  events: [
    {
      sequence: 1,
      type: "status" as const,
      at: "2026-05-29T00:00:00.000Z",
      status: "running" as const,
    },
    {
      sequence: 2,
      type: "phase" as const,
      at: "2026-05-29T00:00:01.000Z",
      name: "implementation-loop",
    },
    {
      sequence: 3,
      type: "workflow" as const,
      at: "2026-05-29T00:00:02.000Z",
      stepId: "implementation-loop",
      runId: "wfr_child_story",
      name: "implementation-loop",
      status: "started",
      details: { target: "coder/mux#3546" },
    },
  ],
  steps: [
    {
      stepId: "implementation-loop",
      inputHash: "sha256:nested-child-input",
      status: "started" as const,
      startedAt: "2026-05-29T00:00:02.000Z",
    },
  ],
};

const nestedWorkflowProps = {
  args: {
    script_path: "skill://issue-implementation-loop/workflow.js",
    args: { issue: 3546 },
    run_in_background: false,
  },
  status: "executing" as const,
  result: {
    status: "running" as const,
    runId: nestedParentRun.id,
    result: null,
    run: nestedParentRun,
  },
} satisfies Parameters<typeof WorkflowRunToolCall>[0];

function NestedWorkflowAPIProvider(props: { children: ReactNode }) {
  const api = {
    workflows: {
      getRun: (input: { runId: string }) =>
        Promise.resolve(input.runId === nestedChildRun.id ? nestedChildRun : nestedParentRun),
    },
  };
  return (
    <APIContext.Provider
      value={{
        status: "connected",
        api: api as never,
        error: null,
        authenticate: () => undefined,
        retry: () => undefined,
      }}
    >
      {props.children}
    </APIContext.Provider>
  );
}

export const NestedWorkflow: Story = {
  render: (args) => (
    <NestedWorkflowAPIProvider>
      <WorkflowRunToolCall {...nestedWorkflowProps} {...args} />
    </NestedWorkflowAPIProvider>
  ),
  args: nestedWorkflowProps,
};

export const WorkspaceFileCompleted: Story = {
  args: {
    args: {
      script_path: "./workflows/local-report.js",
      args: { topic: "local workflow" },
      run_in_background: true,
    },
    status: "completed",
    result: {
      status: "completed",
      runId: "wfr_workspace_file_story",
      result: { reportMarkdown: "# Local workflow\n\nExplicit workspace-file workflow completed." },
      run: {
        id: "wfr_workspace_file_story",
        workspaceId: "workspace-1",
        workflow: {
          name: "local-report",
          description: "Workspace file workflow",
          scope: "project",
          sourcePath: "./workflows/local-report.js",
          requestedScriptPath: "./workflows/local-report.js",
          canonicalScriptPath: "./workflows/local-report.js",
          sourceKind: "workspace-file",
          sourceHash: "sha256:workspace-file-story",
          executable: true,
        },
        source: "export default function workflow() { return null; }",
        sourceHash: "sha256:workspace-file-story",
        args: { topic: "local workflow" },
        status: "completed",
        createdAt: "2026-05-29T00:00:00.000Z",
        updatedAt: "2026-05-29T00:00:02.000Z",
        events: [
          { sequence: 1, type: "phase", at: "2026-05-29T00:00:00.000Z", name: "draft" },
          { sequence: 2, type: "status", at: "2026-05-29T00:00:02.000Z", status: "completed" },
        ],
        steps: [],
      },
    },
  },
};

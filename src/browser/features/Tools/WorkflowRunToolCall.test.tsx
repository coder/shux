/* eslint-disable @typescript-eslint/require-await */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";
import * as RealDialogModule from "@/browser/components/Dialog/Dialog";
import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  type MouseEvent,
  type MouseEventHandler,
  type ReactElement,
  type ReactNode,
} from "react";

import { APIContext } from "@/browser/contexts/API";
import type { WorkflowRunRecord, WorkflowRunStreamEvent } from "@/common/types/workflow";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import {
  CommandRegistryProvider,
  useCommandRegistry,
  type CommandAction,
} from "@/browser/contexts/CommandRegistryContext";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { MessageListProvider } from "@/browser/features/Messages/MessageListContext";
import { ToolNameProvider } from "@/browser/features/Messages/ToolNameContext";
import { STRUCTURED_WORKFLOW_REPORT_PLACEHOLDER_MARKDOWN } from "@/common/constants/workflowReports";
import { getAutoExpandPrefsKey } from "@/common/constants/storage";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
function createWorkflowTaskWorkspaceMetadata(workspaceId: string): FrontendWorkspaceMetadata {
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

interface MockDialogContextValue {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
}

const MockDialogContext = createContext<MockDialogContextValue | null>(null);

interface MockDialogTriggerChildProps {
  onClick?: MouseEventHandler<HTMLElement>;
  "aria-expanded"?: boolean;
  "aria-haspopup"?: "dialog";
}

restoreModulesAfterSuite([["@/browser/components/Dialog/Dialog", { ...RealDialogModule }]]);

void mock.module("@/browser/components/Dialog/Dialog", () => ({
  Dialog: (props: {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
    children: ReactNode;
  }) => (
    <MockDialogContext.Provider value={{ open: props.open, onOpenChange: props.onOpenChange }}>
      {props.children}
    </MockDialogContext.Provider>
  ),
  DialogTrigger: (props: {
    asChild?: boolean;
    children: ReactElement<MockDialogTriggerChildProps>;
  }) => {
    const dialog = useContext(MockDialogContext);
    if (!props.asChild || !isValidElement<MockDialogTriggerChildProps>(props.children)) {
      throw new Error("Mock DialogTrigger expects asChild with a valid element");
    }

    return cloneElement(props.children, {
      "aria-expanded": dialog?.open ?? false,
      "aria-haspopup": "dialog",
      onClick: (event: MouseEvent<HTMLElement>) => {
        props.children.props.onClick?.(event);
        dialog?.onOpenChange?.(true);
      },
    });
  },
  DialogContent: (props: { children: ReactNode; className?: string }) => {
    const dialog = useContext(MockDialogContext);
    if (dialog?.open !== true) {
      return null;
    }

    return (
      <div role="dialog" className={props.className}>
        {props.children}
        <button type="button" aria-label="Close" onClick={() => dialog.onOpenChange?.(false)}>
          Close
        </button>
      </div>
    );
  },
  DialogHeader: (props: { children: ReactNode }) => <div>{props.children}</div>,
  DialogTitle: (props: { children: ReactNode; className?: string }) => (
    <h2 className={props.className}>{props.children}</h2>
  ),
}));

// Keep experiment state local to this suite so cross-file happy-dom storage cannot affect cards.
let dynamicWorkflowsEnabled = false;
void mock.module("@/browser/contexts/ExperimentsContext", () => ({
  useExperimentValue: () => dynamicWorkflowsEnabled,
}));

import { WorkflowResumeToolCall, WorkflowRunToolCall } from "./WorkflowRunToolCall";

function APIHarness(props: { client: unknown; children: ReactNode }) {
  return (
    <APIContext.Provider
      value={{
        status: "connected",
        api: props.client as never,
        error: null,
        authenticate: () => undefined,
        retry: () => undefined,
      }}
    >
      {props.children}
    </APIContext.Provider>
  );
}

const TEST_WORKFLOW_SCRIPT_PATH = "skill://deep-research/workflow.js";
const TEST_REQUESTED_WORKFLOW_SCRIPT_PATH = "skill://deep-research/./workflow.js";

const TEST_WORKSPACE_ID = "workflow-run-tool-test";

function withStickyToolProviders(ui: ReactElement, toolName = "workflow_run") {
  return (
    <ThemeProvider forcedTheme="dark">
      <MessageListProvider value={{ workspaceId: TEST_WORKSPACE_ID, latestMessageId: null }}>
        <ToolNameProvider toolName={toolName}>
          <TooltipProvider>{ui}</TooltipProvider>
        </ToolNameProvider>
      </MessageListProvider>
    </ThemeProvider>
  );
}

function renderWithStickyToolProviders(ui: ReactElement, toolName = "workflow_run") {
  return render(withStickyToolProviders(ui, toolName));
}

function getStoredPrefs(): string | null {
  return globalThis.localStorage.getItem(getAutoExpandPrefsKey(TEST_WORKSPACE_ID));
}

function createWorkflowRunForExpansionTest(input: {
  id: string;
  status: "running" | "completed";
  reportMarkdown?: string;
}) {
  return {
    id: input.id,
    workspaceId: TEST_WORKSPACE_ID,
    workflow: {
      name: "deep-research",
      description: "Deep research",
      scope: "built-in" as const,
      sourcePath: TEST_WORKFLOW_SCRIPT_PATH,
      requestedScriptPath: TEST_WORKFLOW_SCRIPT_PATH,
      canonicalScriptPath: TEST_WORKFLOW_SCRIPT_PATH,
      sourceKind: "skill" as const,
      sourceHash: "sha256:test",
      executable: true,
    },
    source: "export default function workflow() { return null; }",
    sourceHash: "sha256:test",
    args: { topic: "workflow cards" },
    status: input.status,
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt:
      input.status === "completed" ? "2026-05-29T00:00:02.000Z" : "2026-05-29T00:00:01.000Z",
    events:
      input.status === "completed"
        ? [
            {
              sequence: 1,
              type: "result" as const,
              at: "2026-05-29T00:00:02.000Z",
              result: { reportMarkdown: input.reportMarkdown ?? `${input.id} result` },
            },
            {
              sequence: 2,
              type: "status" as const,
              at: "2026-05-29T00:00:02.000Z",
              status: "completed" as const,
            },
          ]
        : [
            {
              sequence: 1,
              type: "status" as const,
              at: "2026-05-29T00:00:01.000Z",
              status: "running" as const,
            },
          ],
    steps: [],
  };
}

function createTimelineRun(input: {
  id: string;
  status?: "running" | "backgrounded" | "completed";
  stepTitle?: string;
  updatedAt?: string;
}): WorkflowRunRecord {
  const status = input.status ?? "running";
  const stepTitle = input.stepTitle ?? "Collect sources";
  const completed = status === "completed";
  const base = createWorkflowRunForExpansionTest({
    id: input.id,
    status: completed ? "completed" : "running",
  });
  const updatedAt =
    input.updatedAt ?? (completed ? "2026-05-29T00:00:03.000Z" : "2026-05-29T00:00:02.000Z");
  return {
    ...base,
    status,
    updatedAt,
    events: [
      { sequence: 1, type: "status", at: "2026-05-29T00:00:01.000Z", status },
      { sequence: 2, type: "phase", at: "2026-05-29T00:00:01.000Z", name: "Research" },
      {
        sequence: 3,
        type: "task",
        at: "2026-05-29T00:00:01.000Z",
        stepId: "collect",
        taskId: "task_collect",
        status: completed ? "completed" : "started",
        title: stepTitle,
      },
      ...(completed
        ? [{ sequence: 4, type: "status" as const, at: updatedAt, status: "completed" as const }]
        : []),
    ],
    steps: [
      {
        stepId: "collect",
        inputHash: "sha256:collect",
        status: completed ? "completed" : "started",
        taskId: "task_collect",
        startedAt: "2026-05-29T00:00:01.000Z",
        ...(completed ? { completedAt: updatedAt } : {}),
      },
    ],
  };
}

function createWorkflowSubscription() {
  const queued: WorkflowRunStreamEvent[] = [];
  let resolveNext: ((result: IteratorResult<WorkflowRunStreamEvent>) => void) | null = null;
  let closed = false;
  const iterator: AsyncIterableIterator<WorkflowRunStreamEvent> = {
    next: () => {
      const event = queued.shift();
      if (event != null) {
        return Promise.resolve({ value: event, done: false });
      }
      if (closed) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise((resolve) => {
        resolveNext = resolve;
      });
    },
    return: () => {
      closed = true;
      resolveNext?.({ value: undefined, done: true });
      resolveNext = null;
      return Promise.resolve({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return {
    iterator,
    emit(event: WorkflowRunStreamEvent) {
      if (resolveNext != null) {
        const resolve = resolveNext;
        resolveNext = null;
        resolve({ value: event, done: false });
        return;
      }
      queued.push(event);
    },
  };
}

function CommandActionCapture(props: { onActions: (actions: CommandAction[]) => void }) {
  const registry = useCommandRegistry();
  useEffect(() => {
    props.onActions(registry.getActions());
  });
  return null;
}

function getWorkflowHeader(view: ReturnType<typeof render>): HTMLElement {
  const workflowBadge = view.getByText("Workflow");
  const header = workflowBadge.closest('[data-scroll-intent="ignore"]');
  if (header == null) {
    throw new Error("Workflow header not found");
  }
  return header as HTMLElement;
}

function openEventLog(view: ReturnType<typeof render>): void {
  const disclosure = view.queryByText("Event log");
  if (disclosure != null) {
    fireEvent.click(disclosure);
  }
}

describe("WorkflowRunToolCall", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalLocalStorage: typeof globalThis.localStorage;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalLocalStorage = globalThis.localStorage;
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.localStorage = globalThis.window.localStorage;
    dynamicWorkflowsEnabled = false;
  });

  afterEach(() => {
    useWorkspaceStoreRaw().setNavigateToWorkspace(() => undefined);
    useWorkspaceStoreRaw().syncWorkspaces(new Map());
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
  });

  test("auto-collapses completed workflow runs without mutating sticky preferences", () => {
    const completedRun = createWorkflowRunForExpansionTest({
      id: "wfr_auto_collapse",
      status: "completed",
      reportMarkdown: "auto result",
    });
    const completedView = renderWithStickyToolProviders(
      <WorkflowRunToolCall
        args={{
          script_path: "skill://deep-research/workflow.js",
          args: { topic: "workflow cards" },
          run_in_background: false,
        }}
        status="completed"
        result={{
          status: "completed",
          runId: completedRun.id,
          result: { reportMarkdown: "auto result" },
          run: completedRun,
        }}
      />
    );

    expect(completedView.queryByText("wfr_auto_collapse")).toBeNull();
    expect(completedView.queryByText("auto result")).toBeNull();
    expect(getStoredPrefs()).toBeNull();
    completedView.unmount();

    const runningRun = createWorkflowRunForExpansionTest({ id: "wfr_running", status: "running" });
    const executingView = renderWithStickyToolProviders(
      <WorkflowRunToolCall
        args={{
          script_path: "skill://deep-research/workflow.js",
          args: { topic: "workflow cards" },
          run_in_background: true,
        }}
        status="executing"
        result={{ status: "running", runId: runningRun.id, result: null, run: runningRun }}
      />
    );

    expect(executingView.getByText("wfr_running")).toBeTruthy();
    expect(getStoredPrefs()).toBeNull();
  });

  test("keeps active workflow runs expanded with the workflows experiment enabled", () => {
    dynamicWorkflowsEnabled = true;

    for (const status of ["running", "backgrounded"] as const) {
      const run = createTimelineRun({ id: `wfr_active_${status}`, status });
      const view = renderWithStickyToolProviders(
        <WorkflowRunToolCall
          args={{ script_path: TEST_WORKFLOW_SCRIPT_PATH, run_in_background: true }}
          status={status === "backgrounded" ? "backgrounded" : "executing"}
          result={{ status, runId: run.id, result: null, run }}
        />
      );

      expect(view.getByText(run.id)).toBeTruthy();
      expect(view.getByText("Research")).toBeTruthy();
      view.unmount();
    }

    const completedRun = createTimelineRun({ id: "wfr_dynamic_completed", status: "completed" });
    const completedView = renderWithStickyToolProviders(
      <WorkflowRunToolCall
        args={{ script_path: TEST_WORKFLOW_SCRIPT_PATH, run_in_background: false }}
        status="completed"
        result={{ status: "completed", runId: completedRun.id, result: null, run: completedRun }}
      />
    );
    expect(completedView.queryByText(completedRun.id)).toBeNull();
  });

  test("auto-collapses a non-interacted card when its run becomes terminal", () => {
    dynamicWorkflowsEnabled = true;
    const runningRun = createTimelineRun({ id: "wfr_transition" });
    const completedRun = createTimelineRun({ id: runningRun.id, status: "completed" });
    const renderCard = (run: WorkflowRunRecord) =>
      withStickyToolProviders(
        <WorkflowRunToolCall
          args={{ script_path: TEST_WORKFLOW_SCRIPT_PATH, run_in_background: true }}
          status={run.status === "completed" ? "completed" : "executing"}
          result={{ status: run.status, runId: run.id, result: null, run }}
        />
      );
    const view = render(renderCard(runningRun));

    expect(view.getByText(runningRun.id)).toBeTruthy();
    view.rerender(renderCard(completedRun));
    expect(view.queryByText(completedRun.id)).toBeNull();
  });

  test("manual collapse sticks while the live header summary updates", () => {
    dynamicWorkflowsEnabled = true;
    const runningRun = createTimelineRun({ id: "wfr_manual_live" });
    const updatedRun = createTimelineRun({
      id: runningRun.id,
      stepTitle: "Verify claims",
      updatedAt: "2026-05-29T00:00:03.000Z",
    });
    const renderCard = (run: WorkflowRunRecord) =>
      withStickyToolProviders(
        <WorkflowRunToolCall
          args={{ script_path: TEST_WORKFLOW_SCRIPT_PATH, run_in_background: true }}
          status="executing"
          result={{ status: "running", runId: run.id, result: null, run }}
        />
      );
    const view = render(renderCard(runningRun));

    fireEvent.click(getWorkflowHeader(view));
    expect(view.queryByText(runningRun.id)).toBeNull();
    view.rerender(renderCard(updatedRun));

    expect(view.queryByText(updatedRun.id)).toBeNull();
    expect(getWorkflowHeader(view).textContent).toContain("0/1 steps · Verify claims");
  });
  test("resets completed workflow auto-collapse interaction for a new run id", () => {
    const firstRun = createWorkflowRunForExpansionTest({ id: "wfr_first", status: "completed" });
    const secondRun = createWorkflowRunForExpansionTest({ id: "wfr_second", status: "completed" });
    const view = renderWithStickyToolProviders(
      <WorkflowRunToolCall
        args={{
          script_path: "skill://deep-research/workflow.js",
          args: { topic: "workflow cards" },
          run_in_background: false,
        }}
        status="completed"
        result={{
          status: "completed",
          runId: firstRun.id,
          result: { reportMarkdown: "first result" },
          run: firstRun,
        }}
      />
    );

    expect(view.queryByText("wfr_first")).toBeNull();
    fireEvent.click(getWorkflowHeader(view));
    expect(view.getByText("wfr_first")).toBeTruthy();
    expect(JSON.parse(getStoredPrefs() ?? "{}")).toEqual({ tools: { workflow_run: true } });

    view.rerender(
      withStickyToolProviders(
        <WorkflowRunToolCall
          args={{
            script_path: "skill://deep-research/workflow.js",
            args: { topic: "workflow cards" },
            run_in_background: false,
          }}
          status="completed"
          result={{
            status: "completed",
            runId: secondRun.id,
            result: { reportMarkdown: "second result" },
            run: secondRun,
          }}
        />
      )
    );

    expect(view.queryByText("wfr_second")).toBeNull();
    expect(view.queryByText("second result")).toBeNull();
    expect(JSON.parse(getStoredPrefs() ?? "{}")).toEqual({ tools: { workflow_run: true } });
  });

  test("renders workflow run phases, linked task ids, and final report", async () => {
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <TooltipProvider>
          <WorkflowRunToolCall
            args={{
              name: "deep-research",
              args: { topic: "workflow cards" },
              run_in_background: false,
            }}
            status="completed"
            result={{
              status: "completed",
              runId: "wfr_123",
              result: {
                reportMarkdown: "# Final report\n\nWorkflow result body.",
                structuredOutput: { confidence: "medium" },
              },
              run: {
                id: "wfr_123",
                workspaceId: "workspace-1",
                workflow: {
                  name: "deep-research",
                  description: "Deep research",
                  scope: "built-in",
                  requestedScriptPath: "skill://deep-research/workflow.js",
                  canonicalScriptPath: "skill://deep-research/workflow.js",
                  sourceKind: "skill",
                  sourceHash: "sha256:abc123",
                  executable: true,
                },
                source: "export default function workflow() { return null; }",
                sourceHash: "sha256:test",
                args: { topic: "workflow cards" },
                status: "completed",
                createdAt: "2026-05-29T00:00:00.000Z",
                updatedAt: "2026-05-29T00:00:01.000Z",
                events: [
                  {
                    sequence: 1,
                    type: "status",
                    at: "2026-05-29T00:00:00.000Z",
                    status: "running",
                  },
                  { sequence: 2, type: "phase", at: "2026-05-29T00:00:00.000Z", name: "scope" },
                  {
                    sequence: 3,
                    type: "log",
                    at: "2026-05-29T00:00:00.000Z",
                    message: "Scoped topic",
                    data: { topic: "workflow cards" },
                  },
                  {
                    sequence: 4,
                    type: "agent-step",
                    at: "2026-05-29T00:00:00.000Z",
                    stepId: "scope-topic",
                    inputHash: "sha256:scope",
                    status: "reserving",
                    title: "Scope topic",
                    details: { agentId: "explore" },
                  },
                  {
                    sequence: 5,
                    type: "task",
                    at: "2026-05-29T00:00:00.000Z",
                    stepId: "scope-topic",
                    taskId: "task_scope",
                    status: "completed",
                  },
                  {
                    sequence: 6,
                    type: "phase",
                    at: "2026-05-29T00:00:00.000Z",
                    name: "adversarial-verification",
                  },
                  {
                    sequence: 7,
                    type: "validation",
                    at: "2026-05-29T00:00:00.000Z",
                    stepId: "adversarial-verify",
                    success: true,
                  },
                  {
                    sequence: 8,
                    type: "result",
                    at: "2026-05-29T00:00:01.000Z",
                    result: { reportMarkdown: "# Final report\n\nWorkflow result body." },
                  },
                  {
                    sequence: 9,
                    type: "status",
                    at: "2026-05-29T00:00:01.000Z",
                    status: "completed",
                  },
                ],
                steps: [
                  {
                    stepId: "scope-topic",
                    inputHash: "sha256:scope",
                    status: "completed",
                    taskId: "task_scope",
                    startedAt: "2026-05-29T00:00:00.000Z",
                    completedAt: "2026-05-29T00:00:01.000Z",
                    result: { reportMarkdown: "## Scope task report\n\nChild task report body." },
                  },
                ],
              },
            }}
          />
        </TooltipProvider>
      </ThemeProvider>
    );

    expect(view.getAllByText("deep-research").length).toBeGreaterThan(0);
    const workflowHeader = getWorkflowHeader(view);
    expect(workflowHeader.textContent?.indexOf("Workflow") ?? -1).toBeLessThan(
      workflowHeader.textContent?.indexOf("deep-research") ?? -1
    );
    expect(view.queryByText("wfr_123")).toBeNull();

    fireEvent.click(workflowHeader);
    openEventLog(view);

    expect(view.getByText("wfr_123")).toBeTruthy();
    const getDisclosureForTitle = (title: string) => view.getByText(title).closest("details");
    expect(getDisclosureForTitle("Arguments")?.hasAttribute("open")).toBe(false);
    expect(getDisclosureForTitle("Script source")?.hasAttribute("open")).toBe(false);
    expect(getDisclosureForTitle("Structured output")?.hasAttribute("open")).toBe(false);
    expect(view.container.textContent).toContain("workflow cards");
    expect(view.container.textContent).toContain("skill://deep-research/workflow.js");
    expect(view.container.textContent).toContain("sha256:abc123");
    expect(view.container.textContent).toContain("scope");
    expect(view.container.textContent).toContain("adversarial-verification");
    expect(view.getByText("Scope topic / reserving")).toBeTruthy();
    expect(view.container.textContent).toContain("task_scope");
    const firstEventIndex = view.getByText("#1");
    expect(firstEventIndex).toBeTruthy();
    expect(firstEventIndex.getAttribute("title")).toBeNull();
    expect(firstEventIndex.getAttribute("aria-label")).toBe("Raw event #2");
    expect(
      view
        .getAllByText("scope")
        .some((element) => element.closest("div")?.className.includes("bg-plan-mode-alpha"))
    ).toBe(true);
    expect(view.getByText("Scoped topic").closest("div")?.className).not.toContain(
      "bg-plan-mode-alpha"
    );
    expect(view.getByText("Event log")).toBeTruthy();
    const taskEventRow = view.getByText("scope-topic / task_scope / completed");
    const taskEventIndex = view.getByText("#3");
    expect(taskEventIndex.className).toContain("cursor-help");
    expect(taskEventRow.closest('[role="button"]')).toBeNull();
    expect(taskEventRow.getAttribute("title")).toBeNull();
    expect(taskEventRow.closest("summary")).toBeNull();
    const taskReportToggle = view.getByLabelText("Open report for task_scope");
    expect(taskReportToggle.closest('[role="button"]')).toBeNull();

    fireEvent.click(taskReportToggle);

    await waitFor(() => {
      const reportDialog = document.querySelector('[role="dialog"]');
      expect(reportDialog?.textContent).toContain("Child task report body.");
    });
    await waitFor(() => expect(view.container.textContent).toContain("Workflow result body"));
    const renderedText = document.body.textContent ?? "";
    expect(renderedText.indexOf("confidence")).toBeLessThan(
      renderedText.indexOf("Workflow result body")
    );
    expect(renderedText).toContain("confidence");
  });

  test("inlines nested workflow progress in workflow event rows", async () => {
    const timestamp = "2026-05-29T00:00:00.000Z";
    const childRun: WorkflowRunRecord = {
      id: "wfr_child01",
      workspaceId: "workspace-1",
      workflow: {
        name: "implementation-loop",
        description: "Implementation loop",
        scope: "global",
        requestedScriptPath: "skill://implementation-loop/workflow.js",
        canonicalScriptPath: "skill://implementation-loop/workflow.js",
        sourceKind: "skill",
        sourceHash: "sha256:child",
        executable: true,
      },
      source: "export default function workflow() { return null; }",
      sourceHash: "sha256:child",
      args: { target: "coder/mux#3546" },
      parentWorkflow: {
        runId: "wfr_parent01",
        stepId: "implementation-loop",
        inputHash: "hash-child",
        depth: 0,
      },
      status: "running",
      createdAt: timestamp,
      updatedAt: timestamp,
      events: [
        { sequence: 1, type: "status", at: timestamp, status: "running" },
        { sequence: 2, type: "phase", at: timestamp, name: "child-phase" },
      ],
      steps: [],
    };
    const requestedRunIds: string[] = [];
    const client = {
      workflows: {
        getRun: async (input: { runId: string }) => {
          requestedRunIds.push(input.runId);
          return childRun;
        },
      },
    };

    const view = renderWithStickyToolProviders(
      <APIHarness client={client}>
        <WorkflowRunToolCall
          args={{
            name: "issue-implementation-loop",
            args: { issue: 3546 },
            run_in_background: false,
          }}
          status="executing"
          result={{
            status: "running",
            runId: "wfr_parent01",
            result: null,
            run: {
              id: "wfr_parent01",
              workspaceId: "workspace-1",
              workflow: {
                name: "issue-implementation-loop",
                description: "Issue loop",
                scope: "global",
                requestedScriptPath: "skill://issue-implementation-loop/workflow.js",
                canonicalScriptPath: "skill://issue-implementation-loop/workflow.js",
                sourceKind: "skill",
                sourceHash: "sha256:parent",
                executable: true,
              },
              source: "export default function workflow() { return null; }",
              sourceHash: "sha256:parent",
              args: { issue: 3546 },
              status: "running",
              createdAt: timestamp,
              updatedAt: timestamp,
              events: [
                { sequence: 1, type: "phase", at: timestamp, name: "delegate" },
                {
                  sequence: 2,
                  type: "workflow",
                  at: timestamp,
                  stepId: "implementation-loop",
                  runId: "wfr_child01",
                  name: "implementation-loop",
                  status: "started",
                },
              ],
              steps: [
                {
                  stepId: "implementation-loop",
                  inputHash: "hash-child",
                  status: "started",
                  startedAt: timestamp,
                },
              ],
            },
          }}
        />
      </APIHarness>
    );

    openEventLog(view);
    await waitFor(() => {
      expect(view.getByText("child-phase")).toBeTruthy();
    });
    expect(requestedRunIds).toContain("wfr_child01");
    expect(view.container.textContent).toContain("running · 0/0 steps · child-phase");
  });

  test("shows live step progress in the header while the run is active", () => {
    const timestamp = "2026-05-29T00:00:00.000Z";
    const laterTimestamp = "2026-05-29T00:00:05.000Z";
    const run: WorkflowRunRecord = {
      id: "wfr_progress01",
      workspaceId: "workspace-1",
      workflow: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in",
        requestedScriptPath: TEST_WORKFLOW_SCRIPT_PATH,
        canonicalScriptPath: TEST_WORKFLOW_SCRIPT_PATH,
        sourceKind: "skill",
        sourceHash: "sha256:progress",
        executable: true,
      },
      source: "export default function workflow() { return null; }",
      sourceHash: "sha256:progress",
      args: {},
      status: "running",
      createdAt: timestamp,
      updatedAt: laterTimestamp,
      events: [
        { sequence: 1, type: "status", at: timestamp, status: "running" },
        { sequence: 2, type: "phase", at: timestamp, name: "research" },
        {
          sequence: 3,
          type: "task",
          at: timestamp,
          stepId: "step-1",
          taskId: "task-1",
          status: "started",
          title: "Survey prior art",
        },
        {
          sequence: 4,
          type: "task",
          at: laterTimestamp,
          stepId: "step-1",
          taskId: "task-1",
          status: "completed",
          title: "Survey prior art",
        },
        {
          sequence: 5,
          type: "task",
          at: laterTimestamp,
          stepId: "step-2",
          taskId: "task-2",
          status: "started",
          title: "Draft report",
        },
      ],
      steps: [
        {
          stepId: "step-1",
          inputHash: "hash-1",
          status: "completed",
          taskId: "task-1",
          startedAt: timestamp,
          completedAt: laterTimestamp,
        },
        {
          stepId: "step-2",
          inputHash: "hash-2",
          status: "started",
          taskId: "task-2",
          startedAt: laterTimestamp,
        },
      ],
    };
    const client = {
      workflows: {
        getRun: async () => run,
      },
    };

    const view = renderWithStickyToolProviders(
      <APIHarness client={client}>
        <WorkflowRunToolCall
          args={{ script_path: TEST_WORKFLOW_SCRIPT_PATH, args: {}, run_in_background: false }}
          status="executing"
          result={{ status: "running", runId: run.id, result: null, run }}
        />
      </APIHarness>
    );

    // Progress is a collapsed-header affordance; the expanded body already shows events.
    const header = getWorkflowHeader(view);
    expect(header.textContent).not.toContain("1/2 steps");
    fireEvent.click(header);
    expect(header.textContent).toContain("1/2 steps · Draft report");
  });

  test("omits header progress once the run completes", () => {
    const timestamp = "2026-05-29T00:00:00.000Z";
    const run: WorkflowRunRecord = {
      ...createWorkflowRunForExpansionTest({ id: "wfr_progress02", status: "completed" }),
      events: [
        { sequence: 1, type: "phase", at: timestamp, name: "research" },
        {
          sequence: 2,
          type: "task",
          at: timestamp,
          stepId: "step-1",
          taskId: "task-1",
          status: "completed",
          title: "Survey prior art",
        },
        { sequence: 3, type: "status", at: timestamp, status: "completed" },
      ],
      steps: [
        {
          stepId: "step-1",
          inputHash: "hash-1",
          status: "completed",
          taskId: "task-1",
          startedAt: timestamp,
          completedAt: timestamp,
        },
      ],
    };
    const client = {
      workflows: {
        getRun: async () => null,
      },
    };

    const view = renderWithStickyToolProviders(
      <APIHarness client={client}>
        <WorkflowRunToolCall
          args={{ script_path: TEST_WORKFLOW_SCRIPT_PATH, args: {}, run_in_background: false }}
          status="completed"
          result={{ status: "completed", runId: run.id, result: null, run }}
        />
      </APIHarness>
    );

    expect(getWorkflowHeader(view).textContent).not.toContain("steps");
  });

  test("does not fetch collapsed terminal child rows after the parent run is terminal", async () => {
    const timestamp = "2026-05-29T00:00:00.000Z";
    let getRunCount = 0;
    const client = {
      workflows: {
        getRun: () => {
          getRunCount += 1;
          return Promise.resolve(null);
        },
      },
    };

    renderWithStickyToolProviders(
      <APIHarness client={client}>
        <WorkflowRunToolCall
          args={{ name: "issue-implementation-loop", args: {}, run_in_background: false }}
          status="interrupted"
          result={{
            status: "interrupted",
            runId: "wfr_parent_terminal_child",
            result: null,
            run: {
              id: "wfr_parent_terminal_child",
              workspaceId: "workspace-1",
              workflow: {
                name: "issue-implementation-loop",
                description: "Issue loop",
                scope: "global",
                requestedScriptPath: "skill://issue-implementation-loop/workflow.js",
                canonicalScriptPath: "skill://issue-implementation-loop/workflow.js",
                sourceKind: "skill",
                sourceHash: "sha256:parent",
                executable: true,
                // Server-shaped record: already hydrated (none derivable).
                phaseManifest: null,
              },
              source: "export default function workflow() { return null; }",
              sourceHash: "sha256:parent",
              args: {},
              status: "interrupted",
              createdAt: timestamp,
              updatedAt: timestamp,
              events: [
                {
                  sequence: 1,
                  type: "workflow",
                  at: timestamp,
                  stepId: "implementation-loop",
                  runId: "wfr_terminal_child",
                  name: "implementation-loop",
                  status: "failed",
                },
              ],
              steps: [],
            },
          }}
        />
      </APIHarness>
    );

    await Promise.resolve();

    expect(getRunCount).toBe(0);
  });

  test("refreshes a collapsed terminal workflow row when the child run is active again", async () => {
    const timestamp = "2026-05-29T00:00:00.000Z";
    const retriedChildRun: WorkflowRunRecord = {
      id: "wfr_retried_child",
      workspaceId: "workspace-1",
      workflow: {
        name: "implementation-loop",
        description: "Implementation loop",
        scope: "global",
        requestedScriptPath: "skill://implementation-loop/workflow.js",
        canonicalScriptPath: "skill://implementation-loop/workflow.js",
        sourceKind: "skill",
        sourceHash: "sha256:child",
        executable: true,
      },
      source: "export default function workflow() { return null; }",
      sourceHash: "sha256:child",
      args: {},
      status: "running",
      createdAt: timestamp,
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [{ sequence: 1, type: "status", at: timestamp, status: "running" }],
      steps: [],
    };
    const client = {
      workflows: {
        getRun: () => Promise.resolve(retriedChildRun),
      },
    };

    const view = renderWithStickyToolProviders(
      <APIHarness client={client}>
        <WorkflowRunToolCall
          args={{ name: "issue-implementation-loop", args: {}, run_in_background: false }}
          status="completed"
          result={{
            status: "running",
            runId: "wfr_parent_retried_child",
            result: null,
            run: {
              id: "wfr_parent_retried_child",
              workspaceId: "workspace-1",
              workflow: {
                name: "issue-implementation-loop",
                description: "Issue loop",
                scope: "global",
                requestedScriptPath: "skill://issue-implementation-loop/workflow.js",
                canonicalScriptPath: "skill://issue-implementation-loop/workflow.js",
                sourceKind: "skill",
                sourceHash: "sha256:parent",
                executable: true,
              },
              source: "export default function workflow() { return null; }",
              sourceHash: "sha256:parent",
              args: {},
              status: "running",
              createdAt: timestamp,
              updatedAt: timestamp,
              events: [
                {
                  sequence: 1,
                  type: "workflow",
                  at: timestamp,
                  stepId: "implementation-loop",
                  runId: "wfr_retried_child",
                  name: "implementation-loop",
                  status: "failed",
                },
              ],
              steps: [],
            },
          }}
        />
      </APIHarness>
    );

    await waitFor(() => {
      expect(
        view.getByText("implementation-loop / implementation-loop / wfr_retried_child / running")
      ).toBeTruthy();
    });
  });

  test("keeps workflow event details visible when a nested run is unavailable", async () => {
    const timestamp = "2026-05-29T00:00:00.000Z";
    const client = {
      workflows: {
        getRun: () => Promise.resolve(null),
      },
    };

    const view = renderWithStickyToolProviders(
      <APIHarness client={client}>
        <WorkflowRunToolCall
          args={{
            name: "issue-implementation-loop",
            args: { issue: 3546 },
            run_in_background: false,
          }}
          status="executing"
          result={{
            status: "running",
            runId: "wfr_parent_missing_child",
            result: null,
            run: {
              id: "wfr_parent_missing_child",
              workspaceId: "workspace-1",
              workflow: {
                name: "issue-implementation-loop",
                description: "Issue loop",
                scope: "global",
                requestedScriptPath: "skill://issue-implementation-loop/workflow.js",
                canonicalScriptPath: "skill://issue-implementation-loop/workflow.js",
                sourceKind: "skill",
                sourceHash: "sha256:parent",
                executable: true,
              },
              source: "export default function workflow() { return null; }",
              sourceHash: "sha256:parent",
              args: { issue: 3546 },
              status: "running",
              createdAt: timestamp,
              updatedAt: timestamp,
              events: [
                { sequence: 1, type: "phase", at: timestamp, name: "delegate" },
                {
                  sequence: 2,
                  type: "workflow",
                  at: timestamp,
                  stepId: "implementation-loop",
                  runId: "wfr_missing_child",
                  name: "implementation-loop",
                  status: "started",
                  details: { error: "child run metadata missing" },
                },
              ],
              steps: [
                {
                  stepId: "implementation-loop",
                  inputHash: "hash-child",
                  status: "started",
                  startedAt: timestamp,
                },
              ],
            },
          }}
        />
      </APIHarness>
    );

    openEventLog(view);
    await waitFor(() => {
      expect(view.getByText("Nested workflow run is not available.")).toBeTruthy();
    });
    expect(view.container.textContent).toContain("Workflow event details");
    expect(view.container.textContent).toContain("child run metadata missing");
  });

  test("coalesces task attempts, navigates active rows, expands completed outputs, opens workspaces, and opens reports", async () => {
    const navigatedTo: string[] = [];
    useWorkspaceStoreRaw().setNavigateToWorkspace((workspaceId) => {
      navigatedTo.push(workspaceId);
    });
    useWorkspaceStoreRaw().syncWorkspaces(
      new Map([
        ["task_live", createWorkflowTaskWorkspaceMetadata("task_live")],
        ["task_retry", createWorkflowTaskWorkspaceMetadata("task_retry")],
      ])
    );
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <TooltipProvider>
          <WorkflowRunToolCall
            args={{ name: "implementation", args: {}, run_in_background: true }}
            status="executing"
            result={{
              status: "running",
              runId: "wfr_task_rows",
              result: null,
              run: {
                id: "wfr_task_rows",
                workspaceId: "workspace-1",
                workflow: {
                  name: "implementation",
                  description: "Implementation",
                  scope: "built-in",
                  executable: true,
                },
                source: "export default function workflow() { return null; }",
                sourceHash: "sha256:test",
                args: {},
                status: "running",
                createdAt: "2026-05-29T00:00:00.000Z",
                updatedAt: "2026-05-29T00:00:01.000Z",
                events: [
                  {
                    sequence: 1,
                    type: "status",
                    at: "2026-05-29T00:00:00.000Z",
                    status: "running",
                  },
                  {
                    sequence: 2,
                    type: "task",
                    at: "2026-05-29T00:00:00.000Z",
                    stepId: "implement",
                    taskId: "task_live",
                    status: "started",
                  },
                  {
                    sequence: 3,
                    type: "task",
                    at: "2026-05-29T00:00:01.000Z",
                    stepId: "implement",
                    taskId: "task_live",
                    status: "completed",
                  },
                  {
                    sequence: 4,
                    type: "task",
                    at: "2026-05-29T00:00:01.000Z",
                    stepId: "implement",
                    taskId: "task_retry",
                    status: "started",
                  },
                  {
                    sequence: 5,
                    type: "patch",
                    at: "2026-05-29T00:00:01.000Z",
                    stepId: "apply-implement",
                    sourceTaskId: "task_live",
                    status: "started",
                  },
                ],
                steps: [
                  {
                    stepId: "implement",
                    inputHash: "sha256:implement-live",
                    status: "completed",
                    taskId: "task_live",
                    startedAt: "2026-05-29T00:00:00.000Z",
                    completedAt: "2026-05-29T00:00:01.000Z",
                    result: {
                      reportMarkdown: "## Implement report\n\nCompleted task body.",
                      structuredOutput: {
                        filesChanged: ["src/feature.ts"],
                        testsPassed: true,
                      },
                    },
                  },
                  {
                    stepId: "apply-implement",
                    inputHash: "sha256:patch",
                    status: "started",
                    taskId: "task_live",
                    startedAt: "2026-05-29T00:00:01.000Z",
                  },
                ],
              },
            }}
          />
        </TooltipProvider>
      </ThemeProvider>
    );

    openEventLog(view);
    expect(view.getAllByText("implement / task_live / completed")).toHaveLength(1);
    expect(view.queryByText("implement / task_live / started")).toBeNull();
    expect(view.getByText("implement / task_retry / started")).toBeTruthy();
    expect(view.getByText("apply-implement / task_live / started")).toBeTruthy();
    const activeTaskControl = view.getByRole("button", {
      name: "Open workflow task task_retry",
    });
    const openAffordance = activeTaskControl.querySelector('[aria-hidden="true"]');
    expect(openAffordance?.textContent).toBe("Open");
    expect(view.queryByRole("button", { name: "Open" })).toBeNull();

    fireEvent.click(activeTaskControl);
    expect(navigatedTo).toEqual(["task_retry"]);
    fireEvent.keyDown(activeTaskControl, { key: "Enter" });
    expect(navigatedTo).toEqual(["task_retry", "task_retry"]);

    const completedTaskControl = view.getByRole("button", {
      name: "Expand structured output for workflow task task_live",
    });
    expect(completedTaskControl.textContent).toContain("implement / task_live / completed");
    expect(completedTaskControl.getAttribute("aria-expanded")).toBe("false");
    expect(view.container.textContent).not.toContain("filesChanged");
    expect(view.container.textContent).not.toContain("Completed task body.");

    fireEvent.keyDown(completedTaskControl, { key: "Enter" });

    expect(navigatedTo).toEqual(["task_retry", "task_retry"]);
    expect(completedTaskControl.getAttribute("aria-expanded")).toBe("true");
    expect(view.container.textContent).toContain("filesChanged");
    expect(view.container.textContent).toContain("src/feature.ts");
    expect(view.container.textContent).toContain("testsPassed");
    const structuredOutputRegion = view.getByRole("region", {
      name: "Structured output for workflow task task_live",
    });
    expect(structuredOutputRegion.getAttribute("tabindex")).toBe("0");
    structuredOutputRegion.focus();
    expect(document.activeElement).toBe(structuredOutputRegion);
    expect(view.container.textContent).not.toContain("Completed task body.");

    const workspaceToggle = view.getByRole("button", { name: "Open task workspace for task_live" });
    expect(workspaceToggle.textContent).toBe("Workspace");
    fireEvent.click(workspaceToggle);
    expect(navigatedTo).toEqual(["task_retry", "task_retry", "task_live"]);

    const reportToggle = view.getByLabelText("Open report for task_live");
    expect(reportToggle.textContent).toBe("Report");
    expect(reportToggle.closest('[role="button"]')).toBeNull();
    fireEvent.click(reportToggle);

    expect(navigatedTo).toEqual(["task_retry", "task_retry", "task_live"]);
    await waitFor(() => {
      const reportDialog = document.querySelector('[role="dialog"]');
      expect(reportDialog?.textContent).toContain("Completed task body.");
    });

    fireEvent.click(view.getByLabelText("Close"));
    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
  });

  test("hides task report button for structured-only workflow reports", async () => {
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <TooltipProvider>
          <WorkflowRunToolCall
            args={{ name: "implementation", args: {}, run_in_background: true }}
            status="executing"
            result={{
              status: "running",
              runId: "wfr_structured_only_report",
              result: null,
              run: {
                id: "wfr_structured_only_report",
                workspaceId: "workspace-1",
                workflow: {
                  name: "implementation",
                  description: "Implementation",
                  scope: "built-in",
                  executable: true,
                },
                source: "export default function workflow() { return null; }",
                sourceHash: "sha256:test",
                args: {},
                status: "running",
                createdAt: "2026-05-29T00:00:00.000Z",
                updatedAt: "2026-05-29T00:00:01.000Z",
                events: [
                  {
                    sequence: 1,
                    type: "task",
                    at: "2026-05-29T00:00:00.000Z",
                    stepId: "scope",
                    taskId: "task_structured_only",
                    status: "completed",
                  },
                  {
                    sequence: 2,
                    type: "task",
                    at: "2026-05-29T00:00:01.000Z",
                    stepId: "manual-report",
                    taskId: "task_placeholder_markdown",
                    status: "completed",
                  },
                ],
                steps: [
                  {
                    stepId: "scope",
                    inputHash: "sha256:scope",
                    status: "completed",
                    taskId: "task_structured_only",
                    startedAt: "2026-05-29T00:00:00.000Z",
                    completedAt: "2026-05-29T00:00:01.000Z",
                    result: {
                      reportMarkdown: STRUCTURED_WORKFLOW_REPORT_PLACEHOLDER_MARKDOWN,
                      structuredOutput: { summary: "Scoped research angles" },
                    },
                  },
                  {
                    stepId: "manual-report",
                    inputHash: "sha256:manual-report",
                    status: "completed",
                    taskId: "task_placeholder_markdown",
                    startedAt: "2026-05-29T00:00:00.000Z",
                    completedAt: "2026-05-29T00:00:01.000Z",
                    result: {
                      reportMarkdown: STRUCTURED_WORKFLOW_REPORT_PLACEHOLDER_MARKDOWN,
                    },
                  },
                ],
              },
            }}
          />
        </TooltipProvider>
      </ThemeProvider>
    );

    openEventLog(view);
    expect(view.queryByLabelText("Open report for task_structured_only")).toBeNull();
    expect(view.container.textContent).not.toContain(
      STRUCTURED_WORKFLOW_REPORT_PLACEHOLDER_MARKDOWN
    );

    const placeholderReportToggle = view.getByLabelText(
      "Open report for task_placeholder_markdown"
    );
    expect(placeholderReportToggle.textContent).toBe("Report");
    fireEvent.click(placeholderReportToggle);
    await waitFor(() => {
      const reportDialog = document.querySelector('[role="dialog"]');
      expect(reportDialog?.textContent).toContain(STRUCTURED_WORKFLOW_REPORT_PLACEHOLDER_MARKDOWN);
    });
    fireEvent.click(view.getByLabelText("Close"));
    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    const completedTaskControl = view.getByRole("button", {
      name: "Expand structured output for workflow task task_structured_only",
    });
    fireEvent.click(completedTaskControl);

    expect(view.container.textContent).toContain("summary");
    expect(view.container.textContent).toContain("Scoped research angles");
  });

  test("labels task rows with the sub-agent title and falls back to stepId without one", () => {
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <TooltipProvider>
          <WorkflowRunToolCall
            args={{
              script_path: "skill://deep-research/workflow.js",
              args: {},
              run_in_background: true,
            }}
            status="executing"
            result={{
              status: "running",
              runId: "wfr_task_titles",
              result: null,
              run: {
                id: "wfr_task_titles",
                workspaceId: "workspace-1",
                workflow: {
                  name: "deep-research",
                  description: "Deep research",
                  scope: "built-in",
                  executable: true,
                },
                source: "export default function workflow() { return null; }",
                sourceHash: "sha256:test",
                args: {},
                status: "running",
                createdAt: "2026-05-29T00:00:00.000Z",
                updatedAt: "2026-05-29T00:00:01.000Z",
                events: [
                  {
                    sequence: 1,
                    type: "status",
                    at: "2026-05-29T00:00:00.000Z",
                    status: "running",
                  },
                  {
                    sequence: 2,
                    type: "task",
                    at: "2026-05-29T00:00:00.000Z",
                    stepId: "verify-claim-0-vote-2",
                    taskId: "task_verify",
                    status: "started",
                    title: "Verify claim 1 vote 3",
                  },
                  // Legacy persisted event without a title keeps the stepId label.
                  {
                    sequence: 3,
                    type: "task",
                    at: "2026-05-29T00:00:01.000Z",
                    stepId: "extract-source-0",
                    taskId: "task_extract",
                    status: "started",
                  },
                ],
                steps: [],
              },
            }}
          />
        </TooltipProvider>
      </ThemeProvider>
    );

    expect(view.getByText("Verify claim 1 vote 3 / task_verify / started")).toBeTruthy();
    expect(view.container.textContent).not.toContain("verify-claim-0-vote-2");
    expect(view.getByText("extract-source-0 / task_extract / started")).toBeTruthy();
  });

  test("coalesces nested workflow start and completion events into one row with child run details", () => {
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <TooltipProvider>
          <WorkflowRunToolCall
            args={{ name: "parent-simple", args: {}, run_in_background: false }}
            status="completed"
            result={{
              status: "completed",
              runId: "wfr_parent",
              result: { reportMarkdown: "done" },
              run: {
                id: "wfr_parent",
                workspaceId: "workspace-1",
                workflow: {
                  name: "parent-simple",
                  description: "Parent",
                  scope: "project",
                  executable: true,
                },
                source: "export default function workflow() { return null; }",
                sourceHash: "sha256:parent",
                args: {},
                status: "completed",
                createdAt: "2026-05-29T00:00:00.000Z",
                updatedAt: "2026-05-29T00:00:01.000Z",
                events: [
                  {
                    sequence: 1,
                    type: "workflow",
                    at: "2026-05-29T00:00:00.000Z",
                    stepId: "child-simple",
                    runId: "wfr_child_abc",
                    name: "child-simple",
                    status: "started",
                  },
                  {
                    sequence: 2,
                    type: "workflow",
                    at: "2026-05-29T00:00:01.000Z",
                    stepId: "child-simple",
                    runId: "wfr_child_abc",
                    name: "child-simple",
                    status: "completed",
                    details: { reportMarkdown: "child done", runId: "wfr_child_abc" },
                  },
                  {
                    sequence: 3,
                    type: "result",
                    at: "2026-05-29T00:00:01.000Z",
                    result: { reportMarkdown: "done" },
                  },
                ],
                steps: [],
              },
            }}
          />
        </TooltipProvider>
      </ThemeProvider>
    );

    fireEvent.click(getWorkflowHeader(view));

    expect(view.getByText("Workflow events (1)")).toBeTruthy();
    expect(view.getByText("child-simple / child-simple / wfr_child_abc / completed")).toBeTruthy();
    expect(view.queryByText("#2")).toBeNull();
  });

  test("coalesces patch start and applied events into one row with combined details", () => {
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <TooltipProvider>
          <WorkflowRunToolCall
            args={{ name: "implementation", args: {}, run_in_background: true }}
            status="completed"
            result={{
              status: "completed",
              runId: "wfr_patch_rows",
              result: null,
              run: {
                id: "wfr_patch_rows",
                workspaceId: "workspace-1",
                workflow: {
                  name: "implementation",
                  description: "Implementation",
                  scope: "built-in",
                  executable: true,
                },
                source: "export default function workflow() { return null; }",
                sourceHash: "sha256:patches",
                args: {},
                status: "completed",
                createdAt: "2026-05-29T00:00:00.000Z",
                updatedAt: "2026-05-29T00:00:02.000Z",
                events: [
                  {
                    sequence: 1,
                    type: "patch",
                    at: "2026-05-29T00:00:00.000Z",
                    stepId: "apply-p0-p1",
                    sourceTaskId: "task_p0",
                    status: "started",
                    details: { target: "workspace" },
                  },
                  {
                    sequence: 2,
                    type: "patch",
                    at: "2026-05-29T00:00:01.000Z",
                    stepId: "apply-p0-p1",
                    sourceTaskId: "task_p0",
                    status: "applied",
                    details: { commitCount: 3 },
                  },
                  {
                    sequence: 3,
                    type: "patch",
                    at: "2026-05-29T00:00:02.000Z",
                    stepId: "apply-p1-p2",
                    sourceTaskId: "task_p1",
                    status: "started",
                    details: { target: "workspace" },
                  },
                ],
                steps: [],
              },
            }}
          />
        </TooltipProvider>
      </ThemeProvider>
    );

    fireEvent.click(getWorkflowHeader(view));

    expect(view.getByText("Workflow events (2)")).toBeTruthy();
    expect(view.getAllByText("apply-p0-p1 / task_p0 / applied")).toHaveLength(1);
    expect(view.queryByText("apply-p0-p1 / task_p0 / started")).toBeNull();
    expect(view.getByText("apply-p1-p2 / task_p1 / started")).toBeTruthy();
    expect(view.getByText("#1").getAttribute("aria-label")).toBe("Raw event #1");

    fireEvent.click(view.getByText("apply-p0-p1 / task_p0 / applied"));

    expect(view.container.textContent).toContain("target");
    expect(view.container.textContent).toContain("commitCount");
  });

  test("leaves cached action events separate from pending started rows", () => {
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <TooltipProvider>
          <WorkflowRunToolCall
            args={{ name: "action-list", args: {}, run_in_background: true }}
            status="completed"
            result={{
              status: "completed",
              runId: "wfr_action_cached_rows",
              result: null,
              run: {
                id: "wfr_action_cached_rows",
                workspaceId: "workspace-1",
                workflow: {
                  name: "action-list",
                  description: "Action list",
                  scope: "built-in",
                  executable: true,
                },
                source: "export default function workflow() { return null; }",
                sourceHash: "sha256:cached-actions",
                args: {},
                status: "completed",
                createdAt: "2026-05-29T00:00:00.000Z",
                updatedAt: "2026-05-29T00:00:02.000Z",
                events: [
                  {
                    sequence: 1,
                    type: "action",
                    at: "2026-05-29T00:00:00.000Z",
                    stepId: "git-status",
                    name: "git.status",
                    status: "started",
                    effect: "read",
                    sourcePath: "actions/git.ts",
                    sourceHash: "sha256:git",
                    details: { input: { marker: "stale-start" } },
                  },
                  {
                    sequence: 2,
                    type: "action",
                    at: "2026-05-29T00:00:01.000Z",
                    stepId: "git-status",
                    name: "git.status",
                    status: "cached",
                    effect: "read",
                    sourcePath: "actions/git.ts",
                    sourceHash: "sha256:git",
                    details: { stdout: "cached-result" },
                  },
                ],
                steps: [],
              },
            }}
          />
        </TooltipProvider>
      </ThemeProvider>
    );

    fireEvent.click(getWorkflowHeader(view));

    expect(view.getByText("Workflow events (2)")).toBeTruthy();
    expect(view.getByText("git-status / git.status / started")).toBeTruthy();
    expect(view.getByText("git-status / git.status / cached")).toBeTruthy();

    fireEvent.click(view.getByText("git-status / git.status / cached"));
    const cachedRow = view.getByText("git-status / git.status / cached").closest("details");
    if (cachedRow == null) {
      throw new Error("Expected cached action row details");
    }
    expect(cachedRow.textContent).toContain("cached-result");
    expect(cachedRow.textContent).not.toContain("stale-start");
  });

  test("preserves raw action rows when same-key starts overlap", () => {
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <TooltipProvider>
          <WorkflowRunToolCall
            args={{ name: "action-list", args: {}, run_in_background: true }}
            status="completed"
            result={{
              status: "completed",
              runId: "wfr_action_ambiguous_rows",
              result: null,
              run: {
                id: "wfr_action_ambiguous_rows",
                workspaceId: "workspace-1",
                workflow: {
                  name: "action-list",
                  description: "Action list",
                  scope: "built-in",
                  executable: true,
                },
                source: "export default function workflow() { return null; }",
                sourceHash: "sha256:ambiguous-actions",
                args: {},
                status: "completed",
                createdAt: "2026-05-29T00:00:00.000Z",
                updatedAt: "2026-05-29T00:00:04.000Z",
                events: [
                  {
                    sequence: 1,
                    type: "action",
                    at: "2026-05-29T00:00:00.000Z",
                    stepId: "git-status",
                    name: "git.status",
                    status: "started",
                    effect: "read",
                    sourcePath: "actions/git.ts",
                    sourceHash: "sha256:git",
                    details: { input: { marker: "first-start" } },
                  },
                  {
                    sequence: 2,
                    type: "action",
                    at: "2026-05-29T00:00:01.000Z",
                    stepId: "git-status",
                    name: "git.status",
                    status: "started",
                    effect: "read",
                    sourcePath: "actions/git.ts",
                    sourceHash: "sha256:git",
                    details: { input: { marker: "second-start" } },
                  },
                  {
                    sequence: 3,
                    type: "action",
                    at: "2026-05-29T00:00:02.000Z",
                    stepId: "git-status",
                    name: "git.status",
                    status: "completed",
                    effect: "read",
                    sourcePath: "actions/git.ts",
                    sourceHash: "sha256:git",
                    details: { stdout: "first-finish" },
                  },
                  {
                    sequence: 4,
                    type: "action",
                    at: "2026-05-29T00:00:03.000Z",
                    stepId: "git-status",
                    name: "git.status",
                    status: "completed",
                    effect: "read",
                    sourcePath: "actions/git.ts",
                    sourceHash: "sha256:git",
                    details: { stdout: "second-finish" },
                  },
                ],
                steps: [],
              },
            }}
          />
        </TooltipProvider>
      </ThemeProvider>
    );

    fireEvent.click(getWorkflowHeader(view));

    expect(view.getByText("Workflow events (4)")).toBeTruthy();
    expect(view.getAllByText("git-status / git.status / started")).toHaveLength(2);
    expect(view.getAllByText("git-status / git.status / completed")).toHaveLength(2);

    const firstCompletedLabel = view.getAllByText("git-status / git.status / completed")[0];
    if (firstCompletedLabel == null) {
      throw new Error("Expected at least one completed action row");
    }
    fireEvent.click(firstCompletedLabel);

    const completedRow = firstCompletedLabel.closest("details");
    if (completedRow == null) {
      throw new Error("Expected completed action row details");
    }
    expect(completedRow.textContent).toContain("first-finish");
    expect(completedRow.textContent).not.toContain("first-start");
    expect(completedRow.textContent).not.toContain("second-start");
  });

  test("hides task workspace actions when the task workspace is unavailable", async () => {
    const navigatedTo: string[] = [];
    useWorkspaceStoreRaw().setNavigateToWorkspace((workspaceId) => {
      navigatedTo.push(workspaceId);
    });
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <TooltipProvider>
          <WorkflowRunToolCall
            args={{ name: "implementation", args: {}, run_in_background: true }}
            status="executing"
            result={{
              status: "running",
              runId: "wfr_missing_task_workspace",
              result: null,
              run: {
                id: "wfr_missing_task_workspace",
                workspaceId: "workspace-1",
                workflow: {
                  name: "implementation",
                  description: "Implementation",
                  scope: "built-in",
                  executable: true,
                },
                source: "export default function workflow() { return null; }",
                sourceHash: "sha256:test",
                args: {},
                status: "running",
                createdAt: "2026-05-29T00:00:00.000Z",
                updatedAt: "2026-05-29T00:00:01.000Z",
                events: [
                  {
                    sequence: 1,
                    type: "task",
                    at: "2026-05-29T00:00:00.000Z",
                    stepId: "completed-task",
                    taskId: "task_deleted_report",
                    status: "completed",
                  },
                  {
                    sequence: 2,
                    type: "task",
                    at: "2026-05-29T00:00:01.000Z",
                    stepId: "running-task",
                    taskId: "task_deleted_running",
                    status: "started",
                  },
                ],
                steps: [
                  {
                    stepId: "completed-task",
                    inputHash: "sha256:completed",
                    status: "completed",
                    taskId: "task_deleted_report",
                    startedAt: "2026-05-29T00:00:00.000Z",
                    completedAt: "2026-05-29T00:00:01.000Z",
                    result: {
                      reportMarkdown: "## Deleted workspace report\n\nReport remains readable.",
                    },
                  },
                ],
              },
            }}
          />
        </TooltipProvider>
      </ThemeProvider>
    );

    openEventLog(view);
    expect(view.queryByLabelText("Open task workspace for task_deleted_report")).toBeNull();
    expect(view.queryByText("Open")).toBeNull();
    expect(
      view.queryByRole("button", { name: "Open workflow task task_deleted_running" })
    ).toBeNull();
    expect(navigatedTo).toEqual([]);

    fireEvent.click(view.getByLabelText("Open report for task_deleted_report"));
    await waitFor(() => {
      const reportDialog = document.querySelector('[role="dialog"]');
      expect(reportDialog?.textContent).toContain("Report remains readable.");
    });
  });

  test("renders the projected timeline with the raw event log collapsed", () => {
    const run = createTimelineRun({ id: "wfr_projected_timeline" });
    const view = renderWithStickyToolProviders(
      <WorkflowRunToolCall
        args={{ script_path: TEST_WORKFLOW_SCRIPT_PATH, run_in_background: true }}
        status="executing"
        result={{ status: "running", runId: run.id, result: null, run }}
      />
    );

    expect(view.getByText("0/1 steps")).toBeTruthy();
    // Without a usage overlay the stats row omits the token/cost cells entirely
    // (mirroring WorkflowRunHeader) instead of rendering dash placeholders.
    expect(view.queryByText(/tokens/)).toBeNull();
    fireEvent.click(view.getByText("Research"));
    expect(view.getByText("Collect sources")).toBeTruthy();
    expect(view.getByText("Event log")).toBeTruthy();
    expect(view.queryByLabelText("Raw event #3")).toBeNull();

    fireEvent.click(view.getByText("Event log"));
    expect(view.getByLabelText("Raw event #3")).toBeTruthy();
  });
  test("shows invocation arguments and script source before workflow events", () => {
    const runningRun = {
      id: "wfr_event_priority",
      workspaceId: TEST_WORKSPACE_ID,
      workflow: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      source: "export default function workflow() { return null; }",
      sourceHash: "sha256:event-priority",
      args: { topic: "workflow cards" },
      status: "running" as const,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:02.000Z",
      events: [
        {
          sequence: 1,
          type: "action" as const,
          at: "2026-05-29T00:00:01.000Z",
          stepId: "collect-sources",
          name: "github.issue.get",
          status: "completed" as const,
          effect: "read" as const,
          details: { issue: 149 },
        },
      ],
      steps: [],
    };

    const view = renderWithStickyToolProviders(
      <WorkflowRunToolCall
        args={{
          script_path: "skill://deep-research/workflow.js",
          args: { topic: "workflow cards" },
          run_in_background: false,
        }}
        status="executing"
        result={{
          status: "running",
          runId: runningRun.id,
          result: null,
          run: runningRun,
        }}
      />
    );

    const argumentsTitle = view.getByText("Arguments");
    const sourceTitle = view.getByText("Script source");
    const eventsTitle = view.getByText("Workflow events (1)");
    expect(view.queryByText("Event log")).toBeNull();
    expect(Boolean(argumentsTitle.compareDocumentPosition(eventsTitle) & 4)).toBe(true);
    expect(Boolean(sourceTitle.compareDocumentPosition(eventsTitle) & 4)).toBe(true);
    expect(view.getByText("collect-sources / github.issue.get / completed")).toBeTruthy();
  });

  test("renders executing foreground workflow status before the durable run is discovered", () => {
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <TooltipProvider>
          <WorkflowRunToolCall
            args={{
              name: "deep-research",
              args: { topic: "workflow cards" },
              run_in_background: false,
            }}
            status="executing"
          />
        </TooltipProvider>
      </ThemeProvider>
    );

    const workflowHeader = getWorkflowHeader(view);
    expect(workflowHeader.textContent).toContain("executing");
    expect(workflowHeader.textContent).not.toContain("pending");
  });

  test("fetches full inline run details when a completed tool output was source-redacted", async () => {
    const inlineSource =
      'export default function workflow({ args }) { return { reportMarkdown: "Inline workflow received " + args.value }; }\n';
    const fullRun: WorkflowRunRecord = {
      id: "wfr_inline_redacted_source",
      workspaceId: TEST_WORKSPACE_ID,
      workflow: {
        name: "inline-c5ab4a2c0aba",
        description: "Inline workflow",
        scope: "project",
        sourcePath: "inline://workflow-c5ab4a2c0aba.js",
        requestedScriptPath: "inline://workflow-c5ab4a2c0aba.js",
        canonicalScriptPath: "inline://workflow-c5ab4a2c0aba.js",
        sourceKind: "inline",
        sourceHash: "c5ab4a2c0aba",
        executable: true,
      },
      source: inlineSource,
      sourceHash: "c5ab4a2c0aba",
      args: { value: "ok" },
      status: "completed",
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:01.000Z",
      events: [
        { sequence: 1, type: "phase", at: "2026-06-28T00:00:00.000Z", name: "inline-smoke" },
        {
          sequence: 2,
          type: "result",
          at: "2026-06-28T00:00:01.000Z",
          result: { reportMarkdown: "Inline workflow received ok" },
        },
        { sequence: 3, type: "status", at: "2026-06-28T00:00:01.000Z", status: "completed" },
      ],
      steps: [],
    };
    const getRun = mock(async () => fullRun);

    const view = render(
      <APIHarness client={{ workflows: { getRun } }}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                script_source: inlineSource,
                args: { value: "ok" },
                run_in_background: false,
              }}
              status="completed"
              result={{
                status: "completed",
                runId: fullRun.id,
                result: { reportMarkdown: "Inline workflow received ok" },
              }}
              workspaceId={TEST_WORKSPACE_ID}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    fireEvent.click(getWorkflowHeader(view));

    await waitFor(() =>
      expect(getRun).toHaveBeenCalledWith({ workspaceId: TEST_WORKSPACE_ID, runId: fullRun.id })
    );
    await waitFor(() => expect(view.getByText("Script source")).toBeTruthy());
    expect(view.getByText(/Inline workflow received ok/)).toBeTruthy();
  });

  test("hydrates the phase rail once for pre-upgrade snapshots that embed source without a manifest", async () => {
    // Persisted by a build before phase manifests existed: terminal, has `source`,
    // no `workflow.phaseManifest`. Terminal cards never subscribe, so without a
    // one-shot fetch the declared rail would never appear after upgrading.
    const source =
      'export const meta = { phases: [{ name: "scope" }, { name: "never-visited", label: "Never visited" }] };\n' +
      'export default function workflow({ phase }) { phase("scope"); return { reportMarkdown: "ok" }; }\n';
    const legacySnapshot: WorkflowRunRecord = {
      id: "wfr_pre_upgrade",
      workspaceId: TEST_WORKSPACE_ID,
      workflow: { name: "phased", description: "Phased", scope: "project", executable: true },
      source,
      sourceHash: "sha256:pre-upgrade",
      args: {},
      status: "completed",
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [
        { sequence: 1, type: "phase", at: "2026-05-29T00:00:00.000Z", name: "scope" },
        { sequence: 2, type: "status", at: "2026-05-29T00:00:01.000Z", status: "completed" },
      ],
      steps: [],
    };
    const hydrated: WorkflowRunRecord = {
      ...legacySnapshot,
      workflow: {
        ...legacySnapshot.workflow,
        phaseManifest: {
          provenance: "declared",
          phases: [{ name: "scope" }, { name: "never-visited", label: "Never visited" }],
        },
      },
    };
    const getRun = mock(async () => hydrated);

    const view = render(
      <APIHarness client={{ workflows: { getRun } }}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{ script_path: "./workflows/phased.js", args: {}, run_in_background: false }}
              status="completed"
              result={{
                status: "completed",
                runId: legacySnapshot.id,
                result: { reportMarkdown: "ok" },
                run: legacySnapshot,
              }}
              workspaceId={TEST_WORKSPACE_ID}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    fireEvent.click(getWorkflowHeader(view));
    await waitFor(() =>
      expect(getRun).toHaveBeenCalledWith({
        workspaceId: TEST_WORKSPACE_ID,
        runId: legacySnapshot.id,
      })
    );
    // The declared-but-unvisited phase exists only on the hydrated rail.
    await waitFor(() => expect(view.getByText("Never visited")).toBeTruthy());

    // Collapsing and re-expanding must not refetch: hydration is attempted once per run.
    fireEvent.click(getWorkflowHeader(view));
    fireEvent.click(getWorkflowHeader(view));
    await waitFor(() => expect(view.getByText("Never visited")).toBeTruthy());
    expect(getRun).toHaveBeenCalledTimes(1);
  });

  test("retries pre-upgrade manifest hydration on the next expand after a failed fetch", async () => {
    const legacySnapshot: WorkflowRunRecord = {
      id: "wfr_pre_upgrade_retry",
      workspaceId: TEST_WORKSPACE_ID,
      workflow: { name: "phased", description: "Phased", scope: "project", executable: true },
      source:
        'export const meta = { phases: [{ name: "scope" }, { name: "later", label: "Later phase" }] };\n' +
        'export default function workflow({ phase }) { phase("scope"); return { reportMarkdown: "ok" }; }\n',
      sourceHash: "sha256:pre-upgrade-retry",
      args: {},
      status: "completed",
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [
        { sequence: 1, type: "phase", at: "2026-05-29T00:00:00.000Z", name: "scope" },
        { sequence: 2, type: "status", at: "2026-05-29T00:00:01.000Z", status: "completed" },
      ],
      steps: [],
    };
    const hydrated: WorkflowRunRecord = {
      ...legacySnapshot,
      workflow: {
        ...legacySnapshot.workflow,
        phaseManifest: {
          provenance: "declared",
          phases: [{ name: "scope" }, { name: "later", label: "Later phase" }],
        },
      },
    };
    let calls = 0;
    const getRun = mock(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("transient");
      }
      return hydrated;
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const view = render(
        <APIHarness client={{ workflows: { getRun } }}>
          <ThemeProvider forcedTheme="dark">
            <TooltipProvider>
              <WorkflowRunToolCall
                args={{ script_path: "./workflows/phased.js", args: {}, run_in_background: false }}
                status="completed"
                result={{
                  status: "completed",
                  runId: legacySnapshot.id,
                  result: { reportMarkdown: "ok" },
                  run: legacySnapshot,
                }}
                workspaceId={TEST_WORKSPACE_ID}
              />
            </TooltipProvider>
          </ThemeProvider>
        </APIHarness>
      );
      fireEvent.click(getWorkflowHeader(view));
      await waitFor(() => expect(calls).toBe(1));
      expect(view.queryByText("Later phase")).toBeNull();
      // A failed attempt must not retire the fetch: collapsing and re-expanding retries.
      fireEvent.click(getWorkflowHeader(view));
      fireEvent.click(getWorkflowHeader(view));
      await waitFor(() => expect(view.getByText("Later phase")).toBeTruthy());
      expect(calls).toBe(2);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("does not fetch for snapshots already hydrated to an explicit null manifest", async () => {
    const hydratedNone: WorkflowRunRecord = {
      id: "wfr_hydrated_none",
      workspaceId: TEST_WORKSPACE_ID,
      workflow: {
        name: "plain",
        description: "Plain",
        scope: "project",
        executable: true,
        phaseManifest: null,
      },
      source: 'export default function workflow() { return { reportMarkdown: "ok" }; }\n',
      sourceHash: "sha256:hydrated-none",
      args: {},
      status: "completed",
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [
        { sequence: 1, type: "status", at: "2026-05-29T00:00:01.000Z", status: "completed" },
      ],
      steps: [],
    };
    const getRun = mock(async () => hydratedNone);
    const view = render(
      <APIHarness client={{ workflows: { getRun } }}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{ script_path: "./workflows/plain.js", args: {}, run_in_background: false }}
              status="completed"
              result={{
                status: "completed",
                runId: hydratedNone.id,
                result: { reportMarkdown: "ok" },
                run: hydratedNone,
              }}
              workspaceId={TEST_WORKSPACE_ID}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );
    fireEvent.click(getWorkflowHeader(view));
    await waitFor(() => expect(view.getByText("Script source")).toBeTruthy());
    expect(getRun).not.toHaveBeenCalled();
  });

  test("renders attached foreground workflow runs without heuristic discovery", async () => {
    const attachedRun = {
      id: "wfr_attached",
      workspaceId: "workspace-1",
      workflow: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      source: "export default function workflow() { return null; }",
      sourceHash: "sha256:attached",
      args: { topic: "workflow cards" },
      status: "running" as const,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:02.000Z",
      events: [
        { sequence: 1, type: "phase" as const, at: "2026-05-29T00:00:02.000Z", name: "scope" },
      ],
      steps: [],
    };
    const listRuns = mock(async () => []);
    const getRun = mock(async () => attachedRun);
    const api = {
      workflows: {
        listRuns,
        getRun,
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                script_path: TEST_REQUESTED_WORKFLOW_SCRIPT_PATH,
                args: { topic: "workflow cards" },
                run_in_background: false,
              }}
              status="executing"
              workspaceId="workspace-1"
              startedAt={Date.parse("2026-05-29T00:00:00.500Z")}
              workflowRunHint={{ runId: "wfr_attached", run: attachedRun }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    expect(view.getByText("wfr_attached")).toBeTruthy();
    expect(view.getByText("scope")).toBeTruthy();
    expect(listRuns).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(getRun).toHaveBeenCalledWith({ workspaceId: "workspace-1", runId: "wfr_attached" })
    );
  });

  test("renders a workflow card from kernel-bounded args via the attached run hint", async () => {
    // A kernel-nested workflow_run whose launch args were replaced by a
    // __kernelBounded marker must still render the live card: identity comes
    // from the attached run hint, and the marker offers nothing for the
    // heuristic name+args discovery to match (listRuns must stay untouched).
    const attachedRun = createWorkflowRunForExpansionTest({ id: "wfr_kernel", status: "running" });
    const listRuns = mock(async () => []);
    const getRun = mock(async () => attachedRun);

    const view = render(
      <APIHarness client={{ workflows: { listRuns, getRun } }}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{ __kernelBounded: true, bytes: 18_457, preview: "{…}" }}
              status="executing"
              workspaceId={TEST_WORKSPACE_ID}
              toolCallId="nested-workflow-1"
              workflowRunHint={{ runId: "wfr_kernel", run: attachedRun }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    // The workflow name renders in both the header and the script card.
    expect(view.getAllByText("deep-research").length).toBeGreaterThan(0);
    expect(view.getByText("wfr_kernel")).toBeTruthy();
    expect(listRuns).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(getRun).toHaveBeenCalledWith({ workspaceId: TEST_WORKSPACE_ID, runId: "wfr_kernel" })
    );
  });

  test("recovers run identity from a kernel-bounded result marker", async () => {
    // With both args and result bounded, the retained runId on the result
    // marker is the only identity; expanding the card must refetch the
    // durable run by that id.
    const completedRun = createWorkflowRunForExpansionTest({
      id: "wfr_bounded_result",
      status: "completed",
    });
    const getRun = mock(async () => completedRun);

    const view = render(
      <APIHarness client={{ workflows: { getRun } }}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{ __kernelBounded: true, bytes: 18_457, preview: "{…}" }}
              result={
                {
                  __kernelBounded: true,
                  bytes: 40_000,
                  preview: "{…}",
                  runId: "wfr_bounded_result",
                  status: "completed",
                } as never
              }
              status="completed"
              workspaceId={TEST_WORKSPACE_ID}
              toolCallId="nested-workflow-2"
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    fireEvent.click(getWorkflowHeader(view));
    await waitFor(() =>
      expect(getRun).toHaveBeenCalledWith({
        workspaceId: TEST_WORKSPACE_ID,
        runId: "wfr_bounded_result",
      })
    );
    await waitFor(() => expect(view.getAllByText("deep-research").length).toBeGreaterThan(0));
  });

  test("uses resume result status when the attachment run snapshot is stale", async () => {
    const staleRun = {
      ...createWorkflowRunForExpansionTest({ id: "wfr_resume_stale", status: "running" }),
      status: "interrupted" as const,
      updatedAt: "2026-05-29T00:00:03.000Z",
      events: [
        {
          sequence: 1,
          type: "status" as const,
          at: "2026-05-29T00:00:03.000Z",
          status: "interrupted" as const,
        },
      ],
    };
    const refreshedRun = {
      ...staleRun,
      status: "completed" as const,
      updatedAt: "2026-05-29T00:00:04.000Z",
      events: [
        ...staleRun.events,
        {
          sequence: 2,
          type: "status" as const,
          at: "2026-05-29T00:00:04.000Z",
          status: "completed" as const,
        },
      ],
    };
    const getRun = mock(async () => refreshedRun);

    const view = render(
      <APIHarness client={{ workflows: { getRun } }}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowResumeToolCall
              args={{ run_id: staleRun.id, run_in_background: true, mode: "resume" }}
              result={{ status: "running", runId: staleRun.id, result: null, mode: "resume" }}
              status="completed"
              workspaceId={TEST_WORKSPACE_ID}
              toolCallId="resume-call-1"
              workflowRunHint={{ runId: staleRun.id, run: staleRun }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    const workflowHeader = getWorkflowHeader(view);
    expect(workflowHeader.textContent).toContain("executing");
    expect(workflowHeader.textContent).not.toContain("interrupted");
    await waitFor(() =>
      expect(getRun).toHaveBeenCalledWith({ workspaceId: TEST_WORKSPACE_ID, runId: staleRun.id })
    );
    await waitFor(() => expect(getWorkflowHeader(view).textContent).toContain("completed"));
  });

  test("discovers foreground workflow runs and renders live run details", async () => {
    const staleRun = {
      id: "wfr_stale",
      workspaceId: "workspace-1",
      workflow: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        sourcePath: TEST_WORKFLOW_SCRIPT_PATH,
        requestedScriptPath: TEST_REQUESTED_WORKFLOW_SCRIPT_PATH,
        canonicalScriptPath: TEST_WORKFLOW_SCRIPT_PATH,
        sourceKind: "skill" as const,
        sourceHash: "sha256:stale",
        executable: true,
      },
      source: "export default function workflow() { return null; }",
      sourceHash: "sha256:stale",
      args: { topic: "workflow cards" },
      status: "running" as const,
      createdAt: "2026-05-28T00:00:00.000Z",
      updatedAt: "2026-05-28T00:00:01.000Z",
      events: [
        { sequence: 1, type: "phase" as const, at: "2026-05-28T00:00:01.000Z", name: "stale" },
      ],
      steps: [],
    };
    const foregroundRun = {
      ...staleRun,
      workflow: { ...staleRun.workflow, sourceHash: "sha256:foreground" },
      id: "wfr_foreground",
      sourceHash: "sha256:foreground",
      createdAt: "2026-05-29T00:00:00.490Z",
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
    };
    const interruptedForegroundRun = {
      ...foregroundRun,
      status: "interrupted" as const,
      updatedAt: "2026-05-29T00:00:03.000Z",
      events: [
        ...foregroundRun.events,
        {
          sequence: 3,
          type: "status" as const,
          at: "2026-05-29T00:00:03.000Z",
          status: "interrupted" as const,
        },
      ],
    };
    const listRuns = mock(async () => [staleRun, foregroundRun]);
    const getRun = mock(async () => foregroundRun);
    const interrupt = mock(async (input: { workspaceId: string; runId: string }) => {
      expect(input).toEqual({ workspaceId: "workspace-1", runId: "wfr_foreground" });
      return interruptedForegroundRun;
    });
    const api = {
      workflows: {
        listRuns,
        getRun,
        interrupt,
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                script_path: TEST_REQUESTED_WORKFLOW_SCRIPT_PATH,
                args: { topic: "workflow cards" },
                run_in_background: false,
              }}
              status="executing"
              workspaceId="workspace-1"
              startedAt={Date.parse("2026-05-29T00:00:00.500Z")}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    await waitFor(() => expect(view.getByText("wfr_foreground")).toBeTruthy());
    expect(getWorkflowHeader(view).textContent).toContain("executing");
    expect(view.queryByText("wfr_stale")).toBeNull();
    expect(view.queryByText("stale")).toBeNull();
    expect(view.getAllByText("built-in").length).toBeGreaterThan(0);
    expect(view.getByText("Event log")).toBeTruthy();
    expect(view.getByText("scope")).toBeTruthy();
    expect(listRuns).toHaveBeenCalledWith({ workspaceId: "workspace-1" });

    fireEvent.click(view.getByRole("button", { name: "Interrupt workflow" }));

    await waitFor(() => expect(interrupt).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getWorkflowHeader(view).textContent).toContain("interrupted"));
  });

  test("discovers foreground inline workflow runs by source equality", async () => {
    const inlineSource =
      "export default function workflow() { return { reportMarkdown: 'inline' }; }\n";
    const inlineRun = {
      id: "wfr_inline_foreground",
      workspaceId: "workspace-1",
      workflow: {
        name: "inline-123456789abc",
        description: "Inline workflow",
        scope: "project" as const,
        sourcePath: "inline://workflow-123456789abc.js",
        requestedScriptPath: "inline://workflow-123456789abc.js",
        canonicalScriptPath: "inline://workflow-123456789abc.js",
        sourceKind: "inline" as const,
        sourceHash: "123456789abc",
        executable: true,
      },
      source: inlineSource,
      sourceHash: "sha256:inline",
      args: { value: "ok" },
      status: "running" as const,
      createdAt: "2026-05-29T00:00:00.490Z",
      updatedAt: "2026-05-29T00:00:02.000Z",
      events: [
        {
          sequence: 1,
          type: "phase" as const,
          at: "2026-05-29T00:00:02.000Z",
          name: "inline-smoke",
        },
      ],
      steps: [],
    };
    const pathRun = {
      ...inlineRun,
      id: "wfr_path_foreground",
      workflow: {
        ...inlineRun.workflow,
        sourceKind: "workspace-file" as const,
        sourcePath: "./workflows/inline.js",
        requestedScriptPath: "./workflows/inline.js",
        canonicalScriptPath: "./workflows/inline.js",
      },
    };
    const listRuns = mock(async () => [pathRun, inlineRun]);
    const getRun = mock(async () => inlineRun);
    const api = {
      workflows: {
        listRuns,
        getRun,
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                script_source: inlineSource,
                args: { value: "ok" },
                run_in_background: false,
              }}
              status="executing"
              workspaceId="workspace-1"
              startedAt={Date.parse("2026-05-29T00:00:00.500Z")}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    expect(getWorkflowHeader(view).textContent).toContain("inline workflow");
    await waitFor(() => expect(view.getByText("wfr_inline_foreground")).toBeTruthy());
    expect(view.queryByText("wfr_path_foreground")).toBeNull();
    expect(view.getByText("inline-smoke")).toBeTruthy();
    expect(getWorkflowHeader(view).textContent).toContain("inline-123456789abc");
    expect(listRuns).toHaveBeenCalledWith({ workspaceId: "workspace-1" });
  });

  test("does not attach ambiguous foreground workflow run matches", async () => {
    const firstRun = {
      id: "wfr_first",
      workspaceId: "workspace-1",
      workflow: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        sourcePath: TEST_WORKFLOW_SCRIPT_PATH,
        requestedScriptPath: TEST_REQUESTED_WORKFLOW_SCRIPT_PATH,
        canonicalScriptPath: TEST_WORKFLOW_SCRIPT_PATH,
        sourceKind: "skill" as const,
        sourceHash: "sha256:first",
        executable: true,
      },
      source: "export default function workflow() { return null; }",
      sourceHash: "sha256:first",
      args: { topic: "workflow cards" },
      status: "running" as const,
      createdAt: "2026-05-29T00:00:01.000Z",
      updatedAt: "2026-05-29T00:00:02.000Z",
      events: [
        { sequence: 1, type: "phase" as const, at: "2026-05-29T00:00:02.000Z", name: "first" },
      ],
      steps: [],
    };
    const secondRun = {
      ...firstRun,
      id: "wfr_second",
      sourceHash: "sha256:second",
      updatedAt: "2026-05-29T00:00:03.000Z",
      events: [
        { sequence: 1, type: "phase" as const, at: "2026-05-29T00:00:03.000Z", name: "second" },
      ],
    };
    const listRuns = mock(async () => [firstRun, secondRun]);
    const getRun = mock(async () => secondRun);
    const api = {
      workflows: {
        listRuns,
        getRun,
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                script_path: TEST_REQUESTED_WORKFLOW_SCRIPT_PATH,
                args: { topic: "workflow cards" },
                run_in_background: false,
              }}
              status="executing"
              workspaceId="workspace-1"
              startedAt={Date.parse("2026-05-29T00:00:00.500Z")}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    await waitFor(() => expect(listRuns).toHaveBeenCalledWith({ workspaceId: "workspace-1" }));
    expect(getWorkflowHeader(view).textContent).toContain("executing");
    expect(view.queryByText("wfr_first")).toBeNull();
    expect(view.queryByText("wfr_second")).toBeNull();
    expect(view.queryByText("first")).toBeNull();
    expect(view.queryByText("second")).toBeNull();
    expect(view.queryByRole("button", { name: "Interrupt workflow" })).toBeNull();
    expect(getRun).not.toHaveBeenCalled();
  });

  test("discovers workflow_resume runs by exact id and promotes the live run details", async () => {
    const runningRun = {
      id: "wfr_known",
      workspaceId: "workspace-1",
      workflow: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      source: "export default function workflow() { return null; }",
      sourceHash: "sha256:known",
      args: { topic: "workflow cards" },
      status: "running" as const,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [
        {
          sequence: 1,
          type: "status" as const,
          at: "2026-05-29T00:00:00.000Z",
          status: "running" as const,
        },
        { sequence: 2, type: "phase" as const, at: "2026-05-29T00:00:01.000Z", name: "scope" },
      ],
      steps: [],
    };
    const getRun = mock(async (input: { workspaceId: string; runId: string }) => {
      expect(input).toEqual({ workspaceId: "workspace-1", runId: "wfr_known" });
      return runningRun;
    });
    const api = {
      workflows: {
        getRun,
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowResumeToolCall
              args={{ run_id: "wfr_known", run_in_background: false }}
              status="executing"
              workspaceId="workspace-1"
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    // Until the snapshot loads, the run id doubles as the header display name.
    expect(getWorkflowHeader(view).textContent).toContain("wfr_known");

    await waitFor(() => expect(getWorkflowHeader(view).textContent).toContain("deep-research"));
    expect(getWorkflowHeader(view).textContent).not.toContain("wfr_known");
    expect(getWorkflowHeader(view).textContent).toContain("executing");
    expect(view.getByText("wfr_known")).toBeTruthy();
    expect(view.getAllByText("built-in").length).toBeGreaterThan(0);
    expect(view.getByText("Event log")).toBeTruthy();
    expect(view.getByText("scope")).toBeTruthy();
    // The fetched snapshot matches the args' run id and this workspace, so the run is
    // actionable before the blocking tool call returns a result.
    expect(view.getByRole("button", { name: "Interrupt workflow" })).toBeTruthy();
    expect(getRun).toHaveBeenCalledWith({ workspaceId: "workspace-1", runId: "wfr_known" });
  });

  test("does not confirm workflow_resume identity for snapshots from another workspace", async () => {
    const otherWorkspaceRun = {
      id: "wfr_known",
      workspaceId: "workspace-other",
      workflow: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      source: "export default function workflow() { return null; }",
      sourceHash: "sha256:known",
      args: { topic: "workflow cards" },
      status: "running" as const,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [
        {
          sequence: 1,
          type: "status" as const,
          at: "2026-05-29T00:00:00.000Z",
          status: "running" as const,
        },
      ],
      steps: [],
    };
    const getRun = mock(async () => otherWorkspaceRun);
    const api = {
      workflows: {
        getRun,
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowResumeToolCall
              args={{ run_id: "wfr_known", run_in_background: false }}
              status="executing"
              workspaceId="workspace-1"
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    await waitFor(() => expect(getWorkflowHeader(view).textContent).toContain("deep-research"));
    // The snapshot still renders, but a cross-workspace id match must not unlock actions.
    expect(view.queryByRole("button", { name: "Interrupt workflow" })).toBeNull();
  });

  test("keeps polling workflow_resume past a stale interrupted snapshot until the run is live", async () => {
    const staleInterruptedRun = {
      id: "wfr_known",
      workspaceId: "workspace-1",
      workflow: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      source: "export default function workflow() { return null; }",
      sourceHash: "sha256:known",
      args: { topic: "workflow cards" },
      status: "interrupted" as const,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [
        {
          sequence: 1,
          type: "status" as const,
          at: "2026-05-29T00:00:01.000Z",
          status: "interrupted" as const,
        },
      ],
      steps: [],
    };
    const resumedRun = {
      ...staleInterruptedRun,
      status: "running" as const,
      updatedAt: "2026-05-29T00:00:02.000Z",
      events: [
        ...staleInterruptedRun.events,
        {
          sequence: 2,
          type: "status" as const,
          at: "2026-05-29T00:00:02.000Z",
          status: "running" as const,
        },
        {
          sequence: 3,
          type: "phase" as const,
          at: "2026-05-29T00:00:02.000Z",
          name: "post-resume",
        },
      ],
    };
    let getRunCalls = 0;
    const getRun = mock(async () => {
      getRunCalls += 1;
      return getRunCalls === 1 ? staleInterruptedRun : resumedRun;
    });
    const api = {
      workflows: {
        getRun,
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowResumeToolCall
              args={{ run_id: "wfr_known", run_in_background: false }}
              status="executing"
              workspaceId="workspace-1"
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    // The first poll races the backend's resume transition and captures the stale pre-resume
    // "interrupted" snapshot; discovery must keep polling instead of pinning the card on it.
    await waitFor(() => expect(view.getByText("post-resume")).toBeTruthy());
    expect(getRunCalls).toBeGreaterThanOrEqual(2);
    expect(getWorkflowHeader(view).textContent).toContain("executing");
    expect(view.getByRole("button", { name: "Interrupt workflow" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Resume workflow" })).toBeNull();
  });

  test("applies matching workflow subscription updates without polling", async () => {
    const initialRun = createTimelineRun({ id: "wfr_subscribed", stepTitle: "Collect sources" });
    const updatedRun = createTimelineRun({
      id: initialRun.id,
      stepTitle: "Verify sources",
      updatedAt: "2026-05-29T00:00:03.000Z",
    });
    const otherRun = createTimelineRun({ id: "wfr_other", stepTitle: "Ignore me" });
    const stream = createWorkflowSubscription();
    const subscribe = mock(async () => stream.iterator);
    const getRun = mock(async () => initialRun);
    const view = render(
      <APIHarness client={{ workflows: { subscribe, getRun } }}>
        {withStickyToolProviders(
          <WorkflowRunToolCall
            args={{ script_path: TEST_WORKFLOW_SCRIPT_PATH, run_in_background: true }}
            status="executing"
            workspaceId={TEST_WORKSPACE_ID}
            result={{ status: "running", runId: initialRun.id, result: null, run: initialRun }}
          />
        )}
      </APIHarness>
    );

    await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
    fireEvent.click(view.getByText("Research"));
    expect(view.getByText("Collect sources")).toBeTruthy();
    stream.emit({ type: "run-changed", run: otherRun });
    stream.emit({ type: "run-changed", run: updatedRun });

    await waitFor(() => expect(view.getByText("Verify sources")).toBeTruthy());
    expect(view.queryByText("Ignore me")).toBeNull();
    expect(getRun).not.toHaveBeenCalled();
  });

  test("falls back to workflow polling when the live subscription fails", async () => {
    const initialRun = createTimelineRun({ id: "wfr_subscription_fallback" });
    const completedRun = createTimelineRun({ id: initialRun.id, status: "completed" });
    const subscribe = mock(async () => {
      throw new Error("stream unavailable");
    });
    const getRun = mock(async () => completedRun);
    const view = render(
      <APIHarness client={{ workflows: { subscribe, getRun } }}>
        {withStickyToolProviders(
          <WorkflowRunToolCall
            args={{ script_path: TEST_WORKFLOW_SCRIPT_PATH, run_in_background: true }}
            status="executing"
            workspaceId={TEST_WORKSPACE_ID}
            result={{ status: "running", runId: initialRun.id, result: null, run: initialRun }}
          />
        )}
      </APIHarness>
    );

    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getWorkflowHeader(view).textContent).toContain("completed"));
  });

  test("does not subscribe terminal workflow cards", async () => {
    const completedRun = createTimelineRun({
      id: "wfr_terminal_no_subscription",
      status: "completed",
    });
    const subscribe = mock(async () => createWorkflowSubscription().iterator);
    render(
      <APIHarness client={{ workflows: { subscribe } }}>
        {withStickyToolProviders(
          <WorkflowRunToolCall
            args={{ script_path: TEST_WORKFLOW_SCRIPT_PATH, run_in_background: false }}
            status="completed"
            workspaceId={TEST_WORKSPACE_ID}
            result={{
              status: "completed",
              runId: completedRun.id,
              result: null,
              run: completedRun,
            }}
          />
        )}
      </APIHarness>
    );

    await Promise.resolve();
    expect(subscribe).not.toHaveBeenCalled();
  });

  test("keeps polling nested runs the subscription feed omits", async () => {
    const parentWorkflow = {
      runId: "wfr_parent",
      stepId: "spawn-child",
      inputHash: "sha256:child",
      depth: 1,
    };
    const nestedRun = {
      ...createTimelineRun({ id: "wfr_nested_child" }),
      parentWorkflow,
    };
    const updatedNestedRun = {
      ...createTimelineRun({
        id: nestedRun.id,
        stepTitle: "Verify sources",
        updatedAt: "2026-05-29T00:00:03.000Z",
      }),
      parentWorkflow,
    };
    const subscribe = mock(async () => createWorkflowSubscription().iterator);
    const getRun = mock(async () => updatedNestedRun);
    const view = render(
      <APIHarness client={{ workflows: { subscribe, getRun } }}>
        {withStickyToolProviders(
          <WorkflowRunToolCall
            args={{ script_path: TEST_WORKFLOW_SCRIPT_PATH, run_in_background: true }}
            status="executing"
            workspaceId={TEST_WORKSPACE_ID}
            result={{ status: "running", runId: nestedRun.id, result: null, run: nestedRun }}
          />
        )}
      </APIHarness>
    );

    await waitFor(() => expect(getRun).toHaveBeenCalled());
    fireEvent.click(view.getByText("Research"));
    await waitFor(() => expect(view.getByText("Verify sources")).toBeTruthy());
    expect(subscribe).not.toHaveBeenCalled();
  });

  test("shares one workspace subscription across concurrent workflow cards", async () => {
    const firstRun = createTimelineRun({ id: "wfr_shared_first", stepTitle: "First initial" });
    const secondRun = createTimelineRun({ id: "wfr_shared_second", stepTitle: "Second initial" });
    const stream = createWorkflowSubscription();
    const subscribe = mock(async () => stream.iterator);
    const view = render(
      <APIHarness client={{ workflows: { subscribe } }}>
        {withStickyToolProviders(
          <>
            <WorkflowRunToolCall
              args={{ script_path: TEST_WORKFLOW_SCRIPT_PATH, run_in_background: true }}
              status="executing"
              workspaceId={TEST_WORKSPACE_ID}
              result={{ status: "running", runId: firstRun.id, result: null, run: firstRun }}
            />
            <WorkflowRunToolCall
              args={{ script_path: TEST_WORKFLOW_SCRIPT_PATH, run_in_background: true }}
              status="executing"
              workspaceId={TEST_WORKSPACE_ID}
              result={{ status: "running", runId: secondRun.id, result: null, run: secondRun }}
            />
          </>
        )}
      </APIHarness>
    );

    await waitFor(() => expect(subscribe).toHaveBeenCalled());
    for (const phase of view.getAllByText("Research")) {
      fireEvent.click(phase);
    }
    expect(view.getByText("First initial")).toBeTruthy();
    expect(view.getByText("Second initial")).toBeTruthy();

    stream.emit({
      type: "run-changed",
      run: createTimelineRun({
        id: firstRun.id,
        stepTitle: "First updated",
        updatedAt: "2026-05-29T00:00:03.000Z",
      }),
    });
    stream.emit({
      type: "run-changed",
      run: createTimelineRun({
        id: secondRun.id,
        stepTitle: "Second updated",
        updatedAt: "2026-05-29T00:00:03.000Z",
      }),
    });

    await waitFor(() => expect(view.getByText("First updated")).toBeTruthy());
    await waitFor(() => expect(view.getByText("Second updated")).toBeTruthy());
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  test("keeps the newest workflow refresh snapshot when polls resolve out of order", async () => {
    const originalSetInterval = globalThis.window.setInterval;
    const originalClearInterval = globalThis.window.clearInterval;
    globalThis.window.setInterval = ((handler: TimerHandler) => {
      if (typeof handler === "function") {
        const callback = handler as () => void;
        queueMicrotask(callback);
      }
      return 1;
    }) as typeof globalThis.window.setInterval;
    globalThis.window.clearInterval = (() => undefined) as typeof globalThis.window.clearInterval;

    try {
      const runningRun = {
        id: "wfr_ordered",
        workspaceId: "workspace-1",
        workflow: {
          name: "deep-research",
          description: "Deep research",
          scope: "built-in" as const,
          executable: true,
        },
        source: "export default function workflow() { return null; }",
        sourceHash: "sha256:ordered",
        args: { topic: "workflow cards" },
        status: "running" as const,
        createdAt: "2026-05-29T00:00:00.000Z",
        updatedAt: "2026-05-29T00:00:01.000Z",
        events: [
          { sequence: 1, type: "phase" as const, at: "2026-05-29T00:00:01.000Z", name: "initial" },
        ],
        steps: [],
      };
      const olderRun = {
        ...runningRun,
        updatedAt: "2026-05-29T00:00:03.000Z",
        events: [
          { sequence: 2, type: "phase" as const, at: "2026-05-29T00:00:03.000Z", name: "older" },
        ],
      };
      const newerRun = {
        ...runningRun,
        updatedAt: "2026-05-29T00:00:03.000Z",
        events: [
          { sequence: 3, type: "phase" as const, at: "2026-05-29T00:00:03.000Z", name: "newer" },
        ],
      };
      const refreshes: Array<(run: typeof runningRun) => void> = [];
      const api = {
        workflows: {
          getRun: mock(
            async () =>
              await new Promise<typeof runningRun>((resolve) => {
                refreshes.push(resolve);
              })
          ),
        },
      };

      const view = render(
        <APIHarness client={api}>
          <ThemeProvider forcedTheme="dark">
            <TooltipProvider>
              <WorkflowRunToolCall
                args={{
                  name: "deep-research",
                  args: { topic: "workflow cards" },
                  run_in_background: true,
                }}
                status="completed"
                result={{ status: "running", runId: "wfr_ordered", result: null, run: runningRun }}
              />
            </TooltipProvider>
          </ThemeProvider>
        </APIHarness>
      );

      await waitFor(() => expect(refreshes.length).toBeGreaterThanOrEqual(2));
      refreshes[1]?.(newerRun);
      await waitFor(() => expect(view.getByText("newer")).toBeTruthy());

      refreshes[0]?.(olderRun);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(view.getByText("newer")).toBeTruthy();
      expect(view.queryByText("older")).toBeNull();
    } finally {
      globalThis.window.setInterval = originalSetInterval;
      globalThis.window.clearInterval = originalClearInterval;
    }
  });

  test("keeps newer poll snapshots when an older action response resolves later", async () => {
    const runningRun = {
      id: "wfr_action_ordered",
      workspaceId: "workspace-1",
      workflow: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
        // Server-shaped record: already hydrated (none derivable).
        phaseManifest: null,
      },
      source: "export default function workflow() { return null; }",
      sourceHash: "sha256:action-ordered",
      args: { topic: "workflow cards" },
      status: "running" as const,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [
        { sequence: 1, type: "phase" as const, at: "2026-05-29T00:00:01.000Z", name: "initial" },
      ],
      steps: [],
    };
    const olderRun = {
      ...runningRun,
      status: "interrupted" as const,
      updatedAt: "2026-05-29T00:00:02.000Z",
      events: [
        { sequence: 2, type: "phase" as const, at: "2026-05-29T00:00:02.000Z", name: "older" },
      ],
    };
    const newerRun = {
      ...runningRun,
      updatedAt: "2026-05-29T00:00:03.000Z",
      events: [
        { sequence: 3, type: "phase" as const, at: "2026-05-29T00:00:03.000Z", name: "newer" },
      ],
    };
    const refreshes: Array<(run: typeof runningRun) => void> = [];
    const pendingInterrupt: { resolve?: (run: typeof olderRun) => void } = {};
    const api = {
      workflows: {
        getRun: mock(
          async () =>
            await new Promise<typeof runningRun>((resolve) => {
              refreshes.push(resolve);
            })
        ),
        interrupt: mock(
          async () =>
            await new Promise<typeof olderRun>((resolve) => {
              pendingInterrupt.resolve = resolve;
            })
        ),
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                name: "deep-research",
                args: { topic: "workflow cards" },
                run_in_background: true,
              }}
              status="completed"
              result={{
                status: "running",
                runId: "wfr_action_ordered",
                result: null,
                run: runningRun,
              }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    await waitFor(() => expect(refreshes.length).toBe(1));
    fireEvent.click(view.getByText("Interrupt workflow"));
    await waitFor(() => expect(pendingInterrupt.resolve).toBeDefined());

    refreshes[0]?.(newerRun);
    await waitFor(() => expect(view.getByText("newer")).toBeTruthy());

    const completeInterrupt = pendingInterrupt.resolve;
    if (completeInterrupt == null) {
      throw new Error("Expected interrupt to be pending");
    }
    completeInterrupt(olderRun);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(view.getByText("newer")).toBeTruthy();
    expect(view.queryByText("older")).toBeNull();
  });

  test("refreshes a running workflow from the API and shows the completed result", async () => {
    const api = {
      workflows: {
        getRun: async () => ({
          id: "wfr_live",
          workspaceId: "workspace-1",
          workflow: {
            name: "deep-research",
            description: "Deep research",
            scope: "built-in",
            executable: true,
          },
          source: "export default function workflow() { return null; }",
          sourceHash: "sha256:test",
          args: { topic: "workflow cards" },
          status: "completed",
          createdAt: "2026-05-29T00:00:00.000Z",
          updatedAt: "2026-05-29T00:00:02.000Z",
          events: [
            { sequence: 1, type: "status", at: "2026-05-29T00:00:00.000Z", status: "running" },
            { sequence: 2, type: "phase", at: "2026-05-29T00:00:00.000Z", name: "scope" },
            {
              sequence: 3,
              type: "result",
              at: "2026-05-29T00:00:02.000Z",
              result: { reportMarkdown: "done live" },
            },
            { sequence: 4, type: "status", at: "2026-05-29T00:00:02.000Z", status: "completed" },
          ],
          steps: [],
        }),
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                name: "deep-research",
                args: { topic: "workflow cards" },
                run_in_background: true,
              }}
              status="completed"
              result={{
                status: "running",
                runId: "wfr_live",
                result: null,
                run: {
                  id: "wfr_live",
                  workspaceId: "workspace-1",
                  workflow: {
                    name: "deep-research",
                    description: "Deep research",
                    scope: "built-in",
                    executable: true,
                  },
                  source: "export default function workflow() { return null; }",
                  sourceHash: "sha256:test",
                  args: { topic: "workflow cards" },
                  status: "running",
                  createdAt: "2026-05-29T00:00:00.000Z",
                  updatedAt: "2026-05-29T00:00:01.000Z",
                  events: [
                    {
                      sequence: 1,
                      type: "status",
                      at: "2026-05-29T00:00:00.000Z",
                      status: "running",
                    },
                  ],
                  steps: [],
                },
              }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    await waitFor(() => expect(view.getAllByText("completed").length).toBeGreaterThan(0));
    expect(view.queryByText("done live")).toBeNull();

    fireEvent.click(getWorkflowHeader(view));

    expect(view.getByText("done live")).toBeTruthy();
  });

  test("keeps completed workflow runs expanded after the user toggles the card", async () => {
    const runningRun = {
      id: "wfr_manual",
      workspaceId: "workspace-1",
      workflow: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      source: "export default function workflow() { return null; }",
      sourceHash: "sha256:test",
      args: { topic: "workflow cards" },
      status: "running" as const,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [
        {
          sequence: 1,
          type: "status" as const,
          at: "2026-05-29T00:00:00.000Z",
          status: "running" as const,
        },
      ],
      steps: [],
    };
    const completedRun = {
      ...runningRun,
      status: "completed" as const,
      updatedAt: "2026-05-29T00:00:02.000Z",
      events: [
        ...runningRun.events,
        {
          sequence: 2,
          type: "result" as const,
          at: "2026-05-29T00:00:02.000Z",
          result: { reportMarkdown: "manual result" },
        },
        {
          sequence: 3,
          type: "status" as const,
          at: "2026-05-29T00:00:02.000Z",
          status: "completed" as const,
        },
      ],
    };
    const pendingRefresh: { resolve?: (run: typeof completedRun) => void } = {};
    const api = {
      workflows: {
        getRun: async () =>
          await new Promise<typeof completedRun>((resolve) => {
            pendingRefresh.resolve = resolve;
          }),
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                name: "deep-research",
                args: { topic: "workflow cards" },
                run_in_background: true,
              }}
              status="completed"
              result={{ status: "running", runId: "wfr_manual", result: null, run: runningRun }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    await waitFor(() => expect(pendingRefresh.resolve).toBeDefined());
    const workflowHeader = getWorkflowHeader(view);
    fireEvent.click(workflowHeader);
    expect(view.queryByText("wfr_manual")).toBeNull();
    fireEvent.click(workflowHeader);
    expect(view.getByText("wfr_manual")).toBeTruthy();

    const completeRefresh = pendingRefresh.resolve;
    if (completeRefresh == null) {
      throw new Error("Expected workflow refresh to be pending");
    }
    completeRefresh(completedRun);

    await waitFor(() => expect(view.getByText("manual result")).toBeTruthy());
    expect(view.getAllByText("completed").length).toBeGreaterThan(0);
  });

  test("keeps open task report dialog mounted after workflow auto-completes", async () => {
    const runningRun = {
      id: "wfr_report_auto",
      workspaceId: "workspace-1",
      workflow: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      source: "export default function workflow() { return null; }",
      sourceHash: "sha256:test",
      args: { topic: "workflow cards" },
      status: "running" as const,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [
        {
          sequence: 1,
          type: "status" as const,
          at: "2026-05-29T00:00:00.000Z",
          status: "running" as const,
        },
        {
          sequence: 2,
          type: "task" as const,
          at: "2026-05-29T00:00:01.000Z",
          stepId: "report-step",
          taskId: "task_report",
          status: "completed" as const,
        },
      ],
      steps: [
        {
          stepId: "report-step",
          inputHash: "sha256:report",
          status: "completed" as const,
          taskId: "task_report",
          startedAt: "2026-05-29T00:00:00.000Z",
          completedAt: "2026-05-29T00:00:01.000Z",
          result: { reportMarkdown: "## Running task report\n\nReport stays open." },
        },
      ],
    };
    const completedRun = {
      ...runningRun,
      status: "completed" as const,
      updatedAt: "2026-05-29T00:00:02.000Z",
      events: [
        ...runningRun.events,
        {
          sequence: 3,
          type: "result" as const,
          at: "2026-05-29T00:00:02.000Z",
          result: { reportMarkdown: "completed workflow result" },
        },
        {
          sequence: 4,
          type: "status" as const,
          at: "2026-05-29T00:00:02.000Z",
          status: "completed" as const,
        },
      ],
    };
    const pendingRefresh: { resolve?: (run: typeof completedRun) => void } = {};
    const api = {
      workflows: {
        getRun: async () =>
          await new Promise<typeof completedRun>((resolve) => {
            pendingRefresh.resolve = resolve;
          }),
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                name: "deep-research",
                args: { topic: "workflow cards" },
                run_in_background: true,
              }}
              status="completed"
              result={{
                status: "running",
                runId: "wfr_report_auto",
                result: null,
                run: runningRun,
              }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    await waitFor(() => expect(pendingRefresh.resolve).toBeDefined());
    openEventLog(view);
    fireEvent.click(view.getByLabelText("Open report for task_report"));
    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        "Report stays open."
      );
    });

    const completeRefresh = pendingRefresh.resolve;
    if (completeRefresh == null) {
      throw new Error("Expected workflow refresh to be pending");
    }
    completeRefresh(completedRun);

    await waitFor(() => expect(view.getByText("completed workflow result")).toBeTruthy());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Report stays open.");
  });

  test("keeps expanded task structured output visible after workflow auto-completes", async () => {
    const runningRun = {
      id: "wfr_structured_auto",
      workspaceId: "workspace-1",
      workflow: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      source: "export default function workflow() { return null; }",
      sourceHash: "sha256:test",
      args: { topic: "workflow cards" },
      status: "running" as const,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [
        {
          sequence: 1,
          type: "status" as const,
          at: "2026-05-29T00:00:00.000Z",
          status: "running" as const,
        },
        {
          sequence: 2,
          type: "task" as const,
          at: "2026-05-29T00:00:01.000Z",
          stepId: "structured-step",
          taskId: "task_structured",
          status: "completed" as const,
        },
      ],
      steps: [
        {
          stepId: "structured-step",
          inputHash: "sha256:structured",
          status: "completed" as const,
          taskId: "task_structured",
          startedAt: "2026-05-29T00:00:00.000Z",
          completedAt: "2026-05-29T00:00:01.000Z",
          result: {
            reportMarkdown: "## Structured task report\n\nReport remains available.",
            structuredOutput: {
              reviewSummary: "Keep this visible after completion.",
            },
          },
        },
      ],
    };
    const completedRun = {
      ...runningRun,
      status: "completed" as const,
      updatedAt: "2026-05-29T00:00:02.000Z",
      events: [
        ...runningRun.events,
        {
          sequence: 3,
          type: "result" as const,
          at: "2026-05-29T00:00:02.000Z",
          result: { reportMarkdown: "completed workflow result" },
        },
        {
          sequence: 4,
          type: "status" as const,
          at: "2026-05-29T00:00:02.000Z",
          status: "completed" as const,
        },
      ],
    };
    const pendingRefresh: { resolve?: (run: typeof completedRun) => void } = {};
    const api = {
      workflows: {
        getRun: async () =>
          await new Promise<typeof completedRun>((resolve) => {
            pendingRefresh.resolve = resolve;
          }),
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                name: "deep-research",
                args: { topic: "workflow cards" },
                run_in_background: true,
              }}
              status="completed"
              result={{
                status: "running",
                runId: "wfr_structured_auto",
                result: null,
                run: runningRun,
              }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    await waitFor(() => expect(pendingRefresh.resolve).toBeDefined());
    openEventLog(view);
    fireEvent.click(
      view.getByRole("button", {
        name: "Expand structured output for workflow task task_structured",
      })
    );
    expect(view.container.textContent).toContain("reviewSummary");

    const completeRefresh = pendingRefresh.resolve;
    if (completeRefresh == null) {
      throw new Error("Expected workflow refresh to be pending");
    }
    completeRefresh(completedRun);

    await waitFor(() => expect(view.getByText("completed workflow result")).toBeTruthy());
    expect(view.container.textContent).toContain("reviewSummary");
    expect(view.container.textContent).toContain("Keep this visible after completion.");
  });

  test("shows interrupt action for running workflows and updates with the returned run", async () => {
    let interrupted = false;
    const api = {
      workflows: {
        getRun: async () => null,
        interrupt: async () => {
          interrupted = true;
          return {
            id: "wfr_interrupt",
            workspaceId: "workspace-1",
            workflow: {
              name: "deep-research",
              description: "Deep research",
              scope: "built-in",
              executable: true,
            },
            source: "export default function workflow() { return null; }",
            sourceHash: "sha256:test",
            args: { topic: "workflow cards" },
            status: "interrupted",
            createdAt: "2026-05-29T00:00:00.000Z",
            updatedAt: "2026-05-29T00:00:02.000Z",
            events: [
              { sequence: 1, type: "status", at: "2026-05-29T00:00:00.000Z", status: "running" },
              {
                sequence: 2,
                type: "status",
                at: "2026-05-29T00:00:02.000Z",
                status: "interrupted",
              },
            ],
            steps: [],
          };
        },
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                name: "deep-research",
                args: { topic: "workflow cards" },
                run_in_background: true,
              }}
              status="completed"
              result={{
                status: "running",
                runId: "wfr_interrupt",
                result: null,
                run: {
                  id: "wfr_interrupt",
                  workspaceId: "workspace-1",
                  workflow: {
                    name: "deep-research",
                    description: "Deep research",
                    scope: "built-in",
                    executable: true,
                  },
                  source: "export default function workflow() { return null; }",
                  sourceHash: "sha256:test",
                  args: { topic: "workflow cards" },
                  status: "running",
                  createdAt: "2026-05-29T00:00:00.000Z",
                  updatedAt: "2026-05-29T00:00:01.000Z",
                  events: [
                    {
                      sequence: 1,
                      type: "status",
                      at: "2026-05-29T00:00:00.000Z",
                      status: "running",
                    },
                  ],
                  steps: [],
                },
              }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    fireEvent.click(view.getByRole("button", { name: "Interrupt workflow" }));

    await waitFor(() => expect(interrupted).toBe(true));
    await waitFor(() => expect(view.getAllByText("interrupted").length).toBeGreaterThan(0));
  });

  test("registers workflow run actions with the command palette", async () => {
    let interrupted = false;
    let actions: CommandAction[] = [];
    const api = {
      workflows: {
        getRun: async () => null,
        interrupt: async () => {
          interrupted = true;
          return {
            id: "wfr_palette",
            workspaceId: "workspace-1",
            workflow: {
              name: "deep-research",
              description: "Deep research",
              scope: "built-in",
              executable: true,
            },
            source: "export default function workflow() { return null; }",
            sourceHash: "sha256:test",
            args: { topic: "workflow cards" },
            status: "interrupted",
            createdAt: "2026-05-29T00:00:00.000Z",
            updatedAt: "2026-05-29T00:00:02.000Z",
            events: [
              { sequence: 1, type: "status", at: "2026-05-29T00:00:00.000Z", status: "running" },
              {
                sequence: 2,
                type: "status",
                at: "2026-05-29T00:00:02.000Z",
                status: "interrupted",
              },
            ],
            steps: [],
          };
        },
      },
    };

    render(
      <CommandRegistryProvider>
        <APIHarness client={api}>
          <ThemeProvider forcedTheme="dark">
            <TooltipProvider>
              <WorkflowRunToolCall
                args={{
                  name: "deep-research",
                  args: { topic: "workflow cards" },
                  run_in_background: true,
                }}
                status="completed"
                result={{
                  status: "running",
                  runId: "wfr_palette",
                  result: null,
                  run: {
                    id: "wfr_palette",
                    workspaceId: "workspace-1",
                    workflow: {
                      name: "deep-research",
                      description: "Deep research",
                      scope: "built-in",
                      executable: true,
                    },
                    source: "export default function workflow() { return null; }",
                    sourceHash: "sha256:test",
                    args: { topic: "workflow cards" },
                    status: "running",
                    createdAt: "2026-05-29T00:00:00.000Z",
                    updatedAt: "2026-05-29T00:00:01.000Z",
                    events: [
                      {
                        sequence: 1,
                        type: "status",
                        at: "2026-05-29T00:00:00.000Z",
                        status: "running",
                      },
                    ],
                    steps: [],
                  },
                }}
              />
              <CommandActionCapture onActions={(nextActions) => (actions = nextActions)} />
            </TooltipProvider>
          </ThemeProvider>
        </APIHarness>
      </CommandRegistryProvider>
    );

    await waitFor(() =>
      expect(actions.some((action) => action.id === "workflow:wfr_palette:interrupt")).toBe(true)
    );
    const interruptAction = actions.find(
      (action) => action.id === "workflow:wfr_palette:interrupt"
    );
    expect(interruptAction).toBeDefined();
    await interruptAction?.run();

    await waitFor(() => expect(interrupted).toBe(true));
  });

  test("shows resume action for interrupted workflows and refreshes after resume", async () => {
    let resumed = false;
    let getRunCalls = 0;
    const interruptedRun = {
      id: "wfr_resume",
      workspaceId: "workspace-1",
      workflow: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      source: "export default function workflow() { return null; }",
      sourceHash: "sha256:test",
      args: { topic: "workflow cards" },
      status: "interrupted" as const,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [
        {
          sequence: 1,
          type: "status" as const,
          at: "2026-05-29T00:00:00.000Z",
          status: "interrupted" as const,
        },
      ],
      steps: [],
    };
    const completedRun = {
      ...interruptedRun,
      status: "completed" as const,
      updatedAt: "2026-05-29T00:00:02.000Z",
      events: [
        ...interruptedRun.events,
        {
          sequence: 2,
          type: "result" as const,
          at: "2026-05-29T00:00:02.000Z",
          result: { reportMarkdown: "resumed" },
        },
        {
          sequence: 3,
          type: "status" as const,
          at: "2026-05-29T00:00:02.000Z",
          status: "completed" as const,
        },
      ],
    };
    const api = {
      workflows: {
        resume: async () => {
          resumed = true;
          return {
            runId: "wfr_resume",
            status: "running" as const,
            result: null,
          };
        },
        getRun: async () => {
          getRunCalls += 1;
          return getRunCalls === 1 ? interruptedRun : completedRun;
        },
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                name: "deep-research",
                args: { topic: "workflow cards" },
                run_in_background: true,
              }}
              status="completed"
              result={{
                status: "interrupted",
                runId: "wfr_resume",
                result: null,
                run: {
                  id: "wfr_resume",
                  workspaceId: "workspace-1",
                  workflow: {
                    name: "deep-research",
                    description: "Deep research",
                    scope: "built-in",
                    executable: true,
                  },
                  source: "export default function workflow() { return null; }",
                  sourceHash: "sha256:test",
                  args: { topic: "workflow cards" },
                  status: "interrupted",
                  createdAt: "2026-05-29T00:00:00.000Z",
                  updatedAt: "2026-05-29T00:00:01.000Z",
                  events: [
                    {
                      sequence: 1,
                      type: "status",
                      at: "2026-05-29T00:00:00.000Z",
                      status: "interrupted",
                    },
                  ],
                  steps: [],
                },
              }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    fireEvent.click(view.getByRole("button", { name: "Resume workflow" }));

    await waitFor(() => expect(resumed).toBe(true));
    await waitFor(() => expect(view.getAllByText("completed").length).toBeGreaterThan(0));
    expect(view.queryByText("resumed")).toBeNull();

    fireEvent.click(getWorkflowHeader(view));

    expect(view.getByText("resumed")).toBeTruthy();
  });

  test("shows retry from checkpoint for recoverable failed workflows", async () => {
    let retried = false;
    let getRunCalls = 0;
    const failedRun = {
      id: "wfr_retry",
      workspaceId: "workspace-1",
      workflow: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      source: "export default function workflow() { return null; }",
      sourceHash: "sha256:test",
      args: { topic: "workflow cards" },
      status: "failed" as const,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [
        {
          sequence: 1,
          type: "error" as const,
          at: "2026-05-29T00:00:00.000Z",
          message: "Execution interrupted",
        },
        {
          sequence: 2,
          type: "status" as const,
          at: "2026-05-29T00:00:01.000Z",
          status: "failed" as const,
        },
      ],
      steps: [],
    };
    const completedRun = {
      ...failedRun,
      status: "completed" as const,
      updatedAt: "2026-05-29T00:00:02.000Z",
      events: [
        ...failedRun.events,
        {
          sequence: 3,
          type: "status" as const,
          at: "2026-05-29T00:00:01.500Z",
          status: "running" as const,
        },
        {
          sequence: 4,
          type: "result" as const,
          at: "2026-05-29T00:00:02.000Z",
          result: { reportMarkdown: "retried" },
        },
        {
          sequence: 5,
          type: "status" as const,
          at: "2026-05-29T00:00:02.000Z",
          status: "completed" as const,
        },
      ],
    };
    const api = {
      workflows: {
        retryFromCheckpoint: async () => {
          retried = true;
          return {
            runId: "wfr_retry",
            status: "running" as const,
            result: null,
          };
        },
        getRun: async () => {
          getRunCalls += 1;
          return getRunCalls === 1 ? failedRun : completedRun;
        },
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                name: "deep-research",
                args: { topic: "workflow cards" },
                run_in_background: true,
              }}
              status="completed"
              result={{ status: "failed", runId: "wfr_retry", result: null, run: failedRun }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    fireEvent.click(view.getByRole("button", { name: "Retry from checkpoint" }));

    await waitFor(() => expect(retried).toBe(true));
    await waitFor(() => expect(view.getAllByText("completed").length).toBeGreaterThan(0));
    fireEvent.click(getWorkflowHeader(view));
    expect(view.getByText("retried")).toBeTruthy();
  });

  test("stops retry polling after an accepted retry reaches terminal failure", async () => {
    const originalSetInterval = globalThis.window.setInterval;
    const originalClearInterval = globalThis.window.clearInterval;
    let clearIntervalCalls = 0;
    const intervalRef: { handler: (() => void) | null } = { handler: null };
    const intervalId = 123;
    globalThis.window.setInterval = ((handler: () => void) => {
      intervalRef.handler = handler;
      return intervalId;
    }) as unknown as typeof window.setInterval;
    globalThis.window.clearInterval = ((id?: number) => {
      if (id === intervalId) {
        clearIntervalCalls += 1;
      }
    }) as unknown as typeof window.clearInterval;
    try {
      let getRunCalls = 0;
      const failedRun = {
        id: "wfr_retry_terminal_failed",
        workspaceId: "workspace-1",
        workflow: {
          name: "deep-research",
          description: "Deep research",
          scope: "built-in" as const,
          executable: true,
          // Server-shaped record: already hydrated (none derivable).
          phaseManifest: null,
        },
        source: "export default function workflow() { return null; }",
        sourceHash: "sha256:test",
        args: {},
        status: "failed" as const,
        createdAt: "2026-05-29T00:00:00.000Z",
        updatedAt: "2026-05-29T00:00:01.000Z",
        events: [
          {
            sequence: 1,
            type: "error" as const,
            at: "2026-05-29T00:00:00.000Z",
            message: "Execution interrupted",
          },
          {
            sequence: 2,
            type: "status" as const,
            at: "2026-05-29T00:00:01.000Z",
            status: "failed" as const,
          },
        ],
        steps: [],
      };
      const terminalFailedRun = {
        ...failedRun,
        updatedAt: "2026-05-29T00:00:04.000Z",
        events: [
          ...failedRun.events,
          {
            sequence: 3,
            type: "status" as const,
            at: "2026-05-29T00:00:02.000Z",
            status: "running" as const,
          },
          {
            sequence: 4,
            type: "error" as const,
            at: "2026-05-29T00:00:03.000Z",
            message: "retry failed",
          },
          {
            sequence: 5,
            type: "status" as const,
            at: "2026-05-29T00:00:04.000Z",
            status: "failed" as const,
          },
        ],
      };
      const api = {
        workflows: {
          retryFromCheckpoint: async () => ({
            runId: failedRun.id,
            status: "running" as const,
            result: null,
          }),
          getRun: async () => {
            getRunCalls += 1;
            return terminalFailedRun;
          },
        },
      };

      const view = render(
        <APIHarness client={api}>
          <ThemeProvider forcedTheme="dark">
            <TooltipProvider>
              <WorkflowRunToolCall
                args={{
                  script_path: "skill://deep-research/workflow.js",
                  args: {},
                  run_in_background: true,
                }}
                status="completed"
                result={{ status: "failed", runId: failedRun.id, result: null, run: failedRun }}
              />
            </TooltipProvider>
          </ThemeProvider>
        </APIHarness>
      );

      fireEvent.click(view.getByRole("button", { name: "Retry from checkpoint" }));

      await waitFor(() => expect(getRunCalls).toBe(1));
      const pendingIntervalHandler = intervalRef.handler;
      if (clearIntervalCalls === 0 && pendingIntervalHandler != null) {
        pendingIntervalHandler();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getRunCalls).toBe(1);
    } finally {
      globalThis.window.setInterval = originalSetInterval;
      globalThis.window.clearInterval = originalClearInterval;
    }
  });

  test("stops resume polling after an accepted resume reaches terminal failure", async () => {
    const originalSetInterval = globalThis.window.setInterval;
    const originalClearInterval = globalThis.window.clearInterval;
    let clearIntervalCalls = 0;
    const intervalRef: { handler: (() => void) | null } = { handler: null };
    const intervalId = 456;
    globalThis.window.setInterval = ((handler: () => void) => {
      intervalRef.handler = handler;
      return intervalId;
    }) as unknown as typeof window.setInterval;
    globalThis.window.clearInterval = ((id?: number) => {
      if (id === intervalId) {
        clearIntervalCalls += 1;
      }
    }) as unknown as typeof window.clearInterval;
    try {
      let getRunCalls = 0;
      const interruptedRun = {
        id: "wfr_resume_terminal_failed",
        workspaceId: "workspace-1",
        workflow: {
          name: "deep-research",
          description: "Deep research",
          scope: "built-in" as const,
          executable: true,
          // Server-shaped record: already hydrated (none derivable).
          phaseManifest: null,
        },
        source: "export default function workflow() { return null; }",
        sourceHash: "sha256:test",
        args: {},
        status: "interrupted" as const,
        createdAt: "2026-05-29T00:00:00.000Z",
        updatedAt: "2026-05-29T00:00:01.000Z",
        events: [
          {
            sequence: 1,
            type: "status" as const,
            at: "2026-05-29T00:00:01.000Z",
            status: "interrupted" as const,
          },
        ],
        steps: [],
      };
      const terminalFailedRun = {
        ...interruptedRun,
        status: "failed" as const,
        updatedAt: "2026-05-29T00:00:04.000Z",
        events: [
          ...interruptedRun.events,
          {
            sequence: 2,
            type: "status" as const,
            at: "2026-05-29T00:00:02.000Z",
            status: "running" as const,
          },
          {
            sequence: 3,
            type: "error" as const,
            at: "2026-05-29T00:00:03.000Z",
            message: "resume failed",
          },
          {
            sequence: 4,
            type: "status" as const,
            at: "2026-05-29T00:00:04.000Z",
            status: "failed" as const,
          },
        ],
      };
      const api = {
        workflows: {
          resume: async () => ({
            runId: interruptedRun.id,
            status: "running" as const,
            result: null,
          }),
          getRun: async () => {
            getRunCalls += 1;
            return terminalFailedRun;
          },
        },
      };

      const view = render(
        <APIHarness client={api}>
          <ThemeProvider forcedTheme="dark">
            <TooltipProvider>
              <WorkflowRunToolCall
                args={{
                  script_path: "skill://deep-research/workflow.js",
                  args: {},
                  run_in_background: true,
                }}
                status="completed"
                result={{
                  status: "interrupted",
                  runId: interruptedRun.id,
                  result: null,
                  run: interruptedRun,
                }}
              />
            </TooltipProvider>
          </ThemeProvider>
        </APIHarness>
      );

      fireEvent.click(view.getByRole("button", { name: "Resume workflow" }));

      await waitFor(() => expect(getRunCalls).toBe(1));
      const pendingIntervalHandler = intervalRef.handler;
      if (clearIntervalCalls === 0 && pendingIntervalHandler != null) {
        pendingIntervalHandler();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getRunCalls).toBe(1);
    } finally {
      globalThis.window.setInterval = originalSetInterval;
      globalThis.window.clearInterval = originalClearInterval;
    }
  });

  test("ignores duplicate checkpoint retry clicks while a retry request is in flight", async () => {
    let releaseRetry!: () => void;
    const retryStarted = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    let retryCalls = 0;
    const failedRun = {
      id: "wfr_retry_duplicate",
      workspaceId: "workspace-1",
      workflow: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      source: "export default function workflow() { return null; }",
      sourceHash: "sha256:test",
      args: {},
      status: "failed" as const,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [
        {
          sequence: 1,
          type: "error" as const,
          at: "2026-05-29T00:00:00.000Z",
          message: "Execution interrupted",
        },
        {
          sequence: 2,
          type: "status" as const,
          at: "2026-05-29T00:00:01.000Z",
          status: "failed" as const,
        },
      ],
      steps: [],
    };
    const completedRun = {
      ...failedRun,
      status: "completed" as const,
      updatedAt: "2026-05-29T00:00:02.000Z",
      events: [
        ...failedRun.events,
        {
          sequence: 3,
          type: "result" as const,
          at: "2026-05-29T00:00:02.000Z",
          result: { reportMarkdown: "retried" },
        },
        {
          sequence: 4,
          type: "status" as const,
          at: "2026-05-29T00:00:02.000Z",
          status: "completed" as const,
        },
      ],
    };
    const api = {
      workflows: {
        retryFromCheckpoint: async () => {
          retryCalls += 1;
          await retryStarted;
          return { runId: failedRun.id, status: "running" as const, result: null };
        },
        getRun: async () => completedRun,
      },
    };
    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                script_path: "skill://deep-research/workflow.js",
                args: {},
                run_in_background: true,
              }}
              status="completed"
              result={{ status: "failed", runId: failedRun.id, result: null, run: failedRun }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    const retryButton = view.getByRole("button", { name: "Retry from checkpoint" });
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);

    await waitFor(() => expect(retryCalls).toBe(1));
    releaseRetry();
    await waitFor(() => expect(view.getAllByText("completed").length).toBeGreaterThan(0));
  });

  test("does not show retry from checkpoint for non-recoverable failed workflows", () => {
    const api = { workflows: { retryFromCheckpoint: async () => null } };
    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                script_path: "skill://deep-research/workflow.js",
                args: {},
                run_in_background: true,
              }}
              status="completed"
              result={{
                status: "failed",
                runId: "wfr_no_retry",
                result: null,
                run: {
                  id: "wfr_no_retry",
                  workspaceId: "workspace-1",
                  workflow: {
                    name: "deep-research",
                    description: "Deep research",
                    scope: "built-in",
                    executable: true,
                  },
                  source: "export default function workflow() { return null; }",
                  sourceHash: "sha256:test",
                  args: {},
                  status: "failed",
                  createdAt: "2026-05-29T00:00:00.000Z",
                  updatedAt: "2026-05-29T00:00:01.000Z",
                  events: [
                    {
                      sequence: 1,
                      type: "error",
                      at: "2026-05-29T00:00:00.000Z",
                      message: "SyntaxError: Unexpected token",
                    },
                    {
                      sequence: 2,
                      type: "status",
                      at: "2026-05-29T00:00:01.000Z",
                      status: "failed",
                    },
                  ],
                  steps: [],
                },
              }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    expect(view.queryByRole("button", { name: "Retry from checkpoint" })).toBeNull();
  });

  test("does not show retry from checkpoint for unfinished patch checkpoints", () => {
    const api = { workflows: { retryFromCheckpoint: async () => null } };
    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                script_path: "skill://deep-research/workflow.js",
                args: {},
                run_in_background: true,
              }}
              status="completed"
              result={{
                status: "failed",
                runId: "wfr_patch_no_retry",
                result: null,
                run: {
                  id: "wfr_patch_no_retry",
                  workspaceId: "workspace-1",
                  workflow: {
                    name: "deep-research",
                    description: "Deep research",
                    scope: "built-in",
                    executable: true,
                  },
                  source: "export default function workflow() { return null; }",
                  sourceHash: "sha256:test",
                  args: {},
                  status: "failed",
                  createdAt: "2026-05-29T00:00:00.000Z",
                  updatedAt: "2026-05-29T00:00:01.000Z",
                  events: [
                    {
                      sequence: 1,
                      type: "patch",
                      at: "2026-05-29T00:00:00.000Z",
                      stepId: "apply-implement",
                      sourceTaskId: "task_impl",
                      status: "started",
                    },
                    {
                      sequence: 2,
                      type: "error",
                      at: "2026-05-29T00:00:00.500Z",
                      message: "Execution interrupted",
                    },
                    {
                      sequence: 3,
                      type: "status",
                      at: "2026-05-29T00:00:01.000Z",
                      status: "failed",
                    },
                  ],
                  steps: [],
                },
              }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    expect(view.queryByRole("button", { name: "Retry from checkpoint" })).toBeNull();
  });

  test("clears resume polling and re-syncs the run snapshot when resume fails", async () => {
    let getRunCalls = 0;
    // A failed resume often means the card was stale (e.g. another agent already resumed the
    // run); the catch path re-fetches the run once so the card converges to the live record.
    const refreshedRun = {
      id: "wfr_resume_failed",
      workspaceId: "workspace-1",
      workflow: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
        // Server-shaped record: already hydrated (none derivable).
        phaseManifest: null,
      },
      source: "export default function workflow() { return null; }",
      sourceHash: "sha256:test",
      args: { topic: "workflow cards" },
      status: "interrupted" as const,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:02.000Z",
      events: [
        {
          sequence: 1,
          type: "status" as const,
          at: "2026-05-29T00:00:00.000Z",
          status: "interrupted" as const,
        },
        {
          sequence: 2,
          type: "log" as const,
          at: "2026-05-29T00:00:02.000Z",
          message: "Trust gate blocked resume",
        },
      ],
      steps: [],
    };
    const api = {
      workflows: {
        resume: async () => {
          throw new Error("Project trust is required");
        },
        getRun: async () => {
          getRunCalls += 1;
          return refreshedRun;
        },
      },
    };

    const view = render(
      <APIHarness client={api}>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <WorkflowRunToolCall
              args={{
                name: "deep-research",
                args: { topic: "workflow cards" },
                run_in_background: true,
              }}
              status="completed"
              result={{
                status: "interrupted",
                runId: "wfr_resume_failed",
                result: null,
                run: {
                  id: "wfr_resume_failed",
                  workspaceId: "workspace-1",
                  workflow: {
                    name: "deep-research",
                    description: "Deep research",
                    scope: "built-in",
                    executable: true,
                    // Server-shaped record: already hydrated (none derivable).
                    phaseManifest: null,
                  },
                  source: "export default function workflow() { return null; }",
                  sourceHash: "sha256:test",
                  args: { topic: "workflow cards" },
                  status: "interrupted",
                  createdAt: "2026-05-29T00:00:00.000Z",
                  updatedAt: "2026-05-29T00:00:01.000Z",
                  events: [
                    {
                      sequence: 1,
                      type: "status",
                      at: "2026-05-29T00:00:00.000Z",
                      status: "interrupted",
                    },
                  ],
                  steps: [],
                },
              }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </APIHarness>
    );

    fireEvent.click(view.getByRole("button", { name: "Resume workflow" }));

    await waitFor(() => expect(view.getByText("Project trust is required")).toBeTruthy());
    // The best-effort getRun re-sync ran and its snapshot was applied to the card.
    await waitFor(() => expect(view.getByText("Trust gate blocked resume")).toBeTruthy());
    expect(getRunCalls).toBe(1);
    expect(view.getByText("Project trust is required")).toBeTruthy();
    // The pending-resume marker was cleared: the run is immediately resumable again and no
    // resume polling keeps hitting getRun after the failure.
    expect(view.getByRole("button", { name: "Resume workflow" })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getRunCalls).toBe(1);
  });

  test("uses live workflow run status for the header instead of stale tool completion state", () => {
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <TooltipProvider>
          <WorkflowRunToolCall
            args={{
              name: "deep-research",
              args: { topic: "workflow cards" },
              run_in_background: true,
            }}
            status="completed"
            result={{
              status: "running",
              runId: "wfr_running",
              result: null,
              run: {
                id: "wfr_running",
                workspaceId: "workspace-1",
                workflow: {
                  name: "deep-research",
                  description: "Deep research",
                  scope: "built-in",
                  executable: true,
                },
                source: "export default function workflow() { return null; }",
                sourceHash: "sha256:test",
                args: { topic: "workflow cards" },
                status: "running",
                createdAt: "2026-05-29T00:00:00.000Z",
                updatedAt: "2026-05-29T00:00:01.000Z",
                events: [
                  {
                    sequence: 1,
                    type: "status",
                    at: "2026-05-29T00:00:00.000Z",
                    status: "running",
                  },
                  { sequence: 2, type: "phase", at: "2026-05-29T00:00:00.000Z", name: "scope" },
                ],
                steps: [],
              },
            }}
          />
        </TooltipProvider>
      </ThemeProvider>
    );

    expect(view.getByText("executing")).toBeTruthy();
    expect(view.queryByText("completed")).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";

import type { DisplayedMessage } from "@/common/types/message";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { computeTaskReportLinking } from "@/browser/utils/messages/taskReportLinking";

let workspaceContextMock: {
  workspaceMetadata: Map<string, FrontendWorkspaceMetadata>;
  setSelectedWorkspace?: (selection: unknown) => void;
} | null = null;

void mock.module("@/browser/contexts/WorkspaceContext", () => ({
  useOptionalWorkspaceContext: () => workspaceContextMock,
  toWorkspaceSelection: (workspace: FrontendWorkspaceMetadata) => workspace,
}));

void mock.module("./SubagentTranscriptDialog", () => ({
  SubagentTranscriptDialog: () => null,
}));

void mock.module("./Shared/ElapsedTimeDisplay", () => ({
  ElapsedTimeDisplay: ({
    startedAt,
    isActive,
    prefix,
    separator,
  }: {
    startedAt: number | undefined;
    isActive: boolean;
    prefix?: string;
    separator?: string;
  }) => (
    <span
      data-testid="elapsed-time"
      data-active={String(isActive)}
      data-prefix={prefix ?? ""}
      data-separator={separator ?? " • "}
      data-started-at={startedAt == null ? "missing" : String(startedAt)}
    />
  ),
}));

import { GenericToolCall } from "./GenericToolCall";
import { getToolComponent } from "./Shared/getToolComponent";

const workspaceTaskArgs = {
  kind: "workspace" as const,
  prompt: "Investigate this issue in a separate workspace.",
  title: "Workspace investigation",
  run_in_background: true,
};
const TaskToolCall = getToolComponent("task", workspaceTaskArgs);

function createWorkspaceMetadata(
  overrides: Partial<FrontendWorkspaceMetadata> = {}
): FrontendWorkspaceMetadata {
  return {
    id: "workspace-1",
    name: "workspace-task",
    projectName: "project",
    projectPath: "/project",
    runtimeConfig: { type: "local" },
    namedWorkspacePath: "/project/workspace-task",
    ...overrides,
  };
}

const taskAwaitArgs = { task_ids: ["task-1"], timeout_secs: 70 };
const TaskAwaitToolCall = getToolComponent("task_await", taskAwaitArgs);

function createToolMessage(overrides: {
  toolName: string;
  args: unknown;
  result?: unknown;
}): DisplayedMessage {
  return {
    type: "tool",
    id: "tool-msg-1",
    historyId: "hist-1",
    toolCallId: "call-1",
    status: "completed",
    isPartial: false,
    historySequence: 1,
    ...overrides,
  };
}

function renderTaskAwaitToolCall(props: Record<string, unknown> = {}) {
  return render(
    <TooltipProvider>
      <TaskAwaitToolCall
        args={taskAwaitArgs}
        status="executing"
        startedAt={1_700_000_000_000}
        {...props}
      />
    </TooltipProvider>
  );
}

describe("TaskToolCall", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    workspaceContextMock = null;
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("renders legacy variants task calls generically", () => {
    expect(
      getToolComponent("task", {
        subagent_type: "explore",
        prompt: "Review ${variant}",
        title: "Split review",
        variants: ["frontend", "backend"],
      })
    ).toBe(GenericToolCall);
  });

  test("labels workspace tasks and opens their created workspace", () => {
    const workspace = createWorkspaceMetadata({
      id: "created-workspace-1",
      title: "Created workspace",
    });
    const setSelectedWorkspace = mock((selection: unknown) => {
      void selection;
    });
    workspaceContextMock = {
      workspaceMetadata: new Map([[workspace.id, workspace]]),
      setSelectedWorkspace,
    };

    const view = render(
      <TooltipProvider>
        <TaskToolCall
          args={workspaceTaskArgs}
          result={{
            status: "running",
            taskId: "wst_workspace_turn",
            workspaceId: workspace.id,
            handleKind: "workspace_turn",
            note: "Task started in background.",
          }}
          status="completed"
        />
      </TooltipProvider>
    );

    expect(view.queryByText("unknown")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Open workspace" }));

    expect(setSelectedWorkspace).toHaveBeenCalledTimes(1);
    expect(setSelectedWorkspace.mock.calls[0][0]).toEqual(workspace);
  });

  test("prefers live workspace settings over the result snapshot", () => {
    // A plan child's auto-handoff to exec rewrites live metadata after launch; the
    // result snapshot keeps the stale plan-phase settings.
    const workspace = createWorkspaceMetadata({
      id: "task-child-1",
      taskModelString: "anthropic:claude-opus-5",
      taskThinkingLevel: "high",
    });
    workspaceContextMock = {
      workspaceMetadata: new Map([[workspace.id, workspace]]),
    };

    const agentTaskArgs = {
      subagent_type: "plan",
      prompt: "Plan then implement.",
      title: "Plan task",
      run_in_background: true,
    };
    const AgentTaskToolCall = getToolComponent("task", agentTaskArgs);
    const view = render(
      <TooltipProvider>
        <AgentTaskToolCall
          args={agentTaskArgs}
          result={{
            status: "running",
            taskId: "task-child-1",
            modelString: "openai:gpt-5.2",
            thinkingLevel: "low",
            note: "Task started in background.",
          }}
          status="completed"
        />
      </TooltipProvider>
    );

    fireEvent.click(view.getByText("task"));

    const settings = view.container.querySelector("[data-task-ai-settings]");
    expect(settings?.textContent).toContain("Opus 5");
    expect(settings?.textContent).toContain("thinking: high");
    expect(settings?.textContent).not.toContain("thinking: low");
  });

  test("prefers linked report settings over the spawn snapshot after cleanup", () => {
    // Workspace already cleaned up; the task_await-linked report carries the exec
    // settings while the spawn result kept the stale plan-phase ones.
    workspaceContextMock = { workspaceMetadata: new Map() };

    const agentTaskArgs = {
      subagent_type: "plan",
      prompt: "Plan then implement.",
      title: "Plan task",
      run_in_background: true,
    };
    const AgentTaskToolCall = getToolComponent("task", agentTaskArgs);
    const view = render(
      <TooltipProvider>
        <AgentTaskToolCall
          args={agentTaskArgs}
          result={{
            status: "running",
            taskId: "task-child-3",
            modelString: "openai:gpt-5.2",
            thinkingLevel: "low",
            note: "Task started in background.",
          }}
          taskReportLinking={{
            reportByTaskId: new Map([
              [
                "task-child-3",
                {
                  taskId: "task-child-3",
                  reportMarkdown: "done",
                  modelString: "anthropic:claude-opus-5",
                  thinkingLevel: "high",
                },
              ],
            ]),
            suppressReportInAwaitTaskIds: new Set(["task-child-3"]),
            spawnTitleByTaskId: new Map(),
          }}
          status="completed"
        />
      </TooltipProvider>
    );

    fireEvent.click(view.getByText("task"));

    const settings = view.container.querySelector("[data-task-ai-settings]");
    expect(settings?.textContent).toContain("Opus 5");
    expect(settings?.textContent).toContain("thinking: high");
    expect(settings?.textContent).not.toContain("thinking: low");
  });

  test("falls back to result-carried settings after workspace cleanup", () => {
    workspaceContextMock = { workspaceMetadata: new Map() };

    const agentTaskArgs = {
      subagent_type: "explore",
      prompt: "Look around.",
      title: "Explore task",
      run_in_background: true,
    };
    const AgentTaskToolCall = getToolComponent("task", agentTaskArgs);
    const view = render(
      <TooltipProvider>
        <AgentTaskToolCall
          args={agentTaskArgs}
          result={{
            status: "running",
            taskId: "task-child-2",
            modelString: "openai:gpt-5.2",
            thinkingLevel: "low",
            note: "Task started in background.",
          }}
          status="completed"
        />
      </TooltipProvider>
    );

    fireEvent.click(view.getByText("task"));

    const settings = view.container.querySelector("[data-task-ai-settings]");
    expect(settings?.textContent).toContain("thinking: low");
  });
});

describe("TaskAwaitToolCall", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    workspaceContextMock = null;
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("shows elapsed time while task_await is executing", () => {
    const startedAt = 1_700_000_000_123;

    const view = renderTaskAwaitToolCall({ startedAt });

    const timer = view.getByTestId("elapsed-time");
    expect(timer.dataset.active).toBe("true");
    expect(timer.dataset.startedAt).toBe(String(startedAt));
    expect(timer.dataset.prefix).toBe("");
    expect(view.getByText("Waiting for 1 task")).toBeDefined();
    expect(timer.dataset.separator).toBe("");
  });

  test("summarizes completed polls without generic tool chrome", () => {
    const view = renderTaskAwaitToolCall({
      status: "completed",
      result: { results: [{ status: "running", taskId: "task-1" }] },
    });

    expect(view.getByText("Still waiting for 1 task")).toBeDefined();
    expect(view.queryByText("task_await")).toBeNull();
  });

  test("renders interrupted waits as terminal instead of still waiting", () => {
    const view = renderTaskAwaitToolCall({
      status: "completed",
      result: { results: [{ status: "interrupted", taskId: "task-1" }] },
    });

    expect(view.getByText("1 task interrupted")).toBeDefined();
    expect(view.queryByText(/still waiting/i)).toBeNull();
  });

  test("treats interrupted error rows as cancelled waits, not failed tasks", () => {
    const view = renderTaskAwaitToolCall({
      status: "completed",
      result: {
        results: [{ status: "error", taskId: "task-1", error: "Interrupted" }],
      },
    });

    expect(view.getByText("1 task interrupted")).toBeDefined();
    expect(view.queryByText("1 task failed")).toBeNull();
  });

  test("renders call-level interruption as terminal", () => {
    const view = renderTaskAwaitToolCall({ status: "interrupted", result: undefined });

    expect(view.getByText("Task wait interrupted")).toBeDefined();
    expect(view.queryByText("Checked task status")).toBeNull();
  });

  test("keeps active task counts visible beside interruptions", () => {
    const view = renderTaskAwaitToolCall({
      status: "completed",
      result: {
        results: [
          { status: "interrupted", taskId: "task-1" },
          { status: "running", taskId: "task-2" },
          { status: "queued", taskId: "task-3" },
        ],
      },
    });

    expect(view.getByText("1 task interrupted")).toBeDefined();
    expect(view.getByText(/2 tasks still active/)).toBeDefined();
  });

  test("surfaces call-level task_await failures", () => {
    const view = renderTaskAwaitToolCall({
      status: "failed",
      result: { success: false, error: "Task service unavailable" },
    });

    expect(view.getByText("Task wait failed")).toBeDefined();
    expect(view.getByText("Task service unavailable")).toBeDefined();
  });

  test("shows bash kind and spawn model_intent for a single completed bash task", () => {
    const bashSpawn = createToolMessage({
      toolName: "bash",
      args: {
        script: "./scripts/wait_pr_ready.sh 27330",
        display_name: "PR ready watcher",
        model_intent: "watching PR 27330 until it is ready",
        timeout_secs: 3600,
        run_in_background: true,
      },
      result: {
        success: true,
        output: "Started",
        exitCode: 0,
        wall_duration_ms: 10,
        taskId: "bash:pr-ready-watcher-a1b2",
        backgroundProcessId: "pr-ready-watcher-a1b2",
      },
    });

    const view = renderTaskAwaitToolCall({
      status: "completed",
      args: { task_ids: ["bash:pr-ready-watcher-a1b2"] },
      result: {
        results: [
          {
            status: "completed",
            taskId: "bash:pr-ready-watcher-a1b2",
            title: "PR ready watcher",
            reportMarkdown: "exit 0",
          },
        ],
      },
      taskReportLinking: computeTaskReportLinking([bashSpawn]),
    });

    expect(view.getByText("1 task completed")).toBeDefined();
    expect(view.getByText(/bash · Watching PR 27330 until it is ready/)).toBeDefined();
  });

  test("falls back to the task title when the spawn intent merely restates the command", () => {
    const bashSpawn = createToolMessage({
      toolName: "bash",
      args: {
        script: "git status",
        display_name: "Repo State",
        model_intent: "git status",
        timeout_secs: 30,
        run_in_background: true,
      },
      result: {
        success: true,
        output: "Started",
        exitCode: 0,
        wall_duration_ms: 10,
        taskId: "bash:repo-state-a1b2",
        backgroundProcessId: "repo-state-a1b2",
      },
    });

    const view = renderTaskAwaitToolCall({
      status: "completed",
      args: { task_ids: ["bash:repo-state-a1b2"] },
      result: {
        results: [
          {
            status: "completed",
            taskId: "bash:repo-state-a1b2",
            title: "Repo State",
            reportMarkdown: "exit 0",
          },
        ],
      },
      taskReportLinking: computeTaskReportLinking([bashSpawn]),
    });

    expect(view.getByText(/bash · Repo State/)).toBeDefined();
    expect(view.queryByText(/bash · Git status/)).toBeNull();
  });

  test("falls back to the completed task title when no spawn intent is linked", () => {
    const view = renderTaskAwaitToolCall({
      status: "completed",
      args: { task_ids: ["bash:pr-ready-watcher-a1b2"] },
      result: {
        results: [
          {
            status: "completed",
            taskId: "bash:pr-ready-watcher-a1b2",
            title: "PR ready watcher",
            reportMarkdown: "exit 0",
          },
        ],
      },
    });

    expect(view.getByText(/bash · PR ready watcher/)).toBeDefined();
  });

  test("shows agent type and title for a single completed sub-agent task", () => {
    const taskSpawn = createToolMessage({
      toolName: "task",
      args: {
        agentId: "explore",
        prompt: "Find pagination helpers.",
        title: "Pagination exploration",
        run_in_background: true,
      },
      result: { status: "queued", taskId: "task-1" },
    });

    const view = renderTaskAwaitToolCall({
      status: "completed",
      result: {
        results: [
          {
            status: "completed",
            taskId: "task-1",
            title: "Pagination exploration",
            reportMarkdown: "Report",
          },
        ],
      },
      taskReportLinking: computeTaskReportLinking([taskSpawn]),
    });

    expect(view.getByText(/explore · Pagination exploration/)).toBeDefined();
  });

  test("prefers the spawn title over the sub-agent's own report title", () => {
    const taskSpawn = createToolMessage({
      toolName: "task",
      args: {
        agentId: "explore",
        prompt: "Find pagination helpers.",
        title: "Pagination exploration",
        run_in_background: true,
      },
      result: { status: "queued", taskId: "task-1" },
    });

    const view = renderTaskAwaitToolCall({
      status: "completed",
      result: {
        results: [
          {
            status: "completed",
            taskId: "task-1",
            title: "Pagination Helpers Investigation Complete",
            reportMarkdown: "Report",
          },
        ],
      },
      taskReportLinking: computeTaskReportLinking([taskSpawn]),
    });

    expect(view.getByText(/explore · Pagination exploration/)).toBeDefined();
    expect(view.queryByText(/Investigation Complete/)).toBeNull();
  });

  test("shows each task's kind and intent for multi-task completions", () => {
    const bashSpawn = createToolMessage({
      toolName: "bash",
      args: {
        script: "./scripts/wait_pr_ready.sh 27330",
        display_name: "PR ready watcher",
        model_intent: "watching PR 27330 until it is ready",
        timeout_secs: 3600,
        run_in_background: true,
      },
      result: {
        success: true,
        output: "Started",
        exitCode: 0,
        wall_duration_ms: 10,
        taskId: "bash:pr-ready-watcher-a1b2",
        backgroundProcessId: "pr-ready-watcher-a1b2",
      },
    });
    const taskSpawn = createToolMessage({
      toolName: "task",
      args: {
        agentId: "explore",
        prompt: "Find pagination helpers.",
        title: "Pagination exploration",
        run_in_background: true,
      },
      result: { status: "queued", taskId: "task-1" },
    });

    const view = renderTaskAwaitToolCall({
      status: "completed",
      args: { task_ids: ["bash:pr-ready-watcher-a1b2", "task-1"] },
      result: {
        results: [
          {
            status: "completed",
            taskId: "bash:pr-ready-watcher-a1b2",
            title: "PR ready watcher",
            reportMarkdown: "exit 0",
          },
          {
            status: "completed",
            taskId: "task-1",
            title: "Pagination exploration",
            reportMarkdown: "Report",
          },
        ],
      },
      taskReportLinking: computeTaskReportLinking([bashSpawn, taskSpawn]),
    });

    expect(view.getByText("2 tasks completed")).toBeDefined();
    expect(view.getByText("bash · Watching PR 27330 until it is ready")).toBeDefined();
    expect(view.getByText("explore · Pagination exploration")).toBeDefined();
  });

  test("uses valid legacy agentType for task_await rows when agentId is invalid", () => {
    workspaceContextMock = {
      workspaceMetadata: new Map([
        [
          "task-1",
          {
            id: "task-1",
            name: "agent_explore_task",
            projectName: "project",
            projectPath: "/project",
            runtimeConfig: { type: "local" },
            namedWorkspacePath: "/project/task",
            parentWorkspaceId: "parent-1",
            agentId: "???",
            agentType: "explore",
            taskStatus: "running",
          },
        ],
      ]),
    };

    const view = renderTaskAwaitToolCall();

    fireEvent.click(view.getByLabelText("Waiting for 1 task. Show task wait details"));

    expect(view.getByText("explore")).toBeDefined();
    expect(view.queryByText("???")).toBeNull();
  });
});

const taskListArgs = { statuses: ["reported" as const, "interrupted" as const] };
const TaskListToolCall = getToolComponent("task_list", taskListArgs);

describe("TaskListToolCall", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("shows inactive child cleanup guidance when expanded", () => {
    const note =
      "Keep reusable roles, retitle stale role names with task_retitle, and remove obsolete children with task_remove.";
    const view = render(
      <TooltipProvider>
        <TaskListToolCall args={taskListArgs} status="completed" result={{ tasks: [], note }} />
      </TooltipProvider>
    );

    fireEvent.click(view.getByText("task_list"));
    expect(view.getByText(note)).toBeDefined();
  });
});

const taskRetitleArgs = { task_id: "child-task", title: "Simplicity Auditor" };
const TaskRetitleToolCall = getToolComponent("task_retitle", taskRetitleArgs);

describe("TaskRetitleToolCall", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("shows the stable task ID and friendly role name", () => {
    const view = render(
      <TooltipProvider>
        <TaskRetitleToolCall
          args={taskRetitleArgs}
          status="completed"
          result={{ status: "retitled", taskId: "child-task", title: "Simplicity Auditor" }}
        />
      </TooltipProvider>
    );

    expect(view.getByText("Simplicity Auditor")).toBeDefined();
    fireEvent.click(view.getByText("task_retitle"));
    expect(view.getByText("child-task")).toBeDefined();
    expect(view.getByText("retitled")).toBeDefined();
  });
});

const taskSendMessageArgs = {
  task_id: "child-task",
  message: "Use the corrected API shape.",
};
const TaskSendMessageToolCall = getToolComponent("task_send_message", taskSendMessageArgs);

describe("TaskSendMessageToolCall", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("shows the guidance and target when expanded", () => {
    const view = render(
      <TooltipProvider>
        <TaskSendMessageToolCall
          args={taskSendMessageArgs}
          status="completed"
          result={{ status: "queued", taskId: "child-task", queueDispatchMode: "tool-end" }}
        />
      </TooltipProvider>
    );

    expect(view.getByRole("status").textContent).toBe("Queued");
    fireEvent.click(view.getByRole("button", { name: "Message to agent" }));
    expect(view.getByText("child-task")).toBeDefined();
    expect(view.getByText("Use the corrected API shape.")).toBeDefined();
  });

  test.each([
    { status: "accepted", taskId: "child-task", targetRelation: "ancestor" },
    { status: "reactivated", taskId: "child-task" },
    { status: "queued", taskId: "child-task", targetRelation: "sibling" },
    { status: "not_found", taskId: "child-task" },
    { status: "invalid_scope", taskId: "child-task" },
    { status: "not_active", taskId: "child-task", taskStatus: "reported", error: "Inactive peer" },
    { status: "error", taskId: "child-task", error: "Delivery failed" },
    { status: "refused", taskId: "child-task", reason: "Message already queued" },
    { status: "rate_limited", taskId: "child-task", retryAfterMs: 1200 },
  ] as const)("uses the delivery outcome instead of generic tool completion: $status", (result) => {
    const view = render(
      <TooltipProvider>
        <TaskSendMessageToolCall args={taskSendMessageArgs} status="completed" result={result} />
      </TooltipProvider>
    );
    const status = view.getByRole("status");
    const sent = result.status === "accepted" || result.status === "reactivated";
    expect(status.className.includes("text-success")).toBe(sent);
    expect(status.className.includes("text-danger")).toBe(!sent && result.status !== "queued");
    if (result.error != null) expect(view.getByRole("alert").textContent).toBe(result.error);
    if (result.reason != null) expect(view.getByRole("alert").textContent).toBe(result.reason);
    if (result.targetRelation != null)
      expect(view.getByText(`To ${result.targetRelation}`)).toBeTruthy();
    if (result.retryAfterMs != null) expect(view.getByText("Retry in 2s")).toBeTruthy();
  });

  test("shows transport failures even while collapsed", () => {
    const view = render(
      <TooltipProvider>
        <TaskSendMessageToolCall
          args={taskSendMessageArgs}
          status="failed"
          result={{ success: false, error: "Connection lost" }}
        />
      </TooltipProvider>
    );
    expect(view.getByRole("alert").textContent).toBe("Connection lost");
    expect(
      view.getByRole("button", { name: "Message to agent" }).getAttribute("aria-expanded")
    ).toBe("false");
  });

  test("opens the recipient workspace without toggling the message", () => {
    const workspace = createWorkspaceMetadata({ id: "child-task", title: "Reviewer" });
    const select = mock(() => undefined);
    workspaceContextMock = {
      workspaceMetadata: new Map([[workspace.id, workspace]]),
      setSelectedWorkspace: select,
    };
    try {
      const view = render(
        <TooltipProvider>
          <TaskSendMessageToolCall
            args={taskSendMessageArgs}
            status="completed"
            result={{ status: "reactivated", taskId: "child-task" }}
          />
        </TooltipProvider>
      );
      fireEvent.click(view.getByRole("button", { name: "child-task" }));
      expect(select).toHaveBeenCalledWith(workspace);
      expect(
        view.getByRole("button", { name: "Message to Reviewer" }).getAttribute("aria-expanded")
      ).toBe("false");
    } finally {
      workspaceContextMock = null;
    }
  });

  test.each(
    [
      "legacy output",
      42,
      true,
      [],
      { status: "refused", reason: {} },
      { status: "constructor" },
    ].map((result) => ({ result }))
  )("keeps malformed persisted message results renderable: %j", ({ result }) => {
    const view = render(
      <TooltipProvider>
        <TaskSendMessageToolCall args={taskSendMessageArgs} result={result} status="completed" />
      </TooltipProvider>
    );
    expect(view.getByRole("status").className).not.toContain("text-success");
    fireEvent.click(view.getByRole("button", { name: "Message to agent" }));
    expect(view.getByText(taskSendMessageArgs.message)).toBeTruthy();
  });

  test("does not render unvalidated fields carried beside a transport error", () => {
    const view = render(
      <TooltipProvider>
        <TaskSendMessageToolCall
          args={taskSendMessageArgs}
          status="failed"
          result={{
            success: false,
            error: "Connection lost",
            status: "refused",
            reason: {},
            targetRelation: {},
          }}
        />
      </TooltipProvider>
    );
    expect(view.getByRole("alert").textContent).toBe("Connection lost");
  });

  test.each(["accepted", "queued", "reactivated"] as const)(
    "preserves hooked delivery outcome: %s",
    (status) => {
      const view = render(
        <TooltipProvider>
          <TaskSendMessageToolCall
            args={taskSendMessageArgs}
            status="completed"
            result={Object.freeze({
              status,
              taskId: "child-task",
              hook_output: "Post hook finished",
              hook_duration_ms: 20,
              hook_path: ".xum/tool_post",
            })}
          />
        </TooltipProvider>
      );
      expect(view.getByRole("status").className).toContain(
        status === "queued" ? "text-backgrounded" : "text-success"
      );
    }
  );

  test("shows bare pre-hook errors alongside their metadata", () => {
    const view = render(
      <TooltipProvider>
        <TaskSendMessageToolCall
          args={taskSendMessageArgs}
          status="completed"
          result={{
            error: "Blocked by project hook",
            hook_output: "Policy refused",
            hook_path: ".xum/tool_pre",
          }}
        />
      </TooltipProvider>
    );
    expect(view.getByRole("alert").textContent).toBe("Blocked by project hook");
    expect(view.getByRole("status").className).toContain("text-danger");
  });

  test.each([null, undefined, { type: "json", value: null }].map((result) => ({ result })))(
    "does not claim delivery for a missing completed result: %j",
    ({ result }) => {
      const view = render(
        <TooltipProvider>
          <TaskSendMessageToolCall args={taskSendMessageArgs} result={result} status="completed" />
        </TooltipProvider>
      );
      expect(view.getByRole("status").className).not.toContain("text-success");
      expect(view.getByRole("status").textContent).toBe("Result unavailable");
    }
  );

  test.each([
    { status: "pending", label: "Pending" },
    { status: "executing", label: "Sending…" },
    { status: "failed", label: "Not sent" },
    { status: "interrupted", label: "Interrupted" },
  ] as const)("preserves lifecycle status without a result: $status", ({ status, label }) => {
    const view = render(
      <TooltipProvider>
        <TaskSendMessageToolCall args={taskSendMessageArgs} result={null} status={status} />
      </TooltipProvider>
    );
    expect(view.getByRole("status").textContent).toBe(label);
  });

  test("accepts SDK-wrapped results with inner and outer hook metadata", () => {
    const view = render(
      <TooltipProvider>
        <TaskSendMessageToolCall
          args={taskSendMessageArgs}
          status="completed"
          result={Object.freeze({
            type: "json",
            value: Object.freeze({
              ...{ status: "accepted", taskId: "child-task" },
              hook_output: "Inner hook",
            }),
            hook_output: "Outer hook",
            hook_path: ".xum/tool_post",
          })}
        />
      </TooltipProvider>
    );
    expect(view.getByRole("status").className).toContain("text-success");
  });

  test("shows SDK-wrapped blocking errors", () => {
    const view = render(
      <TooltipProvider>
        <TaskSendMessageToolCall
          args={taskSendMessageArgs}
          status="completed"
          result={{
            type: "json",
            value: { error: "Wrapped blocking error" },
          }}
        />
      </TooltipProvider>
    );
    expect(view.getByRole("alert").textContent).toBe("Wrapped blocking error");
  });
});

const taskTerminateArgs = { task_ids: ["wfr_x"] };
const TaskTerminateToolCall = getToolComponent("task_terminate", taskTerminateArgs);

describe("TaskTerminateToolCall", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    workspaceContextMock = null;
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("summarizes interrupted workflow runs and reveals the note when expanded", () => {
    const note = "Workflow run interrupted durably; resume it with workflow_resume.";
    const view = render(
      <TooltipProvider>
        <TaskTerminateToolCall
          args={taskTerminateArgs}
          status="completed"
          result={{ results: [{ status: "interrupted", taskId: "wfr_x", note }] }}
        />
      </TooltipProvider>
    );

    // Interrupted workflow runs are a successful outcome, not a still-pending termination.
    expect(view.getByText("1 interrupted")).toBeDefined();
    expect(view.queryByText("1 to terminate")).toBeNull();
    expect(view.queryByText(note)).toBeNull();

    fireEvent.click(view.getByText("task_terminate"));

    expect(view.getByText(note)).toBeDefined();
    const badge = view.getByText("interrupted");
    expect(badge.className).toContain("text-interrupted");
  });
});

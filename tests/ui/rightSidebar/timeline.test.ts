import "../dom";

import React from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { APIContext } from "@/browser/contexts/API";
import { TimelinePanel } from "@/browser/features/RightSidebar/Timeline/TimelinePanel";
import {
  pinTimelineRevealTarget,
  useWorkspaceStoreRaw,
  useWorkspaceTimeline,
  type WorkspaceTimelineSnapshot,
} from "@/browser/stores/WorkspaceStore";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import type { TimelineEvent, TimelinePreview } from "@/common/orpc/schemas/timeline";
import { BACKGROUND_WORK_WAKE_OPENINGS } from "@/common/utils/machineTurnPrompts";

import { installDom } from "../dom";

jest.mock("@/browser/stores/WorkspaceStore", () => ({
  pinTimelineRevealTarget: jest.fn(),
  useWorkspaceStoreRaw: jest.fn(),
  useWorkspaceTimeline: jest.fn(),
}));

const WORKSPACE_ID = "timeline-test-workspace";
const BASE_TIMESTAMP = Date.UTC(2026, 6, 27, 12, 0, 0);

const mockPinTimelineRevealTarget = jest.mocked(pinTimelineRevealTarget);
const mockUseWorkspaceStoreRaw = jest.mocked(useWorkspaceStoreRaw);
const mockUseWorkspaceTimeline = jest.mocked(useWorkspaceTimeline);

function makeEvent(
  id: string,
  kind: string,
  seq: number,
  overrides: Partial<TimelineEvent> = {}
): TimelineEvent {
  return {
    v: 1,
    id,
    kind,
    seq,
    ts: BASE_TIMESTAMP + seq * 1000,
    source: { system: "chat" },
    ...overrides,
  };
}

function timelineSnapshot(events: TimelineEvent[]): WorkspaceTimelineSnapshot {
  return {
    events,
    nextCursor: null,
    hasOlder: false,
    initialized: true,
    loadingOlder: false,
    loadError: null,
    loadErrorKind: null,
  };
}

function renderTimeline(params: {
  events: TimelineEvent[];
  loadOlderHistory?: jest.Mock<Promise<"loaded">, [string]>;
  snapshot?: Partial<WorkspaceTimelineSnapshot>;
  hasOlderHistory?: boolean;
  preview?: TimelinePreview;
}) {
  const loadOlderHistory = params.loadOlderHistory ?? jest.fn().mockResolvedValue("loaded");
  const workspaceState: { messages: unknown[]; muxMessages: unknown[]; hasOlderHistory: boolean } =
    {
      messages: [],
      muxMessages: [],
      hasOlderHistory: params.hasOlderHistory ?? true,
    };
  const workspaceStore = {
    getWorkspaceState: jest.fn(() => workspaceState),
    loadOlderHistory,
    loadOlderTimeline: jest.fn().mockResolvedValue(undefined),
    retryTimeline: jest.fn(),
  };

  mockUseWorkspaceTimeline.mockReturnValue({
    ...timelineSnapshot(params.events),
    ...params.snapshot,
  });
  mockUseWorkspaceStoreRaw.mockReturnValue(workspaceStore as never);

  const api = {
    workspace: {
      timeline: {
        preview: jest.fn().mockResolvedValue(
          params.preview ?? {
            role: "assistant",
            textExcerpt: "Preview fixture",
          }
        ),
      },
    },
  };

  const view = render(
    React.createElement(APIContext.Provider, {
      value: {
        status: "connected",
        api: api as never,
        error: null,
        authenticate: () => undefined,
        retry: () => undefined,
      },
      children: React.createElement(TimelinePanel, { workspaceId: WORKSPACE_ID }),
    })
  );

  return { ...view, loadOlderHistory, workspaceStore, workspaceState };
}

describe("TimelinePanel", () => {
  let cleanupDom: () => void;

  beforeEach(() => {
    cleanupDom = installDom();
    localStorage.clear();
    mockPinTimelineRevealTarget.mockReset();
    mockUseWorkspaceStoreRaw.mockReset();
    mockUseWorkspaceTimeline.mockReset();
  });

  afterEach(() => {
    cleanup();
    cleanupDom();
  });

  test("renders fixture rows, unknown kinds, and agent-authored semantics", () => {
    const events = [
      makeEvent("user-turn", "turn.user", 1),
      makeEvent("future-event", "future.kind", 2),
      makeEvent("agent-event", "agent.event", 3, {
        source: { system: "agent" },
        data: { description: "Committed the backend slice", category: "milestone" },
      }),
    ];

    const view = renderTimeline({ events });

    expect(view.container.querySelectorAll("[data-timeline-event-id]")).toHaveLength(3);
    expect(
      view.container.querySelector(
        '[data-timeline-event-id="future-event"][data-timeline-event-kind="future.kind"]'
      )
    ).not.toBeNull();
    expect(
      view.container.querySelector(
        '[data-timeline-event-id="agent-event"][data-timeline-source="agent"]'
      )
    ).not.toBeNull();
    expect(view.getByText("Committed the backend slice")).not.toBeNull();
    expect(view.getByText("milestone")).not.toBeNull();
    expect(
      view.container.querySelector(
        '[data-timeline-event-id="user-turn"][data-timeline-source="chat"]'
      )
    ).not.toBeNull();
  });

  test("category filters narrow the feed and isolate agent events", () => {
    const events = [
      makeEvent("turn", "turn.user", 1),
      makeEvent("task", "task.created", 2, { source: { system: "task" } }),
      makeEvent("agent-event", "agent.event", 3, { source: { system: "agent" } }),
      makeEvent("agent-plan", "agent.plan_proposed", 4, { source: { system: "agent" } }),
    ];

    const view = renderTimeline({ events });
    const filterButtons = Array.from(view.container.querySelectorAll("button[aria-pressed]"));
    const subagentsFilter = filterButtons.find((button) => button.textContent === "Subagents");
    const agentFilter = filterButtons.find((button) => button.textContent === "Agent");

    if (!subagentsFilter || !agentFilter) {
      throw new Error("Expected timeline category controls");
    }

    fireEvent.click(subagentsFilter);
    expect(view.container.querySelectorAll("[data-timeline-event-id]")).toHaveLength(1);
    expect(view.container.querySelector('[data-timeline-event-id="task"]')).not.toBeNull();

    fireEvent.click(agentFilter);
    const visibleRows = Array.from(
      view.container.querySelectorAll<HTMLElement>("[data-timeline-event-id]")
    );
    expect(visibleRows).toHaveLength(2);
    expect(visibleRows.every((row) => row.dataset.timelineSource === "agent")).toBe(true);
  });

  test("keeps machine-dispatched turns and turn outcomes out of the prompts filter", () => {
    const events = [
      makeEvent("human", "turn.user", 1),
      makeEvent("wakeup", "turn.synthetic", 2),
      makeEvent("outcome", "turn.completed", 3),
      makeEvent("stopped", "turn.interrupted", 4),
    ];

    const view = renderTimeline({ events });
    const promptsFilter = Array.from(view.container.querySelectorAll("button")).find(
      (button) => button.textContent === "Prompts"
    );
    if (!promptsFilter) throw new Error("Expected the prompts filter control");

    fireEvent.click(promptsFilter);

    const visible = Array.from(
      view.container.querySelectorAll<HTMLElement>("[data-timeline-event-id]")
    ).map((row) => row.dataset.timelineEventId);
    expect(visible).toEqual(["human"]);
  });

  test("renders completed turns as compact rules that are never collapsed", () => {
    const events = [
      makeEvent("turn-1", "turn.completed", 1, {
        status: "completed",
        data: { model: "anthropic:claude-opus-5", mode: "exec", durationMs: 33_000 },
      }),
      makeEvent("turn-2", "turn.completed", 2, { status: "completed" }),
      makeEvent("turn-3", "turn.completed", 3, { status: "completed" }),
    ];

    const view = renderTimeline({ events });

    expect(
      view.container.querySelector('[data-timeline-collapsed-kind="turn.completed"]')
    ).toBeNull();
    expect(view.container.querySelectorAll('[role="separator"]')).toHaveLength(3);
    expect(view.container.textContent).toContain("anthropic:claude-opus-5");
  });

  test("classifies persisted synthetic rows from their prompt digest", () => {
    const events = [
      makeEvent("legacy-wake", "turn.synthetic", 1, {
        data: { digest: `${BACKGROUND_WORK_WAKE_OPENINGS.subagentsCompleted} Write the response.` },
      }),
      makeEvent("legacy-other", "turn.synthetic", 2, { data: { digest: "Implement the plan." } }),
    ];

    const view = renderTimeline({ events });
    const subagentsFilter = Array.from(view.container.querySelectorAll("button")).find(
      (button) => button.textContent === "Subagents"
    );
    if (!subagentsFilter) throw new Error("Expected the subagents filter control");
    fireEvent.click(subagentsFilter);

    const visible = Array.from(
      view.container.querySelectorAll<HTMLElement>("[data-timeline-event-id]")
    ).map((row) => row.dataset.timelineEventId);
    expect(visible).toEqual(["legacy-wake"]);
  });

  test("keeps a failed event in its own category as well as errors", () => {
    const view = renderTimeline({
      events: [
        makeEvent("failed-task", "task.failed", 1, {
          source: { system: "task" },
          status: "failed",
        }),
      ],
    });
    const filterButtons = Array.from(view.container.querySelectorAll("button[aria-pressed]"));
    const subagentsFilter = filterButtons.find((button) => button.textContent === "Subagents");
    const errorsFilter = filterButtons.find((button) => button.textContent === "Errors");
    if (!subagentsFilter || !errorsFilter) throw new Error("Expected timeline category controls");

    fireEvent.click(subagentsFilter);
    expect(view.container.querySelectorAll("[data-timeline-event-id]")).toHaveLength(1);

    fireEvent.click(errorsFilter);
    expect(view.container.querySelectorAll("[data-timeline-event-id]")).toHaveLength(1);
  });

  test("collapses three consecutive same-kind rows and expands the run", () => {
    const events = [
      makeEvent("heartbeat-1", "heartbeat.dispatched", 1, { source: { system: "heartbeat" } }),
      makeEvent("heartbeat-2", "heartbeat.dispatched", 2, { source: { system: "heartbeat" } }),
      makeEvent("heartbeat-3", "heartbeat.dispatched", 3, { source: { system: "heartbeat" } }),
      makeEvent("turn", "turn.completed", 4),
    ];

    const view = renderTimeline({ events });
    const collapsedRun = view.container.querySelector<HTMLElement>(
      '[data-timeline-collapsed-kind="heartbeat.dispatched"][data-timeline-collapsed-count="3"]'
    );

    expect(collapsedRun).not.toBeNull();
    expect(collapsedRun?.getAttribute("aria-expanded")).toBe("false");
    expect(
      view.container.querySelectorAll('[data-timeline-event-kind="heartbeat.dispatched"]')
    ).toHaveLength(0);

    fireEvent.click(collapsedRun!);

    expect(
      view.container.querySelectorAll('[data-timeline-event-kind="heartbeat.dispatched"]')
    ).toHaveLength(3);
    expect(
      view.container
        .querySelector('[data-timeline-collapsed-kind="heartbeat.dispatched"]')
        ?.getAttribute("aria-expanded")
    ).toBe("true");
  });

  // Production timeline pages are newest-first, so these fixtures list descending seq.
  test("collapses wake/turn-completed churn into one expandable group", () => {
    const events = [
      makeEvent("report", "task.reported", 5, { source: { system: "task" } }),
      makeEvent("turn-2", "turn.completed", 4),
      makeEvent("wake-2", "turn.monitor_wake", 3),
      makeEvent("turn-1", "turn.completed", 2),
      makeEvent("wake-1", "turn.monitor_wake", 1),
    ];

    const view = renderTimeline({ events });
    const collapsedRun = view.container.querySelector<HTMLElement>(
      '[data-timeline-collapsed-kind="turn.monitor_wake"][data-timeline-collapsed-count="2"]'
    );

    expect(collapsedRun).not.toBeNull();
    expect(view.container.querySelectorAll('[role="separator"]')).toHaveLength(0);
    expect(view.container.querySelector('[data-timeline-event-id="report"]')).not.toBeNull();

    fireEvent.click(collapsedRun!);

    expect(
      view.container.querySelectorAll('[data-timeline-event-kind="turn.monitor_wake"]')
    ).toHaveLength(2);
    expect(view.container.querySelectorAll('[role="separator"]')).toHaveLength(2);
  });

  test("keeps a lone machinery event as a plain row with its turn rule", () => {
    const events = [
      makeEvent("report", "task.reported", 3, { source: { system: "task" } }),
      makeEvent("turn", "turn.completed", 2),
      makeEvent("wake", "turn.monitor_wake", 1),
    ];

    const view = renderTimeline({ events });

    expect(view.container.querySelector("[data-timeline-collapsed-kind]")).toBeNull();
    expect(view.container.querySelector('[data-timeline-event-id="wake"]')).not.toBeNull();
    expect(view.container.querySelectorAll('[role="separator"]')).toHaveLength(1);
  });

  test("groups adjacent machinery events across different kinds", () => {
    const events = [
      makeEvent("report", "task.reported", 3, { source: { system: "task" } }),
      makeEvent("continuation", "goal.continuation_dispatched", 2, {
        source: { system: "goal" },
      }),
      makeEvent("wake", "turn.monitor_wake", 1),
    ];

    const view = renderTimeline({ events });
    const collapsedRun = view.container.querySelector<HTMLElement>(
      '[data-timeline-collapsed-count="2"]'
    );

    expect(collapsedRun).not.toBeNull();
    expect(view.container.querySelector('[data-timeline-event-id="wake"]')).toBeNull();
    expect(view.container.querySelector('[data-timeline-event-id="continuation"]')).toBeNull();

    fireEvent.click(collapsedRun!);

    expect(view.container.querySelector('[data-timeline-event-id="wake"]')).not.toBeNull();
    expect(view.container.querySelector('[data-timeline-event-id="continuation"]')).not.toBeNull();
  });

  test("drops the sub-agent started row once a newer row for its task lands", () => {
    const events = [
      makeEvent("done-report", "task.reported", 3, {
        source: { system: "task", key: "task-report:task-a" },
        status: "completed",
        data: { title: "Auditor finished", digest: "Found two issues" },
        anchor: { taskId: "task-a", childWorkspaceId: "task-a" },
      }),
      makeEvent("done-start", "task.created", 2, {
        source: { system: "task", key: "task-created:task-a" },
        status: "started",
        anchor: { taskId: "task-a", toolCallId: "call-a", childWorkspaceId: "task-a" },
      }),
      makeEvent("inflight-start", "task.created", 1, {
        source: { system: "task", key: "task-created:task-b" },
        status: "started",
        anchor: { taskId: "task-b", toolCallId: "call-b", childWorkspaceId: "task-b" },
      }),
    ];

    const view = renderTimeline({ events });

    expect(view.container.querySelector('[data-timeline-event-id="done-start"]')).toBeNull();
    expect(view.container.querySelector('[data-timeline-event-id="done-report"]')).not.toBeNull();
    expect(
      view.container.querySelector('[data-timeline-event-id="inflight-start"]')
    ).not.toBeNull();
  });

  test("drops the sub-agent update row once the same task's report lands", () => {
    const events = [
      makeEvent("report", "task.reported", 2, {
        source: { system: "task", key: "task-report:task-a" },
        status: "completed",
        data: { title: "Comment audit finding", digest: "No must-fix issues" },
        anchor: { taskId: "task-a", childWorkspaceId: "task-a" },
      }),
      makeEvent("update", "task.progress", 1, {
        source: { system: "task" },
        status: "started",
        data: { title: "Comment audit finding", digest: "No must-fix issues" },
        anchor: { taskId: "task-a", messageId: "msg-1", childWorkspaceId: "task-a" },
      }),
    ];

    const view = renderTimeline({ events });

    expect(view.container.querySelector('[data-timeline-event-id="update"]')).toBeNull();
    expect(view.container.querySelector('[data-timeline-event-id="report"]')).not.toBeNull();
  });

  test("keeps earlier updates with distinct findings after the report lands", () => {
    const events = [
      makeEvent("report", "task.reported", 2, {
        source: { system: "task", key: "task-report:task-a" },
        status: "completed",
        data: { title: "Final summary", digest: "All checks pass" },
        anchor: { taskId: "task-a", childWorkspaceId: "task-a" },
      }),
      makeEvent("finding", "task.progress", 1, {
        source: { system: "task" },
        status: "started",
        data: { title: "Important finding", digest: "Found a race in the loader" },
        anchor: { taskId: "task-a", messageId: "msg-1", childWorkspaceId: "task-a" },
      }),
    ];

    const view = renderTimeline({ events });

    expect(view.container.querySelector('[data-timeline-event-id="finding"]')).not.toBeNull();
    expect(view.container.querySelector('[data-timeline-event-id="report"]')).not.toBeNull();
  });

  test("keeps default-titled updates whose digests differ", () => {
    const events = [
      makeEvent("update-late", "task.progress", 2, {
        source: { system: "task" },
        status: "started",
        data: { title: "Subagent (explore) update", digest: "Cache poisoning suspected" },
        anchor: { taskId: "task-a", messageId: "msg-2", childWorkspaceId: "task-a" },
      }),
      makeEvent("update-early", "task.progress", 1, {
        source: { system: "task" },
        status: "started",
        data: { title: "Subagent (explore) update", digest: "Found a race in the loader" },
        anchor: { taskId: "task-a", messageId: "msg-1", childWorkspaceId: "task-a" },
      }),
    ];

    const view = renderTimeline({ events });

    expect(view.container.querySelector('[data-timeline-event-id="update-late"]')).not.toBeNull();
    expect(view.container.querySelector('[data-timeline-event-id="update-early"]')).not.toBeNull();
  });

  test("drops an untitled update when the terminal report repeats its content", () => {
    // Mapper update rows carry the producer fallback title; TaskService terminal rows omit it.
    const events = [
      makeEvent("report", "task.reported", 2, {
        source: { system: "task", key: "task-report:task-a" },
        status: "completed",
        data: { digest: "All timeline suites pass" },
        anchor: { taskId: "task-a", childWorkspaceId: "task-a" },
      }),
      makeEvent("update", "task.progress", 1, {
        source: { system: "task" },
        status: "started",
        data: { title: "Subagent (explore) update", digest: "All timeline suites pass" },
        anchor: { taskId: "task-a", messageId: "msg-1", childWorkspaceId: "task-a" },
      }),
    ];

    const view = renderTimeline({ events });

    expect(view.container.querySelector('[data-timeline-event-id="update"]')).toBeNull();
    expect(view.container.querySelector('[data-timeline-event-id="report"]')).not.toBeNull();
  });

  test("drops an update whose report repeats it beyond the row digest cap", () => {
    const reportMarkdown = "finding detail ".repeat(20).trim();
    const rowCapped = `${reportMarkdown.slice(0, 117)}...`;
    const events = [
      makeEvent("report", "task.reported", 2, {
        source: { system: "task", key: "task-report:task-a" },
        status: "completed",
        data: { title: "Audit result", digest: reportMarkdown },
        anchor: { taskId: "task-a", childWorkspaceId: "task-a" },
      }),
      makeEvent("update", "task.progress", 1, {
        source: { system: "task" },
        status: "started",
        data: { title: "Audit result", digest: rowCapped },
        anchor: { taskId: "task-a", messageId: "msg-1", childWorkspaceId: "task-a" },
      }),
    ];

    const view = renderTimeline({ events });

    expect(view.container.querySelector('[data-timeline-event-id="update"]')).toBeNull();
    expect(view.container.querySelector('[data-timeline-event-id="report"]')).not.toBeNull();
  });

  test("collapses duplicate update rows while keeping distinct checkpoints", () => {
    const events = [
      makeEvent("update-late", "task.progress", 4, {
        source: { system: "task" },
        status: "started",
        data: { title: "Second checkpoint" },
        anchor: { taskId: "task-a", messageId: "msg-3", childWorkspaceId: "task-a" },
      }),
      makeEvent("update-dupe", "task.progress", 3, {
        source: { system: "task" },
        status: "started",
        data: { title: "Second checkpoint" },
        anchor: { taskId: "task-a", messageId: "msg-2", childWorkspaceId: "task-a" },
      }),
      makeEvent("update-early", "task.progress", 2, {
        source: { system: "task" },
        status: "started",
        data: { title: "First checkpoint" },
        anchor: { taskId: "task-a", messageId: "msg-1", childWorkspaceId: "task-a" },
      }),
      makeEvent("start", "task.created", 1, {
        source: { system: "task", key: "task-created:task-a" },
        status: "started",
        anchor: { taskId: "task-a", toolCallId: "call-a", childWorkspaceId: "task-a" },
      }),
    ];

    const view = renderTimeline({ events });

    expect(view.container.querySelector('[data-timeline-event-id="update-late"]')).not.toBeNull();
    expect(view.container.querySelector('[data-timeline-event-id="update-dupe"]')).toBeNull();
    expect(view.container.querySelector('[data-timeline-event-id="update-early"]')).not.toBeNull();
    expect(view.container.querySelector('[data-timeline-event-id="start"]')).toBeNull();
  });

  test("shows a single representation when the preview excerpt duplicates the digest", async () => {
    // Mirror the producer: a >120-char prompt is digested to a 117-char cut plus "...".
    const longPrompt = "alpha beta gamma delta epsilon ".repeat(8).trim();
    const truncatedDigest = `${longPrompt.slice(0, 117)}...`;
    const view = renderTimeline({
      events: [
        makeEvent("prompt", "turn.user", 1, {
          data: { digest: truncatedDigest },
          anchor: { messageId: "user-1" },
        }),
      ],
      preview: { role: "user", textExcerpt: longPrompt },
    });

    fireEvent.click(view.container.querySelector('[data-timeline-event-id="prompt"]')!);
    await waitFor(() => view.getByText(longPrompt));

    // The digest still renders in the row detail; the card itself shows only the excerpt.
    expect(view.getAllByText(truncatedDigest)).toHaveLength(1);
  });

  test("keeps the reveal path when the retained task row lacks a transcript anchor", async () => {
    const events = [
      makeEvent("report", "task.reported", 2, {
        source: { system: "task", key: "task-report:task-a" },
        status: "completed",
        data: { title: "Auditor finished" },
        anchor: { taskId: "task-a", childWorkspaceId: "task-a" },
      }),
      makeEvent("start", "task.created", 1, {
        source: { system: "task", key: "task-created:task-a" },
        status: "started",
        anchor: { taskId: "task-a", toolCallId: "spawn-call", childWorkspaceId: "task-a" },
      }),
    ];

    const view = renderTimeline({ events });
    expect(view.container.querySelector('[data-timeline-event-id="start"]')).toBeNull();

    fireEvent.click(view.container.querySelector('[data-timeline-event-id="report"]')!);

    // The report row inherited the started row's spawning tool-call anchor, so the reveal
    // action stays available even though TaskService recorded the report without one.
    await waitFor(() => view.getByTestId("timeline-reveal"));
  });

  test("does not hide the excerpt behind a generic title the prompt happens to open with", async () => {
    const view = renderTimeline({
      events: [
        makeEvent("prompt", "turn.user", 1, {
          data: { digest: "User prompt: reproduce the issue" },
          anchor: { messageId: "user-1" },
        }),
      ],
      preview: {
        role: "user",
        textExcerpt: "User prompt: reproduce the issue with the beta build",
      },
    });

    fireEvent.click(view.container.querySelector('[data-timeline-event-id="prompt"]')!);

    await waitFor(() => view.getByText("User prompt: reproduce the issue with the beta build"));
  });

  test("keeps a digest whose natural trailing ellipsis is not a truncation marker", async () => {
    const view = renderTimeline({
      events: [
        makeEvent("prompt", "turn.user", 1, {
          data: { digest: "Investigate..." },
          anchor: { messageId: "user-1" },
        }),
      ],
      preview: { role: "user", textExcerpt: "Investigate the logs" },
    });

    fireEvent.click(view.container.querySelector('[data-timeline-event-id="prompt"]')!);
    await waitFor(() => view.getByText("Investigate the logs"));

    expect(view.getAllByText("Investigate...")).toHaveLength(2);
  });

  test("hides an excerpt that only repeats an agent event's description", async () => {
    const view = renderTimeline({
      events: [
        makeEvent("agent-note", "agent.event", 1, {
          source: { system: "agent", key: "timeline-event:note" },
          data: { description: "Pushed the branch and opened the PR", category: "handoff" },
          anchor: { toolCallId: "tool-1" },
        }),
      ],
      preview: { role: "assistant", textExcerpt: "Pushed the branch and opened the PR" },
    });

    fireEvent.click(view.container.querySelector('[data-timeline-event-id="agent-note"]')!);
    await waitFor(() => view.getByTestId("timeline-reveal"));
    await waitFor(() => {
      if (view.queryByText("Loading preview…")) throw new Error("Preview still loading");
    });

    expect(view.getAllByText("Pushed the branch and opened the PR")).toHaveLength(2);
  });

  test("keeps a digest the preview excerpt does not cover", async () => {
    const view = renderTimeline({
      events: [
        makeEvent("report", "task.reported", 1, {
          source: { system: "task", key: "task-report:task-c" },
          status: "completed",
          data: { digest: "Report digest text" },
          anchor: { messageId: "report-1", taskId: "task-c" },
        }),
      ],
      preview: { role: "assistant", textExcerpt: "Unrelated transcript excerpt" },
    });

    fireEvent.click(view.container.querySelector('[data-timeline-event-id="report"]')!);
    await waitFor(() => view.getByText("Unrelated transcript excerpt"));

    expect(view.getAllByText("Report digest text")).toHaveLength(2);
  });

  test("drops the abandoned-retry row that duplicates an adjacent interruption", () => {
    const events = [
      makeEvent("retry-real", "retry.abandoned", 3, { data: { reason: "max retries" } }),
      makeEvent("stop", "turn.interrupted", 2, { status: "interrupted" }),
      makeEvent("retry", "retry.abandoned", 1, { data: { reason: "aborted" } }),
    ];

    const view = renderTimeline({ events });

    expect(view.container.querySelector('[data-timeline-event-id="retry"]')).toBeNull();
    expect(view.container.querySelector('[data-timeline-event-id="stop"]')).not.toBeNull();
    expect(view.container.querySelector('[data-timeline-event-id="retry-real"]')).not.toBeNull();

    // Under the Errors filter the interruption row is gone, so the retry row must come back.
    const errorsFilter = Array.from(view.container.querySelectorAll("button")).find(
      (button) => button.textContent === "Errors"
    );
    if (!errorsFilter) throw new Error("Expected the errors filter control");
    fireEvent.click(errorsFilter);

    expect(view.container.querySelector('[data-timeline-event-id="retry"]')).not.toBeNull();
  });

  test("stops reveal pagination at the page cap when the target remains unavailable", async () => {
    const loadOlderHistory = jest.fn<Promise<"loaded">, [string]>().mockResolvedValue("loaded");
    const event = makeEvent("anchored", "turn.completed", 1, {
      anchor: { messageId: "missing-message" },
    });
    const view = renderTimeline({ events: [event], loadOlderHistory });

    fireEvent.click(view.container.querySelector('[data-timeline-event-id="anchored"]')!);

    const revealButton = await waitFor(() => {
      const button = view.getByTestId("timeline-reveal");
      if (!button) throw new Error("Reveal action not rendered");
      return button;
    });
    fireEvent.click(revealButton);

    await waitFor(() => {
      expect(view.getByTestId("timeline-reveal-not-found")).not.toBeNull();
    });

    expect(loadOlderHistory).toHaveBeenCalledTimes(10);
    expect(loadOlderHistory).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(mockPinTimelineRevealTarget).toHaveBeenCalledWith(WORKSPACE_ID, {
      messageId: "missing-message",
      toolCallId: undefined,
    });
  });

  test("reveals a target that pinning into the capped projection makes renderable", async () => {
    const event = makeEvent("anchored", "turn.completed", 1, {
      anchor: { messageId: "capped-message" },
    });
    // No older history to page, so the only way to reach the target is the pinned projection.
    const view = renderTimeline({ events: [event], hasOlderHistory: false });
    mockPinTimelineRevealTarget.mockImplementation(() => {
      view.workspaceState.messages = [{ historyId: "capped-message" }];
    });
    const revealed: unknown[] = [];
    const listener = (revealEvent: Event) => revealed.push(revealEvent);
    window.addEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, listener);

    try {
      fireEvent.click(view.container.querySelector('[data-timeline-event-id="anchored"]')!);
      const revealButton = await waitFor(() => view.getByTestId("timeline-reveal"));
      fireEvent.click(revealButton);

      await waitFor(() => {
        if (revealed.length === 0) throw new Error("Reveal was not dispatched");
      });
      expect(view.queryByTestId("timeline-reveal-not-found")).toBeNull();
    } finally {
      window.removeEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, listener);
    }
  });

  test("pages sequence-only anchors before pinning their resolved message", async () => {
    const loadOlderHistory = jest.fn<Promise<"loaded">, [string]>().mockResolvedValue("loaded");
    const event = makeEvent("sequence-anchor", "turn.completed", 1, {
      anchor: { historySequence: 42 },
    });
    const view = renderTimeline({ events: [event], loadOlderHistory });
    loadOlderHistory.mockImplementation(async () => {
      view.workspaceState.muxMessages = [
        { id: "resolved-message", metadata: { historySequence: 42 } },
      ];
      view.workspaceState.messages = [{ historyId: "resolved-message" }];
      return "loaded";
    });
    const revealed: unknown[] = [];
    const listener = (revealEvent: Event) => revealed.push(revealEvent);
    window.addEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, listener);

    try {
      fireEvent.click(view.container.querySelector('[data-timeline-event-id="sequence-anchor"]')!);
      const revealButton = await waitFor(() => view.getByTestId("timeline-reveal"));
      fireEvent.click(revealButton);

      await waitFor(() => {
        if (revealed.length === 0) throw new Error("Reveal was not dispatched");
      });
      expect(loadOlderHistory).toHaveBeenCalledTimes(1);
      expect(mockPinTimelineRevealTarget).toHaveBeenCalledWith(WORKSPACE_ID, {
        messageId: "resolved-message",
        toolCallId: undefined,
      });
    } finally {
      window.removeEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, listener);
    }
  });

  test("selects an anchored context boundary so its summary stays reachable", async () => {
    const events = [
      makeEvent("boundary", "compaction.completed", 1, {
        epoch: 2,
        anchor: { messageId: "summary-message" },
      }),
      makeEvent("plain-boundary", "context.reset", 2),
    ];

    const view = renderTimeline({ events });
    const boundary = view.container.querySelector<HTMLElement>(
      '[data-timeline-event-id="boundary"]'
    );
    if (!boundary) throw new Error("Expected the anchored boundary to be selectable");
    expect(view.container.querySelector('[data-timeline-event-id="plain-boundary"]')).toBeNull();

    fireEvent.click(boundary);

    await waitFor(() => view.getByTestId("timeline-reveal"));
    expect(boundary.getAttribute("aria-pressed")).toBe("true");
  });

  test("reveals the selected event from the keyboard shortcut", async () => {
    const event = makeEvent("anchored", "turn.completed", 1, {
      anchor: { messageId: "loaded-message" },
    });
    const view = renderTimeline({ events: [event] });
    view.workspaceState.messages = [{ historyId: "loaded-message" }];
    const revealed: unknown[] = [];
    const listener = (revealEvent: Event) => revealed.push(revealEvent);
    window.addEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, listener);

    try {
      fireEvent.click(view.container.querySelector('[data-timeline-event-id="anchored"]')!);
      await waitFor(() => view.getByTestId("timeline-reveal"));

      fireEvent.keyDown(window, { key: "Enter", ctrlKey: true, shiftKey: true });

      await waitFor(() => {
        if (revealed.length === 0) throw new Error("Reveal was not dispatched");
      });
    } finally {
      window.removeEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, listener);
    }
  });

  test("ignores the reveal shortcut in a panel hidden behind an open modal", async () => {
    // A CSS-hidden sidebar keeps its panel mounted while the mobile timeline dialog mounts a
    // second one; Radix marks content outside the open modal aria-hidden. The hidden panel's
    // window-level shortcut listener must not fire a competing reveal.
    const event = makeEvent("anchored", "turn.completed", 1, {
      anchor: { messageId: "loaded-message" },
    });
    const view = renderTimeline({ events: [event] });
    view.workspaceState.messages = [{ historyId: "loaded-message" }];
    const revealed: unknown[] = [];
    const listener = (revealEvent: Event) => revealed.push(revealEvent);
    window.addEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, listener);

    try {
      fireEvent.click(view.container.querySelector('[data-timeline-event-id="anchored"]')!);
      const revealButton = await waitFor(() => view.getByTestId("timeline-reveal"));

      view.container.setAttribute("aria-hidden", "true");
      fireEvent.keyDown(window, { key: "Enter", ctrlKey: true, shiftKey: true });

      // The guard rejects synchronously, so the button never enters the revealing state.
      expect(revealButton.textContent).toBe("Reveal in transcript");
      await Promise.resolve();
      expect(revealed).toHaveLength(0);
    } finally {
      window.removeEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, listener);
    }
  });

  test("keeps pagination reachable when the active filter has no matches", () => {
    const view = renderTimeline({
      events: [makeEvent("task", "task.created", 1, { source: { system: "task" } })],
      snapshot: { hasOlder: true, nextCursor: 1 },
    });

    const filterButton = Array.from(view.container.querySelectorAll("button")).find(
      (button) => button.textContent === "Prompts"
    );
    if (!filterButton) throw new Error("Expected the prompts filter control");
    fireEvent.click(filterButton);

    expect(view.container.querySelectorAll("[data-timeline-event-id]")).toHaveLength(0);
    const loadOlder = Array.from(view.container.querySelectorAll("button")).find((button) =>
      button.textContent?.startsWith("Load older")
    );
    expect(loadOlder).not.toBeUndefined();
  });

  test("offers a reconnect when the subscription dies with rows already on screen", () => {
    const view = renderTimeline({
      events: [makeEvent("kept", "turn.user", 1)],
      snapshot: { loadError: "Subscription closed", loadErrorKind: "subscription" },
    });

    expect(view.container.querySelectorAll("[data-timeline-event-id]")).toHaveLength(1);
    const reconnect = Array.from(view.container.querySelectorAll("button")).find(
      (button) => button.textContent === "Reconnect"
    );
    if (!reconnect) throw new Error("Expected a reconnect control");
    fireEvent.click(reconnect);

    expect(view.workspaceStore.retryTimeline).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  test("does not offer a reconnect for a failed older page", () => {
    const view = renderTimeline({
      events: [makeEvent("kept", "turn.user", 1)],
      snapshot: {
        loadError: "Failed to load older events",
        loadErrorKind: "pagination",
        hasOlder: true,
        nextCursor: 1,
      },
    });

    expect(view.container.textContent).toContain("Failed to load older events");
    expect(
      Array.from(view.container.querySelectorAll("button")).some(
        (button) => button.textContent === "Reconnect"
      )
    ).toBe(false);
  });

  test("reports a failed load instead of an empty timeline, and retries on request", () => {
    const view = renderTimeline({
      events: [],
      snapshot: { loadError: "Failed to load timeline" },
    });

    expect(view.container.textContent).toContain("Failed to load timeline");
    expect(view.container.textContent).not.toContain("No timeline events yet");

    const retry = Array.from(view.container.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry"
    );
    if (!retry) throw new Error("Expected a retry control");
    fireEvent.click(retry);

    expect(view.workspaceStore.retryTimeline).toHaveBeenCalledWith(WORKSPACE_ID);
  });
});

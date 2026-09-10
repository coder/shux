import type { Meta, StoryObj } from "@storybook/react-vite";

import { APIContext } from "@/browser/contexts/API";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type { TimelineEvent } from "@/common/orpc/schemas/timeline";
import {
  BACKGROUND_WORK_WAKE_OPENINGS,
  BASH_MONITOR_WAKE_HEADINGS,
} from "@/common/utils/machineTurnPrompts";

import { TimelinePanelView, type TimelineWorkspaceStore } from "./TimelinePanel";

const WORKSPACE_ID = "timeline-story-workspace";
const BASE_TIMESTAMP = Date.UTC(2020, 0, 15, 15, 0, 0);

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
    ts: BASE_TIMESTAMP - (20 - seq) * 45_000,
    source: { system: "chat" },
    ...overrides,
  };
}

const MIXED_EVENTS: TimelineEvent[] = [
  makeEvent("turn-completed", "turn.completed", 20, {
    status: "completed",
    data: { model: "anthropic/claude-sonnet-4", mode: "exec", durationMs: 84_000 },
    anchor: { messageId: "assistant-20" },
  }),
  makeEvent("agent-handoff", "agent.event", 19, {
    source: { system: "agent", key: "timeline-event:handoff" },
    data: {
      description: "Pushed mike/timeline and opened PR #4821",
      category: "handoff",
    },
    anchor: { toolCallId: "tool-timeline-event-2" },
  }),
  makeEvent("turn-failed", "turn.failed", 18, {
    status: "failed",
    data: { reason: "Provider returned 529", errorKind: "api" },
    anchor: { messageId: "assistant-18" },
  }),
  makeEvent("task-reported", "task.reported", 17, {
    source: { system: "task", key: "task_timeline_story" },
    status: "completed",
    data: { title: "Timeline fixture sub-agent finished" },
    anchor: { taskId: "task_timeline_story", childWorkspaceId: "timeline-child-workspace" },
  }),
  makeEvent("task-created", "task.created", 16, {
    source: { system: "task", key: "task_timeline_story" },
    status: "started",
    anchor: { taskId: "task_timeline_story", toolCallId: "tool-task-1" },
  }),
  makeEvent("compaction", "compaction.completed", 15, {
    status: "completed",
    epoch: 3,
  }),
  makeEvent("heartbeat-3", "heartbeat.dispatched", 14, {
    source: { system: "heartbeat" },
    status: "completed",
  }),
  makeEvent("heartbeat-2", "heartbeat.dispatched", 13, {
    source: { system: "heartbeat" },
    status: "completed",
  }),
  makeEvent("heartbeat-1", "heartbeat.dispatched", 12, {
    source: { system: "heartbeat" },
    status: "completed",
  }),
  makeEvent("heartbeat-configured", "heartbeat.configured", 11, {
    source: { system: "heartbeat" },
    status: "completed",
    data: { digest: "Heartbeat is enabled for this workspace at every 30 minutes." },
  }),
  makeEvent("goal-set", "goal.set", 10, {
    source: { system: "goal" },
    status: "started",
    data: { digest: "Land the timeline panel with green checks and a Codex approval" },
  }),
  makeEvent("workflow-attached", "workflow.attached", 9, {
    data: { runId: "wfr_timeline_story" },
    anchor: { toolCallId: "tool-workflow-1" },
  }),
  makeEvent("agent-picked-up", "agent.event", 8, {
    source: { system: "agent", key: "timeline-event:picked-up" },
    data: {
      description: "Picked up review feedback on the retry backoff and rewrote the schedule",
      category: "picked_up",
    },
    anchor: { toolCallId: "tool-timeline-event-1" },
  }),
  makeEvent("future-event", "future.kind", 7, {
    source: { system: "settings", key: "future-fixture" },
    data: { digest: "Forward-compatible event" },
  }),
  makeEvent("user-turn", "turn.user", 6, {
    data: { digest: "Add Timeline behavior coverage and responsive stories" },
    anchor: { messageId: "user-6" },
  }),
  makeEvent("monitor-wake", "turn.monitor_wake", 5, {
    data: {
      title: "Stack CI_Codex watcher",
      digest: `${BASH_MONITOR_WAKE_HEADINGS.matched} Process: Stack CI_Codex watcher`,
    },
    anchor: { messageId: "user-5" },
  }),
  makeEvent("background-wake", "turn.background_wake", 4, {
    data: { digest: BACKGROUND_WORK_WAKE_OPENINGS.subagentsCompleted },
    anchor: { messageId: "user-4" },
  }),
  makeEvent("subagent-update", "task.progress", 3, {
    source: { system: "task", key: "message:user-3" },
    status: "started",
    data: { title: "Halfway through the producer audit", digest: "Checked 6 of 12 producers" },
    anchor: {
      messageId: "user-3",
      taskId: "timeline-child-workspace",
      childWorkspaceId: "timeline-child-workspace",
    },
  }),
  makeEvent("workflow-result", "workflow.result", 2, {
    status: "completed",
    data: { runId: "wfr_timeline_story" },
    anchor: { messageId: "user-2" },
  }),
  makeEvent("subagent-failure", "task.failed", 1, {
    source: { system: "task" },
    status: "failed",
    data: { digest: "Sub-agent exec failed terminally: context limit reached" },
    anchor: { taskId: "timeline-child-workspace", childWorkspaceId: "timeline-child-workspace" },
  }),
];

const CATEGORY_EVENTS: TimelineEvent[] = [
  makeEvent("agent-blocker", "agent.event", 36, {
    source: { system: "agent", key: "timeline-event:blocker" },
    data: {
      description: "PR #87 checks reached terminal state with six failures matching the baseline",
      category: "blocker",
    },
    anchor: { toolCallId: "tool-timeline-event-blocker" },
  }),
  makeEvent("rule-blocker", "turn.completed", 35, {
    status: "completed",
    data: { durationMs: 60_000 },
  }),
  makeEvent("agent-milestone", "agent.event", 34, {
    source: { system: "agent", key: "timeline-event:milestone" },
    data: {
      description: "Landed the retry backoff refactor with green checks",
      category: "milestone",
    },
    anchor: { toolCallId: "tool-timeline-event-milestone" },
  }),
  makeEvent("rule-milestone", "turn.completed", 33, {
    status: "completed",
    data: { durationMs: 60_000 },
  }),
  makeEvent("agent-decision", "agent.event", 32, {
    source: { system: "agent", key: "timeline-event:decision" },
    data: {
      description: "Chose client-side grouping over rewriting the append-only log",
      category: "decision",
    },
    anchor: { toolCallId: "tool-timeline-event-decision" },
  }),
  makeEvent("rule-decision", "turn.completed", 31, {
    status: "completed",
    data: { durationMs: 60_000 },
  }),
  makeEvent("agent-handoff-2", "agent.event", 30, {
    source: { system: "agent", key: "timeline-event:handoff-2" },
    data: {
      description: "Pushed mike/timeline and opened PR #4821",
      category: "handoff",
    },
    anchor: { toolCallId: "tool-timeline-event-handoff-2" },
  }),
  makeEvent("rule-handoff-2", "turn.completed", 29, {
    status: "completed",
    data: { durationMs: 60_000 },
  }),
  makeEvent("agent-picked-up-2", "agent.event", 28, {
    source: { system: "agent", key: "timeline-event:picked-up-2" },
    data: {
      description: "Picked up review feedback on the retry backoff",
      category: "picked_up",
    },
    anchor: { toolCallId: "tool-timeline-event-picked-up-2" },
  }),
  makeEvent("rule-picked-up-2", "turn.completed", 27, {
    status: "completed",
    data: { durationMs: 60_000 },
  }),
  makeEvent("agent-uncategorized", "agent.event", 26, {
    source: { system: "agent", key: "timeline-event:uncategorized" },
    data: { description: "Recorded a note without a category" },
    anchor: { toolCallId: "tool-timeline-event-uncategorized" },
  }),
];

const STORY_STORE: TimelineWorkspaceStore = {
  getWorkspaceState: () => ({ messages: [], muxMessages: [], hasOlderHistory: false }),
  loadOlderHistory: () => Promise.resolve("exhausted"),
  loadOlderTimeline: () => Promise.resolve(),
  retryTimeline: () => undefined,
};

// Override the shared null preview so selecting the user-turn row demonstrates the
// digest-vs-excerpt dedupe.
const STORY_API = createMockORPCClient();
STORY_API.workspace.timeline.preview = () =>
  Promise.resolve({
    role: "user",
    textExcerpt:
      "Add Timeline behavior coverage and responsive stories so the panel is validated at phone widths as well as desktop.",
  });

const meta = {
  title: "Features/RightSidebar/TimelinePanel",
  component: TimelinePanelView,
  parameters: {
    layout: "centered",
    backgrounds: { default: "dark" },
  },
  decorators: [
    (Story) => (
      <ThemeProvider forcedTheme="dark">
        <APIContext.Provider
          value={{
            status: "connected",
            api: STORY_API,
            error: null,
            authenticate: () => undefined,
            retry: () => undefined,
          }}
        >
          <div className="bg-background text-foreground border-border h-[760px] w-full max-w-[430px] overflow-hidden rounded-xl border">
            <Story />
          </div>
        </APIContext.Provider>
      </ThemeProvider>
    ),
  ],
} satisfies Meta<typeof TimelinePanelView>;

export default meta;
type Story = StoryObj<typeof meta>;

const populatedTimeline = {
  events: MIXED_EVENTS,
  nextCursor: null,
  hasOlder: false,
  initialized: true,
  loadingOlder: false,
  loadError: null,
  loadErrorKind: null,
};

export const Default: Story = {
  args: {
    workspaceId: WORKSPACE_ID,
    timeline: populatedTimeline,
    workspaceStore: STORY_STORE,
  },
};

export const Phone390: Story = {
  args: {
    workspaceId: `${WORKSPACE_ID}-phone`,
    timeline: populatedTimeline,
    workspaceStore: STORY_STORE,
  },
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  decorators: [
    (Story) => (
      <div style={{ width: 390, height: 760, overflow: "hidden" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    pixel: {
      matrix: { viewports: ["phone"] },
    },
  },
};

export const AgentEventCategories: Story = {
  args: {
    workspaceId: `${WORKSPACE_ID}-categories`,
    timeline: { ...populatedTimeline, events: CATEGORY_EVENTS },
    workspaceStore: STORY_STORE,
  },
};

export const Empty: Story = {
  args: {
    workspaceId: `${WORKSPACE_ID}-empty`,
    timeline: {
      events: [],
      nextCursor: null,
      hasOlder: false,
      initialized: true,
      loadingOlder: false,
      loadError: null,
      loadErrorKind: null,
    },
    workspaceStore: STORY_STORE,
  },
};

export const LoadFailed: Story = {
  args: {
    workspaceId: `${WORKSPACE_ID}-error`,
    timeline: {
      events: [],
      nextCursor: null,
      hasOlder: false,
      initialized: true,
      loadingOlder: false,
      loadError: "Failed to load timeline",
      loadErrorKind: "subscription",
    },
    workspaceStore: STORY_STORE,
  },
};

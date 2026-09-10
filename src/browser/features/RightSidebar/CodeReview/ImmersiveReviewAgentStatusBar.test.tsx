import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, render, type RenderResult } from "@testing-library/react";
import { Profiler } from "react";

import { installDom } from "../../../../../tests/ui/dom";
// Import the module namespace (not the hook directly) so we can spyOn the hook
// per-test. The bar resolves the store via useWorkspaceStoreRaw(), and several
// OTHER test files globally mock.module this store; spying here keeps this file
// hermetic regardless of cross-file load order (grabbing the real singleton at
// module top-level would crash if another file's stub were active first).
import * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import type { WorkspaceState, WorkspaceStore } from "@/browser/stores/WorkspaceStore";
import type { TodoItem } from "@/common/types/tools";
import { ImmersiveReviewAgentStatusBar } from "./ImmersiveReviewAgentStatusBar";

interface SeedInput {
  todos: TodoItem[];
  canInterrupt?: boolean;
  isStarting?: boolean;
  awaitingUserQuestion?: boolean;
}

// Cache the built state per workspace so getWorkspaceState returns a
// referentially-stable object (useSyncExternalStore would otherwise loop).
// The bar reads todos + streaming flags off a single getWorkspaceState read
// (matching PinnedTodoList), so there's no separate sidebar-state mock.
const seeds = new Map<string, WorkspaceState>();
const subscribers = new Map<string, Set<() => void>>();

function getSubscribers(workspaceId: string): Set<() => void> {
  let set = subscribers.get(workspaceId);
  if (!set) {
    set = new Set();
    subscribers.set(workspaceId, set);
  }
  return set;
}

function buildState(workspaceId: string, input: SeedInput): WorkspaceState {
  return {
    name: workspaceId,
    messages: [],
    queuedMessage: null,
    canInterrupt: input.canInterrupt ?? false,
    isCompacting: false,
    isStreamStarting: input.isStarting ?? false,
    awaitingUserQuestion: input.awaitingUserQuestion ?? false,
    loading: false,
    isTranscriptCaughtUp: true,
    isHydratingTranscript: false,
    hasOlderHistory: false,
    loadingOlderHistory: false,
    muxMessages: [],
    currentModel: null,
    currentThinkingLevel: null,
    recencyTimestamp: null,
    todos: input.todos,
    loadedSkills: [],
    skillLoadErrors: [],
    agentStatus: undefined,
    activeWorkflowRunCount: 0,
    activeBashMonitorCount: 0,
    lastAbortReason: null,
    pendingStreamStartTime: null,
    pendingStreamModel: null,
    runtimeStatus: null,
    autoRetryStatus: null,
  };
}

function seed(workspaceId: string, input: SeedInput): void {
  seeds.set(workspaceId, buildState(workspaceId, input));
}

function notify(workspaceId: string): void {
  getSubscribers(workspaceId).forEach((cb) => cb());
}

/**
 * Replace the cached state with a NEW object reference whose watched fields
 * (todos/canInterrupt/isStreamStarting/awaitingUserQuestion) are byte-identical
 * (todos keeps the same array ref), then notify subscribers — models an
 * unrelated WorkspaceState bump such as a streamed message arriving.
 */
function bumpUnrelated(workspaceId: string): void {
  const prev = seeds.get(workspaceId);
  if (!prev) throw new Error(`Missing seed for ${workspaceId}`);
  seeds.set(workspaceId, { ...prev, name: `${prev.name}-bump`, messages: [...prev.messages] });
  notify(workspaceId);
}

/** Patch a watched field on the cached state and notify subscribers. */
function patchState(workspaceId: string, patch: Partial<WorkspaceState>): void {
  const prev = seeds.get(workspaceId);
  if (!prev) throw new Error(`Missing seed for ${workspaceId}`);
  seeds.set(workspaceId, { ...prev, ...patch });
  notify(workspaceId);
}

// Minimal fake exposing only the store methods the bar calls. Cast through
// unknown because the bar uses just this slice of the WorkspaceStore surface.
const fakeStore = {
  hasRegisteredWorkspace: (id: string) => seeds.has(id),
  subscribeKey: (id: string, cb: () => void) => {
    const set = getSubscribers(id);
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  },
  getWorkspaceState: (id: string) => {
    const state = seeds.get(id);
    if (!state) throw new Error(`Missing seed for ${id}`);
    return state;
  },
} as unknown as WorkspaceStore;

function renderBar(workspaceId: string): RenderResult {
  return render(<ImmersiveReviewAgentStatusBar workspaceId={workspaceId} />);
}

describe("ImmersiveReviewAgentStatusBar", () => {
  // installDom snapshots + fully restores all DOM globals (window, document,
  // localStorage, CustomEvent, …), so this file stays hermetic even when other
  // test files in the same process leave the globals in a partial state.
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    globalThis.localStorage.clear();
    seeds.clear();
    subscribers.clear();

    spyOn(WorkspaceStoreModule, "useWorkspaceStoreRaw").mockReturnValue(fakeStore);
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
    seeds.clear();
    subscribers.clear();
  });

  const todos: TodoItem[] = [
    { content: "Wire up status bar", status: "in_progress" },
    { content: "Add tests", status: "pending" },
  ];

  test("renders the TODO plan inline on a single line when todos exist", () => {
    seed("ws-todos", { todos });
    const result = renderBar("ws-todos");
    // The bar always shows the full plan: a static "TODO" label plus the inline
    // horizontal TodoList strip listing each todo (no collapse toggle).
    expect(result.getByText("TODO")).toBeTruthy();
    expect(result.getByText("Wire up status bar")).toBeTruthy();
    expect(result.getByText("Add tests")).toBeTruthy();
    // The plan is never collapsible, so there's no expand/collapse button.
    expect(result.queryByRole("button")).toBeNull();
  });

  test("renders nothing when there is no plan and no active stream", () => {
    seed("ws-idle", { todos: [] });
    const result = renderBar("ws-idle");
    expect(result.container.firstChild).toBeNull();
  });

  test("shows a streaming chip even when there is no plan yet", () => {
    seed("ws-streaming", { todos: [], canInterrupt: true });
    const result = renderBar("ws-streaming");
    expect(result.getByText("Streaming…")).toBeTruthy();
    // No plan means no TODO summary / expand toggle.
    expect(result.queryByText("TODO")).toBeNull();
  });

  test("shows a starting chip during pre-stream startup", () => {
    seed("ws-starting", { todos: [], isStarting: true });
    const result = renderBar("ws-starting");
    expect(result.getByText("Starting…")).toBeTruthy();
  });

  test("surfaces a prominent prompt when the agent awaits a question", () => {
    seed("ws-question", { todos, awaitingUserQuestion: true });
    const result = renderBar("ws-question");
    expect(result.getByText("Xum has a question")).toBeTruthy();
    // The question chip wins over the streaming label.
    expect(result.queryByText("Streaming…")).toBeNull();
  });

  test("does not re-render on unrelated workspace-state bumps, only on watched fields", () => {
    const workspaceId = "ws-stable";
    seed(workspaceId, { todos, canInterrupt: true });

    let commits = 0;
    const result = render(
      <Profiler
        id="bar"
        onRender={() => {
          commits += 1;
        }}
      >
        <ImmersiveReviewAgentStatusBar workspaceId={workspaceId} />
      </Profiler>
    );
    expect(result.getByText("Streaming…")).toBeTruthy();

    // An unrelated state bump (new WorkspaceState ref, same watched fields)
    // must NOT re-render the bar — this is the leaf-subscription guarantee that
    // keeps streamed-message churn off the immersive diff's sibling bar.
    const committedAfterMount = commits;
    act(() => {
      bumpUnrelated(workspaceId);
      bumpUnrelated(workspaceId);
    });
    expect(commits).toBe(committedAfterMount);

    // Changing a field the bar actually reads DOES re-render it.
    act(() => {
      patchState(workspaceId, { awaitingUserQuestion: true });
    });
    expect(commits).toBeGreaterThan(committedAfterMount);
    expect(result.getByText("Xum has a question")).toBeTruthy();
  });
});

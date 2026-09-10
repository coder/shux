/**
 * ImmersiveReviewAgentStatusBar — pinned to the top of full-screen immersive
 * review. While the user reviews code in immersive mode the chat transcript and
 * composer-adjacent status (TODO plan, streaming barrier) are hidden behind the
 * opaque overlay, so a common workflow — reviewing while waiting on the agent —
 * loses all signal about what the agent is doing.
 *
 * This bar restores that signal without leaving immersive:
 *   - the agent's TODO plan on a single line — a "TODO" label and the plan as a
 *     horizontally-scrolling strip share one row with the streaming chip, so it
 *     reserves minimal review height, and
 *   - live streaming status (starting / streaming / awaiting a question).
 *
 * Design notes:
 *   - Subscriptions live in this leaf component (not in ImmersiveReviewView) so
 *     per-token streaming/todo churn doesn't re-render the large diff tree.
 *   - Flash-free: the streaming chip is gated on the *held* phase from
 *     useWorkspaceStreamingStatusPhase (150ms), so brief starting<->streaming
 *     handoffs don't blink. Because TODO plans persist across streams, the bar
 *     stays mounted between turns and only unmounts once both the held phase
 *     clears AND there are no todos left to show — no mid-review flicker.
 *   - Crash-safe: when the workspace isn't registered in the store yet (tests,
 *     storybook, teardown) the subscriptions fall back to empty/idle instead of
 *     throwing, so the bar simply renders nothing.
 */

import React, { useSyncExternalStore } from "react";
import { CircleHelp, List, Loader2 } from "lucide-react";
import { TodoList } from "@/browser/components/TodoList/TodoList";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import {
  getWorkspaceStreamingStatusPhase,
  useWorkspaceStreamingStatusPhase,
} from "@/browser/hooks/useWorkspaceStreamingStatusPhase";
import { cn } from "@/common/lib/utils";
import type { TodoItem } from "@/common/types/tools";

// Stable empty-plan reference for the unregistered case (tests, storybook,
// teardown). Module-level so the `todos` snapshot stays referentially stable
// and useSyncExternalStore's "getSnapshot should be cached" guard doesn't loop.
const EMPTY_TODOS: TodoItem[] = [];

interface ImmersiveReviewAgentStatusBarProps {
  workspaceId: string;
}

export const ImmersiveReviewAgentStatusBar: React.FC<ImmersiveReviewAgentStatusBarProps> = ({
  workspaceId,
}) => {
  // Subscribe to each field this bar uses as its OWN snapshot rather than
  // returning the whole WorkspaceState object. getWorkspaceState is version-
  // cached, so its reference changes on EVERY state bump (e.g. each streamed
  // message) — returning it wholesale would re-render the bar on every token.
  // Per-field selectors keep the bar stable: primitives compare by value, and
  // `todos` keeps a stable reference from the aggregator (same basis as
  // PinnedTodoList reading only `.todos`).
  const workspaceStore = useWorkspaceStoreRaw();
  const hasRegisteredWorkspace = () =>
    // Some unit tests mock only the store selectors they exercise; keep the
    // immersive status bar crash-safe in those partial-store environments too.
    typeof workspaceStore.hasRegisteredWorkspace === "function" &&
    workspaceStore.hasRegisteredWorkspace(workspaceId);
  const subscribe = (callback: () => void) =>
    hasRegisteredWorkspace() ? workspaceStore.subscribeKey(workspaceId, callback) : () => undefined;
  const todos = useSyncExternalStore(subscribe, () =>
    hasRegisteredWorkspace() ? workspaceStore.getWorkspaceState(workspaceId).todos : EMPTY_TODOS
  );
  const canInterrupt = useSyncExternalStore(subscribe, () =>
    hasRegisteredWorkspace() ? workspaceStore.getWorkspaceState(workspaceId).canInterrupt : false
  );
  // Sidebar derives `isStarting` directly from `isStreamStarting`.
  const isStarting = useSyncExternalStore(subscribe, () =>
    hasRegisteredWorkspace()
      ? workspaceStore.getWorkspaceState(workspaceId).isStreamStarting
      : false
  );
  const awaitingUserQuestion = useSyncExternalStore(subscribe, () =>
    hasRegisteredWorkspace()
      ? workspaceStore.getWorkspaceState(workspaceId).awaitingUserQuestion
      : false
  );

  // Held phase keeps the streaming chip steady across the starting->streaming
  // handoff so it doesn't blink out for a frame between adjacent state settles.
  const phase = getWorkspaceStreamingStatusPhase({ canInterrupt, isStarting });
  const phaseSource = canInterrupt ? "streaming" : isStarting ? "pre-stream" : null;
  const { displayPhase } = useWorkspaceStreamingStatusPhase(phase, phaseSource);

  const hasTodos = todos.length > 0;
  const isStreamingStatusVisible = displayPhase !== null || awaitingUserQuestion;

  // Nothing to surface: don't reserve any vertical space in the review viewport.
  if (!hasTodos && !isStreamingStatusVisible) {
    return null;
  }

  // role=status + aria-live so screen readers announce streaming/question
  // transitions while the user is focused on the diff.
  const statusChip = (() => {
    if (awaitingUserQuestion) {
      return (
        <span className="bg-plan-mode-alpha text-plan-mode-light flex items-center gap-1 rounded px-1.5 py-0.5 font-medium">
          <CircleHelp aria-hidden="true" className="h-3 w-3 shrink-0" />
          <span>Xum has a question</span>
        </span>
      );
    }
    if (displayPhase === "starting") {
      return (
        <span className="text-muted flex items-center gap-1">
          <Loader2 aria-hidden="true" className="h-3 w-3 shrink-0 animate-spin opacity-70" />
          <span>Starting…</span>
        </span>
      );
    }
    if (displayPhase === "streaming") {
      return (
        <span className="text-muted flex items-center gap-1">
          <Loader2 aria-hidden="true" className="h-3 w-3 shrink-0 animate-spin opacity-70" />
          <span>Streaming…</span>
        </span>
      );
    }
    return null;
  })();

  // `alignEnd` pushes the chip to the right with the TODO summary on its left;
  // without a plan there's nothing on the left, so the chip is left-aligned
  // instead of floating alone on the far right of an otherwise-empty bar.
  const renderStatusChip = (alignEnd: boolean) => (
    <div
      className={cn("flex shrink-0 items-center gap-2", alignEnd && "ml-auto")}
      role="status"
      aria-live="polite"
      data-testid="immersive-agent-status-chip"
    >
      {statusChip}
    </div>
  );

  return (
    <div
      className="border-border-light bg-dark border-b text-[11px]"
      data-testid="immersive-agent-status-bar"
      data-component="ImmersiveReviewAgentStatusBar"
    >
      {hasTodos ? (
        // Single-row layout: a static "TODO" label, the plan, and the streaming
        // chip all share one line so the bar reserves a single row of review
        // height. The plan renders as a horizontally-scrolling strip. min-h-7
        // (not a fixed h-7) lets the row grow to the strip's natural height so
        // the chips aren't vertically clipped.
        <div className="flex min-h-7 w-full items-center gap-2 px-3 leading-none">
          <div className="text-muted flex shrink-0 items-center gap-1.5">
            <List aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="font-medium">TODO</span>
          </div>
          {/* Horizontal strip fills the remaining width and scrolls sideways
              when the plan is longer than the bar; min-w-0 lets it shrink so
              the scroll container is bounded instead of pushing the chip off. */}
          <div className="min-w-0 flex-1">
            <TodoList todos={todos} layout="horizontal" />
          </div>
          {renderStatusChip(true)}
        </div>
      ) : (
        // Streaming/question only (no plan yet): static row, nothing to expand.
        // Chip is left-aligned here so it reads as a status label rather than
        // hugging the far right of an otherwise-empty bar.
        <div className="flex h-7 w-full items-center gap-2 px-3 leading-none">
          {renderStatusChip(false)}
        </div>
      )}
    </div>
  );
};

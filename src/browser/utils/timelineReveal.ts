import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import type { HistoryLoadResult, WorkspaceState } from "@/browser/stores/WorkspaceStore";

const DEFAULT_MAX_REVEAL_HISTORY_PAGES = 10;

export interface TimelineRevealStore {
  getWorkspaceState: (
    workspaceId: string
  ) => Pick<WorkspaceState, "messages" | "muxMessages" | "hasOlderHistory">;
  loadOlderHistory: (workspaceId: string) => Promise<HistoryLoadResult>;
}

export type TimelineRevealResult = "revealed" | "not-found" | "error" | "cancelled";

export interface TimelineRevealTarget {
  messageId?: string;
  toolCallId?: string;
}

function hasTimelineRevealTarget(target: TimelineRevealTarget): boolean {
  return target.messageId != null || target.toolCallId != null;
}

function isRevealTargetLoaded(
  workspaceState: Pick<WorkspaceState, "messages">,
  target: TimelineRevealTarget
): boolean {
  if (target.toolCallId) {
    return workspaceState.messages.some(
      (message) => message.type === "tool" && message.toolCallId === target.toolCallId
    );
  }

  return target.messageId
    ? workspaceState.messages.some(
        (message) => "historyId" in message && message.historyId === target.messageId
      )
    : false;
}

function dispatchTimelineReveal(workspaceId: string, target: TimelineRevealTarget): void {
  window.dispatchEvent(
    createCustomEvent(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, {
      workspaceId,
      ...target,
    })
  );
}

/** Loads, pins, and reveals a timeline target in the transcript. */
export async function revealTimelineTarget(options: {
  workspaceId: string;
  getTarget: () => TimelineRevealTarget;
  workspaceStore: TimelineRevealStore;
  pinTarget: (workspaceId: string, target: TimelineRevealTarget) => void;
  maxHistoryPages?: number;
  isCancelled?: () => boolean;
}): Promise<TimelineRevealResult> {
  const { workspaceId, getTarget, workspaceStore, pinTarget, isCancelled } = options;
  const maxHistoryPages = options.maxHistoryPages ?? DEFAULT_MAX_REVEAL_HISTORY_PAGES;
  const cancelled = () => isCancelled?.() === true;

  let target = getTarget();
  if (hasTimelineRevealTarget(target)) {
    if (cancelled()) {
      return "cancelled";
    }
    if (isRevealTargetLoaded(workspaceStore.getWorkspaceState(workspaceId), target)) {
      if (cancelled()) {
        return "cancelled";
      }
      dispatchTimelineReveal(workspaceId, target);
      return "revealed";
    }
    if (cancelled()) {
      return "cancelled";
    }
    pinTarget(workspaceId, target);
    if (cancelled()) {
      return "cancelled";
    }
    if (isRevealTargetLoaded(workspaceStore.getWorkspaceState(workspaceId), target)) {
      if (cancelled()) {
        return "cancelled";
      }
      dispatchTimelineReveal(workspaceId, target);
      return "revealed";
    }
  }

  for (let page = 0; page < maxHistoryPages; page++) {
    if (!workspaceStore.getWorkspaceState(workspaceId).hasOlderHistory) {
      break;
    }

    const loadResult = await workspaceStore.loadOlderHistory(workspaceId);
    if (cancelled()) {
      return "cancelled";
    }
    if (loadResult === "failed" || loadResult === "busy" || loadResult === "unavailable") {
      return "error";
    }

    target = getTarget();
    if (hasTimelineRevealTarget(target)) {
      if (cancelled()) {
        return "cancelled";
      }
      pinTarget(workspaceId, target);
      if (cancelled()) {
        return "cancelled";
      }
      if (isRevealTargetLoaded(workspaceStore.getWorkspaceState(workspaceId), target)) {
        if (cancelled()) {
          return "cancelled";
        }
        dispatchTimelineReveal(workspaceId, target);
        return "revealed";
      }
    }
    if (loadResult === "exhausted") {
      break;
    }
  }

  return "not-found";
}

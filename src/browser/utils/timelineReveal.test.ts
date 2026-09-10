import "../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { installDom } from "../../../tests/ui/dom";
import type { DisplayedMessage } from "@/common/types/message";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { revealTimelineTarget, type TimelineRevealStore } from "./timelineReveal";

const workspaceId = "timeline-reveal-test";

function createStore(
  options: {
    messages?: DisplayedMessage[];
    hasOlderHistory?: boolean;
    loadOlderHistory?: () => Promise<"loaded" | "exhausted" | "busy" | "unavailable" | "failed">;
  } = {}
): TimelineRevealStore & {
  state: { messages: DisplayedMessage[]; hasOlderHistory: boolean };
} {
  const state: { messages: DisplayedMessage[]; hasOlderHistory: boolean } = {
    messages: options.messages ?? [],
    hasOlderHistory: options.hasOlderHistory ?? false,
  };
  return {
    state,
    getWorkspaceState: () => ({
      messages: state.messages,
      muxMessages: [],
      hasOlderHistory: state.hasOlderHistory,
    }),
    loadOlderHistory: options.loadOlderHistory ?? (() => Promise.resolve("exhausted")),
  };
}

function makeUserMessage(historyId: string): DisplayedMessage {
  return {
    type: "user",
    id: historyId,
    historyId,
    content: "prompt",
    historySequence: 1,
  };
}

describe("revealTimelineTarget", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanupDom?.();
    cleanupDom = null;
  });

  it("dispatches immediately for a loaded target", async () => {
    const store = createStore({ messages: [makeUserMessage("prompt-1")] });
    const pinTarget = mock(() => undefined);
    const events: Event[] = [];
    const listener = (event: Event) => events.push(event);
    window.addEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, listener);

    try {
      const result = await revealTimelineTarget({
        workspaceId,
        getTarget: () => ({ messageId: "prompt-1" }),
        workspaceStore: store,
        pinTarget,
      });
      expect(result).toBe("revealed");
      expect(pinTarget).not.toHaveBeenCalled();
      expect(events).toHaveLength(1);
      expect((events[0] as CustomEvent).detail).toEqual({
        workspaceId,
        messageId: "prompt-1",
      });
    } finally {
      window.removeEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, listener);
    }
  });

  it("pins a target that becomes renderable without loading history", async () => {
    const store = createStore();
    const pinTarget = mock((_workspaceId: string, target: { messageId?: string }) => {
      store.state.messages = [makeUserMessage(target.messageId ?? "")];
    });
    const listener = mock(() => undefined);
    window.addEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, listener);

    try {
      const result = await revealTimelineTarget({
        workspaceId,
        getTarget: () => ({ messageId: "prompt-2" }),
        workspaceStore: store,
        pinTarget,
      });
      expect(result).toBe("revealed");
      expect(pinTarget).toHaveBeenCalledWith(workspaceId, { messageId: "prompt-2" });
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, listener);
    }
  });

  it("does not dispatch a target after cancellation during history loading", async () => {
    const store = createStore({ hasOlderHistory: true });
    let resolveLoad: ((result: "loaded") => void) | undefined;
    const loadOlderHistory = mock(
      () =>
        new Promise<"loaded">((resolve) => {
          resolveLoad = resolve;
        })
    );
    store.loadOlderHistory = loadOlderHistory;
    const pinTarget = mock(() => undefined);
    const listener = mock(() => undefined);
    let cancelled = false;
    window.addEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, listener);

    try {
      const revealPromise = revealTimelineTarget({
        workspaceId,
        getTarget: () => ({ messageId: "prompt-cancelled" }),
        workspaceStore: store,
        pinTarget,
        isCancelled: () => cancelled,
      });
      await Promise.resolve();
      cancelled = true;
      store.state.messages = [makeUserMessage("prompt-cancelled")];
      store.state.hasOlderHistory = false;
      resolveLoad?.("loaded");

      const result = await revealPromise;
      expect(result).toBe("cancelled");
      expect(listener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, listener);
    }
  });

  it("loads older history before dispatching a target that is not yet loaded", async () => {
    const store = createStore({ hasOlderHistory: true });
    const loadOlderHistory = mock(() => {
      store.state.messages = [makeUserMessage("prompt-3")];
      store.state.hasOlderHistory = false;
      return Promise.resolve("loaded" as const);
    });
    store.loadOlderHistory = loadOlderHistory;
    const listener = mock(() => undefined);
    window.addEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, listener);

    try {
      const result = await revealTimelineTarget({
        workspaceId,
        getTarget: () => ({ messageId: "prompt-3" }),
        workspaceStore: store,
        pinTarget: mock(() => undefined),
      });
      expect(result).toBe("revealed");
      expect(loadOlderHistory).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, listener);
    }
  });
});

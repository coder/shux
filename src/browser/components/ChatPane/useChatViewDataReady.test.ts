// Bootstrap the baseline DOM before this file's import graph evaluates: the hook's
// transitive UI imports include modules (e.g. Radix's use-layout-effect) that decide
// behavior at module-eval time based on `globalThis.document`. Without this, running
// this file first in a shared bun test process poisons those cached modules for every
// later UI test file (see tests/ui/dom.ts bootstrap comment).
import "../../../../tests/ui/dom";

import { describe, expect, test } from "bun:test";
import { computeChatViewReveal } from "./useChatViewDataReady";

// These cover the reveal *decision* (the branching that makes the chat view
// mount transcript + decorations in one commit); the per-source known-flags
// are covered in their store tests, and the pixel behavior in tests/e2e.
describe("computeChatViewReveal", () => {
  test("first visit holds the skeleton until BOTH history and decoration data are ready", () => {
    // History still replaying, decorations unknown: skeleton, no decorations.
    expect(
      computeChatViewReveal({
        isHydratingTranscript: true,
        chatViewDataReady: false,
        hasRenderableMessages: false,
        shouldShowStreamingBarrier: false,
      })
    ).toEqual({ showHydrationPlaceholder: true, revealDecorations: false });

    // Decoration data ready first (the common ordering — sources are one IPC
    // round trip, replay is longer): skeleton must STILL hold so the reveal
    // stays atomic.
    expect(
      computeChatViewReveal({
        isHydratingTranscript: true,
        chatViewDataReady: true,
        hasRenderableMessages: false,
        shouldShowStreamingBarrier: false,
      })
    ).toEqual({ showHydrationPlaceholder: true, revealDecorations: false });

    // Both ready: one commit reveals transcript and decorations together.
    expect(
      computeChatViewReveal({
        isHydratingTranscript: false,
        chatViewDataReady: true,
        hasRenderableMessages: true,
        shouldShowStreamingBarrier: false,
      })
    ).toEqual({ showHydrationPlaceholder: false, revealDecorations: true });
  });

  test("empty workspaces also wait for decoration data before revealing", () => {
    // Not hydrating (no history) but sources unknown: the skeleton holds so
    // the empty-placeholder + decorations appear together.
    expect(
      computeChatViewReveal({
        isHydratingTranscript: false,
        chatViewDataReady: false,
        hasRenderableMessages: false,
        shouldShowStreamingBarrier: false,
      })
    ).toEqual({ showHydrationPlaceholder: true, revealDecorations: false });
  });

  test("revisits with cached rows never regress to a skeleton", () => {
    // Cached rows paint immediately during incremental catch-up; latched
    // known-flags make decorations renderable in that same commit.
    expect(
      computeChatViewReveal({
        isHydratingTranscript: true,
        chatViewDataReady: true,
        hasRenderableMessages: true,
        shouldShowStreamingBarrier: false,
      })
    ).toEqual({ showHydrationPlaceholder: false, revealDecorations: true });
  });

  test("an active stream barrier trumps the skeleton; decorations still wait for data", () => {
    const state = computeChatViewReveal({
      isHydratingTranscript: true,
      chatViewDataReady: false,
      hasRenderableMessages: false,
      shouldShowStreamingBarrier: true,
    });
    expect(state.showHydrationPlaceholder).toBe(false);
    // Decorations may mount late here (reconnect-with-active-stream) — but
    // they must never render while their data is merely unknown.
    expect(state.revealDecorations).toBe(false);
  });
});

// Bootstrap the baseline DOM before this file's import graph evaluates: the hook's
// transitive UI imports include modules (e.g. Radix's use-layout-effect) that decide
// behavior at module-eval time based on `globalThis.document`. Without this, running
// this file first in a shared bun test process poisons those cached modules for every
// later UI test file (see tests/ui/dom.ts bootstrap comment).
import { installDom } from "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import * as APIModule from "@/browser/contexts/API";
import * as BackgroundBashStore from "@/browser/stores/BackgroundBashStore";
import * as ProvidersConfigStore from "@/browser/stores/ProvidersConfigStore";
import * as WorkspaceStore from "@/browser/stores/WorkspaceStore";
import * as InstructionsStore from "@/browser/utils/additionalSystemContextStore";
import { computeChatViewReveal, useChatViewDataReady } from "./useChatViewDataReady";

describe("useChatViewDataReady", () => {
  let cleanupDom: () => void;
  let known: Record<"backgroundBash" | "providers" | "usage" | "instructions", boolean>;

  beforeEach(() => {
    cleanupDom = installDom();
    known = { backgroundBash: true, providers: true, usage: true, instructions: true };
    spyOn(APIModule, "useAPI").mockReturnValue({
      status: "connecting",
      api: null,
      error: null,
      authenticate: mock(),
      retry: mock(),
    });
    spyOn(BackgroundBashStore, "useBackgroundBashStateKnown").mockImplementation(
      () => known.backgroundBash
    );
    spyOn(ProvidersConfigStore, "useProvidersConfigLoaded").mockImplementation(
      () => known.providers
    );
    spyOn(WorkspaceStore, "useSessionUsageKnown").mockImplementation(() => known.usage);
    spyOn(InstructionsStore, "useAdditionalSystemContextHydrated").mockImplementation(
      () => known.instructions
    );
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom();
  });

  test("reveals an empty chat immediately without initializing cross-workspace activity", () => {
    // No WorkspaceStore singleton or activity subscription exists. Only layout-affecting
    // decoration sources are ready; unrelated activity must not require the timeout fallback.
    const { result } = renderHook(() => useChatViewDataReady("workspace"));
    expect(result.current).toBe(true);
    expect(
      computeChatViewReveal({
        isHydratingTranscript: false,
        chatViewDataReady: result.current,
        hasRenderableMessages: false,
        shouldShowStreamingBarrier: false,
      })
    ).toEqual({ showHydrationPlaceholder: false, revealDecorations: true });
  });

  test.each(["backgroundBash", "providers", "usage", "instructions"] as const)(
    "still waits for the %s decoration source",
    (source) => {
      known[source] = false;
      const { result, rerender } = renderHook(() => useChatViewDataReady("workspace"));
      expect(result.current).toBe(false);
      known[source] = true;
      rerender();
      expect(result.current).toBe(true);
    }
  );
});

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

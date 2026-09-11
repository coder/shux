import { useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { useBackgroundBashStateKnown } from "@/browser/stores/BackgroundBashStore";
import { useSessionUsageKnown } from "@/browser/stores/WorkspaceStore";
import { useProvidersConfigLoaded } from "@/browser/stores/ProvidersConfigStore";
import {
  ensureAdditionalSystemContextHydrated,
  useAdditionalSystemContextHydrated,
} from "@/browser/utils/additionalSystemContextStore";

/**
 * Chat-view first-paint readiness barrier.
 *
 * CONTRACT — "unknown is not empty": the chat view must reveal once, fully
 * formed. Any async data source that can change the chat view's INITIAL
 * layout (composer-dock decorations, dock-internal banners) must:
 *
 *   1. distinguish "not yet loaded" from "known empty" (a store default that
 *      renders as "decoration absent" hides the difference and guarantees a
 *      pop-in when the real data lands after first paint), and
 *   2. register its known-signal in this hook.
 *
 * ChatPane holds the transcript-hydration skeleton and suppresses the
 * decoration lane until every source is known (see computeChatViewReveal), so
 * the transcript and all decorations mount in one commit — layout can never
 * shift because a decoration "loaded in" a few frames after the user started
 * reading. Sources resolve in parallel with (and almost always faster than)
 * the chat history replay, so the barrier adds no perceptible latency.
 *
 * Sources that DON'T need registration:
 *   - synchronous reads (localStorage reviews, workspace metadata);
 *   - chat-history-derived state (todos, queued message) — it flips in the
 *     same caught-up commit that reveals the transcript;
 *   - event-driven UI that is deterministically absent at first paint
 *     (context-switch warnings, edit indicators).
 */
export function useChatViewDataReady(workspaceId: string): boolean {
  const { api } = useAPI();

  // Each hook below is a `useSyncExternalStore` over a latched per-session
  // "state known" flag: flags only flip false -> true, so readiness is
  // monotonic for a mounted workspace and decorations are never unmounted by
  // this barrier after reveal. Subscribing also starts/keeps the underlying
  // backend subscription where applicable (background bashes).
  const backgroundBashKnown = useBackgroundBashStateKnown(workspaceId);
  const providersConfigLoaded = useProvidersConfigLoaded();
  const sessionUsageKnown = useSessionUsageKnown(workspaceId);
  const instructionsHydrated = useAdditionalSystemContextHydrated(workspaceId);

  // The scratchpad store is pull-based (historically only the Instructions
  // tab hydrated it); trigger its once-per-workspace fetch here so the chat
  // instructions decoration state is known before reveal.
  useEffect(() => {
    if (api) {
      ensureAdditionalSystemContextHydrated(api, workspaceId);
    }
  }, [api, workspaceId]);

  // Shared-checkout warnings are intentionally gone; cross-workspace activity no longer
  // affects the composer layout and must not delay first paint when its subscription stalls.
  const allKnown =
    backgroundBashKnown && providersConfigLoaded && sessionUsageKnown && instructionsHydrated;

  // Resilience deadline: every source self-heals on *error*, but a hung
  // backend (no response, no rejection) has no deterministic failure signal —
  // so force-reveal after a bound rather than holding the skeleton forever.
  // Per AGENTS.md, startup-style initialization must never block the app:
  // time out and fall back silently (decorations then mount late, which is
  // exactly the pre-barrier degraded behavior).
  const [forcedReadyWorkspaceId, setForcedReadyWorkspaceId] = useState<string | null>(null);
  useEffect(() => {
    if (allKnown) {
      return;
    }
    const timer = setTimeout(() => {
      setForcedReadyWorkspaceId(workspaceId);
    }, CHAT_VIEW_DATA_READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [allKnown, workspaceId]);

  return allKnown || forcedReadyWorkspaceId === workspaceId;
}

// Generous relative to the expected cost (each source is roughly one local
// IPC round trip resolved in parallel), tight enough that a wedged source
// degrades to "decorations pop in late" instead of "chat looks broken".
const CHAT_VIEW_DATA_READY_TIMEOUT_MS = 2_000;

export interface ChatViewRevealInputs {
  /** Transcript history replay still in flight for the active workspace. */
  isHydratingTranscript: boolean;
  /** All registered decoration data sources are known (useChatViewDataReady). */
  chatViewDataReady: boolean;
  /** Cached/replayed rows already renderable (revisits skip the skeleton). */
  hasRenderableMessages: boolean;
  /** Active stream start/interrupt barrier is visible (trumps the skeleton). */
  shouldShowStreamingBarrier: boolean;
}

export interface ChatViewRevealState {
  /** Hold the full-transcript hydration skeleton (nothing painted yet). */
  showHydrationPlaceholder: boolean;
  /** Mount layout-affecting composer decorations. */
  revealDecorations: boolean;
}

/**
 * Single reveal decision for the chat view, shared by the transcript skeleton
 * and the composer decoration lane so both flip in the same commit:
 *
 * - First visit: skeleton holds until history is caught up AND decoration
 *   data is known, then everything mounts together.
 * - Revisit: cached rows paint immediately (no skeleton) and the latched
 *   known-flags make decorations renderable in that same first commit.
 * - Active stream states keep their barrier visible instead of a skeleton
 *   (reconnect-with-active-stream); decorations then mount when known —
 *   the rare case where data genuinely arrives after paint.
 */
export function computeChatViewReveal(inputs: ChatViewRevealInputs): ChatViewRevealState {
  const showHydrationPlaceholder =
    (inputs.isHydratingTranscript || !inputs.chatViewDataReady) &&
    !inputs.hasRenderableMessages &&
    !inputs.shouldShowStreamingBarrier;

  return {
    showHydrationPlaceholder,
    revealDecorations: inputs.chatViewDataReady && !showHydrationPlaceholder,
  };
}

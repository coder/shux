import React from "react";
import { StreamingBarrierView } from "./StreamingBarrierView";
import { getModelName } from "@/common/utils/ai/models";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { AGENT_AI_DEFAULTS_KEY, VIM_ENABLED_KEY, getModelKey } from "@/common/constants/storage";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import {
  useWorkspaceState,
  useWorkspaceAggregator,
  useWorkspaceStoreRaw,
  useWorkspaceStreamingStats,
} from "@/browser/stores/WorkspaceStore";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { useAPI } from "@/browser/contexts/API";
import { stopStream } from "@/browser/utils/stopStream";

type StreamingPhase =
  | "starting" // Message sent, waiting for stream-start
  | "interrupting" // User triggered interrupt, waiting for stream-abort
  | "streaming" // Normal streaming
  | "compacting" // Compaction in progress
  | "awaiting-input" // ask_user_question waiting for response
  | "waiting-on-monitor"; // Turn ended; armed background bash monitor will wake the agent

interface StreamingBarrierProps {
  workspaceId: string;
  className?: string;
  /**
   * Optional vim state from parent subscription.
   * Falls back to persisted value when omitted.
   */
  vimEnabled?: boolean;
  /**
   * Optional compaction-specific cancel hook.
   * When provided, this path should preserve compaction edit state + follow-up content.
   */
  onCancelCompaction?: () => void;
}

// Debounce delay for transient startup/streaming/compacting label churn.
// Only text that survives this long gets promoted to the display.
const STATUS_DISPLAY_DELAY_MS = 1000;

// Phases whose status text is debounced (transient startup breadcrumbs, etc).
// "interrupting" and "awaiting-input" are high-signal control-flow states that
// should reflect immediately so cancel/input handoff feels responsive.
const DEBOUNCED_PHASES: ReadonlySet<StreamingPhase> = new Set([
  "starting",
  "streaming",
  "compacting",
]);

/**
 * Trailing-edge debounce for streaming status text.
 *
 * - Debounced phases (starting/streaming/compacting): text changes restart a
 *   timer; only the value that survives STATUS_DISPLAY_DELAY_MS is shown.
 *   The first appearance and workspace switches show text immediately.
 * - Non-debounced phases (interrupting/awaiting-input): always immediate.
 * - Disappearance: always immediate so the barrier hides promptly.
 */
function useStabilizedStreamingStatusText(
  workspaceId: string,
  phase: StreamingPhase | null,
  rawStatusText: string | null
): string | null {
  // Seed with the raw text so the very first render has content when a stream
  // phase is already active — avoids a single null-frame that would drop the
  // barrier/stop control before the effect fires.
  const [debouncedText, setDebouncedText] = React.useState<string | null>(rawStatusText);
  const pendingTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevWorkspaceRef = React.useRef(workspaceId);
  const prevPhaseRef = React.useRef(phase);
  const latestRawRef = React.useRef(rawStatusText);
  latestRawRef.current = rawStatusText;

  // Detect context changes at render time so the returned value is correct
  // on the same render frame — no post-paint flash of stale text.
  // Refs are updated in a post-commit effect (not render) to stay stable
  // across React StrictMode double-renders and concurrent replays.
  const isWorkspaceSwitch = prevWorkspaceRef.current !== workspaceId;
  const isPhaseChange = prevPhaseRef.current !== phase;
  // Only debounce within-phase text churn; cross-phase transitions should
  // show the new label immediately.
  const shouldDebounce =
    phase != null && DEBOUNCED_PHASES.has(phase) && !isWorkspaceSwitch && !isPhaseChange;

  // Commit refs after render so detection is stable across double-renders.
  React.useEffect(() => {
    prevWorkspaceRef.current = workspaceId;
    prevPhaseRef.current = phase;
  });

  React.useEffect(() => {
    if (pendingTimerRef.current) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }

    // Disappearance is always immediate.
    if (phase == null || rawStatusText == null) {
      setDebouncedText(null);
      return;
    }

    // Immediate sync: workspace switches, phase transitions, non-debounced
    // phases, or first appearance (prev null).
    if (!shouldDebounce) {
      setDebouncedText(rawStatusText);
      return;
    }

    // Within-phase text churn: keep the previous label and start the timer.
    // Only text that survives the full delay is promoted to the display,
    // so rapid status label cycling (breadcrumbs) is coalesced.
    pendingTimerRef.current = setTimeout(() => {
      pendingTimerRef.current = null;
      setDebouncedText(latestRawRef.current);
    }, STATUS_DISPLAY_DELAY_MS);

    return () => {
      if (pendingTimerRef.current) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
    };
  }, [workspaceId, phase, rawStatusText, shouldDebounce]);

  // Bypass debouncedText for transitions that should be reflected immediately.
  if (phase == null || rawStatusText == null) return null;
  if (!shouldDebounce) return rawStatusText;

  return debouncedText;
}

/**
 * Self-contained streaming status barrier.
 * Computes streaming state internally from workspaceId.
 * Returns null when there's nothing to show.
 */
export const StreamingBarrier: React.FC<StreamingBarrierProps> = ({
  workspaceId,
  className,
  vimEnabled: vimEnabledFromParent,
  onCancelCompaction,
}) => {
  const workspaceState = useWorkspaceState(workspaceId);
  const aggregator = useWorkspaceAggregator(workspaceId);
  const storeRaw = useWorkspaceStoreRaw();
  // Subscribe directly to live streaming stats (token count + TPS) so per-delta
  // updates re-render this leaf only, not the entire ChatPane subtree.
  const streamingStats = useWorkspaceStreamingStats(workspaceId);
  const { api } = useAPI();
  const { open: openSettings } = useSettings();

  const {
    canInterrupt,
    isCompacting,
    isStreamStarting: isStarting,
    awaitingUserQuestion,
    currentModel,
    pendingStreamModel,
    runtimeStatus,
    activeBashMonitorCount,
  } = workspaceState;

  // Compute streaming phase
  const phase: StreamingPhase | null = (() => {
    if (isStarting) return "starting";
    // No active stream: normally hide the barrier, but if an armed background
    // bash monitor is still watching output, the agent will be woken on match.
    // Surface that so the idle chat doesn't read as "done" or stalled.
    if (!canInterrupt) return activeBashMonitorCount > 0 ? "waiting-on-monitor" : null;
    if (aggregator?.hasInterruptingStream()) return "interrupting";
    if (awaitingUserQuestion) return "awaiting-input";
    if (isCompacting) return "compacting";
    return "streaming";
  })();

  // Only show token count during active streaming/compacting
  const showTokenCount = phase === "streaming" || phase === "compacting";

  // Live streaming stats come from a leaf subscription so per-delta updates
  // don't cascade through the full chat subtree.
  const tokenCount = showTokenCount ? streamingStats?.tokenCount : undefined;
  const tps = showTokenCount ? streamingStats?.tps : undefined;

  // Model to display:
  // - "starting" phase: prefer pendingStreamModel (from muxMetadata), then localStorage
  // - Otherwise: use currentModel from active stream
  const model =
    phase === "starting"
      ? (pendingStreamModel ??
        readPersistedState<string | null>(getModelKey(workspaceId), null) ??
        getDefaultModel())
      : currentModel;
  const modelName = model ? getModelName(model) : null;

  // Prefer parent vim state (subscribed in ChatPane) so the hint updates immediately.
  const vimEnabled = vimEnabledFromParent ?? readPersistedState(VIM_ENABLED_KEY, false);
  const interruptKeybind = formatKeybind(
    vimEnabled ? KEYBINDS.INTERRUPT_STREAM_VIM : KEYBINDS.INTERRUPT_STREAM_NORMAL
  ).replace("Escape", "Esc");
  const interruptHint = `hit ${interruptKeybind} to cancel`;

  // Compute status text based on phase
  const rawStatusText = (() => {
    if (!phase) {
      return null;
    }

    switch (phase) {
      case "starting":
        // Prefer any backend-provided startup breadcrumb so users can see whether
        // we're still booting the runtime or doing later prep like loading tools.
        if (runtimeStatus?.phase === "starting" || runtimeStatus?.phase === "waiting") {
          return runtimeStatus.detail ?? "Starting workspace...";
        }
        return modelName ? `${modelName} starting...` : "starting...";
      case "interrupting":
        return "interrupting...";
      case "awaiting-input":
        return "Awaiting your input...";
      case "compacting":
        return modelName ? `${modelName} compacting...` : "compacting...";
      case "streaming":
        return modelName ? `${modelName} streaming...` : "streaming...";
      case "waiting-on-monitor":
        return activeBashMonitorCount === 1
          ? "Waiting on background bash monitor..."
          : `Waiting on ${activeBashMonitorCount} background bash monitors...`;
    }
  })();
  const statusText = useStabilizedStreamingStatusText(workspaceId, phase, rawStatusText);

  if (!phase || statusText == null) {
    return null;
  }

  // Compute cancel hint based on phase
  const cancelText = (() => {
    switch (phase) {
      case "interrupting":
        return "";
      case "awaiting-input":
        return "type a message to respond";
      case "waiting-on-monitor":
        return "agent wakes on matching output";
      case "starting":
      case "compacting":
      case "streaming":
        return interruptHint;
    }
  })();

  const canTapCancel = phase === "starting" || phase === "streaming" || phase === "compacting";
  const handleCancelClick = () => {
    if (!api) {
      return;
    }

    if (phase !== "starting" && phase !== "streaming" && phase !== "compacting") {
      return;
    }

    void api.workspace.setAutoRetryEnabled?.({ workspaceId, enabled: false });

    if (phase === "compacting") {
      // Reuse the established compaction-cancel flow from keyboard shortcuts so we keep
      // edit restoration + follow-up content behavior consistent across input methods.
      if (onCancelCompaction) {
        onCancelCompaction();
        return;
      }

      void stopStream(api, workspaceId, { abandonPartial: true });
      return;
    }

    if (phase === "streaming") {
      storeRaw.setInterrupting(workspaceId);
    }

    void stopStream(api, workspaceId);
  };

  // Show settings hint during compaction if no custom compaction model is configured
  const showCompactionHint =
    phase === "compacting" &&
    !readPersistedState<AgentAiDefaults>(AGENT_AI_DEFAULTS_KEY, {}).compact?.modelString;

  return (
    <StreamingBarrierView
      statusText={statusText}
      tokenCount={tokenCount}
      tps={tps}
      cancelText={cancelText}
      onCancel={canTapCancel ? handleCancelClick : undefined}
      cancelShortcutText={canTapCancel ? interruptKeybind : undefined}
      // Waiting-on-monitor is not streaming-bound: drop the reserved stats slot
      // and let the informational hint hide in narrow panes so the barrier fits
      // phone-width transcripts (the label alone carries the state).
      reserveStatsSlot={phase !== "waiting-on-monitor"}
      hideHintOnNarrow={phase === "waiting-on-monitor"}
      className={className}
      hintElement={
        showCompactionHint ? (
          <button
            onClick={() => openSettings("tasks")}
            className="text-muted hover:text-foreground text-[10px] underline decoration-dotted underline-offset-2"
          >
            configure
          </button>
        ) : undefined
      }
    />
  );
};

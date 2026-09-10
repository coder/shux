import React from "react";

import type { StreamingMessageAggregator } from "xum/browser/utils/messages/StreamingMessageAggregator";
import { StreamingBarrierView } from "xum/browser/features/Messages/ChatBarrier/StreamingBarrierView";
import { getModelName } from "xum/common/utils/ai/models";
import { formatKeybind, KEYBINDS } from "xum/browser/utils/ui/keybinds";
import { VIM_ENABLED_KEY, getModelKey } from "xum/common/constants/storage";
import { readPersistedState } from "xum/browser/hooks/usePersistedState";
import { getDefaultModel } from "xum/browser/hooks/useModelsFromSettings";

type StreamingPhase =
  | "starting" // Message sent, waiting for stream-start
  | "interrupting" // User triggered interrupt, waiting for stream-abort
  | "streaming" // Normal streaming
  | "compacting" // Compaction in progress
  | "awaiting-input"; // ask_user_question waiting for response

export interface VscodeStreamingBarrierProps {
  workspaceId: string;
  aggregator: StreamingMessageAggregator | null;
  className?: string;
}

export const VscodeStreamingBarrier: React.FC<VscodeStreamingBarrierProps> = (props) => {
  const aggregator = props.aggregator;
  if (!aggregator) {
    return null;
  }

  const canInterrupt = Boolean(aggregator.getActiveStreamMessageId());
  const isCompacting = aggregator.isCompacting();
  const awaitingUserQuestion = aggregator.hasAwaitingUserQuestion();
  const currentModel = aggregator.getCurrentModel() ?? null;
  const pendingStreamStartTime = aggregator.getPendingStreamStartTime();
  const pendingCompactionModel = aggregator.getPendingCompactionModel();

  // Determine if we're in "starting" phase (message sent, waiting for stream-start)
  const isStarting = pendingStreamStartTime !== null && !canInterrupt;

  // Compute streaming phase
  const phase: StreamingPhase | null = (() => {
    if (isStarting) return "starting";
    if (!canInterrupt) return null;
    if (aggregator.hasInterruptingStream()) return "interrupting";
    if (awaitingUserQuestion) return "awaiting-input";
    if (isCompacting) return "compacting";
    return "streaming";
  })();

  // Only show token count during active streaming/compacting
  const showTokenCount = phase === "streaming" || phase === "compacting";

  const timingStats = showTokenCount ? aggregator.getActiveStreamTimingStats() : null;
  const tokenCount = showTokenCount ? timingStats?.liveTokenCount : undefined;
  const tps = showTokenCount ? timingStats?.liveTPS : undefined;

  if (!phase) {
    return null;
  }

  // Model to display:
  // - "starting" phase with pending compaction: use the compaction model from the request
  // - "starting" phase without compaction: read chat model from localStorage
  // - Otherwise: use currentModel from active stream
  const model =
    phase === "starting"
      ? (pendingCompactionModel ??
        readPersistedState<string | null>(getModelKey(props.workspaceId), null) ??
        getDefaultModel())
      : currentModel;
  const modelName = model ? getModelName(model) : null;

  // Vim mode affects cancel keybind hint (read once per render, no subscription needed)
  const vimEnabled = readPersistedState(VIM_ENABLED_KEY, false);

  // Compute status text based on phase
  const statusText = (() => {
    switch (phase) {
      case "starting":
        return modelName ? `${modelName} starting...` : "starting...";
      case "interrupting":
        return "interrupting...";
      case "awaiting-input":
        return "Awaiting your input...";
      case "compacting":
        return modelName ? `${modelName} compacting...` : "compacting...";
      case "streaming":
        return modelName ? `${modelName} streaming...` : "streaming...";
    }
  })();

  // Compute cancel hint based on phase
  const cancelText = (() => {
    switch (phase) {
      case "starting":
      case "interrupting":
        return "";
      case "awaiting-input":
        return "type a message to respond";
      case "compacting":
      case "streaming":
        return `hit ${formatKeybind(vimEnabled ? KEYBINDS.INTERRUPT_STREAM_VIM : KEYBINDS.INTERRUPT_STREAM_NORMAL)} to cancel`;
    }
  })();

  return (
    <StreamingBarrierView
      statusText={statusText}
      tokenCount={tokenCount}
      tps={tps}
      cancelText={cancelText}
      className={props.className}
    />
  );
};

import type { WorkspaceChatMessage } from "@/common/orpc/types";

type ReplayBufferedDeltaMessage = Extract<
  WorkspaceChatMessage,
  { type: "stream-delta" | "reasoning-delta" }
>;

function isReplayBufferedDeltaMessage(
  message: WorkspaceChatMessage
): message is ReplayBufferedDeltaMessage {
  return message.type === "stream-delta" || message.type === "reasoning-delta";
}

type ReplayBufferedInitMessage = Extract<
  WorkspaceChatMessage,
  { type: "init-start" | "init-output" | "init-end" }
>;

function isReplayBufferedInitMessage(
  message: WorkspaceChatMessage
): message is ReplayBufferedInitMessage {
  return (
    message.type === "init-start" || message.type === "init-output" || message.type === "init-end"
  );
}

function isReplayMessage(message: WorkspaceChatMessage): boolean {
  return (message as { replay?: unknown }).replay === true;
}

function replayBufferedDeltaKey(message: ReplayBufferedDeltaMessage): string {
  return JSON.stringify([message.type, message.messageId, message.timestamp, message.delta]);
}

function replayBufferedInitKey(message: ReplayBufferedInitMessage): string {
  switch (message.type) {
    case "init-start":
      return JSON.stringify([message.type, message.hookPath, message.timestamp]);
    case "init-output":
      return JSON.stringify([
        message.type,
        message.lineNumber ?? null,
        message.line,
        message.isError === true,
        message.timestamp,
      ]);
    case "init-end":
      return JSON.stringify([
        message.type,
        message.exitCode,
        message.truncatedLines ?? null,
        message.timestamp,
      ]);
  }
}

export function createReplayBufferedStreamMessageRelay(
  push: (message: WorkspaceChatMessage) => void
): {
  handleSessionMessage: (message: WorkspaceChatMessage) => void;
  handleReplayMessage: (message: WorkspaceChatMessage) => void;
  finishReplay: () => void;
} {
  let isReplaying = true;
  const bufferedLiveSessionMessages: WorkspaceChatMessage[] = [];

  // Counters (not Sets) so we don't drop more buffered events than were replayed.
  const replayedDeltaKeyCounts = new Map<string, number>();
  const replayedInitKeyCounts = new Map<string, number>();

  const noteReplayedDelta = (message: ReplayBufferedDeltaMessage) => {
    const key = replayBufferedDeltaKey(message);
    replayedDeltaKeyCounts.set(key, (replayedDeltaKeyCounts.get(key) ?? 0) + 1);
  };

  const noteReplayedInit = (message: ReplayBufferedInitMessage) => {
    const key = replayBufferedInitKey(message);
    replayedInitKeyCounts.set(key, (replayedInitKeyCounts.get(key) ?? 0) + 1);
  };

  const shouldDropBufferedDelta = (message: ReplayBufferedDeltaMessage): boolean => {
    const key = replayBufferedDeltaKey(message);
    const remaining = replayedDeltaKeyCounts.get(key) ?? 0;
    if (remaining <= 0) {
      return false;
    }
    if (remaining === 1) {
      replayedDeltaKeyCounts.delete(key);
    } else {
      replayedDeltaKeyCounts.set(key, remaining - 1);
    }
    return true;
  };

  const shouldDropBufferedInit = (message: ReplayBufferedInitMessage): boolean => {
    const key = replayBufferedInitKey(message);
    const remaining = replayedInitKeyCounts.get(key) ?? 0;
    if (remaining <= 0) {
      return false;
    }
    if (remaining === 1) {
      replayedInitKeyCounts.delete(key);
    } else {
      replayedInitKeyCounts.set(key, remaining - 1);
    }
    return true;
  };

  const flushBuffered = (count = bufferedLiveSessionMessages.length) => {
    for (const message of bufferedLiveSessionMessages.splice(0, count)) {
      if (isReplayBufferedDeltaMessage(message) && shouldDropBufferedDelta(message)) continue;
      if (isReplayBufferedInitMessage(message) && shouldDropBufferedInit(message)) continue;
      push(message);
    }
  };

  const handleReplayMessage = (message: WorkspaceChatMessage) => {
    if (isReplaying) {
      if (message.type === "stream-start") {
        const startIndex = bufferedLiveSessionMessages.findIndex(
          (event) => event.type === "stream-start" && event.messageId === message.messageId
        );
        // Deliver the predecessor terminal and successor's normal start before its replay
        // snapshot. A normal start delivered later would erase the replayed successor content.
        if (startIndex >= 0) flushBuffered(startIndex + 1);
      }
      if (isReplayBufferedDeltaMessage(message)) noteReplayedDelta(message);
      else if (isReplayBufferedInitMessage(message)) noteReplayedInit(message);
    }
    push(message);
  };

  const handleSessionMessage = (message: WorkspaceChatMessage) => {
    if (isReplayMessage(message)) {
      handleReplayMessage(message);
    } else if (isReplaying) {
      // Buffer the whole live event family so terminals cannot overtake starts or tools.
      bufferedLiveSessionMessages.push(message);
    } else {
      push(message);
    }
  };

  const finishReplay = () => {
    flushBuffered();
    isReplaying = false;

    // Avoid retaining replay keys for the lifetime of the subscription.
    replayedDeltaKeyCounts.clear();
    replayedInitKeyCounts.clear();
    bufferedLiveSessionMessages.length = 0;
  };

  return { handleSessionMessage, handleReplayMessage, finishReplay };
}

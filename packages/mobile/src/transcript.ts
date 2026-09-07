import type { WorkspaceChatMessage } from "../../../src/common/orpc/types";
import type { MuxMessage, MuxToolPart } from "../../../src/common/types/message";

export type { MuxMessage, WorkspaceChatMessage };
export interface TranscriptState {
  messages: MuxMessage[];
  streaming: boolean;
  streamingMessageId: string | null;
  error: string | null;
  caughtUp: boolean;
  hasOlderHistory: boolean;
}

/** Reset before EVERY onChat({mode: {type: "full"}}), including reconnects. */
export function createTranscriptState(): TranscriptState {
  return {
    messages: [],
    streaming: false,
    streamingMessageId: null,
    error: null,
    caughtUp: false,
    hasOlderHistory: false,
  };
}

function upsert(messages: MuxMessage[], message: MuxMessage): MuxMessage[] {
  const index = messages.findIndex((item) => item.id === message.id);
  const next = [...messages];
  if (index < 0) next.push(message);
  else next[index] = message;
  // IDs identify rows; only the server's sequence determines their ordering.
  return next.sort(
    (a, b) =>
      (a.metadata?.historySequence ?? Number.MAX_SAFE_INTEGER) -
      (b.metadata?.historySequence ?? Number.MAX_SAFE_INTEGER)
  );
}

function updateMessage(
  state: TranscriptState,
  id: string,
  update: (message: MuxMessage) => MuxMessage
): TranscriptState {
  return {
    ...state,
    messages: state.messages.map((message) => (message.id === id ? update(message) : message)),
  };
}

function finish(state: TranscriptState, id: string): TranscriptState {
  return state.streamingMessageId === null || state.streamingMessageId === id
    ? { ...state, streaming: false, streamingMessageId: null }
    : state;
}

type ToolEvent = Extract<WorkspaceChatMessage, { type: "tool-call-start" | "tool-call-end" }>;

function applyTool(message: MuxMessage, event: ToolEvent): MuxMessage {
  const update = (part?: MuxToolPart): MuxToolPart => {
    if (event.type === "tool-call-start") {
      return {
        type: "dynamic-tool",
        state: "input-available",
        ...part,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.args,
        timestamp: event.timestamp,
        executionStartedAt: event.executionStartedAt ?? part?.executionStartedAt,
      };
    }
    return {
      type: "dynamic-tool",
      input: undefined,
      timestamp: event.timestamp,
      ...part,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      state: "output-available",
      output: event.result,
    };
  };
  const parts = [...message.parts];
  const index = parts.findIndex(
    (part) =>
      part.type === "dynamic-tool" &&
      part.toolCallId === (event.parentToolCallId ?? event.toolCallId)
  );
  const part = parts[index];
  if (event.parentToolCallId) {
    // Nested PTC calls belong inside their parent, not as duplicate top-level rows.
    if (part?.type !== "dynamic-tool") return message;
    const nestedCalls = [...(part.nestedCalls ?? [])];
    const nestedIndex = nestedCalls.findIndex((call) => call.toolCallId === event.toolCallId);
    const previous = nestedCalls[nestedIndex];
    const nested = {
      ...previous,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.type === "tool-call-start" ? event.args : previous?.input,
      timestamp: previous?.timestamp ?? event.timestamp,
      state:
        event.type === "tool-call-end"
          ? ("output-available" as const)
          : (previous?.state ?? "input-available"),
      ...(event.type === "tool-call-end" ? { output: event.result } : {}),
    };
    if (nestedIndex < 0) nestedCalls.push(nested);
    else nestedCalls[nestedIndex] = nested;
    parts[index] = { ...part, nestedCalls };
  } else if (part?.type === "dynamic-tool") {
    parts[index] = update(part);
  } else {
    parts.push(update());
  }
  return { ...message, parts };
}

/** Pure, ordered wire-event reducer. UI-only telemetry is deliberately ignored. */
export function applyChatEvent(
  state: TranscriptState,
  event: WorkspaceChatMessage
): TranscriptState {
  switch (event.type) {
    case "message": {
      // Snapshots are authoritative replacements, not appended text. This also
      // reconciles a persisted final row with its formerly streamed placeholder.
      const message: MuxMessage = {
        id: event.id,
        role: event.role,
        parts: event.parts,
        metadata: event.metadata,
      };
      const next = { ...state, messages: upsert(state.messages, message) };
      return event.metadata?.partial !== true && state.streamingMessageId === event.id
        ? finish(next, event.id)
        : next;
    }
    case "caught-up":
      return {
        ...state,
        caughtUp: true,
        hasOlderHistory: event.hasOlderHistory ?? state.hasOlderHistory,
      };
    case "stream-start":
      return {
        ...state,
        streaming: true,
        streamingMessageId: event.messageId,
        error: null,
        messages: upsert(state.messages, {
          id: event.messageId,
          role: "assistant",
          parts: [],
          metadata: {
            historySequence: event.historySequence,
            timestamp: event.startTime,
            model: event.model,
            metadataModel: event.metadataModel,
            agentId: event.agentId,
            mode: event.mode,
            thinkingLevel: event.thinkingLevel,
            partial: true,
          },
        }),
      };
    case "stream-delta":
    case "reasoning-delta":
      if (state.streamingMessageId !== event.messageId) return state;
      return updateMessage(state, event.messageId, (message) => {
        const type = event.type === "stream-delta" ? "text" : "reasoning";
        const parts = [...message.parts];
        const last = parts[parts.length - 1];
        const signature =
          event.type === "reasoning-delta" && event.signature !== undefined
            ? { signature: event.signature }
            : {};
        if (last?.type === type) {
          parts[parts.length - 1] = { ...last, text: last.text + event.delta, ...signature };
        } else {
          parts.push({ type, text: event.delta, timestamp: event.timestamp, ...signature });
        }
        return { ...message, parts };
      });
    case "usage-delta":
      if (state.streamingMessageId !== event.messageId) return state;
      // Context is the latest step, not cumulative billing across tool iterations.
      return updateMessage(state, event.messageId, (message) => ({
        ...message,
        metadata: {
          ...message.metadata,
          contextUsage: event.usage,
          contextProviderMetadata: event.providerMetadata,
        },
      }));
    case "tool-call-start":
    case "tool-call-end":
      return updateMessage(state, event.messageId, (message) => applyTool(message, event));
    case "tool-call-execution-start":
      return updateMessage(state, event.messageId, (message) => ({
        ...message,
        parts: message.parts.map((part) =>
          part.type === "dynamic-tool" && part.toolCallId === event.toolCallId
            ? { ...part, executionStartedAt: event.timestamp }
            : part
        ),
      }));
    case "stream-end": {
      const previous = state.messages.find((message) => message.id === event.messageId);
      return finish(
        {
          ...state,
          messages: upsert(state.messages, {
            id: event.messageId,
            role: "assistant",
            parts: event.parts,
            metadata: {
              ...previous?.metadata,
              ...event.metadata,
              partial: false,
              error: undefined,
              errorType: undefined,
            },
          }),
        },
        event.messageId
      );
    }
    case "stream-abort": {
      const next = event.abandonPartial
        ? { ...state, messages: state.messages.filter((message) => message.id !== event.messageId) }
        : updateMessage(state, event.messageId, (message) => ({
            ...message,
            metadata: { ...message.metadata, ...event.metadata, partial: true },
          }));
      return finish(next, event.messageId);
    }
    case "stream-error":
    case "error":
      return finish(
        updateMessage({ ...state, error: event.error }, event.messageId, (message) => ({
          ...message,
          metadata: {
            ...message.metadata,
            partial: true,
            error: event.error,
            errorType: event.errorType,
          },
        })),
        event.messageId
      );
    case "delete": {
      const deleted = new Set(event.historySequences);
      const messages = state.messages.filter(
        (message) =>
          message.metadata?.historySequence === undefined ||
          !deleted.has(message.metadata.historySequence)
      );
      const removedActive =
        state.streamingMessageId !== null &&
        !messages.some((message) => message.id === state.streamingMessageId);
      return {
        ...state,
        messages,
        ...(removedActive ? { streaming: false, streamingMessageId: null } : {}),
      };
    }
    case "stream-lifecycle": {
      const streaming =
        event.phase === "preparing" || event.phase === "streaming" || event.phase === "completing";
      return {
        ...state,
        streaming,
        streamingMessageId: streaming ? state.streamingMessageId : null,
      };
    }
    // tool-call-delta carries incomplete args; tool-call-start supplies parsed
    // authoritative input. reasoning-end carries no text or message completion.
    case "tool-call-delta":
    case "reasoning-end":
    default:
      return state;
  }
}

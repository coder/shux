import type { CompletedMessagePart } from "@/common/types/stream";
import type { MockAssistantEvent, MockStreamStartEvent } from "./mockAiEventTypes";
import type { MockAiRouterReply } from "./mockAiRouter";
import { KNOWN_MODELS } from "@/common/constants/knownModels";

const DEFAULT_STREAM_CHUNK_CHARS = 24;
const DEFAULT_STREAM_CHUNK_DELAY_MS = 25;

function chunkText(text: string, chunkChars: number): string[] {
  if (text.length === 0) {
    return [];
  }

  // Stream in word-ish chunks so tests can assert on meaningful substrings.
  // (Fixed-width chunking can split tokens like "README.md" across boundaries.)
  const chunks: string[] = [];

  let cursor = 0;
  while (cursor < text.length) {
    const remaining = text.length - cursor;
    if (remaining <= chunkChars) {
      chunks.push(text.slice(cursor));
      break;
    }

    const window = text.slice(cursor, cursor + chunkChars);
    const lastNewline = window.lastIndexOf("\n");
    const lastSpace = window.lastIndexOf(" ");
    const splitAt = Math.max(lastNewline, lastSpace);

    if (splitAt <= 0) {
      chunks.push(window);
      cursor += chunkChars;
      continue;
    }

    chunks.push(text.slice(cursor, cursor + splitAt + 1));
    cursor += splitAt + 1;
  }

  return chunks;
}

export interface BuildMockStreamEventsOptions {
  messageId: string;
  model?: string;
  mode?: "plan" | "exec" | "compact";
  agentId?: string;
  thinkingLevel?: MockStreamStartEvent["thinkingLevel"];

  /** Chunk size for stream-delta events. */
  chunkChars?: number;
  /** Delay between chunk emissions. */
  chunkDelayMs?: number;
}

/**
 * Convert a high-level mock reply into low-level stream events.
 *
 * IMPORTANT: This is the ONLY place the mock router reply is translated into
 * stream semantics (stream-start/delta/end, usage-delta, etc).
 */
export function buildMockStreamEventsFromReply(
  reply: MockAiRouterReply,
  options: BuildMockStreamEventsOptions
): MockAssistantEvent[] {
  const model = options.model ?? KNOWN_MODELS.OPUS.id;
  const mode = options.mode ?? reply.mode;

  const chunkChars = options.chunkChars ?? DEFAULT_STREAM_CHUNK_CHARS;
  const chunkDelayMs = options.chunkDelayMs ?? DEFAULT_STREAM_CHUNK_DELAY_MS;

  const events: MockAssistantEvent[] = [];

  events.push({
    kind: "stream-start",
    delay: 0,
    messageId: options.messageId,
    model,
    ...(mode && { mode }),
    ...(options.agentId && { agentId: options.agentId }),
    ...(options.thinkingLevel && { thinkingLevel: options.thinkingLevel }),
  });

  let nextDelay = 5;

  if (reply.usage) {
    events.push({
      kind: "usage-delta",
      delay: nextDelay,
      usage: reply.usage,
      cumulativeUsage: reply.usage,
    });
    nextDelay += 5;
  }

  if (reply.reasoningDeltas && reply.reasoningDeltas.length > 0) {
    for (const delta of reply.reasoningDeltas) {
      events.push({
        kind: "reasoning-delta",
        delay: nextDelay,
        text: delta,
      });
      nextDelay += 5;
    }
  }

  nextDelay += reply.toolCallDelayMs ?? 0;

  if (reply.toolCalls && reply.toolCalls.length > 0) {
    for (const toolCall of reply.toolCalls) {
      events.push({
        kind: "tool-start",
        delay: nextDelay,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        args: toolCall.args,
      });
      nextDelay += 5;

      events.push({
        kind: "tool-end",
        delay: nextDelay,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        result: toolCall.result,
      });
      nextDelay += 5;
    }
  }

  const chunkBaseDelay = nextDelay + 5;

  const chunks = chunkText(reply.assistantText, chunkChars);
  for (const [index, chunk] of chunks.entries()) {
    events.push({
      kind: "stream-delta",
      delay: chunkBaseDelay + index * chunkDelayMs,
      text: chunk,
    });
  }

  const terminalDelay = chunkBaseDelay + chunks.length * chunkDelayMs;

  if (reply.error) {
    events.push({
      kind: "stream-error",
      delay: terminalDelay,
      error: reply.error.message,
      errorType: reply.error.type,
    });

    return events;
  }

  const parts: CompletedMessagePart[] = [{ type: "text", text: reply.assistantText }];

  events.push({
    kind: "stream-end",
    delay: terminalDelay,
    metadata: {
      model,
      systemMessageTokens: 0,
    },
    parts,
  });

  return events;
}

/**
 * Stream simulation: synthetic stream event sequences for special early-return conditions.
 *
 * Extracted from `streamMessage()` — these functions simulate the full stream
 * lifecycle (start → delta → end/error) without calling an AI provider.
 *
 * Used for:
 * - `forceContextLimitError`: OpenAI SDK testing of context-exceeded handling
 * - `simulateToolPolicyNoop`: OpenAI SDK testing of tool-policy-disabled handling
 */

import type { MuxMessage, MuxTextPart } from "@/common/types/message";
import { createMuxMessage } from "@/common/types/message";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { StreamDeltaEvent, StreamEndEvent, StreamStartEvent } from "@/common/types/stream";
import type { StreamErrorType } from "@/common/types/errors";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";
import type { HistoryService } from "./historyService";
import { createErrorEvent, type StreamErrorPayload } from "./utils/sendMessageError";

// ---------------------------------------------------------------------------
// Shared context for both simulation paths
// ---------------------------------------------------------------------------

/** Common parameters shared by all simulated stream scenarios. */
export interface SimulationContext {
  workspaceId: string;
  assistantMessageId: string;
  canonicalModelString: string;
  routedThroughGateway: boolean;
  routeProvider?: string;
  historySequence: number;
  systemMessageTokens: number;
  effectiveAgentId: string;
  effectiveMode: "plan" | "exec" | "compact";
  metadataMode?: "plan" | "exec" | "compact";
  effectiveThinkingLevel: ThinkingLevel;
  /** Emit a typed stream event (stream-start, stream-delta, stream-end, error). */
  emit: (event: string, data: unknown) => void;
}

/** Build the common StreamStartEvent used by both simulation paths. */
function createSimulatedStreamStart(ctx: SimulationContext): StreamStartEvent {
  return {
    type: "stream-start",
    workspaceId: ctx.workspaceId,
    messageId: ctx.assistantMessageId,
    model: ctx.canonicalModelString,
    routedThroughGateway: ctx.routedThroughGateway,
    ...(ctx.routeProvider != null ? { routeProvider: ctx.routeProvider } : {}),
    historySequence: ctx.historySequence,
    startTime: Date.now(),
    agentId: ctx.effectiveAgentId,
    ...(ctx.metadataMode != null ? { mode: ctx.metadataMode } : {}),
    thinkingLevel: ctx.effectiveThinkingLevel,
  };
}

// ---------------------------------------------------------------------------
// forceContextLimitError simulation
// ---------------------------------------------------------------------------

/**
 * Simulate a context-length-exceeded error without hitting the provider.
 *
 * Writes an error partial, emits stream-start + error events, then returns.
 * Used by the OpenAI SDK `forceContextLimitError` provider option.
 */
export async function simulateContextLimitError(
  ctx: SimulationContext,
  historyService: HistoryService
): Promise<StreamErrorPayload & { errorType: StreamErrorType }> {
  const errorMessage =
    "Context length exceeded: the conversation is too long to send to this OpenAI model. Please shorten the history and try again.";

  const errorPartialMessage: MuxMessage = {
    id: ctx.assistantMessageId,
    role: "assistant",
    metadata: {
      historySequence: ctx.historySequence,
      timestamp: Date.now(),
      model: ctx.canonicalModelString,
      routedThroughGateway: ctx.routedThroughGateway,
      ...(ctx.routeProvider != null ? { routeProvider: ctx.routeProvider } : {}),
      systemMessageTokens: ctx.systemMessageTokens,
      agentId: ctx.effectiveAgentId,
      ...(ctx.metadataMode != null ? { mode: ctx.metadataMode } : {}),
      thinkingLevel: ctx.effectiveThinkingLevel,
      partial: true,
      error: errorMessage,
      errorType: "context_exceeded",
    },
    parts: [],
  };

  await historyService.writePartial(ctx.workspaceId, errorPartialMessage);

  const payload = {
    messageId: ctx.assistantMessageId,
    error: errorMessage,
    errorType: "context_exceeded",
  } as const;
  ctx.emit("stream-start", createSimulatedStreamStart(ctx));
  ctx.emit("error", createErrorEvent(ctx.workspaceId, payload));
  return payload;
}

// ---------------------------------------------------------------------------
// simulateToolPolicyNoop simulation
// ---------------------------------------------------------------------------

/**
 * Simulate a full stream lifecycle for a tool-policy-disabled noop response.
 *
 * Emits stream-start → stream-delta → stream-end, then updates history.
 * Used by the OpenAI SDK `simulateToolPolicyNoop` provider option.
 */
export async function simulateToolPolicyNoop(
  ctx: SimulationContext,
  effectiveToolPolicy: ToolPolicy | undefined,
  historyService: HistoryService
): Promise<StreamEndEvent> {
  const noopMessage = createMuxMessage(ctx.assistantMessageId, "assistant", "", {
    timestamp: Date.now(),
    model: ctx.canonicalModelString,
    routedThroughGateway: ctx.routedThroughGateway,
    ...(ctx.routeProvider != null ? { routeProvider: ctx.routeProvider } : {}),
    systemMessageTokens: ctx.systemMessageTokens,
    agentId: ctx.effectiveAgentId,
    ...(ctx.metadataMode != null ? { mode: ctx.metadataMode } : {}),
    thinkingLevel: ctx.effectiveThinkingLevel,
    toolPolicy: effectiveToolPolicy,
  });

  const parts: StreamEndEvent["parts"] = [
    {
      type: "text",
      text: "Tool execution skipped because the requested tool is disabled by policy.",
    },
  ];

  ctx.emit("stream-start", createSimulatedStreamStart(ctx));

  const textParts = parts.filter((part): part is MuxTextPart => part.type === "text");
  if (textParts.length === 0) {
    throw new Error("simulateToolPolicyNoop requires at least one text part");
  }

  for (const textPart of textParts) {
    if (textPart.text.length === 0) {
      continue;
    }

    const streamDeltaEvent: StreamDeltaEvent = {
      type: "stream-delta",
      workspaceId: ctx.workspaceId,
      messageId: ctx.assistantMessageId,
      delta: textPart.text,
      tokens: 0, // Mock scenario — actual tokenization happens in streamManager
      timestamp: Date.now(),
    };
    ctx.emit("stream-delta", streamDeltaEvent);
  }

  const streamEndEvent: StreamEndEvent = {
    type: "stream-end",
    workspaceId: ctx.workspaceId,
    messageId: ctx.assistantMessageId,
    metadata: {
      model: ctx.canonicalModelString,
      agentId: ctx.effectiveAgentId,
      ...(ctx.metadataMode != null ? { mode: ctx.metadataMode } : {}),
      thinkingLevel: ctx.effectiveThinkingLevel,
      routedThroughGateway: ctx.routedThroughGateway,
      ...(ctx.routeProvider != null ? { routeProvider: ctx.routeProvider } : {}),
      systemMessageTokens: ctx.systemMessageTokens,
    },
    parts,
  };
  ctx.emit("stream-end", streamEndEvent);

  const finalAssistantMessage: MuxMessage = {
    ...noopMessage,
    metadata: {
      ...noopMessage.metadata,
      historySequence: ctx.historySequence,
    },
    parts,
  };

  await historyService.deletePartial(ctx.workspaceId);
  await historyService.updateHistory(ctx.workspaceId, finalAssistantMessage);
  return streamEndEvent;
}

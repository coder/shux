import type { CompletedMessagePart, StreamStartEvent } from "@/common/types/stream";
import type { StreamErrorType } from "@/common/types/errors";

import type { LanguageModelV2Usage } from "@ai-sdk/provider";

export type MockEventKind =
  | "stream-start"
  | "stream-delta"
  | "stream-end"
  | "stream-error"
  | "reasoning-delta"
  | "tool-start"
  | "tool-end"
  | "usage-delta";

export interface MockAssistantEventBase {
  kind: MockEventKind;
  delay: number;
}

export interface MockStreamStartEvent extends MockAssistantEventBase {
  kind: "stream-start";
  messageId: string;
  model: string;
  mode?: "plan" | "exec" | "compact";
  agentId?: string;
  thinkingLevel?: StreamStartEvent["thinkingLevel"];
}

export interface MockStreamDeltaEvent extends MockAssistantEventBase {
  kind: "stream-delta";
  text: string;
}

export interface MockStreamEndEvent extends MockAssistantEventBase {
  kind: "stream-end";
  metadata: {
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    systemMessageTokens?: number;
  };
  parts: CompletedMessagePart[];
}

export interface MockStreamErrorEvent extends MockAssistantEventBase {
  kind: "stream-error";
  error: string;
  errorType: StreamErrorType;
}

export interface MockReasoningEvent extends MockAssistantEventBase {
  kind: "reasoning-delta";
  text: string;
}

export interface MockToolStartEvent extends MockAssistantEventBase {
  kind: "tool-start";
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface MockUsageDeltaEvent extends MockAssistantEventBase {
  kind: "usage-delta";
  /** Step-level usage (for context window display) */
  usage: LanguageModelV2Usage;
  providerMetadata?: Record<string, unknown>;

  /** Cumulative usage (for cost display) */
  cumulativeUsage: LanguageModelV2Usage;
  cumulativeProviderMetadata?: Record<string, unknown>;
}

export interface MockToolEndEvent extends MockAssistantEventBase {
  kind: "tool-end";
  toolCallId: string;
  toolName: string;
  result: unknown;
}

export type MockAssistantEvent =
  | MockStreamStartEvent
  | MockStreamDeltaEvent
  | MockStreamEndEvent
  | MockStreamErrorEvent
  | MockReasoningEvent
  | MockToolStartEvent
  | MockToolEndEvent
  | MockUsageDeltaEvent;

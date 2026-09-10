import type { PrefixSwapInvalidatedEventSchema } from "@/common/orpc/schemas/stream";
/**
 * Event types emitted by AIService
 */

import type { z } from "zod";
import type { MuxReasoningPart, MuxTextPart, MuxToolPart } from "./message";
import type {
  AutoRetryAbandonedEventSchema,
  AutoRetryScheduledEventSchema,
  AutoRetryStartingEventSchema,
  ErrorEventSchema,
  ReasoningDeltaEventSchema,
  ReasoningEndEventSchema,
  StreamAbortReasonSchema,
  StreamAbortEventSchema,
  StreamLifecycleEventSchema,
  StreamLifecycleSnapshotSchema,
  StreamDeltaEventSchema,
  StreamEndEventSchema,
  StreamStartEventSchema,
  ToolCallDeltaEventSchema,
  ToolCallEndEventSchema,
  ToolCallExecutionStartEventSchema,
  ToolCallStartEventSchema,
  BashOutputEventSchema,
  AdvisorOutputEventSchema,
  AdvisorReasoningOutputEventSchema,
  TaskCreatedEventSchema,
  WorkflowRunAttachedEventSchema,
  AdvisorPhaseEventSchema,
  UsageDeltaEventSchema,
  RuntimeStatusEventSchema,
} from "../orpc/schemas";

/**
 * Completed message part (reasoning, text, or tool) suitable for serialization
 * Used in StreamEndEvent and partial message storage
 */
export type CompletedMessagePart = MuxReasoningPart | MuxTextPart | MuxToolPart;

export type StreamStartEvent = z.infer<typeof StreamStartEventSchema>;
export type StreamDeltaEvent = z.infer<typeof StreamDeltaEventSchema>;
export type StreamEndEvent = z.infer<typeof StreamEndEventSchema>;
export type StreamAbortReason = z.infer<typeof StreamAbortReasonSchema>;
export type StreamLifecycleSnapshot = z.infer<typeof StreamLifecycleSnapshotSchema>;
export type StreamLifecycleEvent = z.infer<typeof StreamLifecycleEventSchema>;

export function copyStreamLifecycleSnapshot(
  snapshot: Pick<StreamLifecycleSnapshot, "phase" | "hadAnyOutput" | "abortReason">
): StreamLifecycleSnapshot {
  return {
    phase: snapshot.phase,
    hadAnyOutput: snapshot.hadAnyOutput,
    ...(snapshot.abortReason != null ? { abortReason: snapshot.abortReason } : {}),
  };
}

export interface StreamAbortReasonSnapshot {
  reason: StreamAbortReason;
  at: number;
}
export type StreamAbortEvent = z.infer<typeof StreamAbortEventSchema>;

export type ErrorEvent = z.infer<typeof ErrorEventSchema>;

export type BashOutputEvent = z.infer<typeof BashOutputEventSchema>;
export type AdvisorOutputEvent = z.infer<typeof AdvisorOutputEventSchema>;
export type AdvisorReasoningOutputEvent = z.infer<typeof AdvisorReasoningOutputEventSchema>;
export type TaskCreatedEvent = z.infer<typeof TaskCreatedEventSchema>;
export type WorkflowRunAttachedEvent = z.infer<typeof WorkflowRunAttachedEventSchema>;
export type AdvisorPhaseEvent = z.infer<typeof AdvisorPhaseEventSchema>;
export type ToolCallStartEvent = z.infer<typeof ToolCallStartEventSchema>;
export type ToolCallExecutionStartEvent = z.infer<typeof ToolCallExecutionStartEventSchema>;
export type ToolCallDeltaEvent = z.infer<typeof ToolCallDeltaEventSchema>;
export type ToolCallEndEvent = z.infer<typeof ToolCallEndEventSchema>;

export type ReasoningDeltaEvent = z.infer<typeof ReasoningDeltaEventSchema>;
export type ReasoningEndEvent = z.infer<typeof ReasoningEndEventSchema>;

/**
 * Emitted on each AI SDK finish-step event, providing incremental usage updates.
 * Allows UI to update token display as steps complete (after each tool call or at stream end).
 */
export type UsageDeltaEvent = z.infer<typeof UsageDeltaEventSchema>;

export type AutoRetryScheduledEvent = z.infer<typeof AutoRetryScheduledEventSchema>;
export type AutoRetryStartingEvent = z.infer<typeof AutoRetryStartingEventSchema>;
export type AutoRetryAbandonedEvent = z.infer<typeof AutoRetryAbandonedEventSchema>;

/**
 * Progress event for pre-stream startup work.
 * Used for both runtime readiness and generic startup breadcrumbs in the barrier UI.
 */
export type RuntimeStatusEvent = z.infer<typeof RuntimeStatusEventSchema>;

export type PrefixSwapInvalidatedEvent = z.infer<typeof PrefixSwapInvalidatedEventSchema>;

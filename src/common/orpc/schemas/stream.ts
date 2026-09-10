import { StreamStopCauseSchema } from "@/common/types/streamStopCause";
import { z } from "zod";
import { AgentDefinitionScopeSchema, AgentIdSchema } from "./agentDefinition";
import { OpenAIReasoningModeSchema, ThinkingLevelSchema } from "../../types/thinking";
import { AgentModeSchema } from "../../types/mode";
import { ChatUsageDisplaySchema } from "./chatStats";
import { StreamErrorTypeSchema } from "./errors";
import {
  FilePartSchema,
  ModelFallbackRecordSchema,
  MuxMessageSchema,
  MuxReasoningPartSchema,
  MuxTextPartSchema,
  MuxToolPartSchema,
} from "./message";
import type { MuxMessageMetadata } from "../../types/message";
import { MuxProviderOptionsSchema } from "./providerOptions";
import { RuntimeModeSchema } from "./runtime";
import { WorkflowRunIdSchema, WorkflowRunRecordSchema } from "./workflow";

// Chat Events

/** Heartbeat event to keep the connection alive during long operations */
export const HeartbeatEventSchema = z.object({
  type: z.literal("heartbeat"),
});

// --- OnChat subscription cursor/mode schemas ---

/** Cursor for where the client left off in persisted history. */
export const OnChatHistoryCursorSchema = z.object({
  messageId: z.string(),
  historySequence: z.number(),
  // Oldest historySequence visible when the cursor was created.
  // Server uses this to detect truncation/compaction that removed older rows
  // while the client was disconnected, forcing a safe full replay fallback.
  oldestHistorySequence: z.number().optional(),
  // Fingerprint for all rows strictly older than historySequence.
  // This lets the server detect middle-row deletions/rewrites below the cursor
  // and force a full replay instead of leaving stale rows client-side.
  priorHistoryFingerprint: z.string().optional(),
});

/** Cursor for where the client left off in an active stream. */
export const OnChatStreamCursorSchema = z.object({
  messageId: z.string(),
  lastTimestamp: z.number(),
});

/** Combined cursor the client sends on reconnect. */
export const OnChatCursorSchema = z.object({
  history: OnChatHistoryCursorSchema.optional(),
  stream: OnChatStreamCursorSchema.optional(),
});

/** Discriminated mode for workspace.onChat subscription. */
export const OnChatModeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("full") }),
  z.object({
    type: z.literal("since"),
    // Since-mode requires a persisted-history anchor; stream-only cursors are unsafe
    // because the frontend uses append semantics for since reconnects.
    cursor: OnChatCursorSchema.extend({ history: OnChatHistoryCursorSchema }),
  }),
  z.object({ type: z.literal("live") }),
]);

/**
 * Why a requested since-mode replay was downgraded to full replay.
 * Ordered by check precedence: the first failing predicate wins.
 */
export const OnChatDowngradeReasonSchema = z.enum([
  "cursor-row-missing",
  "oldest-mismatch",
  "fingerprint-mismatch",
  "history-read-failed",
]);

export const CaughtUpMessageSchema = z.object({
  type: z.literal("caught-up"),
  /** Which replay strategy the server actually used. */
  replay: z.enum(["full", "since", "live"]).optional(),
  /**
   * Present only when the client requested since-mode and the server downgraded to
   * full replay. Silent downgrades defeat incremental reconnects, so this must stay
   * observable to clients and tests.
   */
  downgradeReason: OnChatDowngradeReasonSchema.optional(),
  /**
   * Authoritative pagination signal for full replays.
   * Omitted for since/live replays so the client can preserve existing pagination state.
   */
  hasOlderHistory: z.boolean().optional(),
  /** Server's cursor at end of replay (client should use this for next reconnect). */
  cursor: OnChatCursorSchema.optional(),
});

/**
 * Progress event for pre-stream startup work.
 *
 * Initially introduced for runtime readiness checks, but now also carries generic
 * pre-stream breadcrumbs (for example tool loading or request preparation) so the
 * user can see where startup is currently blocked.
 */
export const RuntimeStatusEventSchema = z.object({
  type: z.literal("runtime-status"),
  workspaceId: z.string(),
  phase: z.enum(["checking", "starting", "waiting", "ready", "error"]),
  runtimeType: RuntimeModeSchema,
  source: z.enum(["runtime", "startup"]).optional(),
  detail: z.string().optional(), // Human-readable status like "Starting Coder workspace..."
});

const AutoCompactionTriggeredEventSchema = z.object({
  type: z.literal("auto-compaction-triggered"),
  reason: z.enum(["on-send", "mid-stream", "idle"]),
  usagePercent: z.number(),
});

const AutoCompactionCompletedEventSchema = z.object({
  type: z.literal("auto-compaction-completed"),
  newUsagePercent: z.number(),
});

export const AutoRetryScheduledEventSchema = z.object({
  type: z.literal("auto-retry-scheduled"),
  attempt: z.number(),
  delayMs: z.number(),
  scheduledAt: z.number(),
});

export const AutoRetryStartingEventSchema = z.object({
  type: z.literal("auto-retry-starting"),
  attempt: z.number(),
});

export const AutoRetryAbandonedEventSchema = z.object({
  type: z.literal("auto-retry-abandoned"),
  reason: z.string(),
});

export const StreamErrorMessageSchema = z.object({
  type: z.literal("stream-error"),
  messageId: z.string(),
  error: z.string(),
  errorType: StreamErrorTypeSchema,
  replay: z.boolean().optional().meta({
    description: "Present when replay re-emits a terminal stream error for reconnect UIs.",
  }),
  acpPromptId: z
    .string()
    .optional()
    .meta({ description: "ACP prompt correlation id for matching terminal events" }),
});

export const DeleteMessageSchema = z.object({
  type: z.literal("delete"),
  historySequences: z.array(z.number()),
});

export const StreamStartEventSchema = z.object({
  type: z.literal("stream-start"),
  workspaceId: z.string(),
  messageId: z.string(),
  replay: z
    .boolean()
    .optional()
    .meta({ description: "True when this event is emitted during stream replay" }),
  model: z.string(),
  metadataModel: z
    .string()
    .optional()
    .meta({
      description:
        "Request-pinned pricing/metadata identity resolved at stream start; " +
        "frontends must prefer it over re-resolving the raw model against a " +
        "possibly refreshed providers config",
    }),
  routedThroughGateway: z.boolean().optional(),
  routeProvider: z.string().optional(),
  historySequence: z.number().meta({
    description: "Backend assigns global message ordering",
  }),
  startTime: z.number().meta({
    description: "Backend timestamp when stream started (Date.now())",
  }),
  mode: AgentModeSchema.optional().catch(undefined).meta({
    description: "Legacy base mode (plan/exec/compact) derived from agent",
  }),
  agentId: AgentIdSchema.optional().catch(undefined).meta({
    description: "Agent id for this stream",
  }),
  thinkingLevel: ThinkingLevelSchema.optional().meta({
    description: "Effective thinking level after model policy clamping",
  }),
  acpPromptId: z
    .string()
    .optional()
    .meta({ description: "ACP prompt correlation id for matching stream events" }),
});

export const StreamDeltaEventSchema = z.object({
  type: z.literal("stream-delta"),
  workspaceId: z.string(),
  messageId: z.string(),
  replay: z
    .boolean()
    .optional()
    .meta({ description: "True when this event is emitted during stream replay" }),
  delta: z.string(),
  tokens: z.number().meta({
    description: "Token count for this delta",
  }),
  timestamp: z.number().meta({
    description: "When delta was received (Date.now())",
  }),
});

export const CompletedMessagePartSchema = z.discriminatedUnion("type", [
  MuxReasoningPartSchema,
  MuxTextPartSchema,
  MuxToolPartSchema,
]);

// Match LanguageModelV2Usage from @ai-sdk/provider exactly
// Note: inputTokens/outputTokens/totalTokens use `number | undefined` (required key, value can be undefined)
// while reasoningTokens/cachedInputTokens use `?: number | undefined` (optional key)
export const LanguageModelV2UsageSchema = z.object({
  inputTokens: z
    .union([z.number(), z.undefined()])
    .meta({ description: "The number of input tokens used" }),
  outputTokens: z
    .union([z.number(), z.undefined()])
    .meta({ description: "The number of output tokens used" }),
  totalTokens: z.union([z.number(), z.undefined()]).meta({
    description:
      "Total tokens used - may differ from sum of inputTokens and outputTokens (e.g. reasoning tokens or overhead)",
  }),
  reasoningTokens: z
    .number()
    .optional()
    .meta({ description: "The number of reasoning tokens used" }),
  cachedInputTokens: z
    .number()
    .optional()
    .meta({ description: "The number of cached input tokens" }),
});

export const StreamEndEventSchema = z.object({
  type: z.literal("stream-end"),
  workspaceId: z.string(),
  messageId: z.string(),
  acpPromptId: z
    .string()
    .optional()
    .meta({ description: "ACP prompt correlation id for matching terminal events" }),
  metadata: z
    .object({
      model: z.string(),
      metadataModel: z.string().optional(),
      agentId: AgentIdSchema.optional().catch(undefined),
      mode: AgentModeSchema.optional().catch(undefined),
      thinkingLevel: ThinkingLevelSchema.optional(),
      routedThroughGateway: z.boolean().optional(),
      routeProvider: z.string().optional(),
      // Present when a fallback model answered after the requested model refused.
      modelFallback: ModelFallbackRecordSchema.optional(),
      // Total usage across all steps (for cost calculation)
      usage: LanguageModelV2UsageSchema.optional(),
      // Last step's usage only (for context window display - inputTokens = current context size)
      contextUsage: LanguageModelV2UsageSchema.optional(),
      // Aggregated provider metadata across all steps (for cost calculation)
      providerMetadata: z.record(z.string(), z.unknown()).optional(),
      // Last step's provider metadata (for context window cache display)
      contextProviderMetadata: z.record(z.string(), z.unknown()).optional(),
      finishReason: z.string().optional(),
      stopCause: StreamStopCauseSchema.optional(),
      duration: z.number().optional(),
      ttftMs: z.number().optional(),
      systemMessageTokens: z.number().optional(),
      muxMetadata: z.custom<MuxMessageMetadata>().optional(),
      historySequence: z.number().optional().meta({
        description: "Present when loading from history",
      }),
      timestamp: z.number().optional().meta({
        description: "Present when loading from history",
      }),
    })
    .meta({
      description: "Structured metadata from backend - directly mergeable with MuxMetadata",
    }),
  parts: z.array(CompletedMessagePartSchema).meta({
    description: "Parts array preserves temporal ordering of reasoning, text, and tool calls",
  }),
});

export const StreamAbortReasonSchema = z.enum(["user", "startup", "system"]);

const StreamLifecyclePhaseSchema = z.enum([
  "idle",
  "preparing",
  "streaming",
  "completing",
  "interrupted",
  "failed",
]);

export const StreamLifecycleSnapshotSchema = z.object({
  phase: StreamLifecyclePhaseSchema,
  hadAnyOutput: z.boolean().meta({
    description:
      "Whether the current or most recent stream produced any model/tool output yet. Distinguishes slow startup from a cut-off response.",
  }),
  abortReason: StreamAbortReasonSchema.optional().meta({
    description:
      "Present for interrupted lifecycle snapshots when the backend knows why the stream stopped.",
  }),
});

export const StreamLifecycleEventSchema = StreamLifecycleSnapshotSchema.extend({
  type: z.literal("stream-lifecycle"),
  workspaceId: z.string(),
});

export const StreamAbortEventSchema = z.object({
  type: z.literal("stream-abort"),
  workspaceId: z.string(),
  messageId: z.string(),
  abortReason: StreamAbortReasonSchema.optional(),
  metadata: z
    .object({
      // Total usage across all steps (for cost calculation)
      usage: LanguageModelV2UsageSchema.optional(),
      // Last step's usage (for context window display - inputTokens = current context size)
      contextUsage: LanguageModelV2UsageSchema.optional(),
      // Provider metadata for cost calculation (cache tokens, etc.)
      providerMetadata: z.record(z.string(), z.unknown()).optional(),
      // Last step's provider metadata (for context window cache display)
      contextProviderMetadata: z.record(z.string(), z.unknown()).optional(),
      duration: z.number().optional(),
      model: z.string().optional(),
      metadataModel: z.string().optional(),
    })
    .optional()
    .meta({
      description: "Metadata may contain usage if abort occurred after stream completed processing",
    }),
  abandonPartial: z.boolean().optional(),
  acpPromptId: z
    .string()
    .optional()
    .meta({ description: "ACP prompt correlation id for matching terminal events" }),
});

export const ToolCallStartEventSchema = z.object({
  type: z.literal("tool-call-start"),
  workspaceId: z.string(),
  messageId: z.string(),
  replay: z
    .boolean()
    .optional()
    .meta({ description: "True when this event is emitted during stream replay" }),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.unknown(),
  tokens: z.number().meta({ description: "Token count for tool input" }),
  timestamp: z.number().meta({ description: "When tool call started (Date.now())" }),
  executionStartedAt: z.number().optional().meta({
    description:
      "When the tool's execute() began running, if it already had by the time this event was built (replay); live streams deliver it via tool-call-execution-start instead",
  }),
  parentToolCallId: z.string().optional().meta({ description: "Set for nested PTC calls" }),
});

/**
 * Emitted when a tool call's execute() actually begins running.
 *
 * Parallel tool calls are serialized by withSequentialExecution, so this can fire
 * long after tool-call-start (which marks when the model emitted the call).
 * The UI uses this to start the elapsed timer only once real execution begins.
 */
export const ToolCallExecutionStartEventSchema = z.object({
  type: z.literal("tool-call-execution-start"),
  workspaceId: z.string(),
  messageId: z.string(),
  toolCallId: z.string(),
  timestamp: z.number().meta({ description: "When execute() began running (Date.now())" }),
});

export const ToolCallDeltaEventSchema = z.object({
  type: z.literal("tool-call-delta"),
  workspaceId: z.string(),
  messageId: z.string(),
  replay: z
    .boolean()
    .optional()
    .meta({ description: "True when this event is emitted during stream replay" }),
  toolCallId: z.string(),
  toolName: z.string(),
  delta: z.unknown(),
  tokens: z.number().meta({ description: "Token count for this delta" }),
  timestamp: z.number().meta({ description: "When delta was received (Date.now())" }),
});

/**
 * UI-only incremental output from the bash tool.
 *
 * This is intentionally NOT part of the tool result returned to the model.
 * It is streamed over workspace.onChat so users can "peek" while the tool is running.
 */
export const BashOutputEventSchema = z.object({
  type: z.literal("bash-output"),
  workspaceId: z.string(),
  toolCallId: z.string(),
  text: z.string(),
  isError: z.boolean().meta({ description: "True if this chunk is from stderr" }),
  timestamp: z.number().meta({ description: "When output was flushed (Date.now())" }),
});

/**
 * UI-only advisor progress update for live phase display.
 *
 * This is intentionally NOT part of the tool result returned to the model.
 * It is streamed over workspace.onChat so the UI can show honest advisor progress.
 */
export const AdvisorPhaseEventSchema = z.object({
  type: z.literal("advisor-phase"),
  workspaceId: z.string(),
  toolCallId: z.string(),
  phase: z.enum(["preparing_context", "waiting_for_response", "finalizing_result"]),
  timestamp: z.number().meta({ description: "When the phase changed (Date.now())" }),
});

/**
 * UI-only incremental output from the advisor tool.
 *
 * This is intentionally NOT part of the tool result returned to the model.
 * It is streamed over workspace.onChat so users can read advice while it is generated.
 */
export const AdvisorOutputEventSchema = z.object({
  type: z.literal("advisor-output"),
  workspaceId: z.string(),
  toolCallId: z.string(),
  text: z.string(),
  timestamp: z.number().meta({ description: "When output was received (Date.now())" }),
});

/**
 * UI-only incremental reasoning from the advisor tool.
 *
 * This is intentionally NOT part of the tool result returned to the model.
 * It is streamed over workspace.onChat so users can see advisor thinking while it is generated.
 */
export const AdvisorReasoningOutputEventSchema = z.object({
  type: z.literal("advisor-reasoning-output"),
  workspaceId: z.string(),
  toolCallId: z.string(),
  text: z.string(),
  timestamp: z.number().meta({ description: "When reasoning output was received (Date.now())" }),
});

/**
 * UI-only notification that a task tool call has created a child workspace.
 *
 * This is intentionally NOT part of the tool result returned to the model.
 * It is streamed over workspace.onChat so the UI can show the spawned taskId
 * immediately, even when the task tool runs in foreground (run_in_background=false).
 */
export const TaskCreatedEventSchema = z.object({
  type: z.literal("task-created"),
  workspaceId: z.string(),
  toolCallId: z.string(),
  taskId: z.string(),
  timestamp: z.number().meta({ description: "When the task was created (Date.now())" }),
});

export const WorkflowRunAttachedEventSchema = z.object({
  type: z.literal("workflow-run-attached"),
  workspaceId: z.string(),
  messageId: z.string().optional(),
  replay: z
    .boolean()
    .optional()
    .meta({ description: "True when this event is emitted during stream replay" }),
  toolCallId: z.string(),
  runId: WorkflowRunIdSchema,
  run: WorkflowRunRecordSchema.optional(),
  timestamp: z.number().meta({ description: "When the workflow run was attached (Date.now())" }),
});

export const ToolCallEndEventSchema = z.object({
  type: z.literal("tool-call-end"),
  workspaceId: z.string(),
  messageId: z.string(),
  replay: z
    .boolean()
    .optional()
    .meta({ description: "True when this event is emitted during stream replay" }),
  toolCallId: z.string(),
  toolName: z.string(),
  result: z.unknown(),
  providerExecuted: z
    .boolean()
    .optional()
    .meta({ description: "True when the provider executed the tool server-side" }),
  timestamp: z.number().meta({ description: "When tool call completed (Date.now())" }),
  parentToolCallId: z.string().optional().meta({ description: "Set for nested PTC calls" }),
});

export const ReasoningDeltaEventSchema = z.object({
  type: z.literal("reasoning-delta"),
  workspaceId: z.string(),
  messageId: z.string(),
  replay: z
    .boolean()
    .optional()
    .meta({ description: "True when this event is emitted during stream replay" }),
  delta: z.string(),
  tokens: z.number().meta({ description: "Token count for this delta" }),
  timestamp: z.number().meta({ description: "When delta was received (Date.now())" }),
  signature: z
    .string()
    .optional()
    .meta({ description: "Anthropic thinking block signature for replay" }),
});

export const ReasoningEndEventSchema = z.object({
  type: z.literal("reasoning-end"),
  workspaceId: z.string(),
  messageId: z.string(),
  replay: z
    .boolean()
    .optional()
    .meta({ description: "True when this event is emitted during stream replay" }),
});

export const ErrorEventSchema = z.object({
  type: z.literal("error"),
  workspaceId: z.string(),
  messageId: z.string(),
  error: z.string(),
  errorType: StreamErrorTypeSchema.optional(),
  acpPromptId: z
    .string()
    .optional()
    .meta({ description: "ACP prompt correlation id for matching terminal events" }),
});

/**
 * Emitted when accumulated session usage changes outside the live stream path,
 * such as a deleted child workspace's usage rolling up into its parent.
 */
export const SessionUsageDeltaEventSchema = z.object({
  type: z.literal("session-usage-delta"),
  workspaceId: z.string().meta({ description: "Workspace receiving the usage delta" }),
  sourceWorkspaceId: z
    .string()
    .meta({ description: "Workspace that produced the usage (deleted child, or self)" }),
  byModelDelta: z.record(z.string(), ChatUsageDisplaySchema),
  timestamp: z.number(),
});
export const UsageDeltaEventSchema = z.object({
  type: z.literal("usage-delta"),
  workspaceId: z.string(),
  messageId: z.string(),
  replay: z
    .boolean()
    .optional()
    .meta({ description: "True when this event is emitted during stream replay" }),

  // Step-level: this step only (for context window display)
  usage: LanguageModelV2UsageSchema,
  providerMetadata: z.record(z.string(), z.unknown()).optional(),

  // Cumulative: sum across all steps (for live cost display)
  cumulativeUsage: LanguageModelV2UsageSchema,
  cumulativeProviderMetadata: z.record(z.string(), z.unknown()).optional(),
});

// Individual init event schemas for flat discriminated union
export const InitStartEventSchema = z.object({
  type: z.literal("init-start"),
  hookPath: z.string(),
  timestamp: z.number(),
  replay: z
    .boolean()
    .optional()
    .meta({ description: "True when this event is emitted during init replay" }),
});

export const InitOutputEventSchema = z.object({
  type: z.literal("init-output"),
  line: z.string(),
  timestamp: z.number(),
  isError: z.boolean().optional(),
  lineNumber: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .meta({ description: "Monotonic line index within the current init run" }),
  replay: z
    .boolean()
    .optional()
    .meta({ description: "True when this event is emitted during init replay" }),
});

export const InitEndEventSchema = z.object({
  type: z.literal("init-end"),
  exitCode: z.number(),
  timestamp: z.number(),
  replay: z
    .boolean()
    .optional()
    .meta({ description: "True when this event is emitted during init replay" }),
  /** Number of lines dropped from middle when output exceeded limit (omitted if 0) */
  truncatedLines: z.number().optional(),
});

// Composite schema for backwards compatibility
export const WorkspaceInitEventSchema = z.discriminatedUnion("type", [
  InitStartEventSchema,
  InitOutputEventSchema,
  InitEndEventSchema,
]);

// Chat message wrapper with type discriminator for streaming events
// XumMessageSchema is used for persisted data (chat.jsonl) which doesn't have a type field.
// This wrapper adds a type discriminator for real-time streaming events.
export const ChatMuxMessageSchema = MuxMessageSchema.extend({
  type: z.literal("message"),
});

// Review data schema for queued message display
export const ReviewNoteDataSchema = z.object({
  filePath: z.string(),
  lineRange: z.string(),
  selectedCode: z.string(),
  selectedDiff: z.string().optional(),
  oldStart: z.number().optional(),
  newStart: z.number().optional(),
  userNote: z.string(),
});

export const GoalBudgetLimitedEventSchema = z.object({
  type: z.literal("goal-budget-limited"),
  workspaceId: z.string(),
  goalId: z.string(),
  causedByChild: z.boolean(),
  childWorkspaceId: z.string().optional(),
  message: z.string(),
});

export const QueuedMessageChangedEventSchema = z.object({
  type: z.literal("queued-message-changed"),
  workspaceId: z.string(),
  /** True when any entry is queued, including hidden synthetic/background entries. */
  hasQueuedMessages: z.boolean().optional(),
  queuedMessages: z.array(z.string()),
  displayText: z.string(),
  fileParts: z.array(FilePartSchema).optional(),
  reviews: z.array(ReviewNoteDataSchema).optional(),
  queueDispatchMode: z.enum(["tool-end", "turn-end"]).optional(),
  /** True when the queued message is a compaction request (/compact) */
  hasCompactionRequest: z.boolean().optional(),
});

export const RestoreToInputEventSchema = z.object({
  type: z.literal("restore-to-input"),
  workspaceId: z.string(),
  text: z.string(),
  fileParts: z.array(FilePartSchema).optional(),
  reviews: z.array(ReviewNoteDataSchema).optional(),
});

// All streaming events now have a `type` field for O(1) discriminated union lookup.
// XumMessages (user/assistant chat messages) are emitted with type: "message"
// when loading from history or sending new messages.
export const PrefixSwapInvalidatedEventSchema = z.object({
  type: z.literal("prefix-swap-invalidated"),
  workspaceId: z.string(),
  messageId: z.string(),
});

export const WorkspaceChatMessageSchema = z.discriminatedUnion("type", [
  PrefixSwapInvalidatedEventSchema,
  // Stream lifecycle events
  HeartbeatEventSchema,
  CaughtUpMessageSchema,
  StreamErrorMessageSchema,
  DeleteMessageSchema,
  StreamLifecycleEventSchema,
  StreamStartEventSchema,
  StreamDeltaEventSchema,
  StreamEndEventSchema,
  StreamAbortEventSchema,
  // Tool events
  ToolCallStartEventSchema,
  ToolCallExecutionStartEventSchema,
  ToolCallDeltaEventSchema,
  ToolCallEndEventSchema,
  BashOutputEventSchema,
  AdvisorOutputEventSchema,
  AdvisorReasoningOutputEventSchema,
  TaskCreatedEventSchema,
  WorkflowRunAttachedEventSchema,
  AdvisorPhaseEventSchema,
  // Reasoning events
  ReasoningDeltaEventSchema,
  ReasoningEndEventSchema,
  // Error events
  ErrorEventSchema,
  GoalBudgetLimitedEventSchema,
  // Usage and queue events
  UsageDeltaEventSchema,
  SessionUsageDeltaEventSchema,
  QueuedMessageChangedEventSchema,
  RestoreToInputEventSchema,
  // Auto-compaction status events
  AutoCompactionTriggeredEventSchema,
  AutoCompactionCompletedEventSchema,
  // Auto-retry status events
  AutoRetryScheduledEventSchema,
  AutoRetryStartingEventSchema,
  AutoRetryAbandonedEventSchema,
  // Runtime status events
  RuntimeStatusEventSchema,
  // Init events
  ...WorkspaceInitEventSchema.def.options,
  // Chat messages with type discriminator
  ChatMuxMessageSchema,
]);

// Update Status
export const RestartBlockerSchema = z.object({
  kind: z.enum([
    "active-streams",
    "pending-turns",
    "workspace-inits",
    "workspace-lifecycle",
    "workflows",
    "projects",
    "requests",
    "desktop-sessions",
    "queued-messages",
    "auto-retries",
    "terminals",
    "background-processes",
  ]),
  count: z.number().int().positive(),
});

export const UpdateStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("checking") }),
  z.object({ type: z.literal("available"), info: z.object({ version: z.string() }) }),
  z.object({ type: z.literal("up-to-date") }),
  z.object({ type: z.literal("unsupported"), reason: z.string() }),
  z.object({
    type: z.literal("install-blocked"),
    info: z.object({ version: z.string() }),
    blockers: z.array(RestartBlockerSchema),
  }),
  z.object({ type: z.literal("downloading"), percent: z.number().nullable() }),
  z.object({ type: z.literal("downloaded"), info: z.object({ version: z.string() }) }),
  z.object({
    type: z.literal("error"),
    phase: z.enum(["check", "download", "install"]),
    message: z.string(),
  }),
]);

// Tool policy schemas
export const ToolPolicyFilterSchema = z.object({
  regex_match: z.string().meta({
    description: 'Regex pattern to match tool names (e.g., "bash", "file_edit_.*", ".*")',
  }),
  action: z.enum(["enable", "disable", "require"]).meta({
    description: "Action to take when pattern matches",
  }),
});

export const ToolPolicySchema = z.array(ToolPolicyFilterSchema).meta({
  description:
    "Tool policy - array of filters applied in order. Default behavior is allow all tools.",
});

// Experiments schema for feature gating.
//
// Unknown keys (e.g. `goals` from older persisted send-options written
// before the Goals experiment graduated to GA) are stripped by Zod's
// default behavior, so we do not need to retain a deprecated field.
export const ExperimentsSchema = z.preprocess(
  // Legacy alias: startup-retry snapshots persisted by builds where "PTC
  // Exclusive Mode" was a separate experiment may carry only the exclusive
  // flag; the merged PTC experiment activates exactly that posture (`true`
  // wins over an explicit programmaticToolCalling: false).
  (value) =>
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).programmaticToolCallingExclusive === true
      ? { ...value, programmaticToolCalling: true }
      : value,
  z.object({
    programmaticToolCalling: z.boolean().optional(),
    /**
     * Downgrade-compat mirror (see withLegacyPtcExclusiveMirror): retained
     * through parsing and stamped alongside programmaticToolCalling in
     * persisted startup-retry snapshots so a downgraded build resumes in the
     * exclusive posture instead of supplement mode.
     */
    programmaticToolCallingExclusive: z.boolean().optional(),
    /**
     * RLM mode (sub-experiment of Programmatic Tool Calling): persistent
     * sandbox kernel for code_execution. Inert unless a PTC flag is also on.
     */
    rlm: z.boolean().optional(),
    advisorTool: z.boolean().optional(),
    dynamicWorkflows: z.boolean().optional(),
    memory: z.boolean().optional(),
    memoryIntuition: z.boolean().optional(),
    timeline: z.boolean().optional(),
    workspaceHeartbeats: z.boolean().optional(),
    toolSearch: z.boolean().optional(),
    continuousCompaction: z.boolean().optional(),
    tokenBudget: z.boolean().optional(),
  })
);

/**
 * `steer` is accepted for older clients, but the backend treats every manual
 * user message as a pause because active goal mode is derived from the latest
 * `goal_continuation` user turn.
 */
export const GoalInterventionPolicySchema = z.enum(["steer", "pause"]);

// SendMessage options
export const SendMessageOptionsSchema = z.object({
  editMessageId: z.string().optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
  /** OpenAI reasoning mode (pro toggle); inert for models without pro-mode support. */
  reasoningMode: OpenAIReasoningModeSchema.optional(),
  model: z.string("No model specified"),
  toolPolicy: ToolPolicySchema.optional(),
  additionalSystemInstructions: z.string().optional(),
  /** Live workspace scratchpad snapshot from the renderer; avoids racing pending disk writes. */
  additionalSystemContext: z.string().optional(),
  maxOutputTokens: z.number().optional(),
  agentId: AgentIdSchema.meta({
    description: "Agent id for this request",
  }),
  mode: AgentModeSchema.optional().catch(undefined).meta({
    description: "Legacy base mode (plan/exec/compact) for backend fallback",
  }),
  providerOptions: MuxProviderOptionsSchema.optional(),
  acpPromptId: z
    .string()
    .optional()
    .meta({ description: "ACP prompt correlation id for terminal stream matching" }),
  delegatedToolNames: z
    .array(z.string())
    .optional()
    .meta({ description: "Tool names delegated back to ACP clients for this request" }),
  muxMetadata: z.any().optional(), // Black box
  /**
   * When true, skip persisting AI settings (e.g., for one-shot or compaction sends).
   */
  skipAiSettingsPersistence: z.boolean().optional(),
  experiments: ExperimentsSchema.optional(),
  /**
   * When true, workspace-specific agent definitions are disabled.
   * Only built-in and global agents are loaded. Useful for "unbricking" when
   * iterating on agent files - a broken agent in the worktree won't affect message sending.
   */
  disableWorkspaceAgents: z.boolean().optional(),
  /**
   * When truthy, a top-level send whose agentId cannot be resolved (or is hidden or
   * disabled) at stream time fails loudly instead of silently falling back to exec.
   * Workspace-turn launches with explicit agent overrides set this: pre-dispatch
   * validation races init hooks and user edits, so stream-time resolution — which
   * runs after initialization completes — is the last sound gate against running
   * a different agent than the caller asked for. The object form additionally pins
   * the validated definition's provenance: if the id resolves from a different
   * scope than launch validation saw (e.g. a validated project shadow vanished and
   * a global/built-in definition with the same id took over), the send fails
   * instead of running a different prompt/tool policy. A single field (rather than
   * a sibling flag) so every option-preservation path copies it verbatim.
   */
  strictAgentResolution: z
    .union([
      z.boolean(),
      z.object({
        expectedScope: AgentDefinitionScopeSchema,
        /**
         * Exact source identity from AgentDefinitionPackage.source ("built-in" or the
         * discovery root). Scope alone collapses distinct candidates (project files
         * and project plugins both report "project"), so this pins the definition
         * itself when known.
         */
        expectedSource: z.string().optional(),
        /**
         * Provenance of the full resolved base chain (leaf first), pinned because
         * stream-time inheritance resolution reloads every base independently — a
         * vanished base shadow must not silently swap a different definition into
         * the chain's prompt/tool policy.
         */
        expectedChain: z
          .array(
            z.object({
              id: AgentIdSchema,
              scope: AgentDefinitionScopeSchema,
              source: z.string().optional(),
            })
          )
          .optional(),
      }),
    ])
    .optional(),
  /**
   * Desktop/app-only capability: expose set_goal so an agent can create a
   * continuation-backed goal for its current parent workspace. Headless callers
   * omit this, so plain one-shot mux run stays one-shot.
   */
  allowAgentSetGoal: z.boolean().optional(),
  goalInterventionPolicy: GoalInterventionPolicySchema.nullish(),
  queueDispatchMode: z.enum(["tool-end", "turn-end"]).nullish(),
});

import type { QueuedInputStopCause, StreamStopCause } from "@/common/types/streamStopCause";
import { estimateToolResultSize } from "@/common/utils/compaction/contextBudget";
import { ContextBudgetExceededError, ContextBudgetBlockedError } from "./contextBudgetError";
import {
  checkAssembledRequestBudgetForModel,
  estimateToolResultTokensForModel,
} from "./contextBudgetCounting";
import {
  applyCacheControl,
  getAnthropicCacheTtl,
  supportsAnthropicCache,
} from "@/common/utils/ai/cacheStrategy";
import { stripMessageCacheControl, type ContinuousPrefixSwap } from "./continuousCompactionJournal";
import type { PrefixSwapInvalidatedEvent } from "@/common/types/stream";
import * as path from "path";
import { Duration, Effect, Exit, Fiber, Scope } from "effect";
import { PlatformPaths } from "@/common/utils/paths";
import { eventSpine } from "@/node/services/events/eventSpine";
import {
  streamText,
  type stepCountIs,
  type ModelMessage,
  type SystemModelMessage,
  type LanguageModel,
  type Tool,
  type ToolSet,
  LoadAPIKeyError,
  APICallError,
  InvalidToolInputError,
  RetryError,
} from "ai";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { Result } from "@/common/types/result";
import assert from "@/common/utils/assert";
import { Ok, Err } from "@/common/types/result";
import { log, type Logger } from "./log";
import type {
  StreamStartEvent,
  StreamDeltaEvent,
  StreamEndEvent,
  StreamAbortEvent,
  StreamAbortReason,
  ErrorEvent,
  UsageDeltaEvent,
  ToolCallStartEvent,
  ToolCallDeltaEvent,
  ToolCallEndEvent,
  ToolCallExecutionStartEvent,
  ReasoningDeltaEvent,
  ReasoningEndEvent,
  CompletedMessagePart,
  WorkflowRunAttachedEvent,
} from "@/common/types/stream";

import type { SendMessageError, StreamErrorType } from "@/common/types/errors";
import type { MuxMetadata, MuxMessage, PersistedToolModelUsage } from "@/common/types/message";
import { hasTokenUsage, MODEL_FALLBACK_REFUSAL_TOOL_NAME } from "@/common/types/message";
import {
  findFirstReasoningPartIndexInTrailingRun,
  mergeReasoningProviderOptions,
  reasoningProviderOptionsFromMetadata,
  type ReasoningProviderMetadata,
} from "@/node/utils/messages/reasoningProviderOptions";
import { ThinkingLevelSchema, type ThinkingLevel } from "@/common/types/thinking";
import type {
  ActiveTurnThinkingOverride,
  RebuildFirstStepForThinkingLevel,
  RebuildProviderOptionsForThinkingLevel,
} from "@/node/services/thinkingOverride";
import type { NestedToolCall } from "@/common/orpc/schemas/message";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import {
  coerceStreamErrorTypeForMessage,
  createErrorEvent,
  stripNoisyErrorPrefix,
  type StreamErrorPayload,
} from "@/node/services/utils/sendMessageError";
import { hasCommitWorthyParts, type HistoryService } from "./historyService";
import {
  addUsage,
  accumulateProviderMetadata,
  normalizeUsage,
  withCacheWriteMetadata,
  type AiSdkUsageLike,
} from "@/common/utils/tokens/usageHelpers";
import { linkAbortSignal } from "@/node/utils/abort";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import { stripInternalToolResultFields } from "@/common/utils/tools/internalToolResultFields";
import {
  formatToolInputIssues,
  isToolInputIssueArray,
} from "@/common/utils/tools/formatToolInputIssues";
import { buildRequiredToolPatterns, type ToolPolicy } from "@/common/utils/tools/toolPolicy";
import {
  computeActiveToolNames,
  type ToolSearchStreamState,
} from "@/common/utils/tools/toolCatalog";
import { StreamingTokenTracker } from "@/node/utils/main/StreamingTokenTracker";
import { countTokens } from "@/node/utils/main/tokenizer";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import type { Runtime } from "@/node/runtime/Runtime";
import type { SessionUsageService } from "./sessionUsageService";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { extractToolMediaAsUserMessagesFromModelMessages } from "@/node/utils/messages/extractToolMediaAsUserMessagesFromModelMessages";
import { stripEncryptedContent } from "@/node/utils/messages/stripEncryptedContent";
import { stripWorkflowRunRecordsFromModelMessages } from "@/node/utils/messages/stripWorkflowRunRecordsFromModelMessages";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { MUX_GATEWAY_SESSION_EXPIRED_MESSAGE } from "@/common/constants/muxGatewayOAuth";
import { getModelStats, getModelStatsResolved } from "@/common/utils/tokens/modelStats";
import { withSequentialExecution } from "@/node/services/tools/withSequentialExecution";
import type { ResolvedCallSettingsOverrides } from "@/common/config/schemas/modelParameters";
import {
  normalizeUsageModelKey,
  resolveModelForMetadata,
} from "@/common/utils/providers/modelEntries";
import { clampErrorMessage, getErrorMessage } from "@/common/utils/errors";
import { runLanguageModelCleanup } from "./languageModelCleanup";
import { defaultEffectRunner, type EffectRunner } from "./di/effectRunner";
import { shellQuote } from "@/common/utils/shell";
import { classify429Capacity } from "@/common/utils/errors/classify429Capacity";
import { extractChunkDeltaText } from "@/common/utils/ai/streamChunks";
import { PROVIDER_DEFINITIONS } from "@/common/constants/providers";
import { isRefusalFinishReason } from "@/common/utils/messages/refusalFinishReason";
import { getOpenAIResponsesBaseUrlHint } from "@/node/services/utils/openAIResponsesBaseUrlHint";

// Disable noisy AI SDK warning logging.
globalThis.AI_SDK_LOG_WARNINGS = false;

export type StreamTextOnChunk = NonNullable<Parameters<typeof streamText>[0]["onChunk"]>;

const EMPTY_STREAM_OUTPUT_ERROR_MESSAGE =
  "The model ended the stream before producing any assistant-visible output. This usually means the upstream stream was dropped rather than completed normally. Xum will retry automatically when possible, and if retries keep failing you should try again or switch models.";

const MAX_EMPTY_STREAM_RECOVERY_ATTEMPTS = 1;

/** Drop reason for a partial that never reaches chat.jsonl. */
type DroppedStreamSource = "aborted_stream" | "errored_stream";
/** Sidecar analytics label: drop reason, or the refusal-specific label. */
type HeadlessDropSource = DroppedStreamSource | "refused_stream";
const STREAM_TRUNCATED_MESSAGE_SUFFIX =
  "stream closed unexpectedly before the response completed. Xum will retry automatically when possible, and if retries keep failing you should try again or switch models.";

class EmptyStreamOutputError extends Error {
  constructor() {
    super(EMPTY_STREAM_OUTPUT_ERROR_MESSAGE);
    this.name = "EmptyStreamOutputError";
  }
}

/**
 * Terminal provider refusal: the model declined to continue the turn. Unlike
 * EmptyStreamOutputError (a transport drop), retrying the same request will
 * likely refuse again, so this maps to the non-retryable "model_refusal" stream
 * error type.
 */
class ModelRefusalError extends Error {
  constructor(model: string, finishReason: string, fallbackNote?: string) {
    super(
      `The model refused to continue (finishReason: ${finishReason}): ${model}. ` +
        "Retrying the same request is unlikely to help; try rephrasing or a different model." +
        (fallbackNote ? ` ${fallbackNote}` : "")
    );
    this.name = "ModelRefusalError";
  }
}

class StreamTruncatedError extends Error {
  readonly providerDisplayName: string;

  constructor(providerDisplayName: string) {
    super(`${providerDisplayName} ${STREAM_TRUNCATED_MESSAGE_SUFFIX}`);
    this.name = "StreamTruncatedError";
    this.providerDisplayName = providerDisplayName;
  }
}

// Type definitions for stream parts with extended properties
interface ReasoningDeltaPart {
  type: "reasoning-delta";
  text?: string;
  delta?: string;
  providerMetadata?: ReasoningProviderMetadata;
}

interface ReasoningLifecyclePart {
  type: "reasoning-start" | "reasoning-end";
  id?: string;
  providerMetadata?: ReasoningProviderMetadata;
}

// Tool-call tracking + branded types
interface ToolCallState {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  /** Concise message for a call the SDK rejected before execution; replaces the raw tool-error string. */
  invalidInputError?: string;
}

type ToolCallMap = Map<string, ToolCallState>;

/**
 * The SDK's InvalidToolInputError message echoes the entire submitted input
 * and buries the zod issue at the end, so the model retries blind. Render only
 * the issues (with received string lengths) when the cause chain
 * (InvalidToolInputError -> TypeValidationError -> ZodError) exposes them.
 */
function describeInvalidToolInput(toolName: string, input: unknown, error: unknown): string {
  if (InvalidToolInputError.isInstance(error)) {
    let cause: unknown = error.cause;
    for (let depth = 0; depth < 3 && typeof cause === "object" && cause !== null; depth += 1) {
      const issues: unknown = (cause as { issues?: unknown }).issues;
      if (isToolInputIssueArray(issues)) {
        return `Invalid input for tool ${toolName}: ${formatToolInputIssues(issues, input)}`;
      }
      cause = (cause as { cause?: unknown }).cause;
    }
  }
  return clampErrorMessage(getErrorMessage(error));
}

type WorkspaceId = string & { __brand: "WorkspaceId" };
type StreamToken = string & { __brand: "StreamToken" };

export type TurnEngineEvent =
  | StreamStartEvent
  | StreamDeltaEvent
  | StreamEndEvent
  | StreamAbortEvent
  | ErrorEvent
  | UsageDeltaEvent
  | ToolCallStartEvent
  | ToolCallExecutionStartEvent
  | ToolCallDeltaEvent
  | ToolCallEndEvent
  | ReasoningDeltaEvent
  | ReasoningEndEvent
  | WorkflowRunAttachedEvent
  | PrefixSwapInvalidatedEvent;

export type TurnEngineEventSink = (event: TurnEngineEvent) => void | Promise<void>;

// Turn identity lives on TurnStreamHandle.messageId; completions cannot diverge from it.
export type TurnCompletion =
  | { status: "completed"; streamEnd: Omit<StreamEndEvent, "messageId"> }
  | {
      status: "aborted";
      abortReason: StreamAbortReason;
      // Absent for startup cancellation / cleanup without a delivered terminal event.
      streamAbort?: Omit<StreamAbortEvent, "messageId" | "abortReason">;
      systemMessageTokens?: number;
    }
  | { status: "failed"; streamError: StreamErrorPayload & { errorType: StreamErrorType } };

export interface TurnStreamHandle {
  messageId: string;
  completion: Promise<TurnCompletion>;
}

interface TurnCompletionController {
  promise: Promise<TurnCompletion>;
  settle: (completion: TurnCompletion) => void;
}

export function createTurnCompletionController(): TurnCompletionController {
  let settled = false;
  let resolveCompletion!: (completion: TurnCompletion) => void;
  const promise = new Promise<TurnCompletion>((resolve) => {
    resolveCompletion = resolve;
  });
  return {
    promise,
    settle: (completion) => {
      if (settled) return;
      settled = true;
      resolveCompletion(completion);
    },
  };
}

// Request-construction options shared by the primary turn and model-fallback
// hops (fallbacks rebuild these from the prepared fallback request).
export interface SettledStepBudget {
  model: string;
  usage: LanguageModelV2Usage | undefined;
  providerMetadata?: Record<string, unknown>;
  toolResultChars: number;
  imageParts: number;
  toolResultTokens?: number;
  sessionHistoryAvailable: boolean;
  memoryWritable: boolean;
  /** A successful `new_context` result settled in this step (its siblings included). */
  newContextRequested?: boolean;
}

export type OnStepSettled = (
  step: SettledStepBudget
) => Promise<"continue" | "warn" | "rollover" | "block">;

interface StreamRequestOptions {
  model: LanguageModel;
  modelString: string;
  messages: ModelMessage[];
  system: string | SystemModelMessage | undefined;
  tools?: Record<string, Tool>;
  providerOptions?: Record<string, unknown>;
  maxOutputTokens?: number;
  callSettingsOverrides?: ResolvedCallSettingsOverrides;
  toolPolicy?: ToolPolicy;
  hasQueuedMessages?: (dispatchMode?: "tool-end" | "turn-end") => boolean;
  getQueuedInputStopCause?: () => QueuedInputStopCause | undefined;
  headers?: Record<string, string | undefined>;
  onChunk?: StreamTextOnChunk;
  onStepMessages?: (messages: ModelMessage[]) => void;
  onStepSettled?: OnStepSettled;
  contextBudgetMemoryWritable?: boolean;
  contextBudgetLimit?: number;
  toolSearchState?: ToolSearchStreamState;
  thinkingOverrideState?: ActiveTurnThinkingOverride;
  rebuildProviderOptionsForThinkingLevel?: RebuildProviderOptionsForThinkingLevel;
  forcedFirstStepToolNames?: string[];
  providersConfigSnapshot?: ProvidersConfigMap;
  rebuildFirstStepForThinkingLevel?: RebuildFirstStepForThinkingLevel;
}

export interface TurnExecutionOptions extends StreamRequestOptions {
  workspaceId: string;
  historySequence: number;
  runtime: Runtime;
  messageId: string;
  abortSignal?: AbortSignal;
  initialMetadata?: Partial<MuxMetadata>;
  providedStreamToken?: StreamToken;
  workspaceName?: string;
  thinkingLevel?: string;
  providedRuntimeTempDir?: string;
  modelFallback?: ModelFallbackOptions;
  onStreamConstructed?: () => Promise<void>;
  assertAdmissionCurrent?: () => Promise<void>;
  withAdmissionCurrent?: (construct: () => void) => Promise<void>;
}

type StreamRequestInput = StreamRequestOptions & {
  onToolExecutionStart?: (toolCallId: string) => void;
};

interface StepMessageTracker {
  workspaceId?: string;
  pendingPrefixSwap?: ContinuousPrefixSwap;
  consumedPrefixSwap?: ContinuousPrefixSwap;
  prefixSwapInvalidated?: boolean;
  prefixSwapInvalidationEmitted?: boolean;
  latestMessages?: ModelMessage[];
}
interface StreamRequestConfig {
  stopCause?: StreamStopCause;
  cacheEnabled?: boolean;
  budgetMetadataModel?: string;
  model: LanguageModel;
  modelString: string;
  messages: ModelMessage[];
  /** Provider-ready system instructions from TurnContextAssembler. */
  system?: string | SystemModelMessage;
  tools?: Record<string, Tool>;
  providerOptions?: Record<string, unknown>;
  /** Per-request HTTP headers (e.g., anthropic-beta for 1M context). */
  headers?: Record<string, string | undefined>;
  maxOutputTokens?: number;
  streamCallSettings?: Omit<ResolvedCallSettingsOverrides, "maxOutputTokens">;
  hasQueuedMessages?: (dispatchMode?: "tool-end" | "turn-end") => boolean;
  getQueuedInputStopCause?: () => QueuedInputStopCause | undefined;
  /** Optional hook for callers that need chunk-level visibility during streaming. */
  onChunk?: StreamTextOnChunk;
  /** Optional hook for callers that need the live prepared step transcript. */
  onStepMessages?: (messages: ModelMessage[]) => void;
  onStepSettled?: OnStepSettled;
  contextBudgetMemoryWritable?: boolean;
  contextBudgetLimit?: number;
  toolPolicy?: ToolPolicy;
  /**
   * Tool-search deferral state (tool-search experiment). Owned and mutated by
   * aiService/tool_catalog_search.execute; prepareStep reads it each step to compute
   * `activeTools`. Absent when the feature is inactive.
   */
  toolSearchState?: ToolSearchStreamState;
  /**
   * Mid-turn thinking override holder — the SESSION'S object, by reference
   * (never created inside StreamManager: a locally-created object would be
   * invisible to AgentSession.setActiveTurnThinkingLevel). prepareStep
   * consumes `pending` before every model step.
   */
  thinkingOverrideState?: ActiveTurnThinkingOverride;
  /**
   * Closure built by TurnRequestBuilder that re-runs the effective-level pipeline
   * (policy clamp + resolveEffectiveThinkingLevel) and rebuilds provider
   * options for the stream's model. `null` ⇒ not applicable / no-op.
   */
  rebuildProviderOptionsForThinkingLevel?: RebuildProviderOptionsForThinkingLevel;
  /**
   * Step-0 message rebuild for overrides that raced stream construction; see
   * RebuildFirstStepForThinkingLevel. Also emits the superseding envelope.
   */
  rebuildFirstStepForThinkingLevel?: RebuildFirstStepForThinkingLevel;
  /** First step must call one of these tools; later steps restore the full toolset. */
  forcedFirstStepToolNames?: string[];
}

/**
 * Per-model request pieces for a refusal-fallback swap, rebuilt by TurnRequestBuilder so
 * provider-specific message preparation, provider options, and headers match a
 * first-class send of the fallback model (reusing the source model's request
 * verbatim would leak provider-specific options/messages across providers).
 */
interface PreparedModelFallback {
  contextBudgetMemoryWritable?: boolean;
  contextBudgetLimit?: number;
  model: LanguageModel;
  /** Canonical model string of the fallback attempt (drives metadata + tokenizer). */
  modelString: string;
  /** Messages re-prepared for the fallback model's provider. */
  messages: ModelMessage[];
  /** Provider-ready system prompt rebuilt for the fallback model. */
  system: string | SystemModelMessage | undefined;
  /**
   * Tools rebuilt for the fallback model. Required (even if undefined for a
   * tool-less stream) so callers cannot silently reuse the source model's
   * provider-specific tools (e.g. Anthropic web tools, unsanitized MCP schemas
   * that OpenAI rejects).
   */
  tools: Record<string, Tool> | undefined;
  providerOptions?: Record<string, unknown>;
  headers?: Record<string, string | undefined>;
  callSettingsOverrides?: ResolvedCallSettingsOverrides;
  thinkingLevel?: string;
  /**
   * Output cap for the fallback attempt when it must differ from the source request's (the
   * context-budget flush sizes its cap for each model's own thinking level). Otherwise the
   * original cap carries over.
   */
  maxOutputTokens?: number;
  /** Route attribution corrections (routedThroughGateway, routeProvider, costsIncluded). */
  initialMetadataPatch?: Partial<MuxMetadata>;
  /**
   * Rebuild closure bound to the FALLBACK model so mid-turn thinking changes
   * keep working after a fallback hop (the source model's closure would build
   * options for the wrong model).
   */
  rebuildProviderOptionsForThinkingLevel?: RebuildProviderOptionsForThinkingLevel;
  /** Step-0 message rebuild bound to the fallback request's build inputs. */
  rebuildFirstStepForThinkingLevel?: RebuildFirstStepForThinkingLevel;
  forcedFirstStepToolNames?: string[];
  /**
   * Invoked once the fallback stream has been constructed successfully (but
   * before it is consumed). Durable side effects that must describe the
   * request that actually streams — e.g. the superseding turn envelope —
   * belong here, not in prepare(): a prepare that succeeds but whose stream
   * construction fails must leave no trace, or replay verification would
   * attribute an unstarted fallback identity. Must not throw.
   */
  onStreamConstructed?: () => Promise<void>;
  /**
   * Pinned providers-config snapshot the fallback request was built from
   * (see TurnRequestBuilder's pinCoderInstanceProvidersConfig). The swap's request-config
   * rebuild and metadata resolution must read THIS snapshot, not the live
   * config: a catalog refresh between prepare() and the swap could retag the
   * instance and hand the prepared SDK model another wire's output limits or
   * usage identity.
   */
  providersConfig?: ProvidersConfigMap;
}

export interface ModelFallbackPrepareOptions {
  /**
   * In-memory partial assistant turn to include when continuing after a
   * mid-turn refusal. This must be cloned from the stream state before prepare()
   * receives it so provider-message preparation cannot mutate live UI parts.
   */
  continuation?: { assistantMessage: MuxMessage };
  /**
   * Mid-turn thinking level to fold into the fallback's baseline: pending (not
   * yet applied) or already-applied override from the refused stream. The
   * fallback prepare re-clamps it for the next model.
   */
  thinkingLevelOverride?: ThinkingLevel;
}

export interface ModelFallbackOptions {
  /** Ordered refusal-fallback chain (canonical model strings); one attempt each. */
  chain: string[];
  /**
   * Rebuilds the full request for a fallback model. An Err result fails the
   * turn terminally as model_refusal (never a retryable error): silently
   * skipping an unstartable fallback would effectively create fallback on
   * auth/config errors, which is explicitly out of scope.
   */
  prepare: (
    nextModelString: string,
    options?: ModelFallbackPrepareOptions
  ) => Promise<
    Result<
      PreparedModelFallback,
      string | Extract<SendMessageError, { type: "context_budget_exceeded" }>
    >
  >;
}

function isKnownProviderName(provider: string): provider is keyof typeof PROVIDER_DEFINITIONS {
  return Object.hasOwn(PROVIDER_DEFINITIONS, provider);
}

/**
 * Model identity persisted/emitted in message and stream metadata. Gateway
 * strings canonicalize for display EXCEPT Coder identities, which stay RAW:
 * name-based canonicalization rewrites a cross-typed instance
 * (coder:openai/<claude>, type anthropic) to openai:<claude>, and usage
 * recovery (WorkspaceStore live deltas, SessionUsageService history rebuilds)
 * re-keys from this metadata via normalizeUsageModelKey — which needs the raw
 * identity to resolve the instance type. Custom-named instances already stay
 * gateway-scoped under normalizeToCanonical, so this only makes
 * canonical-named instances consistent with them.
 */
function metadataModelIdentity(model: string): string {
  return model.startsWith("coder:") ? model : normalizeToCanonical(model);
}

function getStreamProviderDisplayName(model: string): string {
  const canonicalModel = normalizeToCanonical(model);
  const providerSeparatorIndex = canonicalModel.indexOf(":");
  const provider =
    providerSeparatorIndex > 0 ? canonicalModel.slice(0, providerSeparatorIndex) : undefined;
  if (provider && isKnownProviderName(provider)) {
    return PROVIDER_DEFINITIONS[provider].displayName;
  }

  return "The model";
}

function isStreamTruncatedMessage(message: string): boolean {
  const lowerMessage = message.toLowerCase();
  return (
    lowerMessage.includes("stream closed before message_stop") ||
    lowerMessage.includes("stream closed before terminal event") ||
    lowerMessage.includes("stream closed unexpectedly before the response completed")
  );
}

// Stream state enum for exhaustive checking
enum StreamState {
  IDLE = "idle",
  STARTING = "starting",
  STREAMING = "streaming",
  STOPPING = "stopping",
  COMPLETED = "completed", // Stream finished successfully (before cleanup)
  ERROR = "error",
}

const MAX_ORPHAN_TOOL_RESULT_WARNINGS_PER_STREAM = 3;
const ORPHAN_TOOL_RESULT_PREVIEW_CHARS = 160;
const ORPHAN_TOOL_RESULT_MAX_KEYS = 8;

function summarizeToolResultForLog(output: unknown): Record<string, unknown> {
  if (output === null) {
    return { outputType: "null" };
  }

  if (typeof output === "string") {
    return {
      outputType: "string",
      outputLength: output.length,
      outputPreview: output.slice(0, ORPHAN_TOOL_RESULT_PREVIEW_CHARS),
    };
  }

  if (typeof output === "number" || typeof output === "boolean") {
    return {
      outputType: typeof output,
      outputPreview: String(output),
    };
  }

  if (Array.isArray(output)) {
    return {
      outputType: "array",
      outputLength: output.length,
      firstItemType:
        output.length > 0 && output[0] !== null
          ? typeof output[0]
          : output.length > 0
            ? "null"
            : undefined,
    };
  }

  if (typeof output === "object") {
    const outputRecord = output as Record<string, unknown>;
    const keys = Object.keys(outputRecord);
    const summary: Record<string, unknown> = {
      outputType: "object",
      outputKeyCount: keys.length,
      outputKeys: keys.slice(0, ORPHAN_TOOL_RESULT_MAX_KEYS),
    };

    if (typeof outputRecord.type === "string") {
      summary.outputFormat = outputRecord.type;
    }

    if (Array.isArray(outputRecord.value)) {
      summary.outputValueLength = outputRecord.value.length;
    }

    return summary;
  }

  return {
    outputType: typeof output,
    outputPreview: JSON.stringify(output),
  };
}

export function markProviderMetadataCostsIncluded(
  providerMetadata: Record<string, unknown> | undefined,
  costsIncluded: boolean | undefined
): Record<string, unknown> | undefined {
  if (!costsIncluded) return providerMetadata;

  const muxMetadata = providerMetadata?.mux;
  const existingMux =
    muxMetadata && typeof muxMetadata === "object"
      ? (muxMetadata as Record<string, unknown>)
      : undefined;

  return {
    ...(providerMetadata ?? {}),
    mux: {
      ...(existingMux ?? {}),
      costsIncluded: true,
    },
  };
}
/** Build a UsageDeltaEvent with consistent costsIncluded stamping on cumulative metadata. */
function buildUsageDeltaEvent(opts: {
  workspaceId: string;
  messageId: string;
  usage: LanguageModelV2Usage;
  providerMetadata: Record<string, unknown> | undefined;
  cumulativeUsage: LanguageModelV2Usage;
  cumulativeProviderMetadata: Record<string, unknown> | undefined;
  costsIncluded: boolean | undefined;
  replay?: true;
}): UsageDeltaEvent {
  return {
    type: "usage-delta",
    workspaceId: opts.workspaceId,
    messageId: opts.messageId,
    ...(opts.replay ? { replay: true } : {}),
    usage: opts.usage,
    providerMetadata: opts.providerMetadata,
    cumulativeUsage: opts.cumulativeUsage,
    cumulativeProviderMetadata: markProviderMetadataCostsIncluded(
      opts.cumulativeProviderMetadata,
      opts.costsIncluded
    ),
  };
}

/**
 * Deep-clone a PersistedToolModelUsage so the stored copy is independent of the caller's object
 * (usage/providerMetadata are nested references the caller may mutate). Keeps providerMetadata
 * optional so the cloned object only carries the field when defined.
 */
function clonePersistedToolModelUsage(event: PersistedToolModelUsage): PersistedToolModelUsage {
  return {
    ...event,
    usage: { ...event.usage },
    ...(event.providerMetadata != null ? { providerMetadata: event.providerMetadata } : {}),
  };
}

function cloneUsage(usage: LanguageModelV2Usage): LanguageModelV2Usage {
  return { ...usage };
}

/**
 * Fresh all-zero usage object for refusals where the provider billed nothing
 * (or usage never arrived). A new object per call — downstream code mutates
 * usage objects (e.g. reasoning-token backfill), so a shared singleton would
 * leak counts across records.
 */
function zeroTokenUsage(): LanguageModelV2Usage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function hasIncompleteToolCallPart(parts: CompletedMessagePart[]): boolean {
  return parts.some((part) => part.type === "dynamic-tool" && part.state !== "output-available");
}

type DynamicToolCompletedMessagePart = Extract<CompletedMessagePart, { type: "dynamic-tool" }>;
type WorkflowRunToolAttachment = NonNullable<DynamicToolCompletedMessagePart["workflowRun"]>;

// Comprehensive stream info
interface WorkspaceStreamInfo {
  state: StreamState;
  streamResult: Awaited<ReturnType<typeof streamText>>;
  unlinkAbortSignal?: () => void;
  abortController: AbortController;
  workspaceName?: string;
  messageId: string;
  token: StreamToken;
  startTime: number;

  // Used to ensure part timestamps are strictly monotonic, even when multiple deltas land in the
  // same millisecond. This avoids collisions in reconnect replay dedupe logic which keys off of
  // (messageId, timestamp, delta).
  lastPartTimestamp: number;

  // Timestamp when each tool call reached output-available (tool-call-end emission).
  // Needed for reconnect replay filtering because dynamic-tool parts keep their
  // original start timestamp even after they gain output.
  toolCompletionTimestamps: Map<string, number>;

  // Workflow tools can create the durable run before their stream part is stored. Keep the exact
  // attachment and apply it as soon as the matching dynamic-tool part lands.
  pendingWorkflowRunAttachments: Map<string, WorkflowRunToolAttachment>;

  // Kernel-nested tool events can arrive before the fullStream consumer stores the parent
  // code_execution part (same race as pendingToolExecutionStarts). Buffer the nested records
  // by parent toolCallId and merge them when the parent part lands, so an interrupt in that
  // window doesn't lose the nested calls (or their workflow run identity) from partial.json.
  pendingNestedCalls: Map<string, NestedToolCall[]>;

  // execute() can begin (lock acquired in withSequentialExecution) before the fullStream
  // consumer has stored the matching dynamic-tool part. Keep the execution-start timestamp
  // and apply it as soon as the part lands.
  pendingToolExecutionStarts: Map<string, number>;

  model: string;
  /** Metadata model resolved from provider mapping for cost/token metadata lookups. */
  metadataModel: string;
  /** Effective thinking level after model policy clamping */
  thinkingLevel?: string;
  initialMetadata?: Partial<MuxMetadata>;
  toolModelUsages: PersistedToolModelUsage[];
  request: StreamRequestConfig;
  // Track last prepared step messages for safe retries after tool steps
  stepTracker: StepMessageTracker;
  // Track if a previousResponseId retry happened after a step completed so
  // stream-end uses cumulative usage instead of the retried step's totalUsage.
  didRetryPreviousResponseIdAtStep: boolean;
  // Track when Xum restarted the stream after an empty-output completion so
  // stream-end prefers cumulative usage across attempts instead of the final
  // attempt's totalUsage only.
  didRetryAfterEmptyOutput?: boolean;
  // Refusal-fallback chain state. `original` keeps the pre-wrap request inputs
  // (as passed by TurnRequestBuilder) that prepare() does not rebuild, so the request can
  // be rebuilt for a different model. System, tools, and messages are rebuilt
  // per fallback model by prepare() via the prompt assembler because they are
  // model-keyed (cache wrapping, provider web tools, MCP sanitization, model
  // sections) and must not leak across providers.
  modelFallback?: {
    options: ModelFallbackOptions;
    /** Canonical model originally requested for this turn (the chain source). */
    requestedModel: string;
    /** Canonical models that refused during this turn, in order. */
    refusedModels: string[];
    original: { maxOutputTokens?: number };
  };
  // Provider streams must prove semantic completion with a terminal SDK finish part.
  // A clean EOF can be a proxy/provider drop and must not finalize partial assistant text.
  receivedTerminalEvent: boolean;
  terminalFinishReason?: string;
  // Provider-raw finish reason (e.g. Anthropic's "refusal") kept alongside the
  // unified one so refusal classification can match either representation.
  terminalRawFinishReason?: string;
  // Index into parts where the current step started (used to ensure safe retries)
  currentStepStartIndex: number;
  // Exact SDK step starts; part shapes cannot distinguish consecutive tool-only steps.
  stepStartIndices: number[];
  historySequence: number;
  // Track accumulated parts for partial message (includes reasoning, text, and tools)
  parts: CompletedMessagePart[];
  // Reasoning parts before this index belong to refused fallback attempts whose
  // usage was already attributed separately; stream-end backfill must not bill
  // them again under the answering model.
  reasoningBackfillStartIndex?: number;
  // Track last partial write time for throttling
  lastPartialWriteTime: number;
  // Debounce fiber for throttled partial writes (Effect migration Phase 10).
  // Non-null exactly while a delayed flush is scheduled; interrupted on re-arm,
  // on explicit flush, and with resourceScope when the stream ends. Effect's
  // clock registers a plain setTimeout under the hood, so scheduling semantics
  // match the previous timer.
  partialWriteFiber?: Fiber.Fiber<void>;
  // Track in-flight write to serialize writes
  partialWritePromise?: Promise<void>;
  // Track background processing promise for guaranteed cleanup
  processingPromise: Promise<void>;
  // Latched by the first cancelStreamSafely call (synchronously, before its
  // first await) so concurrent cancellers — a user stop racing shutdown's
  // engine supervisor — join one cleanup: exactly one stream-abort, one settle.
  cancelPromise?: Promise<void>;
  // Set by the completion path right before it deletes partial.json and writes
  // the final message to chat.jsonl. From then on no partial may be written for
  // this stream: a cancel landing between deletePartial and COMPLETED (the
  // state flips late, see processStreamWithCleanup) would otherwise resurrect
  // partial.json through its pre-abort flush.
  partialRetired?: boolean;
  // Supervisor fiber in the app's AppFiberScope (superviseEngine); set only when
  // the manager was constructed with an engine scope.
  engineFiber?: Fiber.Fiber<void>;
  // Soft-interrupt state: when pending, stream will end at next block boundary
  softInterrupt:
    | { pending: false }
    | { pending: true; abandonPartial: boolean; abortReason: StreamAbortReason };
  // Temporary directory for tool outputs (auto-cleaned when stream ends)
  runtimeTempDir: string;
  // Runtime for temp directory cleanup
  runtime: Runtime;
  // Owns this stream's Effect-managed resources: the temp-dir release
  // finalizer (registered via acquireRelease in startStream) and the
  // scope-tied partial-write debounce fiber. Closed exactly once — by
  // processStreamWithCleanup's finally after registration, or by startStream
  // when registration fails. Optional: whitebox test fixtures register stream
  // infos without a resource scope.
  resourceScope?: Scope.Closeable;
  resourceCleanup?: Promise<void>;
  // Cumulative usage across all steps (for live cost display during streaming)
  cumulativeUsage: LanguageModelV2Usage;
  // Cumulative provider metadata across all steps (for live cost display with cache tokens)
  cumulativeProviderMetadata?: Record<string, unknown>;
  // Terminal model_refusal usage persisted on no-fallback error partials so live
  // and rebuilt session costs include the refused attempt.
  terminalRefusalUsage?: LanguageModelV2Usage;
  terminalRefusalProviderMetadata?: Record<string, unknown>;
  // Last step's usage (for context window display during streaming)
  lastStepUsage?: LanguageModelV2Usage;
  // Last step's provider metadata (for context window cache display)
  lastStepProviderMetadata?: Record<string, unknown>;
  completionController: TurnCompletionController;
  terminalCompletion?: TurnCompletion;
}

// Ensure per-stream part timestamps are strictly monotonic.
//
// Date.now() is millisecond-granularity, so two distinct chunks with identical text emitted in the
// same millisecond can otherwise collide on (timestamp, delta) during reconnect replay buffering.
function nextPartTimestamp(streamInfo: WorkspaceStreamInfo): number {
  const now = Date.now();
  const last = streamInfo.lastPartTimestamp;
  const timestamp = now <= last ? last + 1 : now;
  streamInfo.lastPartTimestamp = timestamp;
  return timestamp;
}

/**
 * StreamManager - Handles all streaming operations with type safety and atomic operations
 *
 * Key invariants:
 * - Only one active stream per workspace at any time
 * - Atomic stream creation/cancellation operations
 * - Guaranteed resource cleanup in all code paths
 */
interface PendingStreamStartHandle {
  readonly abortSignal: AbortSignal;
  readonly syntheticMessageId: string;
  finish(): void;
}

export interface StopStreamOptions {
  soft?: boolean;
  abandonPartial?: boolean;
  abortReason?: StreamAbortReason;
  /** Teardown of an already-settled attempt must not manufacture a second raw terminal. */
  emitIfMissing?: boolean;
}

interface MockStreamLifecycle {
  isStreaming(workspaceId: string): boolean;
  stop(workspaceId: string, options?: StopStreamOptions): Promise<void>;
  replayStream(workspaceId: string): Promise<void>;
}

export class StreamManager {
  private workspaceStreams = new Map<WorkspaceId, WorkspaceStreamInfo>();
  private readonly pendingStreamStarts = new Map<
    string,
    {
      abortController: AbortController;
      startTime: number;
      syntheticMessageId: string;
      abortDelivery?: Promise<void>;
      acpPromptId?: string;
    }
  >();
  private mockStreamLifecycle?: MockStreamLifecycle;
  private streamLocks = new Map<WorkspaceId, AsyncMutex>();
  private readonly PARTIAL_WRITE_THROTTLE_MS = 500;
  private readonly historyService: HistoryService;
  private mcpServerManager?: MCPServerManager;
  private readonly sessionUsageService?: SessionUsageService;
  private readonly getProvidersConfig: () => ProvidersConfigMap | null;
  private eventSink: TurnEngineEventSink;
  /**
   * Runs the clock-driven lifecycle fibers (partial-write debounce and its
   * interrupt) and is handed to per-session workers that must share this
   * stream's clock (`RetryManager`, via `AgentSessionStreamManager`). The app
   * runtime's context-bound runner in production — a `TestClock` in tests —
   * and the global runtime wherever nothing is injected (di/effectRunner.ts).
   */
  public readonly effectRunner: EffectRunner;
  /**
   * Supervised scope for the stream engine (the app runtime's `AppFiberScope`,
   * di/appFiberScope.ts). When set, every started stream is wrapped in a
   * supervisor fiber forked here (`superviseEngine`), so
   * `ServiceContainer.dispose()`/the CLI cleanup lists interrupt **and await**
   * in-flight streams — aborted as `"system"`, partial flushed and committed —
   * before the bridges and sessions are torn down. `undefined` (direct
   * construction in tests, `aiService.ts` compat path) keeps streams
   * unsupervised: they die with the process and are recovered from
   * partial.json on next load.
   */
  private readonly engineScope?: Scope.Closeable;
  // Token tracker for live streaming statistics
  private tokenTracker = new StreamingTokenTracker();
  // Track OpenAI previousResponseIds that have been invalidated
  // When frontend retries, buildProviderOptions will omit these IDs
  //
  // Effect migration Phase 10: stays a plain Set by the plain-mutables rule —
  // every mutator runs in a non-Effect context (AI-SDK error paths inside
  // processStreamWithCleanup) and no fiber reads or mutates it, so a Ref would
  // add ceremony without adding safety.
  private lostResponseIds = new Set<string>();

  constructor(
    historyService: HistoryService,
    sessionUsageService?: SessionUsageService,
    getProvidersConfig?: () => ProvidersConfigMap | null,
    eventSink: TurnEngineEventSink = () => undefined,
    runner: EffectRunner = defaultEffectRunner,
    engineScope?: Scope.Closeable
  ) {
    this.historyService = historyService;
    this.sessionUsageService = sessionUsageService;
    this.getProvidersConfig = getProvidersConfig ?? (() => null);
    this.eventSink = eventSink;
    this.effectRunner = runner;
    this.engineScope = engineScope;
  }

  setEventSink(eventSink: TurnEngineEventSink): void {
    this.eventSink = eventSink;
  }

  private emitTurnEvent(event: TurnEngineEvent): void {
    // TurnEngineEventSink may return a promise; non-abort delivery stays
    // fire-and-forget, so contain rejections here or a failing async sink
    // becomes an unhandled rejection. Abort delivery is sequenced separately
    // via emitStreamAbort.
    void Promise.resolve(this.eventSink(event)).catch((error) => {
      log.error("Turn event sink failed", { eventType: event.type, error: getErrorMessage(error) });
    });
  }

  private getWorkspaceLogger(
    workspaceId: WorkspaceId,
    streamInfo?: Pick<WorkspaceStreamInfo, "workspaceName">
  ): Logger {
    const fields: Record<string, unknown> = { workspaceId };
    if (streamInfo?.workspaceName) {
      fields.workspaceName = streamInfo.workspaceName;
    }
    return log.withFields(fields);
  }
  resolveMetadataModel(modelString: string, providersConfigSnapshot?: ProvidersConfigMap): string {
    try {
      // A caller's pinned request snapshot wins over the live config so the
      // recorded identity matches the request that was actually built (a
      // concurrent catalog refresh can retag/remove the instance mid-turn).
      return resolveModelForMetadata(
        modelString,
        providersConfigSnapshot ?? this.getProvidersConfig()
      );
    } catch (error) {
      log.debug("Failed to resolve metadata model override", {
        modelString,
        error: getErrorMessage(error),
      });
      return modelString;
    }
  }

  setMCPServerManager(manager: MCPServerManager | undefined): void {
    this.mcpServerManager = manager;
  }

  setMockStreamLifecycle(lifecycle: MockStreamLifecycle | undefined): void {
    this.mockStreamLifecycle = lifecycle;
  }

  getStartupAbortReason(signal?: AbortSignal): StreamAbortReason {
    const reason: unknown = signal?.reason;
    return reason === "user" || reason === "system" || reason === "startup" ? reason : "startup";
  }

  beginStreamStart(input: {
    workspaceId: string;
    abortSignal?: AbortSignal;
    acpPromptId?: string;
  }): PendingStreamStartHandle {
    const abortController = new AbortController();
    const startTime = Date.now();
    const syntheticMessageId =
      "starting-" + startTime + "-" + Math.random().toString(36).substring(2, 11);
    const unlinkAbortSignal = linkAbortSignal(input.abortSignal, abortController);

    this.pendingStreamStarts.set(input.workspaceId, {
      abortController,
      startTime,
      syntheticMessageId,
      acpPromptId: input.acpPromptId,
    });

    let finished = false;
    return {
      abortSignal: abortController.signal,
      syntheticMessageId,
      finish: () => {
        if (finished) return;
        finished = true;
        unlinkAbortSignal();
        const pending = this.pendingStreamStarts.get(input.workspaceId);
        if (pending?.abortController === abortController) {
          this.pendingStreamStarts.delete(input.workspaceId);
        }
      },
    };
  }

  recordToolModelUsage(
    workspaceId: string,
    messageId: string,
    event: PersistedToolModelUsage
  ): void {
    const streamInfo = this.workspaceStreams.get(workspaceId as WorkspaceId);
    if (streamInfo?.messageId !== messageId) {
      return;
    }

    streamInfo.toolModelUsages.push(clonePersistedToolModelUsage(event));
  }

  private getWorkflowRunAttachment(event: WorkflowRunAttachedEvent): WorkflowRunToolAttachment {
    return {
      runId: event.runId,
      ...(event.run != null ? { run: event.run } : {}),
      timestamp: event.timestamp,
    };
  }

  private takePendingWorkflowRunAttachment(
    streamInfo: WorkspaceStreamInfo,
    toolCallId: string
  ): WorkflowRunToolAttachment | undefined {
    const pendingAttachments = (streamInfo.pendingWorkflowRunAttachments ??= new Map());
    const attachment = pendingAttachments.get(toolCallId);
    if (attachment != null) {
      pendingAttachments.delete(toolCallId);
    }
    return attachment;
  }

  private emitWorkflowRunAttachedFromAttachment(input: {
    workspaceId: WorkspaceId;
    messageId: string;
    toolCallId: string;
    attachment: WorkflowRunToolAttachment;
  }): void {
    this.emitTurnEvent({
      type: "workflow-run-attached",
      workspaceId: input.workspaceId as string,
      messageId: input.messageId,
      toolCallId: input.toolCallId,
      runId: input.attachment.runId,
      ...(input.attachment.run != null ? { run: input.attachment.run } : {}),
      timestamp: input.attachment.timestamp,
    } satisfies WorkflowRunAttachedEvent);
  }

  async attachWorkflowRunToToolCall(event: WorkflowRunAttachedEvent): Promise<boolean> {
    const workspaceId = event.workspaceId as WorkspaceId;
    const streamInfo = this.workspaceStreams.get(workspaceId);
    if (
      streamInfo == null ||
      (event.messageId != null && streamInfo.messageId !== event.messageId)
    ) {
      return false;
    }

    const attachment = this.getWorkflowRunAttachment(event);
    const partIndex = streamInfo.parts.findIndex(
      (part) => part.type === "dynamic-tool" && part.toolCallId === event.toolCallId
    );
    if (partIndex === -1) {
      // Kernel-launched workflows target a NESTED call persisted on a
      // code_execution part (see emitNestedToolEvent), not a top-level part.
      if (
        await this.attachWorkflowRunToNestedCall(
          workspaceId,
          streamInfo,
          event.toolCallId,
          attachment
        )
      ) {
        return true;
      }
      (streamInfo.pendingWorkflowRunAttachments ??= new Map()).set(event.toolCallId, attachment);
      return true;
    }

    const part = streamInfo.parts[partIndex];
    if (part.type !== "dynamic-tool") {
      return false;
    }

    streamInfo.pendingWorkflowRunAttachments?.delete(event.toolCallId);
    streamInfo.parts[partIndex] = {
      ...part,
      workflowRun: attachment,
    };

    await this.flushPartialWrite(workspaceId, streamInfo);
    return true;
  }

  /**
   * A nested call's persisted attachment keeps only the run identity: the full
   * WorkflowRunRecord carries the workflow source and invocation args, which
   * would ride into partial.json unbounded and defeat the kernel record caps
   * that already replaced the nested args/result with markers. The frontend
   * re-fetches the durable run by runId. (The live workflow-run-attached event
   * still carries the full run snapshot.)
   */
  private static toNestedWorkflowRunAttachment(
    attachment: WorkflowRunToolAttachment
  ): WorkflowRunToolAttachment {
    return { runId: attachment.runId, timestamp: attachment.timestamp };
  }

  /**
   * Persist a workflow run attachment onto the nested call record it targets,
   * so a kernel-launched run's identity survives reload even when kernel
   * bounding replaced the nested args/result with a marker. The live event
   * still reaches the frontend through the normal emit path.
   */
  private async attachWorkflowRunToNestedCall(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    toolCallId: string,
    attachment: WorkflowRunToolAttachment
  ): Promise<boolean> {
    const nestedAttachment = StreamManager.toNestedWorkflowRunAttachment(attachment);
    for (const part of streamInfo.parts) {
      if (part.type !== "dynamic-tool") {
        continue;
      }
      const parentPart = part as { nestedCalls?: NestedToolCall[] };
      const nestedCalls = parentPart.nestedCalls;
      const nestedIndex =
        nestedCalls?.findIndex((nested) => nested.toolCallId === toolCallId) ?? -1;
      if (nestedCalls == null || nestedIndex === -1) {
        continue;
      }
      nestedCalls[nestedIndex] = { ...nestedCalls[nestedIndex], workflowRun: nestedAttachment };
      await this.flushPartialWrite(workspaceId, streamInfo);
      return true;
    }
    // The nested record may still be buffered because its parent part has not
    // landed yet; attach there so the merge in appendPartAndEmit persists it.
    for (const buffered of streamInfo.pendingNestedCalls?.values() ?? []) {
      const nestedIndex = buffered.findIndex((nested) => nested.toolCallId === toolCallId);
      if (nestedIndex !== -1) {
        buffered[nestedIndex] = { ...buffered[nestedIndex], workflowRun: nestedAttachment };
        return true;
      }
    }
    return false;
  }

  /**
   * Record on the dynamic-tool part when its execute() actually began running and notify
   * the UI. Returns false when the part has not landed in streamInfo.parts yet.
   */
  private applyToolExecutionStart(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    toolCallId: string,
    timestamp: number
  ): boolean {
    const partIndex = streamInfo.parts.findIndex(
      (part) => part.type === "dynamic-tool" && part.toolCallId === toolCallId
    );
    if (partIndex === -1) {
      return false;
    }

    const part = streamInfo.parts[partIndex];
    assert(part.type === "dynamic-tool", "applyToolExecutionStart matched a non-tool part");
    streamInfo.parts[partIndex] = { ...part, executionStartedAt: timestamp };

    this.emitTurnEvent({
      type: "tool-call-execution-start",
      workspaceId: workspaceId as string,
      messageId: streamInfo.messageId,
      toolCallId,
      timestamp,
    } satisfies ToolCallExecutionStartEvent);
    return true;
  }

  /**
   * Called from withSequentialExecution the moment a tool call's execute() acquires the
   * execution lock. Parallel tool calls run sequentially, so this is the honest start of
   * execution — the part's own `timestamp` only marks when the model emitted the call.
   */
  private handleToolExecutionStart(
    workspaceId: WorkspaceId,
    messageId: string,
    toolCallId: string
  ): void {
    const streamInfo = this.workspaceStreams.get(workspaceId);
    if (streamInfo?.messageId !== messageId) {
      return;
    }

    // Use the stream's monotonic clock, not raw Date.now(): the tool-call part timestamp
    // was monotonicized by nextPartTimestamp(), so a same-millisecond raw reading could be
    // <= it. Reconnect replay repairs missed execution starts only when
    // executionStartedAt > cursor, and the cursor sits at the tool-call timestamp when the
    // client disconnected right after tool-call-start.
    const timestamp = nextPartTimestamp(streamInfo);
    if (!this.applyToolExecutionStart(workspaceId, streamInfo, toolCallId, timestamp)) {
      // execute() won the race against the fullStream consumer; the "tool-call" case
      // consumes this entry right after storing the part.
      (streamInfo.pendingToolExecutionStarts ??= new Map()).set(toolCallId, timestamp);
    }
  }

  /**
   * Write the current partial message to disk (throttled by mtime)
   * Ensures writes happen during rapid streaming (crash-resilient)
   */
  private async schedulePartialWrite(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ): Promise<void> {
    const now = Date.now();
    const timeSinceLastWrite = now - streamInfo.lastPartialWriteTime;

    // If enough time has passed, write immediately
    if (timeSinceLastWrite >= this.PARTIAL_WRITE_THROTTLE_MS) {
      await this.flushPartialWrite(workspaceId, streamInfo);
      return;
    }

    // Otherwise, schedule a delayed flush (fire-and-forget for scheduled
    // writes). Re-arming replaces the previous debounce fiber, mirroring the
    // previous clearTimeout.
    this.interruptPartialWriteFiber(streamInfo);

    const remainingTime = this.PARTIAL_WRITE_THROTTLE_MS - timeSinceLastWrite;
    const delayedFlush = Effect.sleep(Duration.millis(remainingTime)).pipe(
      // Clear the self-reference before flushing so flushPartialWrite's re-arm
      // cancellation cannot interrupt the very fiber performing the flush.
      Effect.flatMap(() =>
        Effect.sync(() => {
          streamInfo.partialWriteFiber = undefined;
        })
      ),
      // Async thunk: flush errors are contained inside flushPartialWrite, so
      // this mirrors the previous `void this.flushPartialWrite(...)` callback.
      Effect.flatMap(() =>
        Effect.promise(async () => this.flushPartialWrite(workspaceId, streamInfo))
      )
    );

    // Fork into the stream's resource scope so a pending flush is interrupted
    // with the stream — a debounced write must never fire after the stream
    // ends and resurrect partial.json. runFork/forkIn execute synchronously up
    // to the sleep, so the debounce delay is registered before this method
    // returns (same observable ordering as the previous setTimeout call).
    streamInfo.partialWriteFiber = streamInfo.resourceScope
      ? this.effectRunner.runSync(Effect.forkIn(delayedFlush, streamInfo.resourceScope))
      : // Whitebox test fixtures register stream infos without a resource scope.
        this.effectRunner.runFork(delayedFlush);
  }

  /**
   * Interrupt a scheduled (not yet flushed) partial-write debounce fiber, if
   * any. The interrupt is fire-and-forget: the signal lands synchronously for
   * a fiber sleeping on Effect's clock (house pattern: retryManager), which
   * mirrors the previous clearTimeout semantics.
   */
  private interruptPartialWriteFiber(streamInfo: WorkspaceStreamInfo): void {
    const fiber = streamInfo.partialWriteFiber;
    if (fiber == null) {
      return;
    }
    streamInfo.partialWriteFiber = undefined;
    this.effectRunner.runFork(Fiber.interrupt(fiber));
  }

  private async awaitPendingPartialWrite(streamInfo: WorkspaceStreamInfo): Promise<void> {
    if (streamInfo.partialWritePromise) {
      await streamInfo.partialWritePromise;
    }
  }

  /**
   * Flush any pending partial write and write immediately
   * Serializes writes to prevent races - waits for any in-flight write before starting new one
   */
  private async flushPartialWrite(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ): Promise<void> {
    // Wait for any in-flight write to complete first (serialization)
    await this.awaitPendingPartialWrite(streamInfo);

    // Cancel any scheduled debounce flush — we're writing now
    this.interruptPartialWriteFiber(streamInfo);

    // The final message owns chat.jsonl now; re-creating partial.json here (a
    // cancel racing the completion path) would be committed over it on next load.
    if (streamInfo.partialRetired) {
      return;
    }

    // Start new write and track the promise
    streamInfo.partialWritePromise = (async () => {
      try {
        await this.historyService.writePartial(
          workspaceId as string,
          this.buildPartialAssistantMessage(streamInfo)
        );
        streamInfo.lastPartialWriteTime = Date.now();
      } catch (error) {
        log.error("Failed to write partial message:", error);
      } finally {
        // Clear promise when write completes
        streamInfo.partialWritePromise = undefined;
      }
    })();

    // Wait for this write to complete
    await streamInfo.partialWritePromise;
  }

  /**
   * Atomically ensures stream safety by cancelling any existing stream
   * @param workspaceId The workspace to ensure stream safety for
   * @returns A unique stream token for the new stream
   */
  private async ensureStreamSafety(workspaceId: WorkspaceId): Promise<StreamToken> {
    const existing = this.workspaceStreams.get(workspaceId);

    if (existing && existing.state !== StreamState.IDLE) {
      await this.cancelStreamSafely(workspaceId, existing, "system", undefined);
    }

    // Generate unique token for this stream (8 hex chars for context efficiency)
    return Math.random().toString(16).substring(2, 10) as StreamToken;
  }

  /**
   * Generate a unique stream token (8 hex characters)
   * Used by callers that need to prepare resources (like tools) before starting the stream
   * Uses 8 hex chars instead of UUID for context efficiency (shorter paths in agent output)
   */
  public generateStreamToken(): StreamToken {
    return Math.random().toString(16).substring(2, 10) as StreamToken;
  }

  /**
   * Create a temporary directory for a stream token
   * Use ~/.xum-tmp instead of system temp directory (e.g., /var/folders/...)
   * because macOS user-scoped temp paths are extremely long, which leads to:
   * - Agent mistakes when copying/manipulating paths
   * - Harder to read in tool outputs
   * - Potential path length issues on some systems
   *
   * Uses the Runtime abstraction so temp directories work for both local and SSH runtimes.
   */
  public async createTempDirForStream(streamToken: StreamToken, runtime: Runtime): Promise<string> {
    const tempDir = `~/.xum-tmp/${streamToken}`;

    // Resolve ~ in the runtime's context: callers need the canonical absolute
    // path as a value, and reusing it for ensureDir avoids a second remote
    // resolution round trip per stream on SSH runtimes.
    let resolvedPath = (await runtime.resolvePath(tempDir)).trim();

    // In the main process, PlatformPaths defaults to POSIX behavior (no navigator),
    // so we normalize Windows paths to forward slashes.
    if (process.platform === "win32") {
      resolvedPath = resolvedPath.replace(/\\/g, "/");
    }

    try {
      await runtime.ensureDir(resolvedPath);
    } catch (err) {
      const msg = getErrorMessage(err);
      throw new Error(`Failed to create temp directory ${resolvedPath}: ${msg}`);
    }

    return resolvedPath;
  }

  private cleanupStreamTempDir(runtime: Runtime, runtimeTempDir: string): void {
    // Use parent directory as cwd for safety - if runtimeTempDir is malformed,
    // we won't accidentally run rm -rf from root.
    const tempDirBasename = PlatformPaths.basename(runtimeTempDir);
    const tempDirParent = path.dirname(runtimeTempDir);

    // Fire-and-forget: don't block stream completion waiting for directory deletion.
    // This is especially important for SSH where rm -rf can take 500ms-2s.
    void runtime
      .exec(`rm -rf ${shellQuote(tempDirBasename)}`, {
        cwd: tempDirParent,
        timeout: 10,
      })
      .then(async (result) => {
        await result.exitCode;
        log.debug(`Cleaned up temp dir: ${runtimeTempDir}`);
      })
      .catch((error) => {
        log.error(`Failed to cleanup temp dir ${runtimeTempDir}:`, error);
      });
  }

  /**
   * Extracts usage and duration metadata from stream result.
   *
   * Usage is only available after stream completes naturally.
   * On abort, the usage promise may hang - we use a timeout to return quickly.
   */
  private async emitToolCallDeltaIfPresent(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    part: unknown
  ): Promise<boolean> {
    const maybeDelta = part as { type?: string } | undefined;
    if (maybeDelta?.type !== "tool-call-delta") {
      return false;
    }

    const toolDelta = part as {
      toolCallId: string;
      toolName: string;
      argsTextDelta: string;
    };

    const deltaText = String(toolDelta.argsTextDelta ?? "");
    if (deltaText.length === 0) {
      return true;
    }

    const tokens = await this.tokenTracker.countTokens(deltaText);
    const timestamp = Date.now();

    this.emitTurnEvent({
      type: "tool-call-delta",
      workspaceId: workspaceId as string,
      messageId: streamInfo.messageId,
      toolCallId: toolDelta.toolCallId,
      toolName: toolDelta.toolName,
      delta: toolDelta.argsTextDelta,
      tokens,
      timestamp,
    });

    return true;
  }

  private async getStreamMetadata(
    streamInfo: WorkspaceStreamInfo,
    timeoutMs = 1000
  ): Promise<{
    totalUsage?: LanguageModelV2Usage;
    contextUsage?: LanguageModelV2Usage;
    contextProviderMetadata?: Record<string, unknown>;
    finishReason?: string;
    duration: number;
  }> {
    // Helper: wrap promise with independent timeout + error handling
    // Each promise resolves independently - one failure doesn't mask others
    const withTimeout = <T>(promise: PromiseLike<T>): Promise<T | undefined> =>
      Promise.race([
        promise,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
      ]).catch(() => undefined);

    // Fetch all metadata in parallel with independent timeouts
    // - totalUsage: sum of all steps (for cost calculation). AI SDK 7's
    //   top-level `usage` accumulates across all steps (old `totalUsage`).
    // - contextUsage: last step only (for context window display) — moved to
    //   `finalStep.usage` in AI SDK 7.
    // - contextProviderMetadata: last step (for context window cache display)
    const streamResultWithFinishReason = streamInfo.streamResult as {
      finishReason?: PromiseLike<string>;
    };
    const [totalUsageRaw, finalStep, finishReason] = await Promise.all([
      withTimeout(streamInfo.streamResult.usage),
      withTimeout(streamInfo.streamResult.finalStep),
      streamResultWithFinishReason.finishReason
        ? withTimeout(streamResultWithFinishReason.finishReason)
        : Promise.resolve(undefined),
    ]);

    return {
      totalUsage: normalizeUsage(totalUsageRaw),
      contextUsage: normalizeUsage(finalStep?.usage),
      // AI SDK 7 moved Anthropic cache-write tokens off provider metadata;
      // re-inject from the final step's usage so cache display keeps working.
      contextProviderMetadata: withCacheWriteMetadata(
        finalStep?.providerMetadata,
        finalStep?.usage
      ),
      finishReason,
      duration: Date.now() - streamInfo.startTime,
    };
  }

  private resolveTotalUsageForStreamEnd(
    streamInfo: WorkspaceStreamInfo,
    totalUsage: LanguageModelV2Usage | undefined
  ): LanguageModelV2Usage | undefined {
    const cumulativeUsage = streamInfo.cumulativeUsage;
    if (
      (streamInfo.didRetryPreviousResponseIdAtStep || streamInfo.didRetryAfterEmptyOutput) &&
      hasTokenUsage(cumulativeUsage)
    ) {
      return cumulativeUsage;
    }

    // streamResult.totalUsage is read with a short timeout (getStreamMetadata) and can
    // resolve to undefined under slow SDK settlement even though the provider billed the
    // turn. Fall back to the live per-step accumulation so completed streams never
    // persist an unpriced assistant message (analytics prices rows from metadata.usage).
    if (!hasTokenUsage(totalUsage) && hasTokenUsage(cumulativeUsage)) {
      return cumulativeUsage;
    }

    return totalUsage;
  }

  private async backfillReasoningTokensFromParts(
    streamInfo: Pick<
      WorkspaceStreamInfo,
      "parts" | "metadataModel" | "model" | "reasoningBackfillStartIndex"
    >,
    usage: LanguageModelV2Usage | undefined
  ): Promise<void> {
    // Backfill reasoningTokens from the full reasoning text when the provider
    // doesn't report them. @ai-sdk/anthropic sets reasoning: undefined even for
    // extended-thinking models. Tokenizing concatenated text (not per-delta
    // sums) avoids BPE chunk-boundary inflation.
    if (!usage || usage.reasoningTokens) {
      return;
    }

    const reasoningText = streamInfo.parts
      .slice(streamInfo.reasoningBackfillStartIndex ?? 0)
      .filter(
        (part): part is Extract<CompletedMessagePart, { type: "reasoning" }> =>
          part.type === "reasoning"
      )
      .map((part) => part.text)
      .join("");
    if (!reasoningText) {
      return;
    }

    usage.reasoningTokens = await countTokens(
      streamInfo.metadataModel ?? streamInfo.model,
      reasoningText
    );
  }

  private resolveTtftMsForStreamEnd(streamInfo: WorkspaceStreamInfo): number | undefined {
    const firstTokenPart = streamInfo.parts.find(
      (
        part
      ): part is Extract<
        CompletedMessagePart,
        { type: "text" | "reasoning"; timestamp?: number }
      > => (part.type === "text" || part.type === "reasoning") && part.text.length > 0
    );

    if (!firstTokenPart) {
      return undefined;
    }

    if (!Number.isFinite(streamInfo.startTime)) {
      return undefined;
    }

    const firstTokenTimestamp = firstTokenPart.timestamp;
    if (typeof firstTokenTimestamp !== "number" || !Number.isFinite(firstTokenTimestamp)) {
      return undefined;
    }

    const ttftMs = Math.max(0, firstTokenTimestamp - streamInfo.startTime);
    return Number.isFinite(ttftMs) ? ttftMs : undefined;
  }

  /**
   * Aggregate provider metadata across all steps.
   *
   * CRITICAL: For multi-step tool calls, cache creation tokens are reported per-step.
   * streamResult.providerMetadata only contains the LAST step's metadata, missing
   * cache creation tokens from earlier steps. We must sum across all steps.
   */
  private async getAggregatedProviderMetadata(
    streamInfo: WorkspaceStreamInfo,
    timeoutMs = 1000
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const steps = await Promise.race([
        streamInfo.streamResult.steps,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
      ]);

      if (!steps || steps.length === 0) {
        // Fall back to the final step's provider metadata; AI SDK 7 reports
        // cache writes on usage, so re-inject them for downstream pricing.
        const finalStep = await streamInfo.streamResult.finalStep;
        return withCacheWriteMetadata(finalStep.providerMetadata, finalStep.usage);
      }

      // Aggregate cache creation tokens across all steps. AI SDK 7 moved
      // per-step cache-write tokens from providerMetadata.anthropic to
      // step.usage.inputTokenDetails, so inject them back per step before
      // accumulating (accumulateProviderMetadata sums across steps).
      let accumulated: Record<string, unknown> | undefined;
      for (const step of steps) {
        accumulated = accumulateProviderMetadata(
          accumulated,
          withCacheWriteMetadata(step.providerMetadata, step.usage)
        );
      }
      return accumulated;
    } catch (error) {
      log.debug("Could not aggregate provider metadata:", error);
      return undefined;
    }
  }

  /**
   * Safely cancels an existing stream with proper cleanup
   *
   * CRITICAL: Waits for the processing promise to complete before cleanup.
   * This ensures the old stream fully exits before a new stream can start,
   * preventing concurrent streams and race conditions.
   */
  /**
   * Convert a part to an event and emit it.
   * Shared between live streaming and replay to ensure consistent event emission.
   * This guarantees replay reconstructs the exact stream using the same tokenization logic.
   *
   * @param workspaceId - Workspace identifier
   * @param messageId - Message identifier
   * @param part - The part to emit (text, reasoning, or tool)
   */
  private async emitPartAsEvent(
    workspaceId: WorkspaceId,
    messageId: string,
    part: CompletedMessagePart,
    options?: { replay?: boolean }
  ): Promise<void> {
    const timestamp = part.timestamp ?? Date.now();
    const isReplay = options?.replay === true;

    if (part.type === "text") {
      const tokens = await this.tokenTracker.countTokens(part.text);
      this.emitTurnEvent({
        type: "stream-delta",
        workspaceId: workspaceId as string,
        messageId,
        ...(isReplay ? { replay: true } : {}),
        delta: part.text,
        tokens,
        timestamp,
      });
    } else if (part.type === "reasoning") {
      const tokens = await this.tokenTracker.countTokens(part.text);
      this.emitTurnEvent({
        type: "reasoning-delta",
        workspaceId: workspaceId as string,
        messageId,
        ...(isReplay ? { replay: true } : {}),
        delta: part.text,
        tokens,
        timestamp,
        signature: part.signature,
      });
    } else if (part.type === "dynamic-tool") {
      const inputText = JSON.stringify(part.input);
      const tokens = await this.tokenTracker.countTokens(inputText);
      this.emitTurnEvent({
        type: "tool-call-start",
        workspaceId: workspaceId as string,
        messageId,
        ...(isReplay ? { replay: true } : {}),
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        args: part.input,
        tokens,
        timestamp,
        // Replays rebuild parts from scratch; carry the real execution start so
        // elapsed timers don't restart from the model-emission timestamp.
        ...(part.executionStartedAt !== undefined
          ? { executionStartedAt: part.executionStartedAt }
          : {}),
      });

      if (part.workflowRun != null) {
        this.emitTurnEvent({
          type: "workflow-run-attached",
          workspaceId: workspaceId as string,
          messageId,
          ...(isReplay ? { replay: true } : {}),
          toolCallId: part.toolCallId,
          runId: part.workflowRun.runId,
          ...(part.workflowRun.run != null ? { run: part.workflowRun.run } : {}),
          timestamp: part.workflowRun.timestamp,
        } satisfies WorkflowRunAttachedEvent);
      }

      // Replays rebuild renderer state from persisted parts, but nested kernel
      // calls (and their workflow run identities) live on the parent part and
      // are only ever live-emitted by emitNestedToolEvent; without re-emitting
      // them here a reconnect rebuilds the code_execution card without its
      // nested rows. Live appends never carry nestedCalls (buffered nested
      // records merge after this emit), so this only fires on replay in practice.
      const nestedCalls = (part as { nestedCalls?: NestedToolCall[] }).nestedCalls ?? [];
      this.emitNestedCallEvents(workspaceId, messageId, part.toolCallId, nestedCalls, {
        replay: isReplay,
        fallbackTimestamp: timestamp,
      });

      // If tool has output, emit completion
      if (part.state === "output-available") {
        this.emitTurnEvent({
          type: "tool-call-end",
          workspaceId: workspaceId as string,
          messageId,
          ...(isReplay ? { replay: true } : {}),
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          result: part.output,
          timestamp: Date.now(),
        });
      }
    }
  }

  /**
   * Emit a nested call's full event sequence (start, workflow attachment, end)
   * on behalf of its parent part. Used when the renderer could not have applied
   * the original live events: reconnect replays, and the buffered-merge path in
   * appendPartAndEmit where the original events raced ahead of the parent part.
   * The aggregator dedupes re-delivered nested starts by toolCallId.
   */
  private emitNestedCallEvents(
    workspaceId: WorkspaceId,
    messageId: string,
    parentToolCallId: string,
    nestedCalls: NestedToolCall[],
    options: { replay?: boolean; fallbackTimestamp: number }
  ): void {
    const isReplay = options.replay === true;
    for (const nested of nestedCalls) {
      this.emitTurnEvent({
        type: "tool-call-start",
        workspaceId: workspaceId as string,
        messageId,
        ...(isReplay ? { replay: true } : {}),
        toolCallId: nested.toolCallId,
        toolName: nested.toolName,
        args: nested.input ?? {},
        tokens: 0,
        timestamp: nested.timestamp ?? options.fallbackTimestamp,
        parentToolCallId,
      });
      if (nested.workflowRun != null) {
        this.emitTurnEvent({
          type: "workflow-run-attached",
          workspaceId: workspaceId as string,
          messageId,
          ...(isReplay ? { replay: true } : {}),
          toolCallId: nested.toolCallId,
          runId: nested.workflowRun.runId,
          ...(nested.workflowRun.run != null ? { run: nested.workflowRun.run } : {}),
          timestamp: nested.workflowRun.timestamp,
        } satisfies WorkflowRunAttachedEvent);
      }
      if (nested.state === "output-available") {
        this.emitTurnEvent({
          type: "tool-call-end",
          workspaceId: workspaceId as string,
          messageId,
          ...(isReplay ? { replay: true } : {}),
          toolCallId: nested.toolCallId,
          toolName: nested.toolName,
          result: nested.output,
          timestamp: Date.now(),
          parentToolCallId,
        });
      }
    }
  }

  private async appendPartAndEmit(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    part: CompletedMessagePart,
    schedulePartialWrite = false
  ): Promise<void> {
    // Emit BEFORE adding to streamInfo.parts.
    //
    // On reconnect, we call replayStream() which snapshots streamInfo.parts. If we push a part to
    // streamInfo.parts and then await tokenization/emit, replay can include the "in-flight" part
    // and then the live emit still happens, causing duplicate deltas in the renderer.
    try {
      await this.emitPartAsEvent(workspaceId, streamInfo.messageId, part);
    } finally {
      // Always persist the part in-memory (and to partial.json, if enabled), even if emit fails.
      let partToPersist = part;
      let pendingAttachment: WorkflowRunToolAttachment | undefined;
      let pendingExecutionStart: number | undefined;
      let bufferedNestedCalls: NestedToolCall[] | undefined;
      if (part.type === "dynamic-tool") {
        pendingAttachment = this.takePendingWorkflowRunAttachment(streamInfo, part.toolCallId);
        // execute() may have started (lock acquired) before the fullStream consumer
        // stored this part; carry the real execution start onto the persisted part.
        pendingExecutionStart = streamInfo.pendingToolExecutionStarts?.get(part.toolCallId);
        if (pendingExecutionStart !== undefined) {
          streamInfo.pendingToolExecutionStarts.delete(part.toolCallId);
        }
        // Nested kernel events may have arrived (and been buffered) in the same
        // race window; merge them so they persist with the parent part. Their
        // live events already reached the frontend at emission time.
        bufferedNestedCalls = streamInfo.pendingNestedCalls?.get(part.toolCallId);
        if (bufferedNestedCalls !== undefined) {
          streamInfo.pendingNestedCalls.delete(part.toolCallId);
        }
        if (
          pendingAttachment != null ||
          pendingExecutionStart !== undefined ||
          bufferedNestedCalls !== undefined
        ) {
          partToPersist = {
            ...part,
            ...(pendingAttachment != null ? { workflowRun: pendingAttachment } : {}),
            ...(pendingExecutionStart !== undefined
              ? { executionStartedAt: pendingExecutionStart }
              : {}),
            ...(bufferedNestedCalls !== undefined ? { nestedCalls: bufferedNestedCalls } : {}),
          };
        }
      }
      streamInfo.parts.push(partToPersist);
      if (pendingExecutionStart !== undefined && part.type === "dynamic-tool") {
        this.emitTurnEvent({
          type: "tool-call-execution-start",
          workspaceId: workspaceId as string,
          messageId: streamInfo.messageId,
          toolCallId: part.toolCallId,
          timestamp: pendingExecutionStart,
        } satisfies ToolCallExecutionStartEvent);
      }
      if (bufferedNestedCalls !== undefined && part.type === "dynamic-tool") {
        if (pendingAttachment == null) {
          // Buffered nested calls can carry a workflow run identity that must
          // survive an interrupt; don't wait for the debounced write.
          await this.flushPartialWrite(workspaceId, streamInfo);
        }
        // The original nested events raced ahead of the parent part, so the
        // renderer dropped them (it refuses parented events with no parent
        // row); re-deliver them now that the parent start has been emitted.
        this.emitNestedCallEvents(
          workspaceId,
          streamInfo.messageId,
          part.toolCallId,
          bufferedNestedCalls,
          { fallbackTimestamp: part.timestamp ?? Date.now() }
        );
      }
      if (pendingAttachment != null && part.type === "dynamic-tool") {
        await this.flushPartialWrite(workspaceId, streamInfo);
        this.emitWorkflowRunAttachedFromAttachment({
          workspaceId,
          messageId: streamInfo.messageId,
          toolCallId: part.toolCallId,
          attachment: pendingAttachment,
        });
      } else if (schedulePartialWrite) {
        void this.schedulePartialWrite(workspaceId, streamInfo);
      }
    }
  }

  private async cancelStreamSafely(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    abortReason: StreamAbortReason,
    abandonPartial?: boolean
  ): Promise<void> {
    // If stream already completed normally (emitted stream-end), wait for its
    // finally block to finish before returning. This happens when ensureStreamSafety
    // is called for a new stream after the previous one finished but before it was
    // removed from workspaceStreams.
    // Without this guard, we'd emit stream-abort after stream-end, causing the
    // frontend to incorrectly flip the message back to partial:true.
    // We must NOT delete workspaceStreams here — the finally block does that.
    // If we delete early, the finally block's delete could race with a new stream
    // being registered and delete the new stream's entry instead.
    if (streamInfo.state === StreamState.COMPLETED) {
      await streamInfo.processingPromise;
      return;
    }

    // Idempotent for concurrent cancellers (a user stop racing the shutdown
    // supervisor's "system" cancel): the latch is checked and assigned here,
    // synchronously, with no suspension before it — an await ahead of this
    // point would let both callers reach cleanupAbortedStream and emit two
    // stream-aborts. Later callers join the first cancel; its abortReason and
    // abandonPartial are the ones delivered.
    if (streamInfo.cancelPromise) {
      return streamInfo.cancelPromise;
    }
    streamInfo.cancelPromise = (async () => {
      streamInfo.state = StreamState.STOPPING;
      try {
        // A failed best-effort flush must not prevent the provider from being stopped.
        await this.flushPartialWrite(workspaceId, streamInfo);
      } catch (error) {
        log.error("Failed to flush partial before cancellation", { error });
      } finally {
        streamInfo.abortController.abort();
        // Unlike checkSoftCancelStream, await cleanup (blocking).
        await this.cleanupAbortedStream(workspaceId, streamInfo, abortReason, abandonPartial);
      }
    })();
    return streamInfo.cancelPromise;
  }

  // Checks if a soft interrupt is necessary, and performs one if so
  // Similar to cancelStreamSafely but performs cleanup without blocking
  private async checkSoftCancelStream(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ): Promise<void> {
    if (!streamInfo.softInterrupt.pending) return;
    try {
      streamInfo.state = StreamState.STOPPING;

      // Flush any pending partial write immediately (preserves work on interruption)
      await this.flushPartialWrite(workspaceId, streamInfo);
    } catch (error) {
      log.error("Failed to flush partial before soft cancellation", { error });
    } finally {
      streamInfo.abortController.abort();

      // Return back to the stream loop so we can wait for it to finish before
      // sending the stream abort event. Not awaited: cleanupAbortedStream waits
      // for processingPromise, i.e. for the loop this runs inside of.
      // Shares cancelStreamSafely's latch: a hard cancel that lands during the
      // flush above already owns the abort bookkeeping (keep its promise), and a
      // hard cancel arriving later joins this one — one stream-abort either way.
      const { abandonPartial, abortReason } = streamInfo.softInterrupt;
      streamInfo.cancelPromise ??= this.cleanupAbortedStream(
        workspaceId,
        streamInfo,
        abortReason,
        abandonPartial
      );
    }
  }

  private closeStreamResources(streamInfo: WorkspaceStreamInfo): Promise<void> {
    if (streamInfo.resourceCleanup) return streamInfo.resourceCleanup;
    const closed = Promise.withResolvers<void>();
    streamInfo.resourceCleanup = closed.promise;
    (async () => {
      // Retire scheduled writes before joining their original Promise I/O. Scope close
      // interrupts debounce fibers; remote temp-directory removal remains best effort
      // (its registered finalizer only initiates removal, never awaits SSH).
      streamInfo.partialRetired = true;
      try {
        if (streamInfo.resourceScope) {
          await this.effectRunner.runPromise(Scope.close(streamInfo.resourceScope, Exit.void));
        }
      } catch (error) {
        log.error("Stream resource cleanup failed", { error });
      }
      try {
        this.interruptPartialWriteFiber(streamInfo);
        await this.awaitPendingPartialWrite(streamInfo);
      } catch (error) {
        // A cleanup defect must not orphan a completed/failed handle or skip raw teardown.
        log.error("Pending partial write cleanup failed", { error });
      }

      runLanguageModelCleanup(streamInfo.request?.model);

      streamInfo.unlinkAbortSignal?.();
      streamInfo.unlinkAbortSignal = undefined;
    })().then(closed.resolve, closed.reject);
    return closed.promise;
  }

  private async cleanupAbortedStream(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    abortReason: StreamAbortReason,
    abandonPartial?: boolean
  ): Promise<void> {
    // CRITICAL: Wait for processing to fully complete before cleanup
    // This prevents race conditions where the old stream is still running
    // while a new stream starts (e.g., old stream writing to partial.json)
    try {
      await streamInfo.processingPromise;
    } catch (error) {
      // The provider has exited even when teardown failed. Cancellation still owns
      // an aborted terminal unless the loop already published another outcome.
      log.error("Stream processing failed during cancellation", { error });
    }

    // The cancel lost the race: the loop had already left the fullStream and
    // finished as completed/failed (terminalCompletion set, stream-end/error
    // emitted, completion settled by processStreamWithCleanup's finally).
    // Re-running the abort bookkeeping here would resurrect partial.json after
    // deletePartial and emit a second terminal event (stream-abort after
    // stream-end), which the renderer reads as "still partial".
    if (streamInfo.terminalCompletion !== undefined) {
      return;
    }

    // Also covers registered STARTING attempts: their envelope callback may itself await
    // stopStream, so join owned resources here without joining that callback back into itself.
    // The envelope only journals; its original callback/mutex lifetime stays independently
    // leased. Canceled engine model/temp/debounce resources retire before raw terminal delivery.
    await this.closeStreamResources(streamInfo);

    // For aborts, use our tracked cumulativeUsage directly instead of AI SDK's totalUsage.
    // cumulativeUsage is updated on each finish-step event (before tool execution),
    // so it has accurate data even when the stream is interrupted mid-tool-call.
    // AI SDK's totalUsage may return zeros or stale data when aborted.
    const duration = Date.now() - streamInfo.startTime;
    const usage = hasTokenUsage(streamInfo.cumulativeUsage)
      ? streamInfo.cumulativeUsage
      : undefined;

    // For context window display, use last step's usage (inputTokens = current context size)
    const contextUsage = streamInfo.lastStepUsage;
    const contextProviderMetadata = streamInfo.lastStepProviderMetadata;

    // Include provider metadata for accurate cost calculation
    const providerMetadata = markProviderMetadataCostsIncluded(
      streamInfo.cumulativeProviderMetadata,
      streamInfo.initialMetadata?.costsIncluded
    );

    const streamAbort: StreamAbortEvent = {
      type: "stream-abort",
      workspaceId,
      messageId: streamInfo.messageId,
      metadata: {
        usage,
        contextUsage,
        duration,
        providerMetadata,
        contextProviderMetadata,
        model: streamInfo.model,
        metadataModel: streamInfo.metadataModel,
      },
      abortReason,
      abandonPartial,
      acpPromptId: streamInfo.initialMetadata?.acpPromptId,
    };
    try {
      try {
        await this.backfillReasoningTokensFromParts(streamInfo, usage);
      } catch (error) {
        // Estimation is optional: preserve provider usage and the user's abort reason.
        log.error("Failed to estimate reasoning usage on abort", { error });
      }

      // Record session usage for aborted streams (mirrors stream-end path)
      // This ensures tokens consumed before abort are tracked for cost display
      await this.recordSessionUsage(
        workspaceId,
        streamInfo.model,
        usage,
        providerMetadata,
        "Failed to record session usage on abort",
        "error",
        streamInfo
      );

      // Stamp the aborted turn's usage onto the partial message BEFORE committing
      // it and delivering stream-abort. Analytics
      // prices history rows from metadata.usage, so without this every
      // interrupted turn — user Esc, queued tool-end preemption, monitor wakes —
      // would ingest as $0 even though the provider billed all completed steps.
      if (!abandonPartial && (usage !== undefined || streamInfo.toolModelUsages.length > 0)) {
        try {
          await this.awaitPendingPartialWrite(streamInfo);
          const partialMessage = this.buildPartialAssistantMessage(streamInfo, {
            metadata: {
              ...(usage !== undefined ? { usage: cloneUsage(usage) } : {}),
              ...(providerMetadata !== undefined ? { providerMetadata } : {}),
              ...(contextUsage !== undefined ? { contextUsage } : {}),
              ...(contextProviderMetadata !== undefined ? { contextProviderMetadata } : {}),
              duration,
              ...(streamInfo.toolModelUsages.length > 0
                ? { toolModelUsages: streamInfo.toolModelUsages.map(clonePersistedToolModelUsage) }
                : {}),
            },
          });
          await this.historyService.writePartial(workspaceId as string, partialMessage);

          // Tool-only aborts (Esc while a tool is still running): commitPartial
          // refuses to commit partials whose only parts are input-available tool
          // calls, so the usage stamped above would die with the deleted
          // partial. Route that spend through the headless-usage sidecar
          // instead. Same predicate commitPartial applies, so exactly one of
          // {chat row, sidecar row} carries this turn's usage.
          if (!hasCommitWorthyParts(partialMessage.parts)) {
            await this.recordDroppedPartialUsageInSidecar(
              workspaceId,
              streamInfo,
              usage,
              providerMetadata,
              "aborted_stream"
            );
          }
        } catch (error) {
          log.error("Failed to persist aborted-stream usage on partial message", { error });
        }
      } else if (abandonPartial && (usage !== undefined || streamInfo.toolModelUsages.length > 0)) {
        // Abandoned aborts (edit/discard of the streaming turn): the partial is
        // deliberately dropped and its content never reaches chat.jsonl, but
        // the provider still billed every completed step. The sidecar is the
        // only route to the events table for this spend.
        try {
          await this.recordDroppedPartialUsageInSidecar(
            workspaceId,
            streamInfo,
            usage,
            providerMetadata,
            "aborted_stream"
          );
        } catch (error) {
          log.error("Failed to record abandoned-abort usage in headless sidecar", { error });
        }
      }
    } catch (error) {
      log.error("Failed abort bookkeeping; delivering preserved terminal metadata", { error });
    } finally {
      try {
        // Cancellation owns this attempt through disk cleanup and raw delivery. Keeping
        // the registration until then makes replacement startup join the same fence.
        const result = abandonPartial
          ? await this.historyService.deletePartialIfMessageIdMatches(
              workspaceId,
              streamInfo.messageId
            )
          : await this.historyService.commitPartial(workspaceId, streamInfo.messageId);
        // commitPartial already deletes on success. On failure retain recovery data;
        // an unconditional delete here would silently discard an uncommitted answer.
        if (!result.success)
          log.error("Failed partial cleanup during stream-abort", {
            workspaceId,
            error: result.error,
          });
      } catch (error) {
        log.error("Failed partial cleanup during stream-abort", { workspaceId, error });
      }
      try {
        await this.eventSink(streamAbort);
      } catch (error) {
        log.error("Stream-abort delivery failed", { error: getErrorMessage(error) });
      } finally {
        if (this.workspaceStreams.get(workspaceId) === streamInfo) {
          this.workspaceStreams.delete(workspaceId);
        }
        streamInfo.terminalCompletion = {
          status: "aborted",
          abortReason,
          streamAbort,
          systemMessageTokens: streamInfo.initialMetadata?.systemMessageTokens,
        };
        // Session policy consumes this promise separately. It may start a replacement,
        // so neither this fence nor the raw sink may join that policy.
        streamInfo.completionController?.settle(streamInfo.terminalCompletion);
      }
    }
  }

  /**
   * Route a dropped partial's billed usage to the headless-usage sidecar:
   * the parent stream's cumulative usage plus every tool-internal model call
   * (toolModelUsages). Used by the abort and error paths when the partial
   * fails commitPartial's durability predicate — metadata stamped on such a
   * partial dies with it, so the sidecar is the only route to the events
   * table. skipSessionLedger everywhere: parent usage was recorded via
   * recordSessionUsage and tool usage at report time (AIService).
   */
  private async recordDroppedPartialUsageInSidecar(
    workspaceId: WorkspaceId,
    streamInfo: Pick<WorkspaceStreamInfo, "model" | "metadataModel" | "toolModelUsages">,
    usage: LanguageModelV2Usage | undefined,
    providerMetadata: Record<string, unknown> | undefined,
    analyticsSource: DroppedStreamSource,
    // Label for the stream's OWN usage row only. The error path passes
    // "refused_stream" when the turn died as a terminal model refusal (the
    // stream usage is then terminalRefusalUsage), so refusals are not
    // conflated with generic errored_stream rows in analytics.
    streamUsageSource: HeadlessDropSource = analyticsSource
  ): Promise<void> {
    // Thread the request-pinned metadata identities through the sidecar
    // write: recordHeadlessUsage would otherwise re-resolve the raw model
    // against the CURRENT config, so a Coder instance removed/retagged
    // mid-turn would persist an unknown or repriced identity in analytics.
    if (usage !== undefined) {
      await this.sessionUsageService?.recordHeadlessUsage(
        workspaceId as string,
        streamInfo.model,
        cloneUsage(usage),
        providerMetadata,
        {
          analyticsSource: streamUsageSource,
          skipSessionLedger: true,
          metadataModel: streamInfo.metadataModel,
        }
      );
    }
    for (const toolUsage of streamInfo.toolModelUsages) {
      // Refused fallback hops ARE refusals regardless of how the turn ended
      // (aborted, errored, exhausted chain); every other tool-internal usage
      // entry keeps the turn's drop reason.
      const entrySource: HeadlessDropSource =
        toolUsage.toolName === MODEL_FALLBACK_REFUSAL_TOOL_NAME
          ? "refused_stream"
          : analyticsSource;
      await this.sessionUsageService?.recordHeadlessUsage(
        workspaceId as string,
        toolUsage.model,
        cloneUsage(toolUsage.usage),
        toolUsage.providerMetadata,
        {
          analyticsSource: entrySource,
          skipSessionLedger: true,
          metadataModel: toolUsage.metadataModel,
        }
      );
    }
  }

  private async recordSessionUsage(
    workspaceId: WorkspaceId,
    model: string,
    usage: LanguageModelV2Usage | undefined,
    providerMetadata: Record<string, unknown> | undefined,
    logMessage: string,
    logLevel: "warn" | "error",
    streamInfo?: Pick<WorkspaceStreamInfo, "workspaceName" | "metadataModel">
  ): Promise<void> {
    if (!this.sessionUsageService || !usage) {
      return;
    }
    const messageUsage = createDisplayUsage(
      usage,
      model,
      providerMetadata,
      streamInfo?.metadataModel
    );
    if (!messageUsage) {
      return;
    }
    const workspaceLog = this.getWorkspaceLogger(workspaceId, streamInfo);
    const ledgerModel = this.usageAttributionModel(model, streamInfo?.metadataModel);
    try {
      await this.sessionUsageService.recordUsage(workspaceId as string, ledgerModel, messageUsage);
    } catch (error) {
      (logLevel === "error" ? workspaceLog.error : workspaceLog.warn)(logMessage, { error });
    }
  }

  /**
   * Usage-attribution key, mirroring SessionUsageService.recordHeadlessUsageLocked.
   * Coder identities keep the stream's PINNED record-time metadata identity
   * (streamInfo.metadataModel), NOT a live re-resolution of the raw model: a
   * catalog refresh can remove/retag the instance while the turn is active,
   * and re-resolving would key the ledger differently from the pricing
   * identity createDisplayUsage used, so repricing would later change or
   * strip the row. Non-Coder models resolve to the canonical usage key —
   * their metadata identity can be a mappedToModel alias target (a pricing
   * identity, deliberately not the attribution bucket).
   */
  private usageAttributionModel(model: string, metadataModel: string | undefined): string {
    return model.startsWith("coder:") && metadataModel
      ? metadataModel
      : normalizeUsageModelKey(model, this.getProvidersConfig());
  }

  private buildStreamRequestConfig(input: StreamRequestInput): StreamRequestConfig {
    const {
      model,
      modelString,
      messages,
      system,
      tools,
      providerOptions,
      maxOutputTokens,
      callSettingsOverrides,
      toolPolicy,
      hasQueuedMessages,
      getQueuedInputStopCause,
      headers,
      onChunk,
      onStepMessages,
      onStepSettled,
      contextBudgetMemoryWritable,
      contextBudgetLimit,
      toolSearchState,
      onToolExecutionStart,
      thinkingOverrideState,
      rebuildProviderOptionsForThinkingLevel,
      forcedFirstStepToolNames,
      providersConfigSnapshot,
      rebuildFirstStepForThinkingLevel,
    } = input;
    // The request's pinned providers-config snapshot keeps type-derived output limits
    // aligned with the config that created the SDK model.
    const requestProvidersConfig = providersConfigSnapshot ?? this.getProvidersConfig();
    // Mid-turn thinking overrides mutate providerOptions IN PLACE (the SDK's
    // per-step deep-merge reads the object passed at streamText() time, so
    // identity must stay stable). An initially-undefined value would make that
    // mutation unobservable — normalize to a guaranteed mutable object.
    const finalProviderOptions =
      rebuildProviderOptionsForThinkingLevel != null ? (providerOptions ?? {}) : providerOptions;

    // Use the runtime model's max_output_tokens if available and caller didn't
    // specify. This must be the runtime model (not the mapped metadata model)
    // because max_output_tokens is a request parameter sent to the provider —
    // a custom model's provider may not support the mapped model's output cap.
    // If no metadata exists, omit the parameter to let the provider use its
    // default (Anthropic requires this but has low defaults).
    const { maxOutputTokens: configMaxOutputTokens, ...streamCallSettings } =
      callSettingsOverrides ?? {};

    const runtimeModelStats = getModelStats(modelString);
    // Fall back to resolved stats for custom aliases (e.g., provider alias mappedToModel).
    const resolvedModelStats =
      runtimeModelStats ?? getModelStatsResolved(modelString, requestProvidersConfig);
    const effectiveMaxOutputTokens =
      maxOutputTokens ?? configMaxOutputTokens ?? resolvedModelStats?.max_output_tokens;

    return {
      model,
      modelString,
      messages,
      system,
      cacheEnabled: supportsAnthropicCache(modelString, requestProvidersConfig),
      budgetMetadataModel: resolveModelForMetadata(modelString, requestProvidersConfig),
      // Keep provider-level parallel tool planning enabled, but serialize sibling
      // execute() handlers inside this stream so shared mutable state cannot race.
      tools: withSequentialExecution(tools, onToolExecutionStart),
      providerOptions: finalProviderOptions,
      headers,
      maxOutputTokens: effectiveMaxOutputTokens,
      streamCallSettings:
        Object.keys(streamCallSettings).length > 0 ? streamCallSettings : undefined,
      hasQueuedMessages,
      getQueuedInputStopCause,
      onChunk,
      onStepMessages,
      onStepSettled,
      contextBudgetMemoryWritable,
      contextBudgetLimit,
      toolPolicy,
      toolSearchState,
      thinkingOverrideState,
      forcedFirstStepToolNames,
      rebuildProviderOptionsForThinkingLevel,
      rebuildFirstStepForThinkingLevel,
    };
  }

  private createStopWhenCondition(
    request: Pick<
      StreamRequestConfig,
      | "hasQueuedMessages"
      | "getQueuedInputStopCause"
      | "stopCause"
      | "toolPolicy"
      | "onStepSettled"
      | "modelString"
      | "tools"
      | "contextBudgetMemoryWritable"
      | "budgetMetadataModel"
    >
  ): Array<ReturnType<typeof stepCountIs>> {
    // Completion-tool stop check: completion/routing tools use explicit
    // success/ok markers (agent_report, propose_plan).
    // When a marker is present, respect it — success:false means the tool
    // should be retried, so don't stop. When no marker is present (e.g.,
    // MCP tools, arbitrary required tools), treat non-null object results
    // as successful completion unless the result is error-shaped.
    const isSuccessfulOutput = (output: unknown): boolean => {
      if (typeof output !== "object" || output === null) {
        return false;
      }
      const parsedOutput = output as Record<string, unknown>;
      if ("success" in parsedOutput) {
        return parsedOutput.success === true;
      }
      if ("ok" in parsedOutput) {
        return parsedOutput.ok === true;
      }
      if (parsedOutput.error != null || parsedOutput.isError === true) {
        return false;
      }
      return true;
    };

    const requiredPatterns = buildRequiredToolPatterns(request.toolPolicy);

    const hasSuccessfulRequiredToolResult = ({
      steps,
    }: Parameters<ReturnType<typeof stepCountIs>>[0]): boolean => {
      if (requiredPatterns.length === 0) {
        return false;
      }
      const lastStep = steps[steps.length - 1];
      return (
        lastStep?.toolResults?.some(
          (toolResult) =>
            // A context-lifecycle request is never a terminal completion, even if a policy
            // lists it as required; otherwise its success would end the stream before the
            // settled-step callback could schedule the rollover it promised.
            toolResult.toolName !== "new_context" &&
            requiredPatterns.some((pattern) => pattern.test(toolResult.toolName)) &&
            isSuccessfulOutput(toolResult.output)
        ) ?? false
      );
    };

    return [
      ({ steps }) => {
        if (steps.length < 100000) return false;
        request.stopCause ??= { kind: "step-limit" };
        return true;
      },
      // The SDK evaluates stop conditions only after every sibling tool result in the
      // model's current step settles. Do not move this to individual tool-call-end events:
      // that would abort the remaining calls the model emitted in the same batch.
      async ({ steps }) => {
        const step = steps.at(-1);
        if (request.onStepSettled && step && !hasSuccessfulRequiredToolResult({ steps })) {
          const outputs = step.toolResults.map((result) => result.output);
          const size = estimateToolResultSize(outputs);
          const toolResultTokens = await estimateToolResultTokensForModel(outputs, {
            model: request.modelString,
            metadataModel: request.budgetMetadataModel,
          });
          const decision = await request.onStepSettled({
            model: request.modelString,
            usage: normalizeUsage(step.usage),
            providerMetadata: step.providerMetadata,
            ...size,
            toolResultTokens,
            sessionHistoryAvailable: request.tools?.session_history != null,
            memoryWritable: request.contextBudgetMemoryWritable === true,
            newContextRequested: step.toolResults.some(
              (result) => result.toolName === "new_context" && isSuccessfulOutput(result.output)
            ),
          });
          // All siblings have settled: stop before another provider step without discarding results.
          if (decision !== "continue") {
            request.stopCause ??= { kind: "context-budget", decision };
          }
          if (decision === "block")
            throw new ContextBudgetBlockedError(
              "The settled tool results exceed the context budget. Use /compact or start a new context before continuing."
            );
          // Budget stops are authoritative even when only a turn-end message is queued.
          if (decision !== "continue") return true;
        }
        if (hasSuccessfulRequiredToolResult({ steps })) return false;
        const queuedInput = request.getQueuedInputStopCause?.();
        if (queuedInput != null) {
          request.stopCause ??= queuedInput;
          return true;
        }
        return request.hasQueuedMessages?.("tool-end") ?? false;
      },
      (options) => {
        if (!hasSuccessfulRequiredToolResult(options)) return false;
        request.stopCause ??= { kind: "required-tool" };
        return true;
      },
    ];
  }

  /**
   * Consume a pending mid-turn thinking-level override for the next step.
   *
   * Consume-once: `pending` is always cleared (a failed/no-op application must
   * not retry on every subsequent step). On success the CONTENT of
   * `request.providerOptions` is replaced in place — object identity is
   * preserved because the SDK's per-step deep-merge reads the reference passed
   * at streamText() time, and deep-merge alone cannot delete keys (e.g. the
   * Anthropic `thinking` object when moving to "off").
   *
   * Returns the rebuilt options (for the prepareStep return value) or
   * undefined when there is nothing to apply.
   */
  private applyPendingThinkingOverride(
    request: StreamRequestConfig
  ): Record<string, unknown> | undefined {
    const state = request.thinkingOverrideState;
    const pending = state?.pending;
    if (state == null || pending == null) {
      return undefined;
    }
    state.pending = undefined;
    const rebuild = request.rebuildProviderOptionsForThinkingLevel;
    if (rebuild == null) {
      return undefined;
    }
    const rebuilt = rebuild(pending);
    if (rebuilt == null) {
      log.debug("Mid-turn thinking override skipped (not applicable / no-op)", {
        requestedLevel: pending,
        appliedLevel: state.applied,
      });
      return undefined;
    }
    const target = request.providerOptions;
    // buildStreamRequestConfig normalizes providerOptions to a stable object
    // whenever a rebuild closure is present, so target must exist here.
    assert(target != null, "providerOptions must be normalized when a rebuild closure is present");
    for (const key of Object.keys(target)) {
      delete target[key];
    }
    Object.assign(target, rebuilt.providerOptions);
    state.applied = rebuilt.effectiveLevel;
    state.onApplied?.(rebuilt.effectiveLevel);
    log.debug("Mid-turn thinking override applied", {
      requestedLevel: pending,
      effectiveLevel: rebuilt.effectiveLevel,
    });
    return rebuilt.providerOptions;
  }

  getPrefixSwapPreparation(workspaceId: string) {
    const info = this.workspaceStreams.get(workspaceId as WorkspaceId);
    if (!info) return null;
    return {
      requestProviderOptions: info.request.providerOptions,
      systemPrefix: info.request.messages.filter((message) => message.role === "system"),
      cacheEnabled: info.request.cacheEnabled ?? false,
      preparation: {
        effectiveAgentId: info.initialMetadata?.agentId ?? "exec",
        toolNamesForSentinel: Object.keys(info.request.tools ?? {}),
        effectiveThinkingLevel: ThinkingLevelSchema.parse(info.thinkingLevel ?? "off"),
        modelString: info.model,
        providerForMessages: info.metadataModel.split(":", 1)[0],
        anthropicCacheTtl: getAnthropicCacheTtl(info.request.providerOptions),
      },
    };
  }

  setPrefixSwap(workspaceId: string, swap: ContinuousPrefixSwap): boolean {
    const stream = this.workspaceStreams.get(workspaceId as WorkspaceId);
    if (
      !stream ||
      stream.messageId !== swap.journal.streamMessageId ||
      stream.model !== swap.journal.parentModel ||
      (stream.thinkingLevel ?? "off") !== swap.journal.preparation.effectiveThinkingLevel ||
      stream.stepTracker.pendingPrefixSwap ||
      stream.stepTracker.consumedPrefixSwap
    )
      return false;
    stream.stepTracker.pendingPrefixSwap = swap;
    return true;
  }

  clearPrefixSwap(workspaceId: string): void {
    const tracker = this.workspaceStreams.get(workspaceId as WorkspaceId)?.stepTracker;
    if (tracker) {
      tracker.pendingPrefixSwap = undefined;
      tracker.consumedPrefixSwap = undefined;
    }
  }

  getPrefixSwapState(workspaceId: string): "none" | "pending" | "consumed" | "invalidated" {
    const tracker = this.workspaceStreams.get(workspaceId as WorkspaceId)?.stepTracker;
    return tracker?.prefixSwapInvalidated
      ? "invalidated"
      : tracker?.consumedPrefixSwap
        ? "consumed"
        : tracker?.pendingPrefixSwap
          ? "pending"
          : "none";
  }

  private swapPrefix(messages: ModelMessage[], swap: ContinuousPrefixSwap): ModelMessage[] | null {
    // Reused IDs can name different turns or steps. Neither oldest nor newest
    // proves the cut: ambiguity must use P1 instead of dropping or restoring context.
    let index = -1;
    for (const [messageIndex, message] of messages.entries()) {
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part.type !== "tool-call" || part.toolCallId !== swap.firstTailToolCallId) continue;
        if (index !== -1) {
          log.warn("[continuous-compaction] ambiguous prefix locator; retaining full context");
          return null;
        }
        index = messageIndex;
      }
    }
    if (index < 0) {
      log.warn("[continuous-compaction] prefix locator missing; retaining full context");
      return null;
    }
    return [...swap.prefix, ...stripMessageCacheControl(messages.slice(index))];
  }

  private createStreamResult(
    request: StreamRequestConfig,
    abortController: AbortController,
    stepTracker?: StepMessageTracker
  ): Awaited<ReturnType<typeof streamText>> {
    // Retries can reuse the request, but each stream makes its own stop decision.
    delete request.stopCause;
    // Explicit <ToolSet> pins RUNTIME_CONTEXT to its default: mux tools use
    // Tool's `any` context, which would otherwise infect the inferred result
    // type (no-unsafe-return).
    return streamText<ToolSet>({
      model: request.model,
      messages: request.messages,
      system: request.system,
      // The assembler prepends Anthropic cached system prompts to `messages`.
      // AI SDK 7 rejects system messages inside `messages` unless opted in.
      // Trusted: mux builds these messages server-side.
      allowSystemInMessages: true,
      abortSignal: abortController.signal,
      prepareStep: async ({ messages: stepMessages, stepNumber }) => {
        // streamText runs multiple internal LLM calls (steps) when tools are enabled.
        // Strip workflow run records from same-turn tool results (history-level redaction in
        // applyToolOutputRedaction can't see these), then extract supported attachments out of
        // tool-result JSON so providers don't treat them as text.
        const withoutWorkflowRunRecords = stripWorkflowRunRecordsFromModelMessages(stepMessages);
        const rewritten =
          await extractToolMediaAsUserMessagesFromModelMessages(withoutWorkflowRunRecords);
        let effectiveMessages = rewritten === stepMessages ? stepMessages : rewritten;
        if (stepTracker?.prefixSwapInvalidated) {
          // Cross-family fallback must not send the old provider's cached prefix.
          // Release only on the session's stop, after fallback reset/locks have completed.
          if (!abortController.signal.aborted) {
            await new Promise<void>((resolve) =>
              abortController.signal.addEventListener("abort", () => resolve(), { once: true })
            );
          }
          throw abortController.signal.reason ?? new Error("Prefix swap invalidated");
        }
        // The staged prefix was prepared under the previous thinking options.
        // Keep full context if those options change before the swap is consumed.
        const pendingSwap = stepTracker?.pendingPrefixSwap;
        const appliedThinking = request.thinkingOverrideState?.applied;
        if (
          stepTracker &&
          (request.thinkingOverrideState?.pending != null ||
            (pendingSwap &&
              appliedThinking != null &&
              appliedThinking !== pendingSwap.journal.preparation.effectiveThinkingLevel))
        ) {
          stepTracker.pendingPrefixSwap = undefined;
        }
        const swap = stepTracker?.pendingPrefixSwap;
        if (swap && stepTracker?.workspaceId) {
          const swapped = this.swapPrefix(effectiveMessages, swap);
          if (swapped) {
            const store = this.historyService.getContinuousCompactionJournal(
              stepTracker.workspaceId
            );
            const thinkingLevel = request.thinkingOverrideState?.applied;
            const isCurrent = () =>
              stepTracker.pendingPrefixSwap === swap &&
              !abortController.signal.aborted &&
              request.thinkingOverrideState?.pending == null &&
              request.thinkingOverrideState?.applied === thinkingLevel;
            const journal = await store.write(
              { ...swap.journal, stepNumber },
              swap.prefix,
              isCurrent,
              (committed) => {
                swap.journal = committed;
              }
            );
            if (journal && isCurrent()) {
              swap.journal = journal;
              swap.consumed = true;
              stepTracker.consumedPrefixSwap = swap;
              effectiveMessages = swapped;
            } else if (journal && stepTracker.pendingPrefixSwap === swap) {
              // A thinking change can also arrive after write()'s last fence.
              await store.clear(journal);
            }
          }
          if (stepTracker.pendingPrefixSwap === swap) stepTracker.pendingPrefixSwap = undefined;
        }
        if (stepTracker) {
          stepTracker.latestMessages = effectiveMessages;
        }
        request.onStepMessages?.(effectiveMessages);
        // Tool search (tool-search experiment): scope the advertised tool list
        // to core tools + activated deferred tools. Read per step so tools
        // activated by tool_catalog_search.execute appear on the following step.
        // undefined when the feature is inactive, keeping the return value
        // byte-identical to the pre-feature behavior.
        const searchedActiveTools = computeActiveToolNames(request.toolSearchState);
        const forceFirstStepTools =
          stepNumber === 0 && request.forcedFirstStepToolNames?.length
            ? request.forcedFirstStepToolNames
            : undefined;
        const activeTools = forceFirstStepTools ?? searchedActiveTools;
        // Mid-turn thinking-level change: consume a pending override before
        // this step's provider request is built.
        const thinkingOverride = this.applyPendingThinkingOverride(request);
        // Step 0: an override consumed here raced stream setup (written during
        // startStream's awaits, after TurnRequestBuilder's pre-construction quiescence
        // fold). Message preparation is thinking-level-dependent (Anthropic
        // signed-reasoning transforms), so rebuild the first-step messages
        // under the applied level too; the closure also emits a superseding
        // turn envelope so wire, envelope, and replay agree.
        let rebuiltFirstStepMessages: ModelMessage[] | undefined;
        const appliedLevel = request.thinkingOverrideState?.applied;
        if (
          thinkingOverride !== undefined &&
          stepNumber === 0 &&
          !stepTracker?.consumedPrefixSwap &&
          request.rebuildFirstStepForThinkingLevel != null &&
          appliedLevel != null
        ) {
          try {
            const rebuilt = await request.rebuildFirstStepForThinkingLevel(
              appliedLevel,
              thinkingOverride
            );
            // Same per-step transforms the construction-time messages receive.
            rebuiltFirstStepMessages = await extractToolMediaAsUserMessagesFromModelMessages(
              stripWorkflowRunRecordsFromModelMessages(rebuilt)
            );
            if (stepTracker) {
              stepTracker.latestMessages = rebuiltFirstStepMessages;
            }
            // onStepMessages fired above with the pre-rebuild transcript;
            // re-notify so consumers (advisor transcript ref) track the
            // messages this step actually sends.
            request.onStepMessages?.(rebuiltFirstStepMessages);
          } catch (error) {
            // Fail open to the options-only rebuild rather than killing the
            // turn; the envelope then still matches the options change.
            log.warn("First-step message rebuild for thinking override failed", {
              error: getErrorMessage(error),
            });
          }
        }
        if (request.contextBudgetLimit != null) {
          const exceeded = await checkAssembledRequestBudgetForModel(
            {
              system: request.system,
              messages: rebuiltFirstStepMessages ?? effectiveMessages,
              tools: request.tools,
            },
            {
              model: request.modelString,
              metadataModel: request.budgetMetadataModel,
              modelContextLimit: request.contextBudgetLimit,
              activeTools,
            }
          );
          // Step zero can follow executed tools on a fallback. This late hard stop
          // preserves settled results; it must not reset/replay the activated catalog.
          if (exceeded)
            throw new ContextBudgetBlockedError(
              `The next request exceeds the safe context budget for ${exceeded.model} (${exceeded.estimate} > ${exceeded.hardCeiling}). Use /compact or reduce the active tool/context payload.`
            );
        }
        if (
          effectiveMessages === stepMessages &&
          activeTools === undefined &&
          thinkingOverride === undefined
        ) {
          return undefined;
        }
        return {
          ...(rebuiltFirstStepMessages != null
            ? { messages: rebuiltFirstStepMessages }
            : effectiveMessages === stepMessages
              ? {}
              : { messages: effectiveMessages }),
          ...(forceFirstStepTools !== undefined ? { toolChoice: "required" as const } : {}),
          ...(activeTools !== undefined ? { activeTools } : {}),
          // Defense in depth: the in-place request mutation is authoritative
          // (per-step deep-merge cannot delete keys); returning the rebuilt
          // options also covers any future SDK options snapshotting.
          ...(thinkingOverride !== undefined
            ? { providerOptions: thinkingOverride as ProviderOptions }
            : {}),
        };
      },
      onChunk: request.onChunk,
      tools: request.tools,
      stopWhen: this.createStopWhenCondition(request),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      providerOptions: request.providerOptions as any, // Pass provider-specific options (thinking/reasoning config)
      headers: request.headers, // Per-request HTTP headers (e.g., anthropic-beta for 1M context)
      maxOutputTokens: request.maxOutputTokens,
      ...(request.streamCallSettings ?? {}),
    });
  }

  /**
   * Atomically creates a new stream with all necessary setup
   */
  private createStreamAtomically(
    options: TurnExecutionOptions,
    ctx: {
      streamToken: StreamToken;
      runtimeTempDir: string;
      resourceScope: Scope.Closeable;
      abortController: AbortController;
      completionController: TurnCompletionController;
    }
  ): WorkspaceStreamInfo {
    // ctx.abortController is created and linked to the caller-provided abortSignal in startStream().
    const workspaceId = options.workspaceId as WorkspaceId;
    const {
      messageId,
      modelString,
      historySequence,
      workspaceName,
      thinkingLevel,
      initialMetadata,
      modelFallback,
      maxOutputTokens,
      runtime,
    } = options;
    const stepTracker: StepMessageTracker = { workspaceId: options.workspaceId };
    const metadataModel = this.resolveMetadataModel(modelString, options.providersConfigSnapshot);
    const request = this.buildStreamRequestConfig({
      ...options,
      onToolExecutionStart: (toolCallId) =>
        this.handleToolExecutionStart(workspaceId, messageId, toolCallId),
    });

    // Start streaming - this can throw immediately if API key is missing
    let streamResult;
    try {
      streamResult = this.createStreamResult(request, ctx.abortController, stepTracker);
    } catch (error) {
      // Clean up abort controller if stream creation fails
      ctx.abortController.abort();
      // Re-throw the error to be caught by startStream
      throw error;
    }

    const startTime = Date.now();
    const streamInfo: WorkspaceStreamInfo = {
      state: StreamState.STARTING,
      streamResult,
      workspaceName,
      abortController: ctx.abortController,
      messageId,
      token: ctx.streamToken,
      startTime,
      lastPartTimestamp: startTime,
      toolCompletionTimestamps: new Map(),
      pendingWorkflowRunAttachments: new Map(),
      pendingNestedCalls: new Map(),
      pendingToolExecutionStarts: new Map(),
      model: modelString,
      metadataModel,
      thinkingLevel,
      initialMetadata,
      toolModelUsages: [],
      didRetryPreviousResponseIdAtStep: false,
      didRetryAfterEmptyOutput: false,
      ...(modelFallback && modelFallback.chain.length > 0
        ? {
            modelFallback: {
              options: modelFallback,
              requestedModel: normalizeToCanonical(modelString),
              refusedModels: [],
              // Pre-wrap inputs (NOT request.maxOutputTokens, which may already
              // carry call-settings overrides for the original model).
              original: { maxOutputTokens },
            },
          }
        : {}),
      stepTracker,
      receivedTerminalEvent: false,
      currentStepStartIndex: 0,
      stepStartIndices: [0],
      request,
      historySequence,
      parts: [], // Initialize empty parts array
      lastPartialWriteTime: 0, // Initialize to 0 to allow immediate first write
      partialWritePromise: undefined, // No write in flight initially
      processingPromise: Promise.resolve(), // Placeholder, overwritten in startStream
      softInterrupt: { pending: false },
      completionController: ctx.completionController,
      runtimeTempDir: ctx.runtimeTempDir, // Stream-scoped temp directory for tool outputs
      runtime, // Runtime for temp directory cleanup
      resourceScope: ctx.resourceScope, // Owns temp-dir release + debounce fiber
      // Initialize cumulative tracking for multi-step streams
      cumulativeUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      cumulativeProviderMetadata: undefined,
    };

    // Mid-turn thinking override: route applied levels into this stream's
    // metadata (partials, stream-end, final assistant message). Wired before
    // any step can run; the catch-up sync covers a holder that already applied
    // a level (e.g. re-attachment on retry paths).
    if (request.thinkingOverrideState) {
      request.thinkingOverrideState.onApplied = (level) => {
        streamInfo.thinkingLevel = level;
      };
      if (request.thinkingOverrideState.applied) {
        streamInfo.thinkingLevel = request.thinkingOverrideState.applied;
      }
    }

    // Atomically register the stream
    this.workspaceStreams.set(workspaceId, streamInfo);

    return streamInfo;
  }

  /**
   * Complete a tool call by updating its part and emitting tool-call-end event.
   * CRITICAL: Flushes partial to disk BEFORE emitting event to prevent race conditions
   * where listeners (e.g., sendQueuedMessages) read stale partial data.
   */
  private async completeToolCall(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    toolCalls: ToolCallMap,
    toolCallId: string,
    toolName: string,
    output: unknown,
    providerExecuted?: boolean
  ): Promise<void> {
    // Find and update the existing tool part
    const existingPartIndex = streamInfo.parts.findIndex(
      (p) => p.type === "dynamic-tool" && p.toolCallId === toolCallId
    );
    const pendingAttachment = this.takePendingWorkflowRunAttachment(streamInfo, toolCallId);

    if (existingPartIndex !== -1) {
      const existingPart = streamInfo.parts[existingPartIndex];
      if (existingPart.type === "dynamic-tool") {
        streamInfo.parts[existingPartIndex] = {
          ...existingPart,
          ...(pendingAttachment != null ? { workflowRun: pendingAttachment } : {}),
          state: "output-available" as const,
          output,
        };
      }
    } else {
      // Fallback: if the matching tool-call part is missing, still persist output so the UI
      // does not stay stuck in input-available. Input may be missing for provider-native tools.
      const toolCall = toolCalls.get(toolCallId);
      streamInfo.parts.push({
        type: "dynamic-tool" as const,
        toolCallId,
        toolName,
        state: "output-available" as const,
        input: toolCall?.input ?? null,
        output,
        timestamp: nextPartTimestamp(streamInfo),
        ...(pendingAttachment != null ? { workflowRun: pendingAttachment } : {}),
      });
    }

    // CRITICAL: Flush partial to disk BEFORE emitting event
    // This ensures listeners (like sendQueuedMessages) see the tool result when they
    // read partial.json via commitPartial. Without this await, there's a race condition
    // where the partial is read before the tool result is written, causing "amnesia".
    await this.flushPartialWrite(workspaceId, streamInfo);
    if (pendingAttachment != null) {
      this.emitWorkflowRunAttachedFromAttachment({
        workspaceId,
        messageId: streamInfo.messageId,
        toolCallId,
        attachment: pendingAttachment,
      });
    }

    // Emit tool-call-end event (listeners can now safely read partial)
    const completionTimestamp = nextPartTimestamp(streamInfo);
    streamInfo.toolCompletionTimestamps ??= new Map();
    streamInfo.toolCompletionTimestamps.set(toolCallId, completionTimestamp);
    this.emitTurnEvent({
      type: "tool-call-end",
      workspaceId: workspaceId as string,
      messageId: streamInfo.messageId,
      toolCallId,
      toolName,
      result: output,
      ...(providerExecuted === true ? { providerExecuted: true } : {}),
      timestamp: completionTimestamp,
    } as ToolCallEndEvent);
  }

  private async finishToolCall(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    toolCalls: ToolCallMap,
    toolCallId: string,
    toolName: string,
    output: unknown,
    providerExecuted?: boolean
  ): Promise<void> {
    await this.completeToolCall(
      workspaceId,
      streamInfo,
      toolCalls,
      toolCallId,
      toolName,
      output,
      providerExecuted
    );
    await this.checkSoftCancelStream(workspaceId, streamInfo);
  }

  private logOrphanToolResult(
    workspaceLog: Logger,
    streamInfo: WorkspaceStreamInfo,
    part: { toolCallId: string; toolName: string },
    output: unknown,
    orphanCount: number,
    trackedToolCallCount: number
  ): void {
    if (orphanCount > MAX_ORPHAN_TOOL_RESULT_WARNINGS_PER_STREAM) {
      return;
    }

    workspaceLog.warn(
      "[streamManager] Received tool-result without matching tool-call map entry; persisting fallback output",
      {
        messageId: streamInfo.messageId,
        model: streamInfo.model,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        orphanCount,
        trackedToolCallCount,
        isWebSearch: part.toolName === "web_search",
        ...summarizeToolResultForLog(output),
      }
    );

    if (orphanCount === MAX_ORPHAN_TOOL_RESULT_WARNINGS_PER_STREAM) {
      workspaceLog.warn(
        "[streamManager] Suppressing additional orphan tool-result warnings for this stream",
        {
          messageId: streamInfo.messageId,
          model: streamInfo.model,
          suppressedAfter: orphanCount,
        }
      );
    }
  }

  /**
   * Emit nested tool events from PTC code_execution.
   * These are forwarded to the frontend via the same event channel as regular tool events.
   * The parentToolCallId field identifies which code_execution call spawned this nested call.
   *
   * Also persists nested calls to streamInfo.parts so they survive interruption/reload.
   */
  emitNestedToolEvent(
    workspaceId: string,
    messageId: string,
    event: {
      type: "tool-call-start" | "tool-call-end";
      callId: string;
      toolName: string;
      args: unknown;
      parentToolCallId: string;
      startTime: number;
      endTime?: number;
      result?: unknown;
      error?: string;
    }
  ): void {
    // Kernel guests can call capabilities with zero arguments. JSON.stringify
    // drops an `args: undefined` key, and the wire schema requires args on
    // tool-call-start, so an unnormalized event would fail oRPC output
    // validation and kill every live onChat subscription. Normalize to {} —
    // the same shape a provider zero-arg tool call carries.
    const args = event.args === undefined ? {} : event.args;

    // Persist nested calls to streamInfo.parts for crash/interrupt resilience
    const streamInfo = this.workspaceStreams.get(workspaceId as WorkspaceId);
    if (streamInfo) {
      if (event.type === "tool-call-end") {
        // Nested records never store an end time, so incremental replay needs
        // this to notice a nested call that completed while the renderer was
        // disconnected (same mechanism as top-level tool completions).
        streamInfo.toolCompletionTimestamps.set(event.callId, event.endTime ?? Date.now());
      }
      const parentPartIndex = streamInfo.parts.findIndex(
        (p): p is CompletedMessagePart & { type: "dynamic-tool"; toolCallId: string } =>
          p.type === "dynamic-tool" && "toolCallId" in p && p.toolCallId === event.parentToolCallId
      );

      if (parentPartIndex !== -1) {
        const parentPart = streamInfo.parts[parentPartIndex] as { nestedCalls?: NestedToolCall[] };
        const nestedCalls = parentPart.nestedCalls ?? [];

        if (event.type === "tool-call-start") {
          nestedCalls.push({
            toolCallId: event.callId,
            toolName: event.toolName,
            input: args,
            state: "input-available",
            timestamp: event.startTime,
          });
        } else if (event.type === "tool-call-end") {
          const idx = nestedCalls.findIndex((n) => n.toolCallId === event.callId);
          if (idx !== -1) {
            nestedCalls[idx] = {
              ...nestedCalls[idx],
              output: event.result ?? (event.error ? { error: event.error } : undefined),
              state: "output-available",
            };
          }
        }

        parentPart.nestedCalls = nestedCalls;

        // Schedule partial write so nested calls survive crashes
        void this.schedulePartialWrite(workspaceId as WorkspaceId, streamInfo);
      } else {
        // execute() can win the race against the fullStream consumer (same window as
        // pendingToolExecutionStarts): buffer the nested record and merge it when the
        // parent part lands, instead of silently dropping it from persistence.
        const pendingNestedCalls = (streamInfo.pendingNestedCalls ??= new Map());
        const buffered = pendingNestedCalls.get(event.parentToolCallId) ?? [];
        if (event.type === "tool-call-start") {
          buffered.push({
            toolCallId: event.callId,
            toolName: event.toolName,
            input: args,
            state: "input-available",
            timestamp: event.startTime,
          });
        } else if (event.type === "tool-call-end") {
          const idx = buffered.findIndex((n) => n.toolCallId === event.callId);
          if (idx !== -1) {
            buffered[idx] = {
              ...buffered[idx],
              output: event.result ?? (event.error ? { error: event.error } : undefined),
              state: "output-available",
            };
          }
        }
        pendingNestedCalls.set(event.parentToolCallId, buffered);
      }
    }

    // Emit to frontend
    if (event.type === "tool-call-start") {
      this.emitTurnEvent({
        type: "tool-call-start",
        workspaceId,
        messageId,
        toolCallId: event.callId,
        toolName: event.toolName,
        args,
        tokens: 0, // Nested calls don't count toward stream tokens
        timestamp: event.startTime,
        parentToolCallId: event.parentToolCallId,
      });
    } else if (event.type === "tool-call-end") {
      this.emitTurnEvent({
        type: "tool-call-end",
        workspaceId,
        messageId,
        toolCallId: event.callId,
        toolName: event.toolName,
        result: event.result ?? (event.error ? { error: event.error } : undefined),
        timestamp: event.endTime!,
        parentToolCallId: event.parentToolCallId,
      });
    }
    // Console events are not streamed (appear in final result only)
  }

  private getStreamMode(initialMetadata?: Partial<MuxMetadata>): "plan" | "exec" | undefined {
    const rawMode = initialMetadata?.mode;
    // Stats schema only accepts "plan" | "exec".
    return rawMode === "plan" || rawMode === "exec" ? rawMode : undefined;
  }

  private emitStreamStart(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    historySequence: number,
    options?: { replay?: boolean }
  ): void {
    const streamStartAgentId = streamInfo.initialMetadata?.agentId;
    const streamStartMode = this.getStreamMode(streamInfo.initialMetadata);
    const canonicalModel = metadataModelIdentity(streamInfo.model);
    const routedThroughGateway =
      streamInfo.initialMetadata?.routedThroughGateway ??
      streamInfo.model.startsWith("mux-gateway:");
    const routeProvider = streamInfo.initialMetadata?.routeProvider;

    this.emitTurnEvent({
      type: "stream-start",
      workspaceId: workspaceId as string,
      messageId: streamInfo.messageId,
      ...(options?.replay && { replay: true }),
      model: canonicalModel,
      // Request-pinned identity so frontend live pricing/bucketing cannot
      // diverge from the backend ledger when a Coder catalog refresh
      // removes/retags the instance mid-stream.
      metadataModel: streamInfo.metadataModel,
      routedThroughGateway,
      ...(routeProvider != null && { routeProvider }),
      historySequence,
      startTime: streamInfo.startTime,
      ...(streamStartAgentId && { agentId: streamStartAgentId }),
      ...(streamStartMode && { mode: streamStartMode }),
      ...(streamInfo.thinkingLevel && { thinkingLevel: streamInfo.thinkingLevel }),
      ...(streamInfo.initialMetadata?.acpPromptId != null
        ? { acpPromptId: streamInfo.initialMetadata.acpPromptId }
        : {}),
    } as StreamStartEvent);
    // Lifecycle spine event: skipped on replay — a reconnecting subscriber
    // re-observes an already-running stream, and observers must see exactly
    // one start per stream (paired with the guaranteed end in
    // processStreamWithCleanup's finally).
    if (!options?.replay) {
      eventSpine.emit("stream.start", {
        workspaceId: workspaceId as string,
        messageId: streamInfo.messageId,
      });
    }
  }

  private async emitStreamAbort(
    workspaceId: WorkspaceId,
    messageId: string,
    metadata: Record<string, unknown>,
    abortReason: StreamAbortReason,
    abandonPartial?: boolean,
    acpPromptId?: string
  ): Promise<void> {
    return Promise.resolve(
      this.eventSink({
        type: "stream-abort",
        workspaceId: workspaceId as string,
        messageId,
        abortReason,
        metadata,
        abandonPartial,
        acpPromptId,
      })
    );
  }

  private async handleEmptyStreamCompletion(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ): Promise<void> {
    const workspaceLog = this.getWorkspaceLogger(workspaceId, streamInfo);
    const streamMeta = await this.getStreamMetadata(streamInfo);
    const totalUsage = this.resolveTotalUsageForStreamEnd(streamInfo, streamMeta.totalUsage);
    const contextUsage = streamMeta.contextUsage ?? streamInfo.lastStepUsage;
    const previousResponseId = this.getOpenAIPreviousResponseId(streamInfo.request.providerOptions);

    // Surface silent provider drops instead of leaving an empty assistant placeholder behind.
    // Recent gpt-5.4-pro stalls only logged stream startup, so future occurrences need an
    // explicit backend breadcrumb and a user-visible retryable error.
    workspaceLog.error("Stream ended without emitting text, reasoning, or tool events", {
      messageId: streamInfo.messageId,
      model: streamInfo.model,
      durationMs: streamMeta.duration,
      totalUsage,
      contextUsage,
      cumulativeUsage: streamInfo.cumulativeUsage,
      previousResponseId,
    });

    await this.handleStreamFailure(workspaceId, streamInfo, new EmptyStreamOutputError());
  }

  private async handleModelRefusalCompletion(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    refusalFinishReason: string,
    fallbackNote?: string
  ): Promise<void> {
    const workspaceLog = this.getWorkspaceLogger(workspaceId, streamInfo);
    const streamMeta = await this.getStreamMetadata(streamInfo);

    workspaceLog.error("Stream ended with a terminal refusal", {
      messageId: streamInfo.messageId,
      model: streamInfo.model,
      finishReason: streamInfo.terminalFinishReason,
      rawFinishReason: streamInfo.terminalRawFinishReason,
      durationMs: streamMeta.duration,
      partsCount: streamInfo.parts.length,
      fallbackNote,
    });

    await this.handleStreamFailure(
      workspaceId,
      streamInfo,
      new ModelRefusalError(streamInfo.model, refusalFinishReason, fallbackNote)
    );
  }

  private async getRefusalUsageSnapshot(streamInfo: WorkspaceStreamInfo): Promise<{
    usage?: LanguageModelV2Usage;
    providerMetadata?: Record<string, unknown>;
  }> {
    let usage = hasTokenUsage(streamInfo.cumulativeUsage) ? streamInfo.cumulativeUsage : undefined;
    let providerMetadata = streamInfo.cumulativeProviderMetadata
      ? { ...streamInfo.cumulativeProviderMetadata }
      : undefined;

    if (!usage) {
      const streamMeta = await this.getStreamMetadata(streamInfo);
      usage = hasTokenUsage(streamMeta.totalUsage) ? streamMeta.totalUsage : undefined;
      providerMetadata = providerMetadata ?? streamMeta.contextProviderMetadata;
    }

    if (!usage) {
      return {};
    }

    // Refused attempts never reach the normal stream-end path, so backfill
    // provider-omitted reasoningTokens before snapshotting usage for the
    // refusing model. reasoningBackfillStartIndex excludes earlier refused hops
    // when a later fallback also refuses after preserved parts.
    await this.backfillReasoningTokensFromParts(streamInfo, usage);

    providerMetadata =
      providerMetadata ??
      (streamInfo.cumulativeProviderMetadata
        ? { ...streamInfo.cumulativeProviderMetadata }
        : await this.getAggregatedProviderMetadata(streamInfo));

    return {
      usage: cloneUsage(usage),
      providerMetadata: markProviderMetadataCostsIncluded(
        providerMetadata ? { ...providerMetadata } : undefined,
        streamInfo.initialMetadata?.costsIncluded
      ),
    };
  }

  /**
   * Attribute a refused fallback attempt's token usage to the refusing model
   * before the fallback swap wipes per-attempt counters. The toolModelUsages
   * entry is the durable record (session-usage rebuilds scan it per-model); the
   * live recordSessionUsage call keeps in-memory session totals consistent with it.
   */
  private async recordRefusedAttemptUsage(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    refusedModel: string
  ): Promise<void> {
    const { usage, providerMetadata } = await this.getRefusalUsageSnapshot(streamInfo);

    // Zero-usage refusals (provider billed nothing / usage never arrived) are
    // still real refused attempts: record an explicit all-zero entry so
    // analytics counts the refusal, but skip the session ledger below — no
    // zero-cost noise in the costs UI.
    //
    // The persisted entry carries the ATTRIBUTION key, not the raw stream
    // identity: sidecar refused_stream rows are keyed by
    // recordHeadlessUsageLocked's canonical model, so a raw gateway/Coder
    // identity here (e.g. mux-gateway:openai/gpt-5 vs openai:gpt-5) would
    // split one model across two analytics buckets when queries group
    // committed hop rows and sidecar rows together.
    streamInfo.toolModelUsages.push({
      toolName: MODEL_FALLBACK_REFUSAL_TOOL_NAME,
      timestamp: Date.now(),
      model: this.usageAttributionModel(refusedModel, streamInfo.metadataModel),
      metadataModel: streamInfo.metadataModel,
      usage: usage ?? zeroTokenUsage(),
      ...(providerMetadata ? { providerMetadata } : {}),
    });

    if (!usage) {
      return;
    }

    await this.recordSessionUsage(
      workspaceId,
      refusedModel,
      usage,
      providerMetadata,
      "Failed to record refused-attempt session usage (fallback unaffected)",
      "warn",
      streamInfo
    );
  }

  private async recordTerminalRefusalUsage(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    refusedModel: string
  ): Promise<void> {
    const { usage, providerMetadata } = await this.getRefusalUsageSnapshot(streamInfo);

    // Same zero-usage policy as recordRefusedAttemptUsage: the terminal
    // refusal must reach the analytics sidecar (persistStreamError writes
    // terminalRefusalUsage as a "refused_stream" row) even when the provider
    // billed nothing, but the session ledger stays free of zero-cost entries.
    streamInfo.terminalRefusalUsage = usage ?? zeroTokenUsage();
    streamInfo.terminalRefusalProviderMetadata = providerMetadata;

    if (!usage) {
      return;
    }

    await this.recordSessionUsage(
      workspaceId,
      refusedModel,
      usage,
      providerMetadata,
      "Failed to record terminal-refusal session usage",
      "warn",
      streamInfo
    );
  }

  private buildPartialAssistantMessage(
    streamInfo: WorkspaceStreamInfo,
    options: { metadata?: Partial<MuxMetadata>; parts?: MuxMessage["parts"] } = {}
  ): MuxMessage {
    const canonicalModel = metadataModelIdentity(streamInfo.model);
    const routedThroughGateway =
      streamInfo.initialMetadata?.routedThroughGateway ??
      streamInfo.model.startsWith("mux-gateway:");

    return {
      id: streamInfo.messageId,
      role: "assistant",
      metadata: {
        historySequence: streamInfo.historySequence,
        timestamp: streamInfo.startTime,
        ...streamInfo.initialMetadata,
        model: canonicalModel,
        metadataModel: streamInfo.metadataModel,
        routedThroughGateway,
        ...(streamInfo.thinkingLevel && {
          thinkingLevel: streamInfo.thinkingLevel as ThinkingLevel,
        }),
        partial: true,
        ...options.metadata,
        stepStartPartIndices: streamInfo.stepStartIndices.filter(
          (index) => index < (options.parts ?? streamInfo.parts).length
        ),
      },
      parts: options.parts ?? streamInfo.parts,
    };
  }

  private buildPartialRefusalContinuationMessage(
    streamInfo: WorkspaceStreamInfo,
    refusalFinishReason: string
  ): Result<MuxMessage, string> {
    try {
      const parts = structuredClone(streamInfo.parts) as MuxMessage["parts"];
      return Ok(
        this.buildPartialAssistantMessage(streamInfo, {
          metadata: { finishReason: refusalFinishReason },
          parts,
        })
      );
    } catch (error) {
      return Err(`cloning partial assistant output failed: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Attempt a refusal-fallback model swap in place of a terminal model_refusal.
   *
   * This runs entirely inside the active stream loop, BEFORE any error event or
   * partial error state is committed, so TaskService/waiters never observe an
   * intermediate refusal while the chain is being attempted (no settlement
   * race) and no stale failed placeholder is persisted mid-chain.
   *
   * Returns { kind: "swapped" } when the loop should `continue` on the new
   * streamResult, or { kind: "terminal", terminalNote? } when the refusal must
   * fail the turn (no chain, chain exhausted, interrupted, or an unstartable
   * fallback model — which intentionally fails instead of skipping ahead).
   */
  private async tryModelFallbackAfterRefusal(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    refusalFinishReason: string,
    options?: { preserveParts?: boolean }
  ): Promise<{ kind: "swapped" } | { kind: "terminal"; terminalNote?: string }> {
    const fallbackState = streamInfo.modelFallback;
    const preserveParts = options?.preserveParts === true;
    const refusedModel = normalizeToCanonical(streamInfo.model);
    // Usage attribution keeps the RAW identity: canonicalization rewrites a
    // cross-typed Coder instance (coder:openai/<claude>, type anthropic) to
    // openai:<claude>, and recordSessionUsage / ledger rebuilds could then no
    // longer recover the instance type for pricing. The canonical string is
    // only for the display list / chain bookkeeping below.
    const refusedModelForUsage = streamInfo.model;

    if (!fallbackState) {
      await this.recordTerminalRefusalUsage(workspaceId, streamInfo, refusedModelForUsage);
      return { kind: "terminal" };
    }

    fallbackState.refusedModels.push(refusedModel);
    streamInfo.initialMetadata = {
      ...streamInfo.initialMetadata,
      modelFallback: {
        requestedModel: fallbackState.requestedModel,
        refusedModels: [...fallbackState.refusedModels],
      },
    };

    if (streamInfo.abortController.signal.aborted || streamInfo.softInterrupt.pending) {
      await this.recordRefusedAttemptUsage(workspaceId, streamInfo, refusedModelForUsage);
      return { kind: "terminal" };
    }

    // Attribute this refused attempt's usage to the refusing model for EVERY
    // chain outcome (swap, exhaustion, unstartable fallback) before any state
    // reset. Chains that end in a terminal failure must not drop the final
    // hop's tokens from session usage / cost accounting.
    await this.recordRefusedAttemptUsage(workspaceId, streamInfo, refusedModelForUsage);

    const nextModelString = fallbackState.options.chain[fallbackState.refusedModels.length - 1];
    if (nextModelString === undefined) {
      return {
        kind: "terminal",
        terminalNote: `Model fallback chain exhausted; refused models: ${fallbackState.refusedModels.join(", ")}.`,
      };
    }

    if (preserveParts && hasIncompleteToolCallPart(streamInfo.parts)) {
      return {
        kind: "terminal",
        terminalNote:
          "Model fallback was skipped because the refused partial response had an incomplete tool call.",
      };
    }

    const continuation = preserveParts
      ? this.buildPartialRefusalContinuationMessage(streamInfo, refusalFinishReason)
      : undefined;
    if (continuation != null && !continuation.success) {
      return {
        kind: "terminal",
        terminalNote: `Model fallback was skipped because ${continuation.error}.`,
      };
    }

    const workspaceLog = this.getWorkspaceLogger(workspaceId, streamInfo);
    // A throw out of prepare() must not escape to the generic stream-error path:
    // it would be categorized as a retryable api/unknown error and re-enter the
    // unbounded auto-retry loop this feature exists to prevent. Aborts rethrow so
    // a user interrupt during prepare stays an abort instead of a refusal.
    // Fold a mid-turn thinking override (pending or already applied) into the
    // fallback's baseline so the hop doesn't silently revert the user's
    // mid-turn change. Pending is cleared here — prepare() re-clamps it for
    // the fallback model and bakes it into the rebuilt provider options.
    const overrideHolder = streamInfo.request.thinkingOverrideState;
    const thinkingLevelOverride = overrideHolder?.pending ?? overrideHolder?.applied;
    if (overrideHolder?.pending != null) {
      overrideHolder.pending = undefined;
    }
    if (overrideHolder != null && thinkingLevelOverride != null) {
      // Keep the override visible to later hops: prepare() bakes it into this
      // hop's baseline, but a second hop re-folds from `applied`.
      overrideHolder.applied = thinkingLevelOverride;
    }
    const prepareCallOptions: ModelFallbackPrepareOptions | undefined =
      continuation?.success === true || thinkingLevelOverride != null
        ? {
            ...(continuation?.success === true
              ? { continuation: { assistantMessage: continuation.data } }
              : {}),
            ...(thinkingLevelOverride != null ? { thinkingLevelOverride } : {}),
          }
        : undefined;
    streamInfo.stepTracker.pendingPrefixSwap = undefined;
    let prepared: Awaited<ReturnType<ModelFallbackOptions["prepare"]>>;
    try {
      prepared = await fallbackState.options.prepare(nextModelString, prepareCallOptions);
    } catch (error) {
      if (streamInfo.abortController.signal.aborted) {
        throw error;
      }
      return {
        kind: "terminal",
        terminalNote: `Configured fallback model ${nextModelString} could not be started: ${getErrorMessage(error)}`,
      };
    }
    if (!prepared.success) {
      if (typeof prepared.error !== "string") throw new ContextBudgetExceededError(prepared.error);
      return {
        kind: "terminal",
        terminalNote: `Configured fallback model ${nextModelString} could not be started: ${prepared.error}`,
      };
    }

    // Build the swapped request/stream into locals first so a failure here
    // leaves streamInfo unmodified (the terminal error then names the model
    // that actually refused, not a half-applied fallback).
    const nextRequest = this.buildStreamRequestConfig({
      model: prepared.data.model,
      modelString: prepared.data.modelString,
      messages: prepared.data.messages,
      system: prepared.data.system,
      tools: prepared.data.tools,
      providerOptions: prepared.data.providerOptions,
      maxOutputTokens: prepared.data.maxOutputTokens ?? fallbackState.original.maxOutputTokens,
      callSettingsOverrides: prepared.data.callSettingsOverrides,
      toolPolicy: streamInfo.request.toolPolicy,
      hasQueuedMessages: streamInfo.request.hasQueuedMessages,
      getQueuedInputStopCause: streamInfo.request.getQueuedInputStopCause,
      headers: prepared.data.headers,
      onChunk: streamInfo.request.onChunk,
      onStepMessages: streamInfo.request.onStepMessages,
      onStepSettled: streamInfo.request.onStepSettled,
      contextBudgetMemoryWritable: prepared.data.contextBudgetMemoryWritable,
      contextBudgetLimit: prepared.data.contextBudgetLimit,
      // Same state object: aiService's fallback prepare() rebuilt it in place
      // against the fallback toolset, so prepareStep keeps reading live state.
      toolSearchState: streamInfo.request.toolSearchState,
      onToolExecutionStart: (toolCallId) =>
        this.handleToolExecutionStart(workspaceId, streamInfo.messageId, toolCallId),
      // Same holder object (the session's setter keeps working across the
      // hop) with a closure bound to the FALLBACK model. Attached before
      // createStreamResult below in case the SDK eagerly prepares step 1.
      thinkingOverrideState: streamInfo.request.thinkingOverrideState,
      rebuildProviderOptionsForThinkingLevel: prepared.data.rebuildProviderOptionsForThinkingLevel,
      forcedFirstStepToolNames: prepared.data.forcedFirstStepToolNames,
      providersConfigSnapshot: prepared.data.providersConfig,
      rebuildFirstStepForThinkingLevel: prepared.data.rebuildFirstStepForThinkingLevel,
    });
    const consumedSwap = streamInfo.stepTracker.consumedPrefixSwap;
    if (consumedSwap) {
      const family = this.resolveMetadataModel(
        prepared.data.modelString,
        prepared.data.providersConfig
      ).split(":", 1)[0];
      // Fallback preparation can combine consecutive tool-only steps from the live
      // Mux row. An internal cut is no longer a provable wire-message boundary.
      let messages: ModelMessage[] | null = null;
      if (
        family === consumedSwap.journal.providerFamily &&
        consumedSwap.journal.liveTailCopySpec.partIndex === 0 &&
        (prepared.data.thinkingLevel ?? "off") ===
          consumedSwap.journal.preparation.effectiveThinkingLevel
      ) {
        const conversation = stripMessageCacheControl(
          consumedSwap.prefix.filter((message) => message.role !== "system")
        );
        const prefix = [
          ...nextRequest.messages.filter((message) => message.role === "system"),
          ...(nextRequest.cacheEnabled
            ? applyCacheControl(
                conversation,
                "anthropic:prefix",
                getAnthropicCacheTtl(nextRequest.providerOptions)
              )
            : conversation),
        ];
        const swapped = this.swapPrefix(nextRequest.messages, { ...consumedSwap, prefix });
        if (swapped) {
          const appliedThinking = nextRequest.thinkingOverrideState?.applied;
          const isCurrent = () =>
            streamInfo.stepTracker.consumedPrefixSwap === consumedSwap &&
            !streamInfo.abortController.signal.aborted &&
            nextRequest.thinkingOverrideState?.pending == null &&
            nextRequest.thinkingOverrideState?.applied === appliedThinking;
          const journal = await this.historyService
            .getContinuousCompactionJournal(workspaceId)
            .recordFallbackPrefix(
              consumedSwap.journal,
              {
                modelString: prepared.data.modelString,
                prefix,
                providerOptions: nextRequest.providerOptions,
                system: nextRequest.system,
              },
              isCurrent,
              (committed) => {
                consumedSwap.journal = committed;
              }
            );
          if (journal && isCurrent()) {
            consumedSwap.journal = journal;
            messages = swapped;
          }
        }
      }
      if (messages) nextRequest.messages = messages;
      else streamInfo.stepTracker.prefixSwapInvalidated = true;
    }
    // createStreamResult may eagerly prepare the first fallback step and update
    // latestMessages. Clear stale source-step messages before starting it so a
    // later disk-reset await cannot wipe freshly prepared fallback messages.
    streamInfo.stepTracker.latestMessages = undefined;
    let nextStreamResult: WorkspaceStreamInfo["streamResult"];
    try {
      nextStreamResult = this.createStreamResult(
        nextRequest,
        streamInfo.abortController,
        streamInfo.stepTracker
      );
    } catch (error) {
      // The prepared fallback model never becomes streamInfo.request.model, so
      // the stream-exit finally would miss it (e.g. OpenAI WS transports hold
      // open sockets until cleanup runs).
      runLanguageModelCleanup(prepared.data.model);
      return {
        kind: "terminal",
        terminalNote: `Configured fallback model ${nextModelString} could not be started: ${getErrorMessage(error)}`,
      };
    }

    // The fallback stream exists now; durable side effects describing this
    // request identity (superseding turn envelope) may be recorded.
    await prepared.data.onStreamConstructed?.();

    workspaceLog.warn(
      preserveParts
        ? "Model refused after partial output; continuing on configured fallback model"
        : "Model refused with no output; retrying on configured fallback model",
      {
        messageId: streamInfo.messageId,
        refusedModel,
        nextModel: prepared.data.modelString,
        refusalFinishReason,
        chain: fallbackState.options.chain,
        preservedPartCount: preserveParts ? streamInfo.parts.length : 0,
      }
    );

    // The refused attempt's usage was recorded above, BEFORE the reset wipes
    // cumulative counters (cross-model usage must not be priced under the
    // fallback model).
    await this.resetStreamStateForRetry(workspaceId, streamInfo, {
      preserveParts,
      workspaceLog,
    });
    streamInfo.reasoningBackfillStartIndex = preserveParts ? streamInfo.parts.length : undefined;

    streamInfo.model = prepared.data.modelString;
    streamInfo.metadataModel = this.resolveMetadataModel(
      prepared.data.modelString,
      prepared.data.providersConfig
    );
    if (prepared.data.thinkingLevel !== undefined) {
      streamInfo.thinkingLevel = prepared.data.thinkingLevel;
    }
    // Final stream-end metadata spreads initialMetadata, so route attribution
    // corrections and the fallback record propagate automatically.
    streamInfo.initialMetadata = {
      ...streamInfo.initialMetadata,
      ...prepared.data.initialMetadataPatch,
      modelFallback: {
        requestedModel: fallbackState.requestedModel,
        refusedModels: [...fallbackState.refusedModels],
      },
    };
    // Release the refused model's transport resources now: the stream-exit
    // finally only cleans the final request's model, so without this the
    // refused model (e.g. an OpenAI WS transport socket) would leak per hop.
    runLanguageModelCleanup(streamInfo.request.model);
    streamInfo.request = nextRequest;
    streamInfo.streamResult = nextStreamResult;
    await this.tokenTracker.setModel(streamInfo.model, streamInfo.metadataModel);
    if (
      consumedSwap &&
      streamInfo.stepTracker.prefixSwapInvalidated &&
      !streamInfo.stepTracker.prefixSwapInvalidationEmitted
    ) {
      streamInfo.stepTracker.prefixSwapInvalidationEmitted = true;
      this.emitTurnEvent({
        type: "prefix-swap-invalidated",
        workspaceId,
        messageId: streamInfo.messageId,
      });
    }

    return { kind: "swapped" };
  }

  private async handleTruncatedStreamCompletion(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ): Promise<void> {
    const workspaceLog = this.getWorkspaceLogger(workspaceId, streamInfo);
    const streamMeta = await this.getStreamMetadata(streamInfo);
    const totalUsage = this.resolveTotalUsageForStreamEnd(streamInfo, streamMeta.totalUsage);
    const contextUsage = streamMeta.contextUsage ?? streamInfo.lastStepUsage;
    const previousResponseId = this.getOpenAIPreviousResponseId(streamInfo.request.providerOptions);
    const providerDisplayName = getStreamProviderDisplayName(streamInfo.model);

    // Do not treat iterator EOF as success. Anthropic and OpenAI Responses both
    // have semantic terminal events; without the SDK finish part, this may be a
    // clean proxy/provider drop after partial text was already streamed.
    workspaceLog.error("Stream ended without a terminal finish event", {
      messageId: streamInfo.messageId,
      model: streamInfo.model,
      providerDisplayName,
      durationMs: streamMeta.duration,
      totalUsage,
      contextUsage,
      cumulativeUsage: streamInfo.cumulativeUsage,
      previousResponseId,
      partsCount: streamInfo.parts.length,
    });

    await this.handleStreamFailure(
      workspaceId,
      streamInfo,
      new StreamTruncatedError(providerDisplayName)
    );
  }

  private async retryEmptyStreamBeforeFailure(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    emptyStreamRecoveryAttempts: number
  ): Promise<boolean> {
    if (emptyStreamRecoveryAttempts >= MAX_EMPTY_STREAM_RECOVERY_ATTEMPTS) {
      return false;
    }

    if (streamInfo.abortController.signal.aborted || streamInfo.softInterrupt.pending) {
      return false;
    }

    if (streamInfo.parts.length > 0) {
      return false;
    }

    const workspaceLog = this.getWorkspaceLogger(workspaceId, streamInfo);
    workspaceLog.warn("Retrying stream after empty-output completion", {
      messageId: streamInfo.messageId,
      model: streamInfo.model,
      nextAttempt: emptyStreamRecoveryAttempts + 1,
      maxAttempts: MAX_EMPTY_STREAM_RECOVERY_ATTEMPTS,
      previousResponseId: this.getOpenAIPreviousResponseId(streamInfo.request.providerOptions),
    });

    streamInfo.didRetryAfterEmptyOutput = true;
    await this.resetStreamStateForRetry(workspaceId, streamInfo, {
      preserveUsage: true,
      workspaceLog,
    });
    streamInfo.streamResult = this.createStreamResult(
      streamInfo.request,
      streamInfo.abortController,
      streamInfo.stepTracker
    );
    return true;
  }

  /**
   * Processes a stream with guaranteed cleanup, regardless of success or failure
   */
  private async processStreamWithCleanup(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    historySequence: number
  ): Promise<void> {
    this.mcpServerManager?.acquireLease(workspaceId as string);

    try {
      // Update state to streaming
      streamInfo.state = StreamState.STREAMING;

      // Emit stream start event (include mode from initialMetadata if available)
      this.emitStreamStart(workspaceId, streamInfo, historySequence);

      // Initialize token tracker for this model
      await this.tokenTracker.setModel(streamInfo.model, streamInfo.metadataModel);

      let didRetryPreviousResponseId = false;
      let emptyStreamRecoveryAttempts = 0;
      const workspaceLog = this.getWorkspaceLogger(workspaceId, streamInfo);
      let orphanToolResultCount = 0;

      while (true) {
        // Use fullStream to capture all events including tool calls
        const toolCalls: ToolCallMap = new Map();

        try {
          for await (const part of streamInfo.streamResult.fullStream) {
            // Check if stream was cancelled BEFORE processing any parts
            // This improves interruption responsiveness by catching aborts earlier
            if (streamInfo.abortController.signal.aborted) {
              break;
            }

            // Log all stream parts to debug reasoning (commented out - too spammy)
            // console.log("[DEBUG streamManager]: Stream part", {
            //   type: part.type,
            //   hasText: "text" in part,
            //   preview: "text" in part ? (part as StreamPartWithText).text?.substring(0, 50) : undefined,
            // });

            switch (part.type) {
              case "start-step": {
                this.recordStepStart(streamInfo);
                break;
              }

              case "text-delta": {
                // Providers/SDKs may stream text deltas under different keys.
                const textDeltaPart = part as Record<string, unknown>;

                const deltaText = extractChunkDeltaText(textDeltaPart, [
                  "text",
                  "delta",
                  "textDelta",
                ]);

                if (deltaText.length === 0) {
                  if (
                    textDeltaPart.text !== undefined ||
                    textDeltaPart.delta !== undefined ||
                    textDeltaPart.textDelta !== undefined
                  ) {
                    log.debug("[streamManager] Ignoring non-string text-delta payload", {
                      workspaceId,
                      model: streamInfo.model,
                      textType: typeof textDeltaPart.text,
                      deltaType: typeof textDeltaPart.delta,
                      textDeltaType: typeof textDeltaPart.textDelta,
                    });
                  }
                  break;
                }

                // Append each delta as a new part (merging happens at display time)
                const textPart = {
                  type: "text" as const,
                  text: deltaText,
                  timestamp: nextPartTimestamp(streamInfo),
                };
                await this.appendPartAndEmit(workspaceId, streamInfo, textPart, true);
                break;
              }

              default: {
                if (await this.emitToolCallDeltaIfPresent(workspaceId, streamInfo, part)) {
                  break;
                }
                break;
              }

              case "reasoning-start": {
                // OpenAI/xAI may attach itemId (and sometimes encrypted content) on start.
                // Stash on the latest reasoning part, or open an empty one for later deltas.
                const lifecyclePart = part as ReasoningLifecyclePart;
                const startOptions = reasoningProviderOptionsFromMetadata(
                  lifecyclePart.providerMetadata
                );
                if (startOptions) {
                  const lastPart = streamInfo.parts.at(-1);
                  if (lastPart?.type === "reasoning") {
                    lastPart.providerOptions = mergeReasoningProviderOptions(
                      lastPart.providerOptions,
                      startOptions
                    );
                    void this.schedulePartialWrite(workspaceId, streamInfo);
                  } else {
                    await this.appendPartAndEmit(
                      workspaceId,
                      streamInfo,
                      {
                        type: "reasoning" as const,
                        text: "",
                        timestamp: nextPartTimestamp(streamInfo),
                        providerOptions: startOptions,
                      },
                      true
                    );
                  }
                }
                break;
              }

              case "reasoning-delta": {
                // Anthropic, OpenAI, and xAI stream reasoning content via reasoning-delta.
                const reasoningPart = part as ReasoningDeltaPart;
                const delta = reasoningPart.text ?? reasoningPart.delta ?? "";
                const signature = reasoningPart.providerMetadata?.anthropic?.signature;
                const deltaOptions = reasoningProviderOptionsFromMetadata(
                  reasoningPart.providerMetadata
                );

                // Metadata-only deltas (Anthropic signature, OpenAI/xAI itemId) attach to
                // the latest reasoning part without creating a new empty text part.
                if (!delta && (signature || deltaOptions)) {
                  const lastPart = streamInfo.parts.at(-1);
                  if (lastPart?.type === "reasoning") {
                    if (signature) {
                      lastPart.signature = signature;
                    }
                    lastPart.providerOptions = mergeReasoningProviderOptions(
                      lastPart.providerOptions,
                      deltaOptions ?? (signature ? { anthropic: { signature } } : undefined)
                    );
                    // Emit signature update event for Anthropic UI consumers.
                    if (signature) {
                      this.emitTurnEvent({
                        type: "reasoning-delta",
                        workspaceId: workspaceId as string,
                        messageId: streamInfo.messageId,
                        delta: "",
                        tokens: 0,
                        timestamp: nextPartTimestamp(streamInfo),
                        signature,
                      });
                    }
                    void this.schedulePartialWrite(workspaceId, streamInfo);
                  }
                  break;
                }

                // Append each delta as a new part (merging happens at display time)
                // Include providerOptions for SDK compatibility when converting to ModelMessages
                const newPart = {
                  type: "reasoning" as const,
                  text: delta,
                  timestamp: nextPartTimestamp(streamInfo),
                  signature, // May be undefined, will be filled by subsequent signature delta
                  providerOptions: deltaOptions,
                };
                await this.appendPartAndEmit(workspaceId, streamInfo, newPart, true);
                break;
              }

              case "reasoning-end": {
                // xAI (and OpenAI store=false) put reasoningEncryptedContent on reasoning-end.
                // Xum streams reasoning as many tiny delta parts; providers expect one
                // reasoning item with encrypted content. Attach metadata to the first part
                // of the contiguous reasoning run so convertToModelMessages can replay it
                // even if later parts lack providerOptions.
                const lifecyclePart = part as ReasoningLifecyclePart;
                const endOptions = reasoningProviderOptionsFromMetadata(
                  lifecyclePart.providerMetadata
                );
                if (endOptions) {
                  const firstReasoningIndex = findFirstReasoningPartIndexInTrailingRun(
                    streamInfo.parts
                  );
                  if (firstReasoningIndex >= 0) {
                    const firstPart = streamInfo.parts[firstReasoningIndex];
                    if (firstPart?.type === "reasoning") {
                      firstPart.providerOptions = mergeReasoningProviderOptions(
                        firstPart.providerOptions,
                        endOptions
                      );
                      void this.schedulePartialWrite(workspaceId, streamInfo);
                    }
                  }
                }

                this.emitTurnEvent({
                  type: "reasoning-end",
                  workspaceId: workspaceId as string,
                  messageId: streamInfo.messageId,
                });
                await this.checkSoftCancelStream(workspaceId, streamInfo);
                break;
              }

              case "tool-call": {
                // Tool call started - store in map for later lookup
                const invalidInputError =
                  part.dynamic === true && part.invalid === true && part.error != null
                    ? describeInvalidToolInput(part.toolName, part.input, part.error)
                    : undefined;
                toolCalls.set(part.toolCallId, {
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  input: part.input,
                  ...(invalidInputError != null ? { invalidInputError } : {}),
                });

                // Note: Tool availability is handled by the SDK, which emits tool-error events
                // for unavailable tools. No need to check here.

                // IMPORTANT: Add tool part to streamInfo.parts immediately (not just on completion)
                // This ensures in-progress tool calls are saved to partial.json if stream is interrupted
                const toolPart = {
                  type: "dynamic-tool" as const,
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  state: "input-available" as const,
                  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                  input: part.input,
                  timestamp: nextPartTimestamp(streamInfo),
                };

                // Emit using shared logic (ensures replay consistency)
                const inputText = JSON.stringify(part.input);
                log.debug(
                  `[StreamManager] tool-call: toolName=${part.toolName}, input length=${inputText.length}`
                );
                await this.appendPartAndEmit(workspaceId, streamInfo, toolPart);

                // CRITICAL: Flush partial immediately for ask_user_question
                // This tool blocks waiting for user input, and if the app restarts during
                // that wait, the partial must be persisted so it can be restored.
                // Without this, the throttled write might not complete before app shutdown.
                if (part.toolName === "ask_user_question") {
                  await this.flushPartialWrite(workspaceId, streamInfo);
                }
                break;
              }

              case "tool-result": {
                const toolResultPart = part as {
                  toolCallId: string;
                  toolName: string;
                  output: unknown;
                  providerExecuted?: boolean;
                };

                // Strip encrypted content from web search results before storing
                const strippedOutput = stripInternalToolResultFields(
                  stripEncryptedContent(toolResultPart.output)
                );

                // Tool call completed successfully
                const toolCall = toolCalls.get(toolResultPart.toolCallId);
                if (toolCall) {
                  toolCall.output = strippedOutput;
                } else {
                  orphanToolResultCount += 1;
                  this.logOrphanToolResult(
                    workspaceLog,
                    streamInfo,
                    {
                      toolCallId: toolResultPart.toolCallId,
                      toolName: toolResultPart.toolName,
                    },
                    strippedOutput,
                    orphanToolResultCount,
                    toolCalls.size
                  );
                }

                // Use shared completion logic (await to ensure partial is flushed before event)
                await this.finishToolCall(
                  workspaceId,
                  streamInfo,
                  toolCalls,
                  toolResultPart.toolCallId,
                  toolResultPart.toolName,
                  strippedOutput,
                  toolResultPart.providerExecuted
                );
                break;
              }

              // Handle tool-error parts from the stream (AI SDK 5.0+)
              // These are emitted when tool execution fails (e.g., tool doesn't exist)
              case "tool-error": {
                const toolErrorPart = part as {
                  toolCallId: string;
                  toolName: string;
                  error: unknown;
                  providerExecuted?: boolean;
                };

                const logLevel = streamInfo.abortController.signal.aborted ? log.debug : log.error;
                logLevel(`Tool execution error for '${toolErrorPart.toolName}'`, {
                  toolCallId: toolErrorPart.toolCallId,
                  error: toolErrorPart.error,
                });

                // Format error output. getErrorMessage (not bare
                // JSON.stringify) so a cyclic/BigInt tool-error payload stays
                // a recoverable tool error instead of throwing here and
                // failing the whole stream.
                const errorOutput = {
                  success: false,
                  error:
                    toolCalls.get(toolErrorPart.toolCallId)?.invalidInputError ??
                    (typeof toolErrorPart.error === "string"
                      ? toolErrorPart.error
                      : toolErrorPart.error instanceof Error
                        ? toolErrorPart.error.message
                        : getErrorMessage(toolErrorPart.error)),
                };

                // Use shared completion logic (await to ensure partial is flushed before event)
                await this.finishToolCall(
                  workspaceId,
                  streamInfo,
                  toolCalls,
                  toolErrorPart.toolCallId,
                  toolErrorPart.toolName,
                  errorOutput,
                  toolErrorPart.providerExecuted
                );
                break;
              }

              // Handle error parts from the stream (e.g., OpenAI context_length_exceeded)
              case "error": {
                // Capture the error and immediately throw to trigger error handling
                // Error parts are structured errors from the AI SDK
                const errorPart = part as { error: unknown };

                // Try to extract error message from various possible structures
                let errorMessage: string | undefined;

                if (errorPart.error instanceof Error) {
                  throw errorPart.error;
                } else if (typeof errorPart.error === "object" && errorPart.error !== null) {
                  const errorObj = errorPart.error as Record<string, unknown>;

                  // Check for nested error object with message (OpenAI format)
                  if (
                    errorObj.error &&
                    typeof errorObj.error === "object" &&
                    errorObj.error !== null
                  ) {
                    const nestedError = errorObj.error as Record<string, unknown>;
                    if (typeof nestedError.message === "string") {
                      errorMessage = nestedError.message;
                    }
                  }

                  // Fallback to direct message property
                  errorMessage ??=
                    typeof errorObj.message === "string" ? errorObj.message : undefined;

                  // Last resort: stringify the error. getErrorMessage guards
                  // against cyclic/BigInt payloads and undefined-returning
                  // toJSON, where a bare JSON.stringify would throw and
                  // replace the provider error with a serialization TypeError.
                  errorMessage ??= getErrorMessage(errorObj);

                  const error = new Error(errorMessage);
                  // Preserve original error as cause for debugging
                  Object.assign(error, { cause: errorObj });
                  throw error;
                } else {
                  throw new Error(String(errorPart.error));
                }
              }

              // Handle other event types as needed
              case "start":
              case "text-start":
                // These events can be logged or handled if needed
                break;

              case "finish": {
                const finishPart = part as {
                  finishReason?: unknown;
                  rawFinishReason?: unknown;
                };
                // Skip the `ai` package's synthesized-default finish part.
                //
                // `streamText`'s internal `runStep` initializes
                // `stepFinishReason = "other"` and `stepRawFinishReason = undefined`,
                // and unconditionally emits those values from its flush() at
                // end-of-stream — even when the underlying SSE stream closed
                // before any terminal event arrived. The OpenAI Responses,
                // Chat Completions, and Anthropic Messages adapters all
                // exhibit this in practice: a clean upstream EOF (no
                // `response.completed`, no `message_stop`, no
                // `finish_reason` delta) ends up as a synthesized
                // `(other, undefined)` finish here.
                //
                // The discriminator is narrow on purpose. Every real OpenAI
                // and Anthropic finish path that maps to `"other"` pairs it
                // with a defined raw reason (e.g. Anthropic's `"compaction"`).
                // The `(other, undefined)` shape is unreachable from the
                // adapters' own finish-reason mappers and is therefore a
                // reliable signal that the finish was synthesized.
                //
                // Treating it as a non-event lets the existing
                // `!receivedTerminalEvent` branch below fire
                // `handleTruncatedStreamCompletion`, which surfaces a
                // retryable `stream_truncated` error instead of silently
                // committing partial output as a normal assistant message.
                if (
                  finishPart.finishReason === "other" &&
                  finishPart.rawFinishReason === undefined
                ) {
                  // Observability for the unaudited-adapter risk: if a future
                  // provider adapter we haven't read source for legitimately
                  // emits `(other, undefined)` as a real terminal finish, the
                  // discriminator misfires and the user sees a spurious
                  // truncated-stream retry. Surface a log so that misfires
                  // are diagnosable instead of silent.
                  workspaceLog.warn(
                    "Treating synthesized-default (other, undefined) finish as truncated stream",
                    {
                      messageId: streamInfo.messageId,
                      model: streamInfo.model,
                    }
                  );
                  break;
                }
                streamInfo.receivedTerminalEvent = true;
                if (typeof finishPart.finishReason === "string") {
                  streamInfo.terminalFinishReason = finishPart.finishReason;
                }
                if (typeof finishPart.rawFinishReason === "string") {
                  streamInfo.terminalRawFinishReason = finishPart.rawFinishReason;
                }
                break;
              }

              case "finish-step": {
                // Emit usage-delta event with usage from this step
                const finishStepPart = part as {
                  type: "finish-step";
                  usage: AiSdkUsageLike;
                  providerMetadata?: Record<string, unknown>;
                };

                // Normalize AI SDK 7 nested usage into mux's persisted flat shape,
                // re-injecting Anthropic cache-write tokens into provider metadata.
                const stepUsage = normalizeUsage(finishStepPart.usage);
                const stepProviderMetadata = withCacheWriteMetadata(
                  finishStepPart.providerMetadata,
                  finishStepPart.usage
                );

                // Update cumulative totals for this stream.
                //
                // Effect migration Phase 10: usage accounting stays in plain
                // mutables on streamInfo by the plain-mutables rule — the only
                // mutators are this AI-SDK fullStream loop and plain
                // retry/reset methods, never fibers. The emit below runs with
                // zero suspension after the mutation (emitTurnEvent invokes
                // the sink synchronously), so downstream Effect queue bridges
                // (SubscriptionEmit's offerUnsafe) observe usage-delta events
                // in mutation order.
                streamInfo.cumulativeUsage = addUsage(streamInfo.cumulativeUsage, stepUsage);
                streamInfo.cumulativeProviderMetadata = accumulateProviderMetadata(
                  streamInfo.cumulativeProviderMetadata,
                  stepProviderMetadata
                );

                // Track last step's data for context window display
                streamInfo.lastStepUsage = stepUsage;
                streamInfo.lastStepProviderMetadata = stepProviderMetadata;

                const usageEvent = buildUsageDeltaEvent({
                  workspaceId: workspaceId as string,
                  messageId: streamInfo.messageId,
                  // Step-level (for context window display)
                  usage: stepUsage,
                  providerMetadata: stepProviderMetadata,
                  // Cumulative (for live cost display)
                  cumulativeUsage: streamInfo.cumulativeUsage,
                  cumulativeProviderMetadata: streamInfo.cumulativeProviderMetadata,
                  // Preserve gateway-billed zero-cost behavior throughout the stream.
                  costsIncluded: streamInfo.initialMetadata?.costsIncluded,
                });
                streamInfo.currentStepStartIndex = streamInfo.parts.length;
                this.emitTurnEvent(usageEvent);
                await this.checkSoftCancelStream(workspaceId, streamInfo);
                break;
              }

              case "text-end": {
                await this.checkSoftCancelStream(workspaceId, streamInfo);
                break;
              }
            }
          }

          // No need to save remaining text - text-delta handler already maintains parts array
          // (Removed duplicate push that was causing double text parts)

          // Flush final state to partial.json for crash resilience
          // This happens regardless of abort status to ensure the final state is persisted to disk
          // On abort: second flush after cancelStreamSafely, ensures all streamed content is saved
          // On normal completion: provides crash resilience before AIService writes to chat.jsonl
          await this.flushPartialWrite(workspaceId, streamInfo);

          // Check if stream completed successfully
          if (!streamInfo.abortController.signal.aborted) {
            // Terminal refusal check must precede both the empty-output recovery
            // path and normal stream-end finalization. A refusal is a deliberate
            // provider outcome, not a transport drop; with partial output, a
            // configured fallback must continue from the partial transcript rather
            // than replay the original turn and re-run tools.
            const refusalFinishReason = streamInfo.receivedTerminalEvent
              ? ([streamInfo.terminalFinishReason, streamInfo.terminalRawFinishReason].find(
                  isRefusalFinishReason
                ) ?? null)
              : null;
            if (refusalFinishReason !== null) {
              // A configured fallback chain may swap models in place of the
              // terminal failure. The swap happens before any error event is
              // emitted, so task settlement can never race a pending fallback.
              const fallback = await this.tryModelFallbackAfterRefusal(
                workspaceId,
                streamInfo,
                refusalFinishReason,
                { preserveParts: streamInfo.parts.length > 0 }
              );
              if (fallback.kind === "swapped") {
                continue;
              }

              await this.handleModelRefusalCompletion(
                workspaceId,
                streamInfo,
                refusalFinishReason,
                fallback.terminalNote
              );
              break;
            }

            if (streamInfo.parts.length === 0) {
              const retriedEmptyStream = await this.retryEmptyStreamBeforeFailure(
                workspaceId,
                streamInfo,
                emptyStreamRecoveryAttempts
              );
              if (retriedEmptyStream) {
                emptyStreamRecoveryAttempts += 1;
                continue;
              }

              await this.handleEmptyStreamCompletion(workspaceId, streamInfo);
              break;
            }

            if (!streamInfo.receivedTerminalEvent) {
              await this.handleTruncatedStreamCompletion(workspaceId, streamInfo);
              break;
            }

            // Get all metadata from stream result in one call
            // - totalUsage: sum of all steps (for cost calculation)
            // - contextUsage: last step only (for context window display)
            // - contextProviderMetadata: last step (for context window cache tokens)
            // Falls back to tracked values when step retries invalidate totalUsage
            // or streamResult metadata fails/times out.
            const streamMeta = await this.getStreamMetadata(streamInfo);
            const totalUsage = this.resolveTotalUsageForStreamEnd(
              streamInfo,
              streamMeta.totalUsage
            );
            await this.backfillReasoningTokensFromParts(streamInfo, totalUsage);
            const contextUsage = streamMeta.contextUsage ?? streamInfo.lastStepUsage;
            const contextProviderMetadata =
              streamMeta.contextProviderMetadata ?? streamInfo.lastStepProviderMetadata;
            // Required-tool completion must remain successful after downgrade or crash recovery.
            // Keep the internal stop cause, but persist the legacy-compatible terminal signal.
            const finishReason =
              streamInfo.request.stopCause?.kind === "required-tool"
                ? "stop"
                : (streamInfo.terminalFinishReason ?? streamMeta.finishReason);
            if (finishReason === "tool-calls" && streamInfo.request.stopCause == null) {
              workspaceLog.warn("Tool-calls stream ended without a recorded stop cause", {
                messageId: streamInfo.messageId,
                muxMetadata: streamInfo.initialMetadata?.muxMetadata,
              });
            }
            const duration = streamMeta.duration;
            const ttftMs = this.resolveTtftMsForStreamEnd(streamInfo);
            // Aggregated provider metadata across all steps (for cost calculation with cache tokens)
            const providerMetadata = markProviderMetadataCostsIncluded(
              await this.getAggregatedProviderMetadata(streamInfo),
              streamInfo.initialMetadata?.costsIncluded
            );
            const canonicalModel = metadataModelIdentity(streamInfo.model);
            const routedThroughGateway =
              streamInfo.initialMetadata?.routedThroughGateway ??
              streamInfo.model.startsWith("mux-gateway:");
            const toolModelUsages =
              streamInfo.toolModelUsages.length > 0
                ? streamInfo.toolModelUsages.map(clonePersistedToolModelUsage)
                : undefined;

            // Emit stream end event with parts preserved in temporal order
            const streamEndEvent: StreamEndEvent = {
              type: "stream-end",
              workspaceId: workspaceId as string,
              messageId: streamInfo.messageId,
              ...(streamInfo.initialMetadata?.acpPromptId != null
                ? { acpPromptId: streamInfo.initialMetadata.acpPromptId }
                : {}),
              metadata: {
                ...streamInfo.initialMetadata, // TurnRequestBuilder-provided metadata (systemMessageTokens, etc)
                model: canonicalModel,
                metadataModel: streamInfo.metadataModel,
                routedThroughGateway,
                ...(streamInfo.thinkingLevel && {
                  thinkingLevel: streamInfo.thinkingLevel as ThinkingLevel,
                }),
                usage: totalUsage, // Total across all steps (for cost calculation)
                contextUsage, // Last step only (for context window display)
                providerMetadata, // Aggregated (for cost calculation)
                contextProviderMetadata, // Last step (for context window display)
                ...(toolModelUsages != null ? { toolModelUsages } : {}),
                ...(finishReason !== undefined && { finishReason }),
                ...(streamInfo.request.stopCause != null && {
                  stopCause: streamInfo.request.stopCause,
                }),
                historySequence: streamInfo.historySequence,
                duration,
                ...(ttftMs !== undefined && { ttftMs }),
              },
              parts: streamInfo.parts, // Parts array with temporal ordering (includes reasoning)
            };

            // Update history with final message BEFORE emitting stream-end
            // This prevents a race condition where compaction (triggered by stream-end)
            // clears history while updateHistory is still running, causing old messages
            // to be written back after compaction completes.
            if (streamInfo.parts && streamInfo.parts.length > 0) {
              const finalAssistantMessage: MuxMessage = {
                id: streamInfo.messageId,
                role: "assistant",
                metadata: {
                  ...streamEndEvent.metadata,
                  historySequence: streamInfo.historySequence,
                  stepStartPartIndices: streamInfo.stepStartIndices.filter(
                    (index) => index < streamInfo.parts.length
                  ),
                },
                parts: streamInfo.parts,
              };

              // CRITICAL: Delete partial.json before updating chat.jsonl
              // On successful completion, partial.json becomes stale and must be removed.
              // Retire partial writes first: a cancel (user stop, shutdown) landing
              // between here and COMPLETED must not flush partial.json back to disk.
              streamInfo.partialRetired = true;
              const deleteResult = await this.historyService.deletePartial(workspaceId as string);
              if (!deleteResult.success) {
                workspaceLog.warn("Failed to delete partial on stream end", {
                  error: deleteResult.error,
                });
              }

              // Update the placeholder message in chat.jsonl with final content
              const updateResult = await this.historyService.updateHistory(
                workspaceId as string,
                finalAssistantMessage
              );
              if (!updateResult.success) {
                workspaceLog.warn("Failed to update history on stream end", {
                  error: updateResult.error,
                });
              }

              // Update cumulative session usage (if service is available)
              // Wrapped in try-catch: usage recording is non-critical and shouldn't block stream completion
              await this.recordSessionUsage(
                workspaceId,
                streamInfo.model,
                totalUsage,
                providerMetadata,
                "Failed to record session usage (stream completion unaffected)",
                "warn",
                streamInfo
              );
            }

            // Mark as completed right before emitting stream-end.
            // This must happen AFTER async I/O (deletePartial, updateHistory) completes.
            // If we set COMPLETED earlier, isStreaming() returns false during cleanup,
            // allowing new messages (e.g., force-compaction) to bypass queuing and write
            // to history before stream-end fires - causing compaction to use wrong parts.
            streamInfo.state = StreamState.COMPLETED;

            // Emit stream-end AFTER history is updated to prevent race with compaction
            // Compaction handler listens to this event and clears history - if we emit
            // before updateHistory completes, compaction can clear the file and then
            // updateHistory writes stale data back.
            this.emitTurnEvent(streamEndEvent);
            streamInfo.terminalCompletion = { status: "completed", streamEnd: streamEndEvent };
          }
          break;
        } catch (error) {
          // A cancellation may surface as an iterator rejection instead of a
          // clean close (provider/transport dependent). The canceller that
          // aborted the signal owns the terminal bookkeeping (cleanupAbortedStream
          // after processingPromise resolves: stream-abort, partial commit,
          // settle), so recording this as a provider failure would turn a user
          // stop or a shutdown abort into an error event and — via the
          // lost-race guard in cleanupAbortedStream — suppress the abort. Take
          // the same exit as the clean-close abort path instead.
          if (streamInfo.abortController.signal.aborted) {
            workspaceLog.debug("Stream iterator rejected after abort; treating as cancellation", {
              error: getErrorMessage(error),
            });
            await this.flushPartialWrite(workspaceId, streamInfo);
            break;
          }
          let handledError: unknown = error;
          let retried = false;
          try {
            retried = await this.retryStreamWithoutPreviousResponseId(
              workspaceId,
              streamInfo,
              error,
              didRetryPreviousResponseId
            );
          } catch (retryError) {
            handledError = retryError;
          }

          if (retried) {
            didRetryPreviousResponseId = true;
            continue;
          }

          await this.handleStreamFailure(workspaceId, streamInfo, handledError);
          break;
        }
      }
    } catch (error) {
      await this.handleStreamFailure(workspaceId, streamInfo, error);
    } finally {
      this.mcpServerManager?.releaseLease(workspaceId as string);

      await this.closeStreamResources(streamInfo);

      // Aborts keep their registration until cleanupAbortedStream completes its disk
      // transaction and raw delivery. A stale finally must never remove a replacement.
      if (
        streamInfo.terminalCompletion != null &&
        this.workspaceStreams.get(workspaceId) === streamInfo
      ) {
        this.workspaceStreams.delete(workspaceId);
      }

      // Lifecycle spine event: emitted from the guaranteed-cleanup path so
      // EVERY terminal outcome (completion, abort/Escape, provider failure)
      // closes the stream.start emitted at the top of this method — observers
      // tracking active streams must never retain stale entries.
      eventSpine.emit("stream.end", {
        workspaceId: workspaceId as string,
        messageId: streamInfo.messageId,
      });

      if (streamInfo.terminalCompletion != null) {
        // Optional-chained: whitebox test fixtures register stream infos without a controller.
        streamInfo.completionController?.settle(streamInfo.terminalCompletion);
      }
    }
  }

  /**
   * Persist error state and emit error events for failed streams.
   */
  private async handleStreamFailure(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    error: unknown
  ): Promise<void> {
    streamInfo.state = StreamState.ERROR;

    const workspaceLog = this.getWorkspaceLogger(workspaceId, streamInfo);

    // Log the actual error for debugging
    workspaceLog.error("Stream processing error:", error);

    // Record lost previousResponseId so future requests can filter it out
    this.recordLostResponseIdIfApplicable(workspaceId, error, streamInfo, workspaceLog);

    const errorPayload = this.buildStreamErrorPayload(streamInfo, error);
    const persistedPayload = await this.persistStreamError(workspaceId, streamInfo, errorPayload);
    streamInfo.terminalCompletion = { status: "failed", streamError: persistedPayload };
  }

  private buildStreamErrorPayload(
    streamInfo: WorkspaceStreamInfo,
    error: unknown
  ): StreamErrorPayload & { errorType: StreamErrorType } {
    if (error instanceof EmptyStreamOutputError) {
      return {
        messageId: streamInfo.messageId,
        error: error.message,
        errorType: "empty_output",
        acpPromptId: streamInfo.initialMetadata?.acpPromptId,
      };
    }

    if (error instanceof ModelRefusalError) {
      return {
        messageId: streamInfo.messageId,
        error: error.message,
        errorType: "model_refusal",
        acpPromptId: streamInfo.initialMetadata?.acpPromptId,
      };
    }

    if (error instanceof StreamTruncatedError) {
      return {
        messageId: streamInfo.messageId,
        error: error.message,
        errorType: "stream_truncated",
        acpPromptId: streamInfo.initialMetadata?.acpPromptId,
      };
    }

    // Extract error message (errors thrown from 'error' parts already have the correct message)
    // Apply prefix stripping to remove noisy "undefined: " prefixes from provider errors
    let errorMessage: string = stripNoisyErrorPrefix(getErrorMessage(error));
    let actualError: unknown = error;

    // For categorization, use the cause if available (preserves the original error structure)
    if (error instanceof Error && error.cause) {
      actualError = error.cause;
    }

    if (actualError instanceof ContextBudgetBlockedError) {
      return {
        messageId: streamInfo.messageId,
        error: actualError.message,
        errorType: "context_budget_blocked",
        acpPromptId: streamInfo.initialMetadata?.acpPromptId,
      };
    }
    if (actualError instanceof ContextBudgetExceededError) {
      return {
        messageId: streamInfo.messageId,
        error: actualError.message,
        errorType: "context_budget_blocked",
        contextBudgetExceeded: actualError.details,
        acpPromptId: streamInfo.initialMetadata?.acpPromptId,
      };
    }

    let errorType = this.categorizeError(actualError);

    // Enhance previous-response and model-not-found error messages

    const previousResponseId = this.extractPreviousResponseIdFromError(actualError);
    if (previousResponseId) {
      errorMessage = "OpenAI lost the previous response state while streaming. Retry to continue.";
    }
    if (errorType === "model_not_found") {
      // Extract model name from model string (e.g., "anthropic:sonnet-1m" -> "sonnet-1m")
      const [, modelName] = streamInfo.model.split(":");
      errorMessage = `Model '${modelName || streamInfo.model}' does not exist or is not available. Please check your model selection.`;
    }

    // Normalize Anthropic overload errors (HTTP 529 / overloaded_error) into a stable,
    // user-friendly message. Keep errorType = server_error so the frontend's auto-retry
    // behavior remains unchanged.
    const canonicalModel = normalizeToCanonical(streamInfo.model);
    const isAnthropic = canonicalModel.startsWith("anthropic:");

    const hasErrorProperty = (data: unknown): data is { error: { type?: string } } => {
      return (
        typeof data === "object" &&
        data !== null &&
        "error" in data &&
        typeof data.error === "object" &&
        data.error !== null
      );
    };

    const isOverloadedApiCallError = (apiError: APICallError): boolean => {
      return (
        apiError.statusCode === 529 ||
        (hasErrorProperty(apiError.data) && apiError.data.error.type === "overloaded_error")
      );
    };

    const isAnthropicOverloaded =
      isAnthropic &&
      ((APICallError.isInstance(actualError) && isOverloadedApiCallError(actualError)) ||
        (RetryError.isInstance(actualError) &&
          actualError.lastError &&
          APICallError.isInstance(actualError.lastError) &&
          isOverloadedApiCallError(actualError.lastError)));

    if (isAnthropicOverloaded) {
      errorMessage = "Anthropic is temporarily overloaded (HTTP 529). Please try again later.";
      errorType = "server_error";
    }

    const muxGatewayUnauthorized =
      streamInfo.model.startsWith("mux-gateway:") &&
      ((APICallError.isInstance(actualError) && actualError.statusCode === 401) ||
        (RetryError.isInstance(actualError) &&
          actualError.lastError &&
          APICallError.isInstance(actualError.lastError) &&
          actualError.lastError.statusCode === 401));

    if (muxGatewayUnauthorized) {
      // Friendly normalization for expired mux-gateway sessions.
      errorMessage = MUX_GATEWAY_SESSION_EXPIRED_MESSAGE;
    }

    const openAIResponsesBaseUrlHint = getOpenAIResponsesBaseUrlHint({
      // The route provider identifies whose config served the request. The
      // canonical model would misattribute gateway routes: openrouter:openai/x
      // canonicalizes to openai:x but never uses the openai base URL.
      providerId: streamInfo.initialMetadata?.routeProvider ?? "",
      error: actualError,
    });
    if (openAIResponsesBaseUrlHint) {
      errorMessage = `${errorMessage}\n\n${openAIResponsesBaseUrlHint}`;
    }

    errorType = coerceStreamErrorTypeForMessage(errorType, errorMessage);

    return {
      messageId: streamInfo.messageId,
      error: errorMessage,
      errorType,
      acpPromptId: streamInfo.initialMetadata?.acpPromptId,
    };
  }

  /**
   * Write error metadata to partial.json and emit the corresponding error event.
   */
  private async persistStreamError(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    payload: StreamErrorPayload & { errorType: StreamErrorType }
  ): Promise<StreamErrorPayload & { errorType: StreamErrorType }> {
    // Clamp at the single choke point every stream error payload passes
    // through before persist/emit, including buildStreamErrorPayload's
    // early-return branches (e.g. ModelRefusalError, whose fallbackNote can
    // embed another error's message). Some SDK errors embed the entire
    // serialized prompt in their message (AI_TypeValidationError via the
    // cause walk); unbounded, that would be persisted to history metadata,
    // shipped over IPC, and rendered in the chat.
    payload = { ...payload, error: clampErrorMessage(payload.error) };
    const refusalFinishReason =
      payload.errorType === "model_refusal"
        ? ([streamInfo.terminalFinishReason, streamInfo.terminalRawFinishReason].find(
            isRefusalFinishReason
          ) ?? streamInfo.terminalFinishReason)
        : undefined;
    const terminalRefusalUsage = streamInfo.terminalRefusalUsage;
    const terminalRefusalProviderMetadata = streamInfo.terminalRefusalProviderMetadata;

    // Errored turns still billed every completed step. Capture the
    // live-tracked cumulative usage for the sidecar below and mirror it into
    // session-usage.json — the error path previously skipped both, ingesting
    // failed turns as $0. Refusal errors are excluded entirely: the refusal
    // paths already attributed the refusing attempt's tokens (terminal
    // refusals via terminalRefusalUsage, fallback hops — including the FINAL
    // hop on chain exhaustion — via recordRefusedAttemptUsage into
    // toolModelUsages + the ledger), so re-recording the cumulative counters
    // here would double-count the last refusing attempt.
    let cumulativeErrorUsage: LanguageModelV2Usage | undefined;
    let cumulativeErrorProviderMetadata: Record<string, unknown> | undefined;
    if (payload.errorType !== "model_refusal" && hasTokenUsage(streamInfo.cumulativeUsage)) {
      cumulativeErrorUsage = cloneUsage(streamInfo.cumulativeUsage);
      await this.backfillReasoningTokensFromParts(streamInfo, cumulativeErrorUsage);
      cumulativeErrorProviderMetadata = markProviderMetadataCostsIncluded(
        streamInfo.cumulativeProviderMetadata
          ? { ...streamInfo.cumulativeProviderMetadata }
          : undefined,
        streamInfo.initialMetadata?.costsIncluded
      );
      await this.recordSessionUsage(
        workspaceId,
        streamInfo.model,
        cumulativeErrorUsage,
        cumulativeErrorProviderMetadata,
        "Failed to record session usage for errored stream",
        "warn",
        streamInfo
      );
    }
    const errorUsage = terminalRefusalUsage ?? cumulativeErrorUsage;
    const errorProviderMetadata =
      terminalRefusalProviderMetadata ?? cumulativeErrorProviderMetadata;

    const errorPartialMessage = this.buildPartialAssistantMessage(streamInfo, {
      metadata: {
        error: payload.error,
        errorType: payload.errorType,
        ...(refusalFinishReason !== undefined ? { finishReason: refusalFinishReason } : {}),
        ...(errorProviderMetadata !== undefined ? { providerMetadata: errorProviderMetadata } : {}),
        // INVARIANT: usage / toolModelUsages are deliberately NOT stamped on
        // the error partial. Errored turns are sidecar-canonical: unlike
        // aborts, nothing commits the partial at error time (AIService
        // forwards "error" without commitPartial), so usage stamped here
        // would strand in partial.json until an unrelated send — or die
        // entirely when a retry overwrites the partial. The sidecar rows
        // below are ingested immediately by the error listener, and the
        // eventually committed row carries no usage, so exactly one source
        // ever reaches the events table.
      },
    });

    // Wait for any in-flight partial write to complete before writing error state.
    // This prevents race conditions where the error write and a throttled flush
    // write at the same time, causing inconsistent partial.json state.
    await this.awaitPendingPartialWrite(streamInfo);

    // Write error state to disk - await to ensure consistent state before any resume.
    await this.historyService.writePartial(workspaceId as string, errorPartialMessage);

    try {
      await this.recordDroppedPartialUsageInSidecar(
        workspaceId,
        streamInfo,
        errorUsage,
        errorProviderMetadata,
        "errored_stream",
        // A model_refusal error's stream usage row is terminalRefusalUsage
        // (only set for terminal no-fallback refusals); label it as a refusal
        // so analytics can distinguish refusals from generic stream errors.
        payload.errorType === "model_refusal" ? "refused_stream" : "errored_stream"
      );
    } catch (error) {
      log.error("Failed to record errored-stream usage in headless sidecar", { error });
    }

    // Emit error event before completion settles so recovery bookkeeping is ready for waiters.
    this.emitTurnEvent(createErrorEvent(workspaceId as string, payload));
    return payload;
  }

  private getOpenAIPreviousResponseId(
    providerOptions?: Record<string, unknown>
  ): string | undefined {
    if (!providerOptions || typeof providerOptions !== "object" || !("openai" in providerOptions)) {
      return undefined;
    }

    const openaiOptions = providerOptions.openai;
    if (!openaiOptions || typeof openaiOptions !== "object") {
      return undefined;
    }

    const previousResponseId = (openaiOptions as Record<string, unknown>).previousResponseId;
    return typeof previousResponseId === "string" ? previousResponseId : undefined;
  }

  private clearOpenAIPreviousResponseId(
    providerOptions?: Record<string, unknown>
  ): Record<string, unknown> | undefined {
    if (!providerOptions || typeof providerOptions !== "object" || !("openai" in providerOptions)) {
      return providerOptions;
    }

    const openaiOptions = providerOptions.openai;
    if (!openaiOptions || typeof openaiOptions !== "object") {
      return providerOptions;
    }

    if (!("previousResponseId" in openaiOptions)) {
      return providerOptions;
    }

    const { previousResponseId: _prev, ...rest } = openaiOptions as Record<string, unknown>;
    return {
      ...providerOptions,
      openai: rest,
    };
  }

  private recordStepStart(streamInfo: WorkspaceStreamInfo): void {
    const start = streamInfo.parts.length;
    // Retries may discard parts. Drop stale/duplicate starts before reseeding.
    streamInfo.stepStartIndices = streamInfo.stepStartIndices.filter((index) => index < start);
    streamInfo.stepStartIndices.push(start);
    streamInfo.currentStepStartIndex = start;
  }

  private async resetStreamStateForRetry(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    options?: { preserveParts?: boolean; preserveUsage?: boolean; workspaceLog?: Logger }
  ): Promise<void> {
    streamInfo.stepTracker.pendingPrefixSwap = undefined;
    const preserveParts = options?.preserveParts ?? false;
    const preserveUsage = options?.preserveUsage ?? false;

    this.interruptPartialWriteFiber(streamInfo);

    await this.awaitPendingPartialWrite(streamInfo);
    streamInfo.partialWritePromise = undefined;

    if (!preserveParts) {
      streamInfo.parts = [];
    }
    if (!preserveParts) {
      streamInfo.reasoningBackfillStartIndex = undefined;
    }
    this.recordStepStart(streamInfo);
    streamInfo.receivedTerminalEvent = false;
    streamInfo.terminalFinishReason = undefined;
    streamInfo.terminalRawFinishReason = undefined;
    streamInfo.lastPartialWriteTime = 0;

    if (!preserveUsage) {
      streamInfo.cumulativeUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      streamInfo.cumulativeProviderMetadata = undefined;
      streamInfo.terminalRefusalUsage = undefined;
      streamInfo.terminalRefusalProviderMetadata = undefined;
      streamInfo.lastStepUsage = undefined;
      streamInfo.lastStepProviderMetadata = undefined;
    }

    if (!preserveParts) {
      try {
        await this.historyService.deletePartial(workspaceId as string);
      } catch (deleteError) {
        const logger = options?.workspaceLog ?? this.getWorkspaceLogger(workspaceId, streamInfo);
        logger.warn("Failed to clear partial state before retry", { error: deleteError });
      }
    }
  }

  private async retryStreamWithoutPreviousResponseId(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    error: unknown,
    hasRetried: boolean
  ): Promise<boolean> {
    if (hasRetried) {
      return false;
    }

    if (streamInfo.abortController.signal.aborted || streamInfo.softInterrupt.pending) {
      return false;
    }

    const hasParts = streamInfo.parts.length > 0;
    const currentStepStartIndex = streamInfo.currentStepStartIndex;
    // If the current step already emitted parts, retrying would duplicate output/tool calls.
    if (hasParts && currentStepStartIndex !== streamInfo.parts.length) {
      return false;
    }

    const responseId = this.extractPreviousResponseIdFromError(error);
    if (!responseId) {
      return false;
    }

    const errorCode = this.extractErrorCode(error);
    const statusCode = this.extractStatusCode(error);
    // Retry if: we have the specific error code, OR a likely status code,
    // OR we successfully extracted a response ID from the error message
    // (the message match is strong evidence this is a "not found" error regardless of status code)
    const shouldRetry =
      errorCode === "previous_response_not_found" ||
      statusCode === 404 ||
      statusCode === 500 ||
      statusCode === 400;
    if (!shouldRetry) {
      return false;
    }

    const previousResponseId = this.getOpenAIPreviousResponseId(streamInfo.request.providerOptions);
    if (!previousResponseId || previousResponseId !== responseId) {
      return false;
    }

    const stepMessages = streamInfo.stepTracker.latestMessages;
    if (hasParts && !stepMessages) {
      return false;
    }

    const providerOptions = this.clearOpenAIPreviousResponseId(streamInfo.request.providerOptions);
    if (providerOptions === streamInfo.request.providerOptions) {
      return false;
    }

    const workspaceLog = this.getWorkspaceLogger(workspaceId, streamInfo);
    this.recordLostResponseIdIfApplicable(workspaceId, error, streamInfo, workspaceLog);

    // Step-boundary retries restart the SDK stream, so totalUsage only reflects
    // the retried step. Track this to prefer cumulativeUsage at stream end.
    if (hasParts) {
      streamInfo.didRetryPreviousResponseIdAtStep = true;
    }

    workspaceLog.info("Retrying stream without invalid previousResponseId", {
      messageId: streamInfo.messageId,
      model: streamInfo.model,
      retryScope: hasParts ? "step" : "stream",
      previousResponseId,
      errorCode,
      statusCode,
    });

    await this.resetStreamStateForRetry(workspaceId, streamInfo, {
      preserveParts: hasParts,
      preserveUsage: hasParts,
      workspaceLog,
    });

    streamInfo.request = {
      ...streamInfo.request,
      ...(stepMessages ? { messages: stepMessages } : {}),
      providerOptions,
    };
    streamInfo.streamResult = this.createStreamResult(
      streamInfo.request,
      streamInfo.abortController,
      streamInfo.stepTracker
    );

    return true;
  }

  /**
   * Converts errors to strongly-typed SendMessageError
   */
  private convertToSendMessageError(error: unknown): SendMessageError {
    // Check for specific AI SDK errors using type guards
    if (LoadAPIKeyError.isInstance(error)) {
      return {
        type: "api_key_not_found",
        provider: "anthropic", // We can infer this from LoadAPIKeyError context
      };
    }

    // Fallback for unknown errors
    const message = getErrorMessage(error);
    return { type: "unknown", raw: message };
  }

  /**
   * Categorizes errors for better error handling (used for event emission)
   */
  private categorizeError(error: unknown): StreamErrorType {
    if (error instanceof ContextBudgetExceededError || error instanceof ContextBudgetBlockedError)
      return "context_budget_blocked";
    if (error instanceof StreamTruncatedError) {
      return "stream_truncated";
    }

    // Use AI SDK error type guards first
    if (LoadAPIKeyError.isInstance(error)) {
      return "authentication";
    }
    if (APICallError.isInstance(error)) {
      if (error.statusCode === 401) return "authentication";
      // 402 (Payment Required) is used by mux gateway for billing/credits issues
      // (e.g. "Insufficient balance. Please add credits to continue.").
      // Treat as non-retryable quota. Some providers also encode quota failures as
      // 429, so classify 429 by payload intent instead of status code alone.
      if (error.statusCode === 402) return "quota";
      if (error.statusCode === 429) {
        return classify429Capacity({
          message: error.message,
          data: error.data,
          responseBody: error.responseBody,
        });
      }
      if (error.statusCode && error.statusCode >= 500) return "server_error";

      // Check for model_not_found errors (OpenAI and Anthropic)
      // Type guard for error data structure
      const hasErrorProperty = (
        data: unknown
      ): data is { error: { code?: string; type?: string } } => {
        return (
          typeof data === "object" &&
          data !== null &&
          "error" in data &&
          typeof data.error === "object" &&
          data.error !== null
        );
      };

      // OpenAI: error.code === 'model_not_found'. The status has flipped between 400 and
      // 404 over time, so key on the code rather than the status.
      const isOpenAIModelError =
        hasErrorProperty(error.data) && error.data.error.code === "model_not_found";

      // Anthropic: 404 with error.type === 'not_found_error'
      const isAnthropicModelError =
        error.statusCode === 404 &&
        hasErrorProperty(error.data) &&
        error.data.error.type === "not_found_error";

      if (isOpenAIModelError || isAnthropicModelError) {
        return "model_not_found";
      }

      // Check for context exceeded errors (Anthropic + OpenAI-compatible / Copilot)
      const msgLower = error.message.toLowerCase();

      // Anthropic: "prompt is too long" / "input is too long"
      // Copilot / OpenAI-compatible: "prompt token count of X exceeds the limit of Y"
      const isContextExceeded =
        msgLower.includes("prompt is too long") ||
        msgLower.includes("input is too long") ||
        (msgLower.includes("token") && msgLower.includes("exceeds") && msgLower.includes("limit"));

      if (isContextExceeded) {
        return "context_exceeded";
      }

      return "api";
    }
    if (RetryError.isInstance(error)) {
      // The AI SDK wraps the underlying error(s) in RetryError when it exhausts its internal retries.
      // If the underlying error is deterministically non-retryable (e.g. model_not_found), we should
      // surface that classification so the frontend auto-retry loop stops.
      //
      // Keep returning retry_failed for generic/transient failures so the UI still communicates that
      // the SDK already retried and gave up.
      const underlyingType = error.lastError ? this.categorizeError(error.lastError) : "unknown";
      if (
        underlyingType !== "unknown" &&
        underlyingType !== "api" &&
        underlyingType !== "retry_failed"
      ) {
        return underlyingType;
      }
      return "retry_failed";
    }

    // Check for OpenAI/Anthropic structured error format (from error.cause)
    // Structure: { error: { code: 'context_length_exceeded', type: '...', message: '...' } }
    if (
      typeof error === "object" &&
      error !== null &&
      "error" in error &&
      typeof error.error === "object" &&
      error.error !== null
    ) {
      const structuredError = error.error as { code?: string; type?: string };

      // Model not found
      if (
        structuredError.code === "model_not_found" ||
        structuredError.type === "not_found_error"
      ) {
        return "model_not_found";
      }

      // OpenAI context length errors have code: 'context_length_exceeded'
      if (structuredError.code === "context_length_exceeded") {
        return "context_exceeded";
      }

      // Check for other specific error codes/types
      if (structuredError.code === "rate_limit_exceeded") {
        return "rate_limit";
      }
    }

    // Fall back to string matching for other errors
    if (error instanceof Error) {
      const message = error.message.toLowerCase();

      if (isStreamTruncatedMessage(message)) {
        return "stream_truncated";
      }

      if (error.name === "AbortError" || message.includes("abort")) {
        return "aborted";
      } else if (message.includes("network") || message.includes("fetch")) {
        return "network";
      } else if (
        message.includes("model") &&
        (message.includes("does not exist") ||
          message.includes("doesn't exist") ||
          message.includes("not found") ||
          message.includes("do not have access") ||
          message.includes("don't have access") ||
          message.includes("no access"))
      ) {
        return "model_not_found";
      } else if (
        message.includes("token") ||
        message.includes("context") ||
        message.includes("too long") ||
        message.includes("maximum")
      ) {
        return "context_exceeded";
      } else if (
        message.includes("quota") ||
        message.includes("limit") ||
        message.includes("insufficient balance") ||
        message.includes("add credits") ||
        message.includes("payment required")
      ) {
        return "quota";
      } else if (message.includes("auth") || message.includes("key")) {
        return "authentication";
      } else {
        return "api";
      }
    }

    return "unknown";
  }

  /**
   * Starts a new stream for a workspace, automatically cancelling any existing stream
   *
   * Uses per-workspace mutex to prevent concurrent streams. The mutex ensures:
   * 1. Only one startStream can execute at a time per workspace
   * 2. Old stream fully exits before new stream starts
   * 3. No race conditions in stream registration or cleanup
   */
  async startStream(
    options: TurnExecutionOptions
  ): Promise<Result<TurnStreamHandle, SendMessageError>> {
    const {
      workspaceId,
      messages,
      model,
      modelString,
      historySequence,
      runtime,
      messageId,
      abortSignal,
      providedStreamToken,
      providedRuntimeTempDir,
      onStreamConstructed,
    } = options;
    const completionController = createTurnCompletionController();
    const handle: TurnStreamHandle = { messageId, completion: completionController.promise };
    const settleStartupAbort = (): Result<TurnStreamHandle, SendMessageError> => {
      completionController.settle({
        status: "aborted",
        abortReason: this.getStartupAbortReason(abortSignal),
      });
      return Ok(handle);
    };

    const typedWorkspaceId = workspaceId as WorkspaceId;

    if (messages.length === 0) {
      return Err({
        type: "unknown",
        raw: "Invalid prompt: messages must not be empty",
      });
    }

    let registeredStream: WorkspaceStreamInfo | undefined;
    try {
      // Acquire lock - guarantees only one startStream per workspace
      // Lock is automatically released when scope exits via Symbol.asyncDispose
      await using _lock = await this.acquireStreamStartLock(workspaceId);

      // DEBUG: Log stream start
      log.debug(
        `[STREAM START] workspaceId=${workspaceId} historySequence=${historySequence} model=${modelString}`
      );

      const streamAbortController = new AbortController();
      const unlinkAbortSignal = linkAbortSignal(abortSignal, streamAbortController);

      // Owns this stream's Effect-managed resources (temp dir, debounce
      // fiber). Ownership transfers to processStreamWithCleanup once the
      // stream registers; otherwise the finally below closes it.
      const resourceScope = Scope.makeUnsafe();
      let processingStarted = false;
      const cleanupStartup = async (): Promise<void> => {
        // streamText may already have invoked the provider while the envelope awaited I/O.
        // A refused startup must cancel that request before releasing its owned resources.
        if (!streamAbortController.signal.aborted)
          streamAbortController.abort(new Error("Stream startup did not complete"));
        if (registeredStream) return this.closeStreamResources(registeredStream);
        runLanguageModelCleanup(model);
        unlinkAbortSignal();
        try {
          await this.effectRunner.runPromise(Scope.close(resourceScope, Exit.void));
        } catch (error) {
          log.error("Startup resource cleanup failed", { error });
        }
      };

      try {
        // Step 1: Cancel any existing stream before proceeding
        // This must happen regardless of whether a token was provided
        const generatedStreamToken = await this.ensureStreamSafety(typedWorkspaceId);

        // Step 2: Use provided stream token or the generated one
        const streamToken = providedStreamToken ?? generatedStreamToken;

        // If the stream was interrupted while we were waiting on async setup (mutex,
        // temp dir creation, etc), avoid starting the stream entirely.
        if (streamAbortController.signal.aborted) {
          await cleanupStartup();
          return settleStartupAbort();
        }

        // Step 3: Acquire the temp directory for this stream as a scoped
        // resource. The release finalizer registers only after acquisition
        // succeeds, and Scope.close runs it exactly once across both cleanup
        // paths (startup failure in the finally below, stream teardown in
        // processStreamWithCleanup). TurnRequestBuilder pre-creates this dir
        // so tool configuration can reference the same stable path; once
        // startStream receives it, StreamManager owns cleanup for both
        // success and abort paths.
        const runtimeTempDir = await Effect.runPromise(
          Scope.provide(resourceScope)(
            Effect.acquireRelease(
              Effect.tryPromise({
                // Async thunk: createTempDirForStream failures follow the same
                // rejection path into this method's catch as the previous
                // plain await.
                try: async () =>
                  providedRuntimeTempDir ??
                  (await this.createTempDirForStream(streamToken, runtime)),
                catch: (error) => error,
              }),
              (dir) =>
                Effect.sync(() => {
                  // Whitebox tests pass providedRuntimeTempDir: "" to skip
                  // cleanup; mirror the previous falsy guard.
                  if (dir) {
                    this.cleanupStreamTempDir(runtime, dir);
                  }
                })
            )
          )
        );

        if (streamAbortController.signal.aborted) {
          await cleanupStartup();
          return settleStartupAbort();
        }

        // Construction invokes the provider: validate after every startup resource await.
        await options.assertAdmissionCurrent?.();
        if (streamAbortController.signal.aborted) return settleStartupAbort();

        // The persisted comparison and synchronous provider registration share one lock.
        // Record cleanup ownership inside the callback, even if releasing the lock fails.
        const construct = () => {
          if (streamAbortController.signal.aborted) return;
          registeredStream = this.createStreamAtomically(options, {
            streamToken,
            runtimeTempDir,
            resourceScope,
            abortController: streamAbortController,
            completionController,
          });
          registeredStream.unlinkAbortSignal = unlinkAbortSignal;
          // Scope close must own STARTING streams before the fence's release can await.
          this.superviseEngine(typedWorkspaceId, registeredStream);
        };
        if (options.withAdmissionCurrent) await options.withAdmissionCurrent(construct);
        else construct();
        const streamInfo = registeredStream;
        if (!streamInfo) return settleStartupAbort();

        // Guard against a narrow race:
        // - stopStream() may abort while we're between the last aborted-check and stream registration.
        // - If we start processStreamWithCleanup anyway, it would emit stream-start, but no one would
        //   subsequently call stopStream() again (it already ran), so we'd never emit stream-abort/end.
        // In that case, immediately drop the registered stream and rely on the caller to handle UI.
        if (streamAbortController.signal.aborted) {
          if (this.workspaceStreams.get(typedWorkspaceId) === streamInfo)
            this.workspaceStreams.delete(typedWorkspaceId);
          await cleanupStartup();
          return settleStartupAbort();
        }

        // Stream constructed + registered: durable request-describing side
        // effects (turn envelope) may be recorded now.
        await onStreamConstructed?.();
        // The envelope may wait on storage after construction; do not begin processing a
        // superseded request. Existing failure cleanup owns its registered stream and handle.
        if (
          !streamAbortController.signal.aborted &&
          this.workspaceStreams.get(typedWorkspaceId) === streamInfo
        )
          await options.assertAdmissionCurrent?.();

        // A hard interrupt during the awaited envelope write finds the
        // registered STARTING stream, aborts it, awaits its placeholder
        // processingPromise, and deletes the registration — a replacement
        // stream may already occupy this workspace's slot. Launching
        // processing now would emit stream-start after the abort and its
        // cleanup would later delete that replacement. Bail out; the finally
        // block releases this never-processed stream's resources.
        if (
          streamAbortController.signal.aborted ||
          this.workspaceStreams.get(typedWorkspaceId) !== streamInfo
        ) {
          // The envelope may return while abort persistence/raw delivery is still held.
          // Joining its existing fence preserves the first reason and attempt registration.
          await streamInfo.cancelPromise;
          await cleanupStartup();
          if (this.workspaceStreams.get(typedWorkspaceId) === streamInfo)
            this.workspaceStreams.delete(typedWorkspaceId);
          return settleStartupAbort();
        }

        // Step 5: Track the processing promise for guaranteed cleanup
        // This allows cancelStreamSafely to wait for full exit
        processingStarted = true;
        streamInfo.processingPromise = this.processStreamWithCleanup(
          typedWorkspaceId,
          streamInfo,
          historySequence
        ).catch((error) => {
          log.error("Unexpected error in stream processing:", error);
        });

        return Ok(handle);
      } finally {
        if (!processingStarted) await cleanupStartup();
      }
    } catch (error) {
      // An envelope failure may arrive after an old stop and replacement registration.
      // Preserve both the captured cancellation fence and the replacement's map entry.
      await registeredStream?.cancelPromise;
      if (registeredStream && this.workspaceStreams.get(typedWorkspaceId) === registeredStream) {
        this.workspaceStreams.delete(typedWorkspaceId);
      }
      // No handle is handed out on this path, so the completion is observed only
      // by a supervisor forked at registration: settle it so that fiber exits
      // instead of cancelling this never-started stream at shutdown.
      completionController.settle({
        status: "aborted",
        abortReason: this.getStartupAbortReason(abortSignal),
      });
      // Convert to strongly-typed error
      return Err(this.convertToSendMessageError(error));
    }
  }

  /**
   * Make the engine scope (`AppFiberScope`) supervise this stream: one fiber
   * per stream that lives exactly as long as the turn is unsettled (it waits on
   * `completionController.promise`) and, when interrupted by the scope closing
   * during shutdown, cancels the stream through the user-stop path
   * (`cancelStreamSafely`, abort reason `"system"`) and waits for the turn to
   * settle — i.e. for the partial to be flushed with usage, `stream-abort`
   * delivered after attempt-owned partial persistence, and `completion` resolved.
   * `closeScopeBounded` awaits that
   * finalizer, so dispose() proceeds to tear down bridges and sessions only once
   * every in-flight stream is durably settled. Supervision starts at
   * registration (before the awaited turn-envelope write), so a STARTING stream
   * is covered too: cancelling it takes the same hard-interrupt path a user stop
   * takes during that write.
   *
   * The fiber is the ownership unit only; the stream's AbortSignal stays the
   * sole cancellation transport (the loop, the AI SDK, soft interrupts and
   * `stopStream` all key off it), so interruption meets the stream at exactly
   * one point — this finalizer. A turn that settles on its own resolves the
   * promise and the fiber exits, which removes its finalizer from the scope
   * (no per-stream residue). A stream started after the scope closed is
   * interrupted synchronously by `forkIn` and thus aborted right away (pinned in
   * appFiberScope.test.ts); the pre-registration window (`pendingStreamStarts`)
   * is not supervised — nothing durable exists for it yet and `stopStream`
   * already aborts pending controllers.
   */
  private superviseEngine(workspaceId: WorkspaceId, streamInfo: WorkspaceStreamInfo): void {
    if (this.engineScope === undefined) {
      return;
    }
    assert(streamInfo.engineFiber === undefined, "stream engine already supervised");
    // Zero-arity thunk on purpose: Effect.promise allocates an internal
    // AbortController only when the thunk declares a `signal` parameter; the
    // stream's own controller must stay the only signal in play.
    const supervisor = Effect.promise(() => streamInfo.completionController.promise).pipe(
      Effect.onInterrupt(() =>
        // Finalizers already run uninterruptibly; explicit per house doctrine so
        // the cancel → settle sequence is visibly atomic under a second interrupt.
        Effect.uninterruptible(
          Effect.promise(async () => {
            const startedAt = performance.now();
            await this.cancelStreamSafely(workspaceId, streamInfo, "system");
            // The engine fence includes persistence and raw delivery, never session policy.
            await streamInfo.completionController.promise;
            // Per-stream cost inside the AppFiberScope close (shutdownStep style).
            log.debug("[shutdown] streamManager.abortStream", {
              workspaceId,
              messageId: streamInfo.messageId,
              ms: Math.round(performance.now() - startedAt),
            });
          })
        )
      ),
      Effect.catchDefect((defect) =>
        Effect.sync(() => {
          log.warn("[stream] engine supervisor defect", { workspaceId, error: defect });
        })
      ),
      Effect.asVoid
    );
    // startImmediately: the fiber reaches its (only) suspension point — the
    // promise wait — before forkIn registers it with the scope, so a scope that
    // is already closed interrupts it right here, synchronously.
    streamInfo.engineFiber = this.effectRunner.runSync(
      Effect.forkIn(supervisor, this.engineScope, { startImmediately: true })
    );
  }

  /**
   * Record a previousResponseId as lost if the error indicates OpenAI no longer has it.
   * StreamManager retries once automatically, and buildProviderOptions filters it for future requests.
   */
  private recordLostResponseIdIfApplicable(
    workspaceId: WorkspaceId,
    error: unknown,
    streamInfo: WorkspaceStreamInfo,
    workspaceLog?: Logger
  ): void {
    const responseId = this.extractPreviousResponseIdFromError(error);
    if (!responseId) {
      return;
    }

    const errorCode = this.extractErrorCode(error);
    const statusCode = this.extractStatusCode(error);
    // Record if: we have the specific error code, OR a likely status code.
    // mux-gateway currently surfaces OpenAI's "previous_response_not_found" as a 400
    // (and omits the structured error code), so we treat 400 as eligible once the
    // responseId regex matched the error payload/message.
    const shouldRecord =
      errorCode === "previous_response_not_found" ||
      statusCode === 404 ||
      statusCode === 500 ||
      statusCode === 400;

    if (!shouldRecord || this.lostResponseIds.has(responseId)) {
      return;
    }

    const logger = workspaceLog ?? this.getWorkspaceLogger(workspaceId, streamInfo);
    logger.info("Recording lost previousResponseId for future filtering", {
      previousResponseId: responseId,
      messageId: streamInfo.messageId,
      model: streamInfo.model,
      statusCode,
      errorCode,
    });

    this.lostResponseIds.add(responseId);
  }

  /**
   * Extract previousResponseId from error response body
   * OpenAI's error message includes the ID: "Previous response with id 'resp_...' not found."
   */
  private extractPreviousResponseIdFromError(error: unknown): string | undefined {
    // Check APICallError.responseBody first
    if (APICallError.isInstance(error) && typeof error.responseBody === "string") {
      const match = /'(resp_[a-f0-9]+)'/.exec(error.responseBody);
      if (match) {
        return match[1];
      }
    }

    // Check error message
    if (error instanceof Error) {
      const match = /'(resp_[a-f0-9]+)'/.exec(error.message);
      if (match) {
        return match[1];
      }
    }

    return undefined;
  }

  /**
   * Check if a previousResponseId has been marked as lost
   * Called by buildProviderOptions to filter out invalid IDs
   */
  public isResponseIdLost(responseId: string): boolean {
    return this.lostResponseIds.has(responseId);
  }

  private extractErrorCode(error: unknown): string | undefined {
    const candidates: unknown[] = [];
    if (error instanceof Error && error.cause) {
      candidates.push(error.cause);
    }
    if (APICallError.isInstance(error)) {
      candidates.push(error.data);
    }
    candidates.push(error);
    for (const candidate of candidates) {
      const directCode = this.getStructuredErrorCode(candidate);
      if (directCode) {
        return directCode;
      }
      if (candidate && typeof candidate === "object" && "data" in candidate) {
        const dataCandidate = (candidate as { data?: unknown }).data;
        const nestedCode = this.getStructuredErrorCode(dataCandidate);
        if (nestedCode) {
          return nestedCode;
        }
      }
    }
    return undefined;
  }

  private extractStatusCode(error: unknown): number | undefined {
    if (error instanceof Error && error.cause) {
      const statusCode = this.extractStatusCode(error.cause);
      if (typeof statusCode === "number") {
        return statusCode;
      }
    }

    if (APICallError.isInstance(error) && typeof error.statusCode === "number") {
      return error.statusCode;
    }

    if (typeof error === "object" && error !== null && "statusCode" in error) {
      const candidate = (error as { statusCode?: unknown }).statusCode;
      if (typeof candidate === "number") {
        return candidate;
      }
    }

    return undefined;
  }

  private getStructuredErrorCode(candidate: unknown): string | undefined {
    if (typeof candidate === "object" && candidate !== null && "error" in candidate) {
      const withError = candidate as { error?: unknown };
      if (withError.error && typeof withError.error === "object") {
        const nested = withError.error as Record<string, unknown>;
        const code = nested.code;
        if (typeof code === "string") {
          return code;
        }
      }
    }
    return undefined;
  }

  /**
   * Stops an active stream for a workspace
   * If soft is true, performs a soft interrupt (cancels at next block boundary)
   */
  async stopStream(workspaceId: string, options?: StopStreamOptions): Promise<Result<void>> {
    const typedWorkspaceId = workspaceId as WorkspaceId;
    // Capture every target before abort callbacks or raw startup delivery can reenter and
    // register a replacement. Never look up a new engine after an asynchronous stop step.
    const pending = this.pendingStreamStarts.get(workspaceId);
    const streamInfo = this.workspaceStreams.get(typedWorkspaceId);
    const mockLifecycle = this.mockStreamLifecycle;
    const isActuallyStreaming = mockLifecycle
      ? mockLifecycle.isStreaming(workspaceId)
      : this.isStreaming(workspaceId);

    try {
      // Invoke against the captured mock before pending abort can synchronously start another.
      const mockStop = mockLifecycle?.stop(workspaceId, options);
      let engineStop: Promise<void> | undefined;
      if (!mockLifecycle && streamInfo) {
        const abortReason = options?.abortReason ?? "system";
        if (options?.soft) {
          streamInfo.softInterrupt = {
            pending: true,
            abandonPartial: options.abandonPartial ?? false,
            abortReason,
          };
        } else {
          engineStop = this.cancelStreamSafely(
            typedWorkspaceId,
            streamInfo,
            abortReason,
            options?.abandonPartial
          );
        }
      }
      let startupDelivery: Promise<void> | undefined;
      if (pending) {
        if (!isActuallyStreaming && !streamInfo && !pending.abortDelivery) {
          const delivery = Promise.withResolvers<void>();
          pending.abortDelivery = delivery.promise;
          pending.abortController.abort(options?.abortReason ?? "startup");
          this.emitStreamAbort(
            typedWorkspaceId,
            pending.syntheticMessageId,
            { duration: Date.now() - pending.startTime },
            this.getStartupAbortReason(pending.abortController.signal),
            options?.abandonPartial,
            pending.acpPromptId
          ).then(delivery.resolve, delivery.reject);
        } else {
          pending.abortController.abort(options?.abortReason ?? "startup");
        }
        startupDelivery = pending.abortDelivery;
      }

      if (!mockLifecycle && !streamInfo && !pending && options?.emitIfMissing !== false) {
        startupDelivery = this.emitStreamAbort(
          typedWorkspaceId,
          "",
          {},
          options?.abortReason ?? "startup",
          options?.abandonPartial
        );
      }
      const outcomes = await Promise.allSettled([startupDelivery, engineStop, mockStop]);
      const failure = outcomes.find((outcome) => outcome.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      return Ok(undefined);
    } catch (error) {
      return Err("Failed to stop stream: " + getErrorMessage(error));
    }
  }

  /**
   * Gets the current stream state for a workspace
   */
  getStreamState(workspaceId: string): StreamState {
    const typedWorkspaceId = workspaceId as WorkspaceId;
    const streamInfo = this.workspaceStreams.get(typedWorkspaceId);
    return streamInfo?.state ?? StreamState.IDLE;
  }

  /**
   * Checks if a workspace currently has an active stream
   */
  isStreaming(workspaceId: string): boolean {
    if (this.mockStreamLifecycle) {
      return this.mockStreamLifecycle.isStreaming(workspaceId);
    }
    const state = this.getStreamState(workspaceId);
    return state === StreamState.STARTING || state === StreamState.STREAMING;
  }

  /**
   * Gets all active workspace streams (for debugging/monitoring)
   */
  getActiveStreams(): string[] {
    return Array.from(this.workspaceStreams.keys()).map((id) => id as string);
  }

  /** Serialize idle recovery with stream startup, including terminal persistence. */
  async acquireStreamStartLock(workspaceId: string) {
    const id = workspaceId as WorkspaceId;
    let mutex = this.streamLocks.get(id);
    if (mutex == null) {
      mutex = new AsyncMutex();
      this.streamLocks.set(id, mutex);
    }
    return mutex.acquire();
  }

  /**
   * Gets the current stream info for a workspace if actively streaming.
   * Include finalizing streams when checking whether recovery can proceed.
   */
  getStreamInfo(
    workspaceId: string,
    includeFinalizing = false
  ):
    | {
        messageId: string;
        model: string;
        historySequence: number;
        startTime: number;
        parts: CompletedMessagePart[];
        currentStepStartIndex: number;
        stepStartIndices: number[];
        initialMetadata?: { systemMessageTokens?: number };
        toolCompletionTimestamps: Map<string, number>;
        muxMetadata?: unknown;
      }
    | undefined {
    const typedWorkspaceId = workspaceId as WorkspaceId;
    const streamInfo = this.workspaceStreams.get(typedWorkspaceId);

    // Only return info if stream is actively running
    if (
      streamInfo &&
      (includeFinalizing ||
        streamInfo.state === StreamState.STARTING ||
        streamInfo.state === StreamState.STREAMING)
    ) {
      return {
        messageId: streamInfo.messageId,
        model: streamInfo.model,
        historySequence: streamInfo.historySequence,
        startTime: streamInfo.startTime,
        toolCompletionTimestamps: streamInfo.toolCompletionTimestamps ?? new Map(),
        parts: streamInfo.parts,
        currentStepStartIndex: streamInfo.currentStepStartIndex,
        stepStartIndices: streamInfo.stepStartIndices.slice(),
        initialMetadata: { systemMessageTokens: streamInfo.initialMetadata?.systemMessageTokens },
        // Correlation metadata for delegated work (e.g. workspace-turn
        // continuations); lets TaskService match a live continuation stream
        // to its still-open workspace-turn handle.
        muxMetadata: streamInfo.initialMetadata?.muxMetadata,
      };
    }

    return undefined;
  }

  /**
   * Replay stream events
   * Emits the same events (stream-start, stream-delta, etc.) that would be emitted during live streaming
   * This allows replay to flow through the same event path as live streaming (no duplication)
   */
  async replayStream(workspaceId: string, opts?: { afterTimestamp?: number }): Promise<void> {
    if (this.mockStreamLifecycle) {
      await this.mockStreamLifecycle.replayStream(workspaceId);
      return;
    }

    const typedWorkspaceId = workspaceId as WorkspaceId;
    const streamInfo = this.workspaceStreams.get(typedWorkspaceId);

    // Only replay if stream is actively running
    if (
      !streamInfo ||
      (streamInfo.state !== StreamState.STARTING && streamInfo.state !== StreamState.STREAMING)
    ) {
      return;
    }

    // Initialize token tracker for this model (required for tokenization)
    await this.tokenTracker.setModel(streamInfo.model, streamInfo.metadataModel);

    // Emit stream-start event (include mode from initialMetadata if available)
    this.emitStreamStart(typedWorkspaceId, streamInfo, streamInfo.historySequence, {
      replay: true,
    });

    // Replay accumulated parts as events using shared emission logic.
    // IMPORTANT: Snapshot the parts array up-front.
    //
    // streamInfo.parts is mutated while the stream is running. Because emitPartAsEvent() is async
    // (tokenization happens in worker threads), iterating the live array would keep consuming newly
    // appended parts and can effectively block until the stream ends.
    //
    // That blocks AgentSession.emitHistoricalEvents() from sending "caught-up" on reconnect,
    // leaving the renderer stuck in "Loading workspace" and suppressing the streaming indicator.
    const replayParts = streamInfo.parts.slice();
    const afterTimestamp = opts?.afterTimestamp;
    const filteredReplayParts =
      afterTimestamp != null
        ? replayParts.filter((part) => {
            const partTimestamp = part.timestamp;

            // Missing timestamps should be replayed defensively rather than dropped.
            if (partTimestamp === undefined) {
              return true;
            }

            if (partTimestamp > afterTimestamp) {
              return true;
            }

            // Dynamic tool parts keep their original start timestamp even when they later
            // transition to output-available. Use the recorded tool completion timestamp
            // (from tool-call-end emission) to decide whether completion happened after
            // the reconnect cursor.
            if (part.type === "dynamic-tool") {
              const workflowRunAttachedAt = part.workflowRun?.timestamp;
              if (workflowRunAttachedAt !== undefined && workflowRunAttachedAt > afterTimestamp) {
                return true;
              }

              // Nested kernel calls carry their own activity (start or workflow
              // attach) after the cursor even while the parent part's own
              // timestamps are older; replay the parent so emitPartAsEvent can
              // rebuild the nested rows.
              const nestedCalls = (part as { nestedCalls?: NestedToolCall[] }).nestedCalls ?? [];
              if (
                nestedCalls.some(
                  (nested) =>
                    // Legacy rows can miss the timestamp; replay defensively.
                    nested.timestamp === undefined ||
                    nested.timestamp > afterTimestamp ||
                    (nested.workflowRun != null && nested.workflowRun.timestamp > afterTimestamp) ||
                    // The nested record stores no end time, so a call that
                    // completed while the renderer was disconnected is only
                    // visible through the recorded completion timestamp.
                    // Missing entry => replay defensively; re-delivered nested
                    // events are deduped by the aggregator.
                    (nested.state === "output-available" &&
                      (streamInfo.toolCompletionTimestamps.get(nested.toolCallId) ??
                        Number.POSITIVE_INFINITY) > afterTimestamp)
                )
              ) {
                return true;
              }

              if (part.state === "output-available") {
                const completionTimestamp = streamInfo.toolCompletionTimestamps.get(
                  part.toolCallId
                );
                if (completionTimestamp === undefined) {
                  log.warn(
                    "[streamManager] Missing tool completion timestamp during replay; dropping replayed completion to avoid duplicate side effects",
                    {
                      workspaceId,
                      messageId: streamInfo.messageId,
                      toolCallId: part.toolCallId,
                    }
                  );
                  return false;
                }

                return completionTimestamp > afterTimestamp;
              }

              // A queued tool's execute() can begin after the reconnect cursor while the
              // part's own timestamp (model emission) is older. Replay the part so the
              // enriched tool-call-start carries executionStartedAt and the renderer can
              // start the elapsed timer (the aggregator merges it into the existing row).
              if (
                part.executionStartedAt !== undefined &&
                part.executionStartedAt > afterTimestamp
              ) {
                return true;
              }
            }

            return false;
          })
        : replayParts;

    const replayMessageId = streamInfo.messageId;
    for (const part of filteredReplayParts) {
      await this.emitPartAsEvent(typedWorkspaceId, replayMessageId, part, { replay: true });
    }

    // Live streams emit usage-delta after each finish-step. Replay part snapshots do not
    // include finish-step boundaries, so full replays emit the latest accumulated usage
    // explicitly. Incremental/live-mode replays pass afterTimestamp and should only replay
    // stream context (not stale usage snapshots) to avoid duplicate usage updates.
    if (streamInfo.lastStepUsage && afterTimestamp == null) {
      const usageEvent = buildUsageDeltaEvent({
        workspaceId,
        messageId: streamInfo.messageId,
        replay: true,
        usage: streamInfo.lastStepUsage,
        providerMetadata: streamInfo.lastStepProviderMetadata,
        cumulativeUsage: streamInfo.cumulativeUsage,
        cumulativeProviderMetadata: streamInfo.cumulativeProviderMetadata,
        // Replays must preserve gateway-billed zero-cost behavior from the original stream.
        costsIncluded: streamInfo.initialMetadata?.costsIncluded,
      });
      this.emitTurnEvent(usageEvent);
    }
  }

  /**
   * DEBUG ONLY: Trigger an artificial stream error for testing
   * This method allows integration tests to simulate stream errors without
   * mocking the AI SDK or network layer. It triggers the same error handling
   * path as genuine stream errors by aborting the stream and manually triggering
   * the error event (since abort alone doesn't throw, it just sets a flag that
   * causes the for-await loop to break cleanly).
   */
  async debugTriggerStreamError(workspaceId: string, errorMessage: string): Promise<boolean> {
    const typedWorkspaceId = workspaceId as WorkspaceId;
    const streamInfo = this.workspaceStreams.get(typedWorkspaceId);

    // Only trigger error if stream is actively running
    if (
      !streamInfo ||
      (streamInfo.state !== StreamState.STARTING && streamInfo.state !== StreamState.STREAMING)
    ) {
      return false;
    }

    // Abort the stream first (causes for-await loop to break cleanly)
    streamInfo.abortController.abort(new Error(errorMessage));

    // Mark as error state (same as catch block does)
    streamInfo.state = StreamState.ERROR;

    // Update streamInfo metadata with error (so subsequent flushes preserve it)
    streamInfo.initialMetadata = {
      ...streamInfo.initialMetadata,
      error: errorMessage,
      errorType: "network",
    };

    // Write error state to partial.json (same as real error handling)
    const persistedPayload = await this.persistStreamError(typedWorkspaceId, streamInfo, {
      messageId: streamInfo.messageId,
      error: errorMessage,
      errorType: "network",
    });
    // Debug-injected failures bypass handleStreamFailure, so record the failed
    // completion here or cleanup would never settle the turn handle.
    streamInfo.terminalCompletion = { status: "failed", streamError: persistedPayload };

    // Wait for the stream processing to complete (cleanup)
    await streamInfo.processingPromise;

    return true;
  }
}

import assert from "@/common/utils/assert";
import { stripStagedAttachmentNotice } from "@/browser/features/ChatInput/stagedAttachments";
import type {
  MuxMessage,
  DisplayedMessage,
  PendingSendMessage,
  QueuedMessage,
} from "@/common/types/message";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { isGoalPendingPersistence, type GoalSnapshot } from "@/common/types/goal";
import type {
  WorkspaceActivitySnapshot,
  WorkspaceChatMessage,
  WorkspaceStatsSnapshot,
  OnChatMode,
  ProvidersConfigMap,
} from "@/common/orpc/types";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import type { TodoItem } from "@/common/types/tools";
import type { AssistedReviewHunk } from "@/common/types/review";
import type { WorkflowRunRecord } from "@/common/types/workflow";
import type { TimelineEvent, TimelineSubscriptionEvent } from "@/common/orpc/schemas/timeline";
import { applyWorkspaceChatEventToAggregator } from "@/browser/utils/messages/applyWorkspaceChatEventToAggregator";
import {
  StreamingMessageAggregator,
  type LoadedSkill,
  type SkillLoadError,
} from "@/browser/utils/messages/StreamingMessageAggregator";
import {
  createCompactionCompletion,
  type ResponseCompleteEvent,
  type ResponseCompleteHandler,
} from "@/browser/utils/messages/responseCompletionMetadata";
import { isAbortError } from "@/browser/utils/isAbortError";
import {
  SUBSCRIPTION_RETRY_BASE_MS,
  calculateSubscriptionBackoffMs,
  runSubscriptionLoop,
  sleepWithAbort,
} from "@/browser/stores/subscriptionTransport";
import {
  ADVISOR_LIVE_OUTPUT_MAX_CHARS,
  BASH_TRUNCATE_MAX_TOTAL_BYTES,
} from "@/common/constants/toolLimits";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  isCaughtUpMessage,
  isStreamAbort,
  isStreamError,
  isStreamLifecycle,
  isDeleteMessage,
  isInitEnd,
  isInitOutput,
  isInitStart,
  isAdvisorOutputEvent,
  isAdvisorReasoningOutputEvent,
  isAdvisorPhaseEvent,
  isBashOutputEvent,
  isTaskCreatedEvent,
  isWorkflowRunAttachedEvent,
  isMuxMessage,
  isQueuedMessageChanged,
  isRestoreToInput,
  isRuntimeStatus,
} from "@/common/orpc/types";
import {
  type AdvisorPhaseEvent,
  type StreamAbortEvent,
  type StreamAbortReasonSnapshot,
  type StreamDeltaEvent,
  type StreamEndEvent,
  type ToolCallDeltaEvent,
  type ReasoningDeltaEvent,
  type StreamStartEvent,
  type RuntimeStatusEvent,
} from "@/common/types/stream";
import { MapStore } from "./MapStore";
import { createDisplayUsage, recomputeUsageCosts } from "@/common/utils/tokens/displayUsage";
import { deriveTodoStatus } from "@/common/utils/todoList";
import { getModelStats } from "@/common/utils/tokens/modelStats";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";
import { computeProvidersConfigFingerprint } from "@/common/utils/providers/configFingerprint";
import { isDurableCompactionBoundaryMarker } from "@/common/utils/messages/compactionBoundary";
import { WorkspaceConsumerManager } from "./WorkspaceConsumerManager";
import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import { sumUsageHistory } from "@/common/utils/tokens/usageAggregator";
import type { TokenConsumer } from "@/common/types/chatStats";
import { normalizeUsageModelKey } from "@/common/utils/providers/modelEntries";
import type { z } from "zod";
import type { SessionUsageFileSchema } from "@/common/orpc/schemas/chatStats";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import {
  appendLiveBashOutputChunk,
  type LiveBashOutputInternal,
  type LiveBashOutputView,
} from "@/browser/utils/messages/liveBashOutputBuffer";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  getAutoCompactionThresholdKey,
  getAutoRetryKey,
  getPinnedTodoExpandedKey,
} from "@/common/constants/storage";
import { DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT } from "@/common/constants/ui";
import { APPROX_CHARS_PER_TOKEN } from "@/constants/streaming";
import { trackStreamCompleted } from "@/common/telemetry";
import { isWorkflowRunEmittingToolName } from "@/common/utils/workflowRunMessages";
import { isProviderConfigFixableError } from "@/common/utils/messages/retryEligibility";

/** Stable empty reference returned when a workspace has no assisted hunks; keeps useSyncExternalStore snapshot identity stable. */
const EMPTY_ASSISTED_REVIEW: AssistedReviewHunk[] = [];

export function mergeTimelineEvents(
  preferred: TimelineEvent[],
  fallback: TimelineEvent[]
): TimelineEvent[] {
  if (preferred.length === 0) return fallback;
  if (fallback.length === 0) {
    return preferred.every((event, index) => index === 0 || preferred[index - 1].seq > event.seq)
      ? preferred
      : preferred.toSorted((a, b) => b.seq - a.seq);
  }

  // Pages are newest-first, but live events queued while the initial snapshot is built can arrive as
  // one oldest-first batch. Normalize only that uncommon case before taking the linear fast paths.
  const orderedPreferred = preferred.every(
    (event, index) => index === 0 || preferred[index - 1].seq > event.seq
  )
    ? preferred
    : preferred.toSorted((a, b) => b.seq - a.seq);

  const preferredOldest = orderedPreferred[orderedPreferred.length - 1];
  const fallbackNewest = fallback[0];
  if (preferredOldest && fallbackNewest && preferredOldest.seq > fallbackNewest.seq) {
    return [...orderedPreferred, ...fallback];
  }
  const fallbackOldest = fallback[fallback.length - 1];
  const preferredNewest = orderedPreferred[0];
  if (fallbackOldest && preferredNewest && fallbackOldest.seq > preferredNewest.seq) {
    return [...fallback, ...orderedPreferred];
  }

  const preferredIds = new Set(orderedPreferred.map((event) => event.id));
  return [...orderedPreferred, ...fallback.filter((event) => !preferredIds.has(event.id))].toSorted(
    (a, b) => b.seq - a.seq
  );
}

export interface WorkspaceLastUserPromptInfo {
  text: string;
  messageId: string;
}

interface WorkspaceLastUserPromptSnapshot {
  displayed: WorkspaceLastUserPromptInfo | null;
  historyEpoch: number;
  isCaughtUp: boolean;
}

export interface WorkspaceTimelineSnapshot {
  events: TimelineEvent[];
  nextCursor: number | null;
  hasOlder: boolean;
  initialized: boolean;
  loadingOlder: boolean;
  loadError: string | null;
  // A dead subscription needs a retry to recover; a failed page can just be requested again.
  loadErrorKind: "subscription" | "pagination" | null;
}

const EMPTY_TIMELINE_SNAPSHOT: WorkspaceTimelineSnapshot = {
  events: [],
  nextCursor: null,
  hasOlder: false,
  initialized: false,
  loadingOlder: false,
  loadError: null,
  loadErrorKind: null,
};

export type AutoRetryStatus = Extract<
  WorkspaceChatMessage,
  | { type: "auto-retry-scheduled" }
  | { type: "auto-retry-starting" }
  | { type: "auto-retry-abandoned" }
>;

export type HistoryLoadResult = "loaded" | "exhausted" | "busy" | "unavailable" | "failed";

export interface WorkspaceState {
  name: string; // User-facing workspace name (e.g., "feature-branch")
  messages: DisplayedMessage[];
  queuedMessage: QueuedMessage | null;
  pendingSend: PendingSendMessage | null;
  canInterrupt: boolean;
  isCompacting: boolean;
  isStreamStarting: boolean;
  awaitingUserQuestion: boolean;
  loading: boolean;
  isTranscriptCaughtUp: boolean;
  isHydratingTranscript: boolean;
  hasOlderHistory: boolean;
  loadingOlderHistory: boolean;
  muxMessages: MuxMessage[];
  currentModel: string | null;
  currentThinkingLevel: string | null;
  recencyTimestamp: number | null;
  todos: TodoItem[];
  loadedSkills: LoadedSkill[];
  skillLoadErrors: SkillLoadError[];
  agentStatus: { emoji: string; message: string; url?: string } | undefined;
  activeWorkflowRunIds?: string[];
  activeWorkflowRunCount: number;
  activeBashMonitorCount: number;
  lastAbortReason: StreamAbortReasonSnapshot | null;
  pendingStreamStartTime: number | null;
  // Model used for the pending send (used during "starting" phase)
  pendingStreamModel: string | null;
  // Current pre-stream startup breadcrumb (runtime readiness, tool loading, etc.)
  runtimeStatus: RuntimeStatusEvent | null;
  autoRetryStatus: AutoRetryStatus | null;
  goal?: GoalSnapshot | null;
}

export interface WorkspaceShellStatus {
  loading: boolean;
  isHydratingTranscript: boolean;
  isStreamStarting: boolean;
}

/**
 * Live streaming stats snapshot for the active stream of a workspace.
 *
 * Exposed via {@link useWorkspaceStreamingStats} as a leaf subscription so
 * components that display tokens-per-second / token count (e.g. StreamingBarrier)
 * re-render on each delta WITHOUT cascading through the full WorkspaceState
 * snapshot. Keeping these out of WorkspaceState is what lets the streaming
 * smoothing engine actually run smoothly: otherwise the per-delta TPS read
 * (which uses Date.now()) makes the snapshot unstable on every microtask and
 * forces ChatPane to reconcile faster than the RAF presentation clock can
 * draw.
 */
export interface WorkspaceStreamingStats {
  tokenCount: number;
  /** Tokens-per-second over a trailing window. */
  tps: number;
  /** Approximate characters-per-second the model is producing. Used by the
   *  smoothing engine to target the model's actual emission rate rather than
   *  the legacy fixed BASE rate. */
  charsPerSec: number;
}

/**
 * Subset of WorkspaceState needed for sidebar display.
 * Subscribing to only these fields prevents re-renders when messages update.
 *
 * Note: timingStats/sessionStats are intentionally excluded - they update on every
 * streaming token. Components needing timing should use useWorkspaceStatsSnapshot().
 */
export interface WorkspaceSidebarState {
  canInterrupt: boolean;
  isStarting: boolean;
  awaitingUserQuestion: boolean;
  lastAbortReason: StreamAbortReasonSnapshot | null;
  currentModel: string | null;
  // Requested model for the pending send so the sidebar keeps the same label while
  // the turn transitions from pre-stream "starting" into the live stream.
  pendingStreamModel: string | null;
  recencyTimestamp: number | null;
  loadedSkills: LoadedSkill[];
  skillLoadErrors: SkillLoadError[];
  agentStatus: { emoji: string; message: string; url?: string } | undefined;
  activeWorkflowRunIds?: string[];
  activeWorkflowRunCount: number;
  activeBashMonitorCount: number;
  terminalActiveCount: number;
  terminalSessionCount: number;
  goal?: GoalSnapshot | null;
}

/**
 * Derived state values stored in the derived MapStore.
 * Currently only recency timestamps for workspace sorting.
 */
type DerivedState = Record<string, number>;

/**
 * Per-attempt context for an onChat subscription. Carries the since-mode anchor the
 * attempt's cursor requested (so caught-up reconciliation only ever sees its own
 * attempt's anchor) plus an abort handle used to force a full resubscribe when a
 * since caught-up arrives without a usable anchor.
 */
interface OnChatAttemptContext {
  abort: () => void;
  since?: {
    requestedAnchorSequence: number;
    localActiveStreamMessageId: string | undefined;
  };
}

/**
 * Usage metadata extracted from API responses (no tokenization).
 * Updates instantly when usage metadata arrives.
 *
 * For multi-step tool calls, cost and context usage differ:
 * - sessionTotal: Pre-computed sum of all models from session-usage.json
 * - lastRequest: Last completed request (persisted for app restart)
 * - lastContextUsage: Last step's usage for context window display (inputTokens = actual context size)
 */
export interface WorkspaceUsageState {
  /** Pre-computed session total (sum of all models) */
  sessionTotal?: ChatUsageDisplay;
  /** Session usage per canonical model string (source of sessionTotal) */
  sessionByModel?: Record<string, ChatUsageDisplay>;
  /** Last completed request (persisted) */
  lastRequest?: {
    model: string;
    usage: ChatUsageDisplay;
    timestamp: number;
  };
  /** Last message's context usage (last step only, for context window display) */
  lastContextUsage?: ChatUsageDisplay;
  totalTokens: number;
  /** Live context usage during streaming (last step's inputTokens = current context window) */
  liveUsage?: ChatUsageDisplay;
  /** Live cost usage during streaming (cumulative across all steps) */
  liveCostUsage?: ChatUsageDisplay;
  /**
   * Request-pinned metadata identity of the active stream (backend-stamped
   * at stream start). Consumers keying/pricing live Coder usage must prefer
   * it over re-resolving the raw model against a refreshed providers config.
   */
  liveMetadataModel?: string;
}

/**
 * Consumer breakdown requiring tokenization (lazy calculation).
 * Updates after async Web Worker calculation completes.
 */
export interface WorkspaceConsumersState {
  consumers: TokenConsumer[];
  tokenizerName: string;
  totalTokens: number; // Total from tokenization (may differ from usage totalTokens)
  isCalculating: boolean;
  topFilePaths?: Array<{ path: string; tokens: number }>; // Top 10 files aggregated across all file tools
}

export interface AdvisorLivePhaseState {
  phase: AdvisorPhaseEvent["phase"];
  timestamp: number;
}

export interface AdvisorLiveTextState {
  text: string;
  timestamp: number;
}

export type AdvisorLiveOutputState = AdvisorLiveTextState;
export type AdvisorLiveReasoningState = AdvisorLiveTextState;

export interface WorkflowToolLiveRunState {
  runId: string;
  run?: WorkflowRunRecord;
}

interface PendingSendState {
  message: PendingSendMessage;
  /** User echoes already in the transcript when the send began; null when begun before catch-up. */
  knownUserEchoIds: Set<string> | null;
  /** Wall clock at begin; with no baseline, only rows persisted at or after it can be the echo. */
  beganAtMs: number;
  /** The send request succeeded, so any later replay is guaranteed to contain its echo. */
  accepted: boolean;
  /** A synthetic user row (pre-send compaction) took the turn; the echo follows that turn. */
  deferredBehindSyntheticTurn: boolean;
}

/** A persisted user turn the backend emits in response to a send; synthetic rows are not echoes. */
function isUserEcho(message: MuxMessage): boolean {
  return message.role === "user" && message.metadata?.synthetic !== true;
}

interface WorkspaceChatTransientState {
  caughtUp: boolean;
  isHydratingTranscript: boolean;
  historicalMessages: MuxMessage[];
  pendingStreamEvents: WorkspaceChatMessage[];
  replayingHistory: boolean;
  queuedMessage: QueuedMessage | null;
  /** Visible queue payload size from the last queue update, to tell drains from new enqueues. */
  queuedMessageCount: number;
  /** Dispatched queue entries whose user rows have not arrived yet; they are not send echoes. */
  queueDispatchesAwaitingEcho: number;
  pendingSend: PendingSendState | null;
  liveBashOutput: Map<string, LiveBashOutputInternal>;
  liveAdvisorOutput: Map<string, AdvisorLiveOutputState>;
  liveAdvisorReasoning: Map<string, AdvisorLiveReasoningState>;
  liveAdvisorPhase: Map<string, AdvisorLivePhaseState>;
  liveTaskIds: Map<string, string[]>;
  liveWorkflowRuns: Map<string, WorkflowToolLiveRunState>;
  autoRetryStatus: AutoRetryStatus | null;
}

interface HistoryPaginationCursor {
  beforeHistorySequence: number;
  beforeMessageId?: string | null;
}

interface WorkspaceHistoryPaginationState {
  nextCursor: HistoryPaginationCursor | null;
  hasOlder: boolean;
  loading: boolean;
}

function areHistoryPaginationCursorsEqual(
  a: HistoryPaginationCursor | null,
  b: HistoryPaginationCursor | null
): boolean {
  if (a === b) {
    return true;
  }

  if (!a || !b) {
    return false;
  }

  return (
    a.beforeHistorySequence === b.beforeHistorySequence &&
    (a.beforeMessageId ?? null) === (b.beforeMessageId ?? null)
  );
}

function createInitialHistoryPaginationState(): WorkspaceHistoryPaginationState {
  return {
    nextCursor: null,
    hasOlder: false,
    loading: false,
  };
}

function getBufferedActiveStreamStart(
  events: WorkspaceChatMessage[]
): Pick<StreamStartEvent, "model" | "thinkingLevel"> | null {
  let activeStreamStart: StreamStartEvent | null = null;

  for (const event of events) {
    if (!("type" in event)) {
      continue;
    }

    if (event.type === "stream-start") {
      activeStreamStart = event;
      continue;
    }

    if (
      activeStreamStart !== null &&
      (event.type === "stream-end" ||
        event.type === "stream-abort" ||
        event.type === "stream-error") &&
      event.messageId === activeStreamStart.messageId
    ) {
      activeStreamStart = null;
    }
  }

  if (!activeStreamStart) {
    return null;
  }

  return {
    model: activeStreamStart.model,
    thinkingLevel: activeStreamStart.thinkingLevel,
  };
}

function appendAdvisorLiveText(
  liveTextByToolCallId: Map<string, AdvisorLiveTextState>,
  toolCallId: string,
  chunk: string,
  timestamp: number
): boolean {
  const prev = liveTextByToolCallId.get(toolCallId);
  const appendedText = `${prev?.text ?? ""}${chunk}`;
  const text =
    appendedText.length > ADVISOR_LIVE_OUTPUT_MAX_CHARS
      ? appendedText.slice(-ADVISOR_LIVE_OUTPUT_MAX_CHARS)
      : appendedText;

  if (prev?.text === text && prev.timestamp === timestamp) {
    return false;
  }

  liveTextByToolCallId.set(toolCallId, { text, timestamp });
  return true;
}

function createInitialChatTransientState(): WorkspaceChatTransientState {
  return {
    caughtUp: false,
    isHydratingTranscript: false,
    historicalMessages: [],
    pendingStreamEvents: [],
    replayingHistory: false,
    queuedMessage: null,
    queuedMessageCount: 0,
    queueDispatchesAwaitingEcho: 0,
    pendingSend: null,
    liveBashOutput: new Map(),
    liveAdvisorOutput: new Map(),
    liveAdvisorReasoning: new Map(),
    liveAdvisorPhase: new Map(),
    liveTaskIds: new Map(),
    liveWorkflowRuns: new Map(),
    autoRetryStatus: null,
  };
}

interface ValidationIssue {
  path?: Array<string | number>;
  message?: string;
}

type IteratorValidationFailedError = Error & {
  code: "EVENT_ITERATOR_VALIDATION_FAILED";
  cause?: {
    issues?: ValidationIssue[];
    data?: unknown;
  };
};

function isIteratorValidationFailed(error: unknown): error is IteratorValidationFailedError {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === "EVENT_ITERATOR_VALIDATION_FAILED"
  );
}

/**
 * Extract a human-readable summary from an iterator validation error.
 * ORPC wraps Zod issues in error.cause with { issues: [...], data: ... }
 */
function formatValidationError(error: IteratorValidationFailedError): string {
  const cause = error.cause;
  if (!cause) {
    return "Unknown validation error (no cause)";
  }

  const issues = cause.issues ?? [];
  if (issues.length === 0) {
    return `Unknown validation error (no issues). Data: ${JSON.stringify(cause.data)}`;
  }

  // Format issues like: "type: Invalid discriminator value" or "metadata.usage.inputTokens: Expected number"
  const issuesSummary = issues
    .slice(0, 3) // Limit to first 3 issues
    .map((issue) => {
      const path = issue.path?.join(".") ?? "(root)";
      const message = issue.message ?? "Unknown issue";
      return `${path}: ${message}`;
    })
    .join("; ");

  const moreCount = issues.length > 3 ? ` (+${issues.length - 3} more)` : "";

  // Include the event type if available
  const data = cause.data as { type?: string } | undefined;
  const eventType = data?.type ? ` [event: ${data.type}]` : "";

  return `${issuesSummary}${moreCount}${eventType}`;
}

/**
 * Auto-collapse the pinned TODO panel when a workspace's stream stops.
 * Lives in the store (not the component) because PinnedTodoList is only
 * mounted for the active workspace — background workspaces would miss
 * the transition. Callers supply the authoritative hasTodos value: the
 * live aggregator for active workspaces, the backend snapshot for background ones.
 */
function collapsePinnedTodoOnStreamStop(workspaceId: string, hasTodos: boolean): void {
  if (!hasTodos) {
    return;
  }

  updatePersistedState(getPinnedTodoExpandedKey(workspaceId), false);
}

const EMPTY_ACTIVE_WORKFLOW_RUN_IDS: string[] = [];

function areStringArraysEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  const leftValues = left ?? EMPTY_ACTIVE_WORKFLOW_RUN_IDS;
  const rightValues = right ?? EMPTY_ACTIVE_WORKFLOW_RUN_IDS;
  return (
    leftValues === rightValues ||
    (leftValues.length === rightValues.length &&
      leftValues.every((value, index) => value === rightValues[index]))
  );
}

function areAgentStatusesEqual(
  a: { emoji: string; message: string; url?: string } | undefined | null,
  b: { emoji: string; message: string; url?: string } | undefined | null
): boolean {
  if (a === b) {
    return true;
  }

  if (!a || !b) {
    return false;
  }

  return a.emoji === b.emoji && a.message === b.message && (a.url ?? null) === (b.url ?? null);
}

function getMaxHistorySequence(messages: MuxMessage[]): number | undefined {
  let max: number | undefined;
  for (const message of messages) {
    const seq = message.metadata?.historySequence;
    if (typeof seq !== "number") {
      continue;
    }
    if (max === undefined || seq > max) {
      max = seq;
    }
  }
  return max;
}

/**
 * Detect gateway-billed (costs-included) usage entries.
 * `createDisplayUsage` sets `costsIncluded: true` when
 * `providerMetadata.mux.costsIncluded` is true. These entries should
 * not be repriced when model mappings change because the provider
 * gateway already handles billing.
 */
function isCostsIncludedEntry(
  usage: ChatUsageDisplay,
  runtimeModelId: string,
  providersConfig: ProvidersConfigMap
): boolean {
  if (usage.costsIncluded === true) {
    return true;
  }

  // Unknown-cost rows are not gateway-billed by definition; they indicate
  // missing pricing metadata and should be eligible for repricing when a
  // mapping is later configured.
  if (usage.hasUnknownCosts === true) {
    return false;
  }

  // Backward-compatibility: older session-usage.json entries may have been
  // gateway-billed with all costs explicitly zeroed before the costsIncluded
  // marker was persisted. Treat those all-zero entries as costs-included so
  // repricing doesn't inflate historical gateway-billed totals after upgrade.
  //
  // Guardrail: only apply this legacy heuristic for models that have non-zero
  // billable pricing in model stats. Use the resolved metadata model so mapped
  // custom IDs (e.g. ollama:custom -> anthropic:claude-*) are classified by the
  // effective pricing model, not the raw runtime string.
  const metadataModel = resolveModelForMetadata(runtimeModelId, providersConfig);
  const stats = getModelStats(metadataModel);
  const hasBillableRates =
    (stats?.input_cost_per_token ?? 0) > 0 ||
    (stats?.output_cost_per_token ?? 0) > 0 ||
    (stats?.cache_creation_input_token_cost ?? 0) > 0 ||
    (stats?.cache_read_input_token_cost ?? 0) > 0;
  if (!hasBillableRates) {
    return false;
  }

  const components = ["input", "cached", "cacheCreate", "output", "reasoning"] as const;
  let hasTokens = false;
  for (const key of components) {
    const component = usage[key];
    if (component.tokens > 0) {
      hasTokens = true;
    }
    if (component.cost_usd !== 0) {
      return false;
    }
  }

  return hasTokens;
}

/**
 * Recompute cost aggregates for a single session-usage entry so session totals
 * and last-request costs reflect the current model mapping.
 *
 * Skips non-model aggregate buckets (e.g. "historical" from legacy compaction
 * summaries) and costs-included entries (gateway-billed requests where cost_usd
 * was explicitly zeroed).
 */
function repriceSessionUsage(
  usage: z.infer<typeof SessionUsageFileSchema>,
  config: ProvidersConfigMap,
  providersConfigFingerprint: number
): void {
  if (usage.tokenStatsCache?.providersConfigVersion !== providersConfigFingerprint) {
    usage.tokenStatsCache = undefined;
  }
  for (const [model, entry] of Object.entries(usage.byModel)) {
    if (!model.includes(":") || isCostsIncludedEntry(entry, model, config)) continue;
    const resolved = resolveModelForMetadata(model, config);
    // `byModel` is a session-long aggregate, so tiered models cannot be safely repriced from
    // the summed token totals alone. recomputeUsageCosts() preserves those stored costs and marks
    // them approximate when the effective model has non-linear pricing.
    usage.byModel[model] = recomputeUsageCosts(entry, resolved, { aggregatedUsage: true });
  }
  if (
    usage.lastRequest &&
    !isCostsIncludedEntry(usage.lastRequest.usage, usage.lastRequest.model, config)
  ) {
    const resolved = resolveModelForMetadata(usage.lastRequest.model, config);
    usage.lastRequest.usage = recomputeUsageCosts(usage.lastRequest.usage, resolved);
  }
}

/**
 * External store for workspace aggregators and streaming state.
 *
 * This store lives outside React's lifecycle and manages all workspace
 * message aggregation and IPC subscriptions. Components subscribe to
 * specific workspaces via useSyncExternalStore, ensuring only relevant
 * components re-render when workspace state changes.
 */
function getStreamingMessageKey(workspaceId: string, messageId: string): string {
  return workspaceId + "\0" + messageId;
}

function getAdvisorLiveKey(workspaceId: string, toolCallId: string): string {
  return workspaceId + "\0" + toolCallId;
}

export class WorkspaceStore {
  // Per-workspace state (lazy computed on get)
  private states = new MapStore<string, WorkspaceState>();

  // Stable subset for WorkspaceShell so message deltas do not re-render shell chrome.
  private workspaceShellStatusCache = new Map<string, WorkspaceShellStatus>();

  // Derived aggregate state (computed from multiple workspaces)
  private derived = new MapStore<string, DerivedState>();

  // The footer's last-prompt projection changes only on transcript/history mutations, not deltas.
  private lastUserPromptStore = new MapStore<string, WorkspaceLastUserPromptSnapshot>();

  // Usage and consumer stores (two-store approach for CostsTab optimization)
  private usageStore = new MapStore<string, WorkspaceUsageState>();
  private client: RouterClient<AppRouter> | null = null;
  private clientChangeController = new AbortController();
  private providersConfig: ProvidersConfigMap | null = null;
  /** Stable fingerprint for cache freshness checks across reconnects/app restarts.
   * `null` until the first successful config fetch — prevents hydrating stale caches
   * and blocks tokenization until we know the real configuration. */
  private providersConfigFingerprint: number | null = null;
  /** Monotonic request counter for serializing provider config refreshes (latest wins). */
  private providersConfigVersion = 0;
  /** Version of the last successfully applied provider config (prevents stale overwrites). */
  private providersConfigAppliedVersion = 0;
  /** Consecutive provider-config subscription/refresh failures (used for exponential backoff). */
  private providersConfigFailureStreak = 0;
  // Workspaces that need a clean history replay once a new iterator is established.
  // We keep the existing UI visible until the replay can actually start.
  private pendingReplayReset = new Set<string>();
  // Last usage snapshot captured right before full replay clears the aggregator.
  // Used as a temporary fallback so context/cost indicators don't flash empty
  // during reconnect until replayed usage catches up.
  private preReplayUsageSnapshot = new Map<string, WorkspaceUsageState>();
  private consumersStore = new MapStore<string, WorkspaceConsumersState>();

  // Manager for consumer calculations (debouncing, caching, lazy loading)
  // Architecture: WorkspaceStore orchestrates (decides when), manager executes (performs calculations)
  // Dual-cache: consumersStore (MapStore) handles subscriptions, manager owns data cache
  private readonly consumerManager: WorkspaceConsumerManager;

  // Supporting data structures
  private aggregators = new Map<string, StreamingMessageAggregator>();
  // Active onChat subscription cleanup handlers (must stay size <= 1).
  private ipcUnsubscribers = new Map<string, () => void>();

  // Workspace selected in the UI (set from WorkspaceContext routing state).
  private activeWorkspaceId: string | null = null;

  // Workspace currently owning the live onChat subscription.
  private activeOnChatWorkspaceId: string | null = null;

  // Lightweight activity snapshots from workspace.activity.list/subscribe.
  private workspaceActivity = new Map<string, WorkspaceActivitySnapshot>();
  // Recency timestamp observed when a workspace transitions into streaming=true.
  // Used to distinguish true stream completion (recency bumps on stream-end) from
  // abort/error transitions (streaming=false without recency advance).
  private activityStreamingStartRecency = new Map<string, number>();
  private activityAbortController: AbortController | null = null;
  // True once the initial activity.list() snapshot has been applied (or the
  // subscription failed and we self-healed). Until then, "no other workspace
  // is streaming" is merely unknown — the chat view's first-paint barrier
  // (useChatViewDataReady) waits on this so cross-workspace decorations like
  // the concurrent-local warning can't pop in after the transcript reveals.
  private activityHydrated = false;
  private activityAuthoritative = false;
  // Workspace ids that received a live subscription delta while a bootstrap-retry
  // list() read was in flight (null while no retry read is pending). Those deltas
  // are newer than the pending list response, which must not overwrite or clear
  // them (see retryActivityBootstrapList).
  private activityDeltaTouchesDuringRetry: Set<string> | null = null;
  private activityHydratedListeners = new Set<() => void>();
  // Workspaces whose persisted session usage fetch has settled (success or
  // failure). Distinguishes "usage unknown" from "no usage" for the same
  // first-paint barrier (CompactionWarning derives from usage).
  //
  // Deliberately LATCHED per session: revisiting a workspace re-fetches usage
  // (setActiveWorkspaceId), but the barrier keeps revealing with last-known
  // usage rather than waiting for the refresh. Resetting this per refresh
  // would flip useChatViewDataReady false on every workspace switch and
  // unmount/remount the whole composer decoration lane (a guaranteed flash)
  // to guard against a rare one (usage changed while inactive AND crossed the
  // compaction threshold — a genuine live state change, allowed to move UI
  // like any other live event). The barrier's contract is "never paint
  // unknown as absent", not "freeze data that legitimately updates".
  private sessionUsageKnown = new Set<string>();

  private activeGoalCount = 0;
  private activeGoalCountStore = new MapStore<string, void>();

  // Per-workspace terminal activity aggregates (from terminal.activity.subscribe).
  private workspaceTerminalActivity = new Map<
    string,
    { activeCount: number; totalSessions: number }
  >();
  private terminalActivityAbortController: AbortController | null = null;

  // Per-workspace ephemeral chat state (buffering, queued message, live bash output, etc.)
  private chatTransientState = new Map<string, WorkspaceChatTransientState>();

  // Per-workspace transcript pagination state for loading prior compaction epochs.
  private historyPagination = new Map<string, WorkspaceHistoryPaginationState>();

  private workspaceMetadata = new Map<string, FrontendWorkspaceMetadata>(); // Store metadata for name lookup

  // Workspace timing stats snapshots (from workspace.stats.subscribe)
  private workspaceStats = new Map<string, WorkspaceStatsSnapshot>();
  private statsStore = new MapStore<string, WorkspaceStatsSnapshot | null>();
  private statsUnsubscribers = new Map<string, () => void>();
  // Per-workspace listener refcount for useWorkspaceStatsSnapshot().
  // Used to only subscribe to backend stats when something in the UI is actually reading them.
  private statsListenerCounts = new Map<string, number>();

  private workspaceTimelines = new Map<string, WorkspaceTimelineSnapshot>();
  private timelineStore = new MapStore<string, WorkspaceTimelineSnapshot>();
  private timelineUnsubscribers = new Map<string, () => void>();
  private timelineListenerCounts = new Map<string, number>();

  // Cumulative session usage (from session-usage.json)

  private sessionUsage = new Map<string, z.infer<typeof SessionUsageFileSchema>>();
  private sessionUsageRequestVersion = new Map<string, number>();

  // Global callback for navigating to a workspace (set by App, used for notification clicks)
  private navigateToWorkspaceCallback: ((workspaceId: string) => void) | null = null;

  // Global callback when a response completes (for "notify on response" feature).
  private responseCompleteCallback: ResponseCompleteHandler | null = null;

  // Tracks when a file-modifying tool (file_edit_*, bash) last completed per workspace.
  // ReviewPanel subscribes to trigger diff refresh. Two structures:
  // - timestamps: actual Date.now() values for cache invalidation checks
  // - subscriptions: MapStore for per-workspace subscription support
  private fileModifyingToolMs = new Map<string, number>();
  private fileModifyingToolSubs = new MapStore<string, void>();

  // Idle callbacks keep high-frequency init logs from blocking the renderer.
  private deltaIdleHandles = new Map<string, number>();

  private pendingStreamingMessageBump = new Map<string, string>();
  // Live keyed-channel key per workspace, so every stream-clearing path can
  // release it even when no terminal chat event names the message.
  private streamingMessageKeys = new Map<string, string>();
  private streamingMessageStore = new MapStore<string, void>();
  private advisorLiveStore = new MapStore<string, void>();
  private streamingStatsStore = new MapStore<string, WorkspaceStreamingStats | null>();

  /**
   * Replace the auto-retry banner state and notify subscribers. Shared across the
   * three auto-retry-* event handlers below; they only differ in the discriminant
   * which is already encoded by {@link AutoRetryStatus}.
   *
   * Declared as an arrow class field so it can be referenced in the
   * {@link bufferedEventHandlers} initializer (class fields initialize top-to-bottom).
   */
  private readonly applyAutoRetryStatus = (
    workspaceId: string,
    _aggregator: StreamingMessageAggregator,
    data: WorkspaceChatMessage
  ): void => {
    const transient = this.assertChatTransientState(workspaceId);
    transient.autoRetryStatus = data as AutoRetryStatus;
    this.states.bump(workspaceId);
  };

  /**
   * Map of event types to their handlers. This is the single source of truth for:
   * 1. Which events should be buffered during replay (the keys)
   * 2. How to process those events (the values)
   *
   * By keeping check and processing in one place, we make it structurally impossible
   * to buffer an event type without having a handler for it.
   */
  private readonly bufferedEventHandlers: Record<
    string,
    (
      workspaceId: string,
      aggregator: StreamingMessageAggregator,
      data: WorkspaceChatMessage
    ) => void
  > = {
    "stream-start": (workspaceId, aggregator, data) => {
      // Every dispatched entry echoes before its stream starts, so nothing is still owed.
      this.assertChatTransientState(workspaceId).queueDispatchesAwaitingEcho = 0;
      applyWorkspaceChatEventToAggregator(aggregator, data);
      if (this.onModelUsed) {
        this.onModelUsed((data as { model: string }).model);
      }

      // A new stream supersedes any prior retry banner state.
      const transient = this.assertChatTransientState(workspaceId);
      transient.autoRetryStatus = null;

      this.states.bump(workspaceId);
      // Bump usage store so liveUsage is recomputed with new activeStreamId
      this.usageStore.bump(workspaceId);
      // Invalidate cached streaming stats so the pill never displays the prior
      // turn's TPS at the start of a new one. Stream-end / stream-abort /
      // stream-error already bump on terminal events, but those bumps can be
      // skipped on reconnect/hydration paths that drop activeStreams via
      // aggregator.clearActiveStreams() without notifying this store. Bumping
      // on stream-start makes the cache invariant: every new turn forces a
      // fresh recompute regardless of how the previous one was wound down.
      this.streamingStatsStore.bump(workspaceId);
    },
    "stream-lifecycle": (workspaceId, aggregator, data) => {
      applyWorkspaceChatEventToAggregator(aggregator, data);
      this.states.bump(workspaceId);
    },
    "stream-delta": (workspaceId, aggregator, data) => {
      this.applyStreamingDelta(workspaceId, aggregator, data as StreamDeltaEvent);
    },
    "stream-end": (workspaceId, aggregator, data) => {
      const streamEndData = data as StreamEndEvent;
      applyWorkspaceChatEventToAggregator(aggregator, streamEndData);
      this.releaseStreamingMessageChannel(workspaceId);

      // Track stream completion telemetry
      this.trackStreamCompletedTelemetry(streamEndData, false);

      const transient = this.assertChatTransientState(workspaceId);
      transient.autoRetryStatus = null;

      // Update local session usage (mirrors backend's addUsage)
      const model = streamEndData.metadata?.model;
      const rawUsage = streamEndData.metadata?.usage;
      const providerMetadata = streamEndData.metadata?.providerMetadata;
      // Request-pinned metadata identity stamped by the backend at stream
      // start. A Coder catalog refresh can remove/retag the instance while
      // the request is active; resolving the raw model against the browser's
      // freshly refreshed config here would price and bucket the delta
      // differently from the backend ledger until reload.
      const pinnedMetadataModel = streamEndData.metadata?.metadataModel;
      if (model && rawUsage) {
        const usage = createDisplayUsage(
          rawUsage,
          model,
          providerMetadata,
          pinnedMetadataModel ?? this.resolveMetadataModel(model)
        );
        if (usage) {
          // Must match the backend's ledger keys (recordSessionUsage): Coder
          // identities use the stream's pinned record-time metadata identity,
          // all others the canonical normalizeUsageModelKey, so the live
          // delta accumulates under the same key.
          const normalizedModel =
            model.startsWith("coder:") && pinnedMetadataModel
              ? pinnedMetadataModel
              : normalizeUsageModelKey(model, this.providersConfig);
          const current = this.sessionUsage.get(workspaceId) ?? {
            byModel: {},
            version: 1 as const,
          };
          const existing = current.byModel[normalizedModel];
          // CRITICAL: Accumulate, don't overwrite (same logic as backend)
          current.byModel[normalizedModel] = existing ? sumUsageHistory([existing, usage])! : usage;
          current.lastRequest = { model: normalizedModel, usage, timestamp: Date.now() };
          this.sessionUsage.set(workspaceId, current);
        }
      }

      collapsePinnedTodoOnStreamStop(workspaceId, aggregator.getCurrentTodos().length > 0);

      // Flush any pending debounced bump before final bump to avoid double-bump
      this.cancelPendingIdleBump(workspaceId);
      this.cancelPendingStreamingBump(workspaceId);
      this.states.bump(workspaceId);
      this.streamingStatsStore.bump(workspaceId);
      this.checkAndBumpRecencyIfChanged();
      this.finalizeUsageStats(workspaceId, streamEndData.metadata);
    },
    "stream-abort": (workspaceId, aggregator, data) => {
      const streamAbortData = data as StreamAbortEvent;
      applyWorkspaceChatEventToAggregator(aggregator, streamAbortData);
      this.releaseStreamingMessageChannel(workspaceId);
      this.retirePendingSendAfterAbandonedTurn(workspaceId);

      // Track stream interruption telemetry (get model from aggregator)
      const model = aggregator.getCurrentModel();
      if (model) {
        this.trackStreamCompletedTelemetry(
          {
            metadata: {
              model,
              usage: streamAbortData.metadata?.usage,
              duration: streamAbortData.metadata?.duration,
            },
          },
          true
        );
      }

      collapsePinnedTodoOnStreamStop(workspaceId, aggregator.getCurrentTodos().length > 0);

      // Flush any pending debounced bump before final bump to avoid double-bump
      this.cancelPendingIdleBump(workspaceId);
      this.cancelPendingStreamingBump(workspaceId);
      this.states.bump(workspaceId);
      this.streamingStatsStore.bump(workspaceId);
      this.finalizeUsageStats(workspaceId, streamAbortData.metadata);
    },
    "tool-call-start": (workspaceId, aggregator, data) => {
      applyWorkspaceChatEventToAggregator(aggregator, data);
      this.states.bump(workspaceId);
    },
    "tool-call-execution-start": (workspaceId, aggregator, data) => {
      applyWorkspaceChatEventToAggregator(aggregator, data);
      this.states.bump(workspaceId);
    },
    "tool-call-delta": (workspaceId, aggregator, data) => {
      this.applyStreamingDelta(workspaceId, aggregator, data as ToolCallDeltaEvent);
    },
    "tool-call-end": (workspaceId, aggregator, data) => {
      const toolCallEnd = data as Extract<WorkspaceChatMessage, { type: "tool-call-end" }>;
      const transient = this.chatTransientState.get(workspaceId);

      // Cleanup live bash output once the real tool result contains output.
      // If output is missing (e.g. tmpfile overflow), keep the tail buffer so the UI still shows something.
      if (toolCallEnd.toolName === "bash" && transient) {
        const output = (toolCallEnd.result as { output?: unknown } | undefined)?.output;
        if (typeof output === "string") {
          transient.liveBashOutput.delete(toolCallEnd.toolCallId);
        }
      }

      // Cleanup ephemeral advisor/task state once the actual tool result is available.
      if (toolCallEnd.toolName === "advisor") {
        transient?.liveAdvisorOutput.delete(toolCallEnd.toolCallId);
        transient?.liveAdvisorReasoning.delete(toolCallEnd.toolCallId);
        transient?.liveAdvisorPhase.delete(toolCallEnd.toolCallId);
        this.advisorLiveStore.delete(getAdvisorLiveKey(workspaceId, toolCallEnd.toolCallId));
      }
      if (toolCallEnd.toolName === "task") {
        transient?.liveTaskIds.delete(toolCallEnd.toolCallId);
      }
      if (isWorkflowRunEmittingToolName(toolCallEnd.toolName)) {
        const result =
          typeof toolCallEnd.result === "object" && toolCallEnd.result !== null
            ? (toolCallEnd.result as { run?: unknown; status?: unknown })
            : null;
        // Background workflow_resume can return a fresh running/backgrounded status while omitting
        // a stale pre-dispatch run. Keep the attachment hint so the card still has workspace/id
        // context for polling until a fresh run snapshot arrives.
        const shouldKeepRunHintForPolling =
          result?.run == null &&
          (result?.status === "running" || result?.status === "backgrounded");
        if (!shouldKeepRunHintForPolling) {
          transient?.liveWorkflowRuns.delete(toolCallEnd.toolCallId);
        }
      }
      applyWorkspaceChatEventToAggregator(aggregator, data);

      this.states.bump(workspaceId);
      this.consumerManager.scheduleCalculation(workspaceId, aggregator);

      // Track file-modifying tools for ReviewPanel diff refresh.
      const shouldTriggerReviewPanelRefresh =
        toolCallEnd.toolName.startsWith("file_edit_") || toolCallEnd.toolName === "bash";

      if (shouldTriggerReviewPanelRefresh) {
        this.fileModifyingToolMs.set(workspaceId, Date.now());
        this.fileModifyingToolSubs.bump(workspaceId);
      }
    },
    "reasoning-delta": (workspaceId, aggregator, data) => {
      this.applyStreamingDelta(workspaceId, aggregator, data as ReasoningDeltaEvent);
    },
    "reasoning-end": (workspaceId, aggregator, data) => {
      applyWorkspaceChatEventToAggregator(aggregator, data);
      this.states.bump(workspaceId);
    },
    "runtime-status": (workspaceId, aggregator, data) => {
      applyWorkspaceChatEventToAggregator(aggregator, data);
      this.states.bump(workspaceId);
    },
    "auto-compaction-triggered": (workspaceId) => {
      // Informational event from backend auto-compaction monitor.
      // We bump workspace state so warning/banner components can react immediately.
      this.states.bump(workspaceId);
    },
    "auto-compaction-completed": (workspaceId) => {
      // Compaction resets context usage; force both stores to recompute from compacted history.
      this.usageStore.bump(workspaceId);
      this.states.bump(workspaceId);
    },
    "auto-retry-scheduled": this.applyAutoRetryStatus,
    "auto-retry-starting": this.applyAutoRetryStatus,
    "auto-retry-abandoned": this.applyAutoRetryStatus,
    "session-usage-delta": (workspaceId, _aggregator, data) => {
      const usageDelta = data as Extract<WorkspaceChatMessage, { type: "session-usage-delta" }>;

      const current = this.sessionUsage.get(workspaceId) ?? {
        byModel: {},
        version: 1 as const,
      };

      for (const [model, usage] of Object.entries(usageDelta.byModelDelta)) {
        const existing = current.byModel[model];
        current.byModel[model] = existing ? sumUsageHistory([existing, usage])! : usage;
      }

      this.sessionUsage.set(workspaceId, current);
      this.usageStore.bump(workspaceId);
    },
    "usage-delta": (workspaceId, aggregator, data) => {
      applyWorkspaceChatEventToAggregator(aggregator, data);
      this.usageStore.bump(workspaceId);
    },
    "init-start": (workspaceId, aggregator, data) => {
      applyWorkspaceChatEventToAggregator(aggregator, data);
      this.states.bump(workspaceId);
    },
    "init-output": (workspaceId, aggregator, data) => {
      applyWorkspaceChatEventToAggregator(aggregator, data);
      // Init output can be very high-frequency (e.g. installs, rsync). Like stream/tool deltas,
      // we update aggregator state immediately but coalesce UI bumps to keep the renderer responsive.
      this.scheduleIdleStateBump(workspaceId);
    },
    "init-end": (workspaceId, aggregator, data) => {
      applyWorkspaceChatEventToAggregator(aggregator, data);
      // Avoid a double-bump if an init-output idle bump is pending.
      this.cancelPendingIdleBump(workspaceId);
      this.states.bump(workspaceId);
    },
    "queued-message-changed": (workspaceId, aggregator, data) => {
      if (!isQueuedMessageChanged(data)) return;

      // Create QueuedMessage once here instead of on every render
      // Use displayText which handles slash commands (shows /compact instead of expanded prompt)
      // Show queued message if there's text OR attachments OR reviews (support review-only queued messages)
      const hasContent =
        data.queuedMessages.length > 0 ||
        (data.fileParts?.length ?? 0) > 0 ||
        (data.reviews?.length ?? 0) > 0;
      const queuedMessage: QueuedMessage | null = hasContent
        ? {
            // Change identity whenever the visible queue projection changes so
            // per-card actions (notably Send now) reset after a partial FIFO drain.
            id: `queued-${workspaceId}-${JSON.stringify([
              data.displayText,
              data.fileParts?.map((part) => [part.mediaType, part.filename, part.url.length]) ?? [],
              data.reviews?.map((review) => [review.filePath, review.lineRange]) ?? [],
              data.queueDispatchMode,
              data.hasCompactionRequest,
            ])}`,
            content: data.displayText,
            fileParts: data.fileParts,
            reviews: data.reviews,
            queueDispatchMode: data.queueDispatchMode,
            hasCompactionRequest: data.hasCompactionRequest,
          }
        : null;

      // Mirror the queue signal onto active streams so response notifications follow
      // user-visible terminal turns instead of every intermediate handoff.
      aggregator.setActiveQueuedFollowUp(data.hasQueuedMessages ?? queuedMessage !== null);
      const transient = this.assertChatTransientState(workspaceId);
      transient.queuedMessage = queuedMessage;
      const pending = transient.pendingSend;
      // Attachment-only entries add no text, so size the queue by every visible payload kind.
      const nextCount =
        data.queuedMessages.length + (data.fileParts?.length ?? 0) + (data.reviews?.length ?? 0);
      if (transient.caughtUp && !transient.replayingHistory) {
        if (nextCount < transient.queuedMessageCount) {
          // One dispatched entry per shrink, however many batched strings it carried.
          transient.queueDispatchesAwaitingEcho += 1;
        } else if (
          pending &&
          (nextCount > transient.queuedMessageCount || (pending.accepted && queuedMessage))
        ) {
          // The send landed in the backend queue; the queued card takes over from the pending row.
          transient.pendingSend = null;
        }
      }
      transient.queuedMessageCount = nextCount;
      this.states.bump(workspaceId);
    },
    "restore-to-input": (workspaceId, _aggregator, data) => {
      if (!isRestoreToInput(data)) return;

      // The queue was cleared, not dispatched; the shrink that preceded this owes no echo.
      this.assertChatTransientState(workspaceId).queueDispatchesAwaitingEcho = 0;

      // Use UPDATE_CHAT_INPUT event with mode="replace"
      window.dispatchEvent(
        createCustomEvent(CUSTOM_EVENTS.UPDATE_CHAT_INPUT, {
          text: data.text,
          mode: "replace",
          fileParts: data.fileParts,
          reviews: data.reviews,
          // Restore events can arrive for a background workspace; never let them
          // overwrite the composer currently mounted for another workspace.
          workspaceId: data.workspaceId,
        })
      );
    },
  };

  // Cache of last known recency per workspace (for change detection)
  private recencyCache = new Map<string, number | null>();

  // Store workspace metadata for aggregator creation (ensures createdAt never lost)
  private workspaceCreatedAt = new Map<string, string>();

  // Track model usage (optional integration point for model bookkeeping)
  private readonly onModelUsed?: (model: string) => void;

  constructor(onModelUsed?: (model: string) => void) {
    this.onModelUsed = onModelUsed;

    // Initialize consumer calculation manager
    this.consumerManager = new WorkspaceConsumerManager(
      (workspaceId) => {
        this.consumersStore.bump(workspaceId);
      },
      () => this.providersConfigFingerprint
    );

    // Note: We DON'T auto-check recency on every state bump.
    // Instead, checkAndBumpRecencyIfChanged() is called explicitly after
    // message completion events (not on deltas) to prevent App.tsx re-renders.
  }

  private resolveMetadataModel(model: string): string {
    return resolveModelForMetadata(model, this.providersConfig);
  }

  private bumpAllUsageStoreEntries(): void {
    for (const workspaceId of this.aggregators.keys()) {
      this.usageStore.bump(workspaceId);
    }
  }

  /**
   * Fetch persisted session usage from backend and update in-memory cache.
   * Uses a per-workspace request version guard so slower/older responses
   * cannot overwrite fresher state (e.g. rapid workspace switches).
   */
  private refreshSessionUsage(workspaceId: string): void {
    const client = this.client;
    if (!client || !this.isWorkspaceRegistered(workspaceId)) {
      return;
    }

    const requestVersion = (this.sessionUsageRequestVersion.get(workspaceId) ?? 0) + 1;
    this.sessionUsageRequestVersion.set(workspaceId, requestVersion);

    client.workspace
      .getSessionUsage({ workspaceId })
      .then((data) => {
        // Stale-response guard: a newer refresh was issued while this one was
        // in-flight. The newer request owns the "known" flip too — flipping it
        // here would let the chat view reveal before the latest usage landed,
        // re-opening the post-reveal pop-in this barrier exists to prevent.
        if ((this.sessionUsageRequestVersion.get(workspaceId) ?? 0) !== requestVersion) {
          return;
        }
        // Workspace may have been removed while the fetch was in-flight.
        if (!this.isWorkspaceRegistered(workspaceId)) {
          return;
        }
        // The latest settled fetch makes the usage "known" (including a null
        // response = known-empty) — the chat view's first-paint barrier
        // distinguishes that from not-yet-loaded so usage-derived banners
        // can't pop in after reveal.
        this.markSessionUsageKnown(workspaceId);
        if (!data) {
          return;
        }

        if (
          this.providersConfig &&
          this.providersConfigFingerprint != null &&
          data.tokenStatsCache?.providersConfigVersion !== this.providersConfigFingerprint
        ) {
          repriceSessionUsage(data, this.providersConfig, this.providersConfigFingerprint);
        }

        this.sessionUsage.set(workspaceId, data);
        this.usageStore.bump(workspaceId);
      })
      .catch((error) => {
        console.warn(`Failed to fetch session usage for ${workspaceId}:`, error);
        // Self-heal: a failed LATEST fetch must not hold the first-paint
        // barrier. Stale failures defer to the newer in-flight request, same
        // as the success path above.
        if ((this.sessionUsageRequestVersion.get(workspaceId) ?? 0) === requestVersion) {
          this.markSessionUsageKnown(workspaceId);
        }
      });
  }

  private async refreshProvidersConfig(client: RouterClient<AppRouter>): Promise<void> {
    // Version counter prevents an older, slower response from overwriting a newer one.
    // We bump eagerly so concurrent requests each get unique versions, then only apply
    // if no newer response has already been written (version >= lastApplied).
    const version = ++this.providersConfigVersion;
    try {
      const config = await client.providers.getConfig();
      if (
        this.client !== client ||
        this.clientChangeController.signal.aborted ||
        version < this.providersConfigAppliedVersion
      ) {
        return;
      }

      const previousFingerprint = this.providersConfigFingerprint;
      const nextFingerprint = computeProvidersConfigFingerprint(config);

      this.providersConfigAppliedVersion = version;
      this.providersConfigFailureStreak = 0;
      this.providersConfig = config;
      this.providersConfigFingerprint = nextFingerprint;

      if (previousFingerprint !== nextFingerprint) {
        // Invalidate consumer token stats — both in-memory and persisted —
        // so mapped-model changes take effect on next access.
        this.consumerManager.invalidateAll();

        for (const [, usage] of this.sessionUsage) {
          repriceSessionUsage(usage, config, nextFingerprint);
        }
      }

      // Bump usage-store subscribers AFTER repricing so observers see
      // updated cost totals. Must happen on every successful apply (not
      // just fingerprint changes) to unblock initial hydration.
      this.bumpAllUsageStoreEntries();
    } catch {
      // Existing providersConfig is preserved so metadata resolution
      // continues using the last successful snapshot. Retry with
      // exponential backoff to recover from transient errors — both
      // at startup (fingerprint still null, tokenization blocked) and
      // after onConfigChanged notifications where the fetch failed.
      if (this.client === client && !this.clientChangeController.signal.aborted) {
        this.providersConfigFailureStreak++;
        const retryDelay = Math.min(1000 * 2 ** (this.providersConfigFailureStreak - 1), 30_000);
        setTimeout(() => {
          if (this.client === client && !this.clientChangeController.signal.aborted) {
            void this.refreshProvidersConfig(client);
          }
        }, retryDelay);
      }
    }
  }

  private clearProviderConfigFixableAutoRetryStatuses(): void {
    // Provider notifications are not provider-scoped. Clear every fixable banner rather than
    // guessing which chat changed, but never resume a stream here (PR #2317 was rejected).
    for (const [workspaceId, transient] of this.chatTransientState) {
      const status = transient.autoRetryStatus;
      if (status?.type !== "auto-retry-abandoned" || !isProviderConfigFixableError(status.reason)) {
        continue;
      }

      transient.autoRetryStatus = null;
      this.states.bump(workspaceId);
    }
  }

  private subscribeToProvidersConfig(client: RouterClient<AppRouter>): void {
    const { signal } = this.clientChangeController;

    (async () => {
      // Some oRPC iterators don't eagerly close on abort alone.
      // Ensure we `return()` them so backend subscriptions clean up EventEmitter listeners.
      let iterator: AsyncIterator<unknown> | null = null;

      try {
        const subscribedIterator = await client.providers.onConfigChanged(undefined, { signal });

        if (signal.aborted || this.client !== client) {
          void subscribedIterator.return?.();
          return;
        }

        iterator = subscribedIterator;

        for await (const _ of subscribedIterator) {
          if (signal.aborted || this.client !== client) {
            break;
          }

          this.providersConfigFailureStreak = 0;
          this.clearProviderConfigFixableAutoRetryStatuses();
          void this.refreshProvidersConfig(client);
        }
      } catch {
        // Subscription stream failed — fall through to retry below.
      } finally {
        void iterator?.return?.();
      }

      // Stream ended or errored. Re-subscribe after a delay unless the
      // client changed or the controller was aborted (intentional teardown).
      if (!signal.aborted && this.client === client) {
        this.providersConfigFailureStreak++;
        const resubDelay = Math.min(1000 * 2 ** (this.providersConfigFailureStreak - 1), 30_000);
        setTimeout(() => {
          if (!signal.aborted && this.client === client) {
            this.subscribeToProvidersConfig(client);
          }
        }, resubDelay);
      }
    })();
  }

  setClient(client: RouterClient<AppRouter> | null): void {
    if (this.client === client) {
      return;
    }

    // Drop stats subscriptions before swapping clients so reconnects resubscribe cleanly.
    for (const unsubscribe of this.statsUnsubscribers.values()) {
      unsubscribe();
    }
    this.statsUnsubscribers.clear();
    for (const unsubscribe of this.timelineUnsubscribers.values()) {
      unsubscribe();
    }
    this.timelineUnsubscribers.clear();

    this.client = client;
    this.clientChangeController.abort();
    this.clientChangeController = new AbortController();

    this.bumpAllUsageStoreEntries();

    for (const workspaceId of this.workspaceMetadata.keys()) {
      this.pendingReplayReset.add(workspaceId);
    }

    if (client) {
      this.ensureActivitySubscription();
      this.ensureTerminalActivitySubscription();
    }

    if (!client) {
      return;
    }

    // Re-subscribe any workspaces that already have UI consumers.
    for (const workspaceId of this.statsListenerCounts.keys()) {
      this.subscribeToStats(workspaceId);
    }
    for (const workspaceId of this.timelineListenerCounts.keys()) {
      this.subscribeToTimeline(workspaceId);
    }

    this.ensureActiveOnChatSubscription();
    void this.refreshProvidersConfig(client);
    this.subscribeToProvidersConfig(client);
  }

  setActiveWorkspaceId(workspaceId: string | null): void {
    assert(
      workspaceId === null || (typeof workspaceId === "string" && workspaceId.length > 0),
      "setActiveWorkspaceId requires a non-empty workspaceId or null"
    );

    if (this.activeWorkspaceId === workspaceId) {
      return;
    }

    const previousActiveId = this.activeWorkspaceId;
    this.activeWorkspaceId = workspaceId;
    this.ensureActiveOnChatSubscription();

    // Re-hydrate persisted session usage so cost totals reflect any
    // session-usage-delta events that arrived while this workspace was inactive.
    if (workspaceId) {
      this.refreshSessionUsage(workspaceId);
    }

    // Invalidate cached workspace state for both the old and new active
    // workspaces. getWorkspaceState() uses activeOnChatWorkspaceId to decide
    // whether to trust aggregator data or activity snapshots, so a switch
    // requires recomputation even if no new events arrived.
    if (previousActiveId) {
      this.states.bump(previousActiveId);
    }
    if (workspaceId) {
      this.states.bump(workspaceId);
    }
  }

  isOnChatSubscriptionActive(workspaceId: string): boolean {
    assert(
      typeof workspaceId === "string" && workspaceId.length > 0,
      "isOnChatSubscriptionActive requires a non-empty workspaceId"
    );

    return this.activeOnChatWorkspaceId === workspaceId;
  }

  private ensureActivitySubscription(): void {
    if (this.activityAbortController) {
      return;
    }

    const controller = new AbortController();
    this.activityAbortController = controller;
    void this.runActivitySubscription(controller.signal);
  }

  private ensureTerminalActivitySubscription(): void {
    if (this.terminalActivityAbortController) {
      return;
    }

    const controller = new AbortController();
    this.terminalActivityAbortController = controller;
    void this.runTerminalActivitySubscription(controller);
  }

  private releaseTerminalActivityController(controller: AbortController): void {
    if (this.terminalActivityAbortController === controller) {
      this.terminalActivityAbortController = null;
    }
  }

  private assertSingleActiveOnChatSubscription(): void {
    assert(
      this.ipcUnsubscribers.size <= 1,
      `[WorkspaceStore] Expected at most one active onChat subscription, found ${this.ipcUnsubscribers.size}`
    );

    if (this.activeOnChatWorkspaceId === null) {
      assert(
        this.ipcUnsubscribers.size === 0,
        "[WorkspaceStore] onChat unsubscribe map must be empty when no active workspace is subscribed"
      );
      return;
    }

    assert(
      this.ipcUnsubscribers.has(this.activeOnChatWorkspaceId),
      `[WorkspaceStore] Missing onChat unsubscribe handler for ${this.activeOnChatWorkspaceId}`
    );
  }

  private clearReplayBuffers(workspaceId: string): void {
    const transient = this.chatTransientState.get(workspaceId);
    if (!transient) {
      return;
    }

    // Replay buffers are only valid for the in-flight subscription attempt that
    // populated them. Clear eagerly when deactivating/retrying so stale buffered
    // events cannot leak into a later caught-up cycle.
    transient.caughtUp = false;
    transient.replayingHistory = false;
    transient.historicalMessages.length = 0;
    transient.pendingStreamEvents.length = 0;
    this.lastUserPromptStore.bump(workspaceId);
  }

  private ensureActiveOnChatSubscription(): void {
    const targetWorkspaceId =
      this.activeWorkspaceId && this.isWorkspaceRegistered(this.activeWorkspaceId)
        ? this.activeWorkspaceId
        : null;

    if (this.activeOnChatWorkspaceId === targetWorkspaceId) {
      this.assertSingleActiveOnChatSubscription();
      return;
    }

    if (this.activeOnChatWorkspaceId) {
      const previousActiveWorkspaceId = this.activeOnChatWorkspaceId;
      const previousTransient = this.chatTransientState.get(previousActiveWorkspaceId);
      if (previousTransient) {
        previousTransient.isHydratingTranscript = false;
      }

      // Clear replay buffers before aborting so a fast workspace switch/reopen
      // cannot replay stale buffered rows from the previous subscription attempt.
      this.clearReplayBuffers(previousActiveWorkspaceId);

      const unsubscribe = this.ipcUnsubscribers.get(previousActiveWorkspaceId);
      if (unsubscribe) {
        unsubscribe();
      }
      this.ipcUnsubscribers.delete(previousActiveWorkspaceId);
      this.activeOnChatWorkspaceId = null;
    }

    if (targetWorkspaceId) {
      const transient = this.chatTransientState.get(targetWorkspaceId);
      if (transient) {
        transient.caughtUp = false;
        // Only show transcript hydration once we can actually establish onChat.
        // When the ORPC client is unavailable, avoid pinning the pane in loading.
        transient.isHydratingTranscript = this.client !== null;
      }

      const controller = new AbortController();
      this.ipcUnsubscribers.set(targetWorkspaceId, () => controller.abort());
      this.activeOnChatWorkspaceId = targetWorkspaceId;
      void this.runOnChatSubscription(targetWorkspaceId, controller.signal);
    }

    this.assertSingleActiveOnChatSubscription();
  }

  /**
   * Set the callback for navigating to a workspace (used for notification clicks)
   */
  setNavigateToWorkspace(callback: (workspaceId: string) => void): void {
    this.navigateToWorkspaceCallback = callback;
    // Update existing aggregators with the callback
    for (const aggregator of this.aggregators.values()) {
      aggregator.onNavigateToWorkspace = callback;
    }
  }

  navigateToWorkspace(workspaceId: string): void {
    this.navigateToWorkspaceCallback?.(workspaceId);
  }

  /**
   * Set the callback for when a response completes (used for "notify on response" feature).
   */
  setOnResponseComplete(callback: ResponseCompleteHandler): void {
    this.responseCompleteCallback = callback;
  }

  private emitResponseComplete(event: ResponseCompleteEvent): void {
    this.responseCompleteCallback?.(event);
  }

  private readonly forwardResponseComplete = (event: ResponseCompleteEvent): void => {
    this.emitResponseComplete(event);
  };

  /**
   * Schedule a state bump during browser idle time.
   * Instead of updating UI on every delta, wait until the browser has spare capacity.
   * This adapts to actual CPU availability - fast machines update more frequently,
   * slow machines naturally throttle without dropping data.
   *
   * Data is always updated immediately in the aggregator - only UI notification is deferred.
   *
   * NOTE: This is the "ingestion clock" half of the two-clock streaming model.
   * The "presentation clock" (useSmoothStreamingText) handles visual cadence
   * independently — do not collapse them into a single mechanism.
   */
  private scheduleIdleStateBump(workspaceId: string): void {
    // Skip if already scheduled
    if (this.deltaIdleHandles.has(workspaceId)) {
      return;
    }

    // requestIdleCallback is not available in some environments (e.g. Node-based unit tests).
    // Fall back to a regular timeout so we still throttle bumps.
    if (typeof requestIdleCallback !== "function") {
      const handle = setTimeout(() => {
        this.deltaIdleHandles.delete(workspaceId);
        this.states.bump(workspaceId);
      }, 0);

      // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
      this.deltaIdleHandles.set(workspaceId, handle as unknown as number);
      return;
    }

    const handle = requestIdleCallback(
      () => {
        this.deltaIdleHandles.delete(workspaceId);
        this.states.bump(workspaceId);
      },
      { timeout: 100 } // Force update within 100ms even if browser stays busy
    );

    this.deltaIdleHandles.set(workspaceId, handle);
  }

  private releaseStreamingMessageChannel(workspaceId: string): void {
    const key = this.streamingMessageKeys.get(workspaceId);
    if (key === undefined) return;
    this.streamingMessageKeys.delete(workspaceId);
    this.streamingMessageStore.delete(key);
  }

  /**
   * Deltas normally extend the active message's last part in place and only
   * need the row-local bump. A delta that adds a part creates a new display
   * row with no mounted subscriber yet, so only a workspace bump can mount it.
   */
  private applyStreamingDelta(
    workspaceId: string,
    aggregator: StreamingMessageAggregator,
    data: StreamDeltaEvent | ToolCallDeltaEvent | ReasoningDeltaEvent
  ): void {
    // Route by the delta's own message ID: a second stream can start before the
    // previous stream context is removed, and the "first active entry" would
    // then attribute this delta's part-count change to the wrong message.
    const messageId = data.messageId;
    const partsBefore = aggregator.getMessagePartCount(messageId);
    applyWorkspaceChatEventToAggregator(aggregator, data);
    if (aggregator.getMessagePartCount(messageId) !== partsBefore) {
      this.states.bump(workspaceId);
      this.streamingStatsStore.bump(workspaceId);
    } else {
      this.scheduleStreamingMessageBump(workspaceId, aggregator, messageId);
    }
  }

  private scheduleStreamingMessageBump(
    workspaceId: string,
    aggregator: StreamingMessageAggregator,
    messageId: string
  ): void {
    const pendingId = this.pendingStreamingMessageBump.get(workspaceId);
    if (pendingId === messageId) return;
    if (pendingId !== undefined) {
      // Deltas from two concurrent streams are interleaved in this pump. The
      // per-row channel tracks one row, so refresh the whole workspace rather
      // than waking only the other stream's row.
      this.states.bump(workspaceId);
      this.streamingStatsStore.bump(workspaceId);
      return;
    }
    this.pendingStreamingMessageBump.set(workspaceId, messageId);
    queueMicrotask(() => {
      if (this.pendingStreamingMessageBump.get(workspaceId) !== messageId) return;
      this.pendingStreamingMessageBump.delete(workspaceId);
      // Deltas extend the active message's trailing displayed row; keying the
      // bump by that row wakes one subscriber instead of every row of the
      // message. The list is freshly cached here, so leaf reads hit the cache.
      const rows = aggregator.getDisplayedMessages();
      let rowId: string | undefined;
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        if ("historyId" in row && row.historyId === messageId) {
          rowId = row.id;
          break;
        }
      }
      if (rowId === undefined) return;
      const key = getStreamingMessageKey(workspaceId, rowId);
      const previousKey = this.streamingMessageKeys.get(workspaceId);
      if (previousKey !== undefined && previousKey !== key) {
        this.streamingMessageStore.delete(previousKey);
      }
      this.streamingMessageKeys.set(workspaceId, key);
      this.streamingMessageStore.bump(key);
      this.streamingStatsStore.bump(workspaceId);
    });
  }

  private cancelPendingStreamingBump(workspaceId: string): void {
    this.pendingStreamingMessageBump.delete(workspaceId);
  }

  getStreamingMessage(
    workspaceId: string,
    displayedId: string,
    messageId: string
  ): DisplayedMessage | null {
    const aggregator = this.aggregators.get(workspaceId);
    // Completed rows may be transformed by the transcript (e.g. merged stream
    // errors); only an actively streaming message overrides its prop row. Check
    // membership rather than the first active entry so a second concurrent
    // stream's rows keep receiving live overrides.
    if (!aggregator?.isStreamActive(messageId)) return null;
    return aggregator.getDisplayedMessages().find((message) => message.id === displayedId) ?? null;
  }

  subscribeStreamingMessage(
    workspaceId: string,
    displayedId: string,
    listener: () => void
  ): () => void {
    return this.streamingMessageStore.subscribeKey(
      getStreamingMessageKey(workspaceId, displayedId),
      listener
    );
  }

  /**
   * Get current live streaming stats for a workspace, or null if no stream is active.
   *
   * Cached per MapStore version: changes only when {@link streamingStatsStore} is
   * bumped (stream-start + every coalesced delta + every terminal stream event).
   * Reading uses Date.now() at the bump point, so the trailing-window TPS is
   * always current relative to the latest delta.
   */
  getWorkspaceStreamingStats(workspaceId: string): WorkspaceStreamingStats | null {
    return this.streamingStatsStore.get(workspaceId, () => {
      const aggregator = this.aggregators.get(workspaceId);
      if (!aggregator) return null;
      const messageId = aggregator.getActiveStreamMessageId();
      if (!messageId) return null;
      const tokenCount = aggregator.getStreamingTokenCount(messageId);
      const tps = aggregator.getStreamingTPS(messageId);
      // Approximate chars-per-token of 4 — good enough for the smoothing engine
      // to target the model's emit rate; exact tokenization isn't needed.
      const charsPerSec = tps * APPROX_CHARS_PER_TOKEN;
      return { tokenCount, tps, charsPerSec };
    });
  }

  getWorkspaceRoundedStreamingTps(workspaceId: string): number | null {
    const stats = this.getWorkspaceStreamingStats(workspaceId);
    return stats != null && stats.tps > 0 ? Math.round(stats.tps) : null;
  }

  subscribeStreamingStats(workspaceId: string, listener: () => void): () => void {
    return this.streamingStatsStore.subscribeKey(workspaceId, listener);
  }

  /**
   * Subscribe to backend timing stats snapshots for a workspace.
   */

  private subscribeToStats(workspaceId: string): void {
    if (!this.client) {
      return;
    }

    // Only subscribe for registered workspaces when we have at least one UI consumer.
    if (!this.isWorkspaceRegistered(workspaceId)) {
      return;
    }
    if ((this.statsListenerCounts.get(workspaceId) ?? 0) <= 0) {
      return;
    }

    // Skip if already subscribed
    if (this.statsUnsubscribers.has(workspaceId)) {
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;
    let iterator: AsyncIterator<WorkspaceStatsSnapshot> | null = null;

    (async () => {
      try {
        const subscribedIterator = await this.client!.workspace.stats.subscribe(
          { workspaceId },
          { signal }
        );
        iterator = subscribedIterator;

        for await (const snapshot of subscribedIterator) {
          if (signal.aborted) break;
          queueMicrotask(() => {
            if (signal.aborted) {
              return;
            }
            this.workspaceStats.set(workspaceId, snapshot);
            this.statsStore.bump(workspaceId);
          });
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        console.warn(`[WorkspaceStore] Error in stats subscription for ${workspaceId}:`, error);
      }
    })();

    this.statsUnsubscribers.set(workspaceId, () => {
      controller.abort();
      void iterator?.return?.();
    });
  }

  private subscribeToTimeline(workspaceId: string): void {
    const client = this.client;
    if (
      !client ||
      !this.isWorkspaceRegistered(workspaceId) ||
      (this.timelineListenerCounts.get(workspaceId) ?? 0) <= 0 ||
      this.timelineUnsubscribers.has(workspaceId)
    ) {
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;
    let iterator: AsyncIterator<TimelineSubscriptionEvent> | null = null;

    (async () => {
      try {
        const subscribedIterator = await client.workspace.timeline.subscribe(
          { workspaceId },
          { signal }
        );
        iterator = subscribedIterator;
        if (signal.aborted) {
          await subscribedIterator.return?.();
          return;
        }

        for await (const update of subscribedIterator) {
          if (signal.aborted) break;
          queueMicrotask(() => {
            if (signal.aborted) return;

            // The snapshot is the initial page: it establishes pagination, and an empty one still
            // has to mark the timeline initialized so the panel can render its empty state.
            if (update.type === "snapshot") {
              this.workspaceTimelines.set(workspaceId, {
                events: update.events,
                nextCursor: update.nextCursor,
                hasOlder: update.hasOlder,
                initialized: true,
                loadingOlder: false,
                loadError: null,
                loadErrorKind: null,
              });
              this.timelineStore.bump(workspaceId);
              return;
            }

            if (update.events.length === 0) return;
            const current = this.workspaceTimelines.get(workspaceId) ?? EMPTY_TIMELINE_SNAPSHOT;
            const events = mergeTimelineEvents(update.events, current.events);
            this.workspaceTimelines.set(workspaceId, { ...current, events, initialized: true });
            this.timelineStore.bump(workspaceId);
          });
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        console.warn(`[WorkspaceStore] Error in timeline subscription for ${workspaceId}:`, error);
        this.workspaceTimelines.set(workspaceId, {
          ...(this.workspaceTimelines.get(workspaceId) ?? EMPTY_TIMELINE_SNAPSHOT),
          initialized: true,
          loadError: error instanceof Error ? error.message : "Failed to load timeline",
          loadErrorKind: "subscription",
        });
        this.timelineStore.bump(workspaceId);
      }
    })();

    this.timelineUnsubscribers.set(workspaceId, () => {
      controller.abort();
      void iterator?.return?.();
    });
  }

  /**
   * Cancel any pending idle state bump for a workspace.
   * Used when immediate state visibility is needed (e.g., stream-end).
   * Just cancels the callback - the caller will bump() immediately after.
   */
  private cancelPendingIdleBump(workspaceId: string): void {
    const handle = this.deltaIdleHandles.get(workspaceId);
    if (handle) {
      if (typeof cancelIdleCallback === "function") {
        cancelIdleCallback(handle);
      } else {
        // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
        clearTimeout(handle as unknown as number);
      }
      this.deltaIdleHandles.delete(workspaceId);
    }
  }

  /**
   * Track stream completion telemetry
   */
  private trackStreamCompletedTelemetry(
    data: {
      metadata: {
        model: string;
        usage?: { outputTokens?: number };
        duration?: number;
      };
    },
    wasInterrupted: boolean
  ): void {
    const { metadata } = data;
    const durationSecs = metadata.duration ? metadata.duration / 1000 : 0;
    const outputTokens = metadata.usage?.outputTokens ?? 0;

    // trackStreamCompleted handles rounding internally
    trackStreamCompleted(metadata.model, wasInterrupted, durationSecs, outputTokens);
  }

  /**
   * Check if any workspace's recency changed and bump global recency if so.
   * Uses cached recency values from aggregators for O(1) comparison per workspace.
   */
  private checkAndBumpRecencyIfChanged(): void {
    let recencyChanged = false;

    for (const workspaceId of this.aggregators.keys()) {
      const aggregator = this.aggregators.get(workspaceId)!;
      const currentRecency = aggregator.getRecencyTimestamp();
      const cachedRecency = this.recencyCache.get(workspaceId);

      if (currentRecency !== cachedRecency) {
        this.recencyCache.set(workspaceId, currentRecency);
        recencyChanged = true;
      }
    }

    if (recencyChanged) {
      this.derived.bump("recency");
    }
  }

  private cleanupStaleLiveToolState(
    workspaceId: string,
    aggregator: StreamingMessageAggregator
  ): void {
    const transient = this.chatTransientState.get(workspaceId);
    if (!transient) return;
    if (
      transient.liveBashOutput.size === 0 &&
      transient.liveAdvisorOutput.size === 0 &&
      transient.liveAdvisorReasoning.size === 0 &&
      transient.liveWorkflowRuns.size === 0
    ) {
      return;
    }

    const activeBashToolCallIds = new Set<string>();
    const activeAdvisorToolCallIds = new Set<string>();
    const activeWorkflowToolCallIds = new Set<string>();
    const collectToolCallId = (toolName: string, toolCallId: string) => {
      if (toolName === "bash") {
        activeBashToolCallIds.add(toolCallId);
      }
      if (toolName === "advisor") {
        activeAdvisorToolCallIds.add(toolCallId);
      }
      if (isWorkflowRunEmittingToolName(toolName)) {
        activeWorkflowToolCallIds.add(toolCallId);
      }
    };
    for (const msg of aggregator.getDisplayedMessages()) {
      if (msg.type !== "tool") continue;

      collectToolCallId(msg.toolName, msg.toolCallId);
      // Kernel-nested calls (code_execution) render inside the parent card but
      // key their live state by their own nested ids; without collecting them
      // the sweep would prune a nested workflow/bash card's live state mid-run.
      for (const nested of msg.nestedCalls ?? []) {
        collectToolCallId(nested.toolName, nested.toolCallId);
      }
    }

    for (const toolCallId of Array.from(transient.liveBashOutput.keys())) {
      if (!activeBashToolCallIds.has(toolCallId)) {
        transient.liveBashOutput.delete(toolCallId);
      }
    }

    for (const toolCallId of Array.from(transient.liveAdvisorReasoning.keys())) {
      if (!activeAdvisorToolCallIds.has(toolCallId)) {
        transient.liveAdvisorReasoning.delete(toolCallId);
        this.advisorLiveStore.delete(getAdvisorLiveKey(workspaceId, toolCallId));
      }
    }

    for (const toolCallId of Array.from(transient.liveAdvisorOutput.keys())) {
      if (!activeAdvisorToolCallIds.has(toolCallId)) {
        transient.liveAdvisorOutput.delete(toolCallId);
        // Release the keyed channel version too; once the transient entry is
        // gone, the workspace-removal sweep can no longer discover this key.
        this.advisorLiveStore.delete(getAdvisorLiveKey(workspaceId, toolCallId));
      }
    }

    for (const toolCallId of Array.from(transient.liveWorkflowRuns.keys())) {
      if (!activeWorkflowToolCallIds.has(toolCallId)) {
        transient.liveWorkflowRuns.delete(toolCallId);
      }
    }
  }

  /**
   * Subscribe to store changes (any workspace).
   * Delegates to MapStore's subscribeAny.
   */
  subscribe = this.states.subscribeAny;

  /**
   * Subscribe to derived state changes (recency, etc.).
   * Use for hooks that depend on derived.bump() rather than states.bump().
   */
  subscribeDerived = this.derived.subscribeAny;

  /**
   * Subscribe to changes for a specific workspace.
   * Only notified when this workspace's state changes.
   */
  subscribeKey = (workspaceId: string, listener: () => void) => {
    return this.states.subscribeKey(workspaceId, listener);
  };

  subscribeAdvisorLive(workspaceId: string, toolCallId: string, listener: () => void): () => void {
    return this.advisorLiveStore.subscribeKey(getAdvisorLiveKey(workspaceId, toolCallId), listener);
  }

  getBashToolLiveOutput(workspaceId: string, toolCallId: string): LiveBashOutputView | null {
    const state = this.chatTransientState.get(workspaceId)?.liveBashOutput.get(toolCallId);

    // Important: return the stored object reference so useSyncExternalStore sees a stable snapshot.
    // (Returning a fresh object every call can trigger an infinite re-render loop.)
    return state ?? null;
  }

  getAdvisorToolLiveOutput(workspaceId: string, toolCallId: string): AdvisorLiveOutputState | null {
    const state = this.chatTransientState.get(workspaceId)?.liveAdvisorOutput.get(toolCallId);

    return state ?? null;
  }

  getAdvisorToolLiveReasoning(
    workspaceId: string,
    toolCallId: string
  ): AdvisorLiveReasoningState | null {
    const state = this.chatTransientState.get(workspaceId)?.liveAdvisorReasoning.get(toolCallId);

    return state ?? null;
  }

  getAdvisorToolLivePhase(
    workspaceId: string,
    toolCallId: string
  ): AdvisorLivePhaseState | undefined {
    return this.chatTransientState.get(workspaceId)?.liveAdvisorPhase.get(toolCallId);
  }

  getTaskToolLiveTaskIds(workspaceId: string, toolCallId: string): string[] | null {
    const taskIds = this.chatTransientState.get(workspaceId)?.liveTaskIds.get(toolCallId);
    return taskIds ?? null;
  }

  /**
   * Assert that workspace exists and return its aggregator.
   * Centralized assertion for all workspace access methods.
   */
  private assertGet(workspaceId: string): StreamingMessageAggregator {
    const aggregator = this.aggregators.get(workspaceId);
    assert(aggregator, `Workspace ${workspaceId} not found - must call addWorkspace() first`);
    return aggregator;
  }

  private assertChatTransientState(workspaceId: string): WorkspaceChatTransientState {
    const state = this.chatTransientState.get(workspaceId);
    assert(state, `Workspace ${workspaceId} not found - must call addWorkspace() first`);
    return state;
  }

  private deriveHistoryPaginationState(
    aggregator: StreamingMessageAggregator,
    hasOlderOverride?: boolean
  ): WorkspaceHistoryPaginationState {
    for (const message of aggregator.getAllMessages()) {
      const historySequence = message.metadata?.historySequence;
      if (
        typeof historySequence !== "number" ||
        !Number.isInteger(historySequence) ||
        historySequence < 0
      ) {
        continue;
      }

      // The server's caught-up payload is authoritative for full replays because
      // display-only messages can skip early historySequence rows. When legacy
      // payloads omit hasOlderHistory, only infer older pages when the oldest
      // loaded message is a durable compaction boundary marker (a concrete signal
      // that this replay started mid-history), not merely historySequence > 0.
      const hasOlder =
        hasOlderOverride ?? (historySequence > 0 && isDurableCompactionBoundaryMarker(message));
      return {
        nextCursor: hasOlder
          ? {
              beforeHistorySequence: historySequence,
              beforeMessageId: message.id,
            }
          : null,
        hasOlder,
        loading: false,
      };
    }

    if (hasOlderOverride !== undefined) {
      return {
        nextCursor: null,
        hasOlder: hasOlderOverride,
        loading: false,
      };
    }

    return createInitialHistoryPaginationState();
  }

  /**
   * Get state for a specific workspace.
   * Lazy computation - only runs when version changes.
   *
   * REQUIRES: Workspace must have been added via addWorkspace() first.
   */
  getWorkspaceState(workspaceId: string): WorkspaceState {
    return this.states.get(workspaceId, () => {
      const aggregator = this.assertGet(workspaceId);

      const hasMessages = aggregator.hasMessages();
      const displayedMessages = aggregator.getDisplayedMessages();
      const hasRunningInitMessage = displayedMessages.some(
        (message) => message.type === "workspace-init" && message.status === "running"
      );
      const transient = this.assertChatTransientState(workspaceId);
      const historyPagination =
        this.historyPagination.get(workspaceId) ?? createInitialHistoryPaginationState();
      const hasInterruptibleActiveStream = aggregator.hasInterruptibleActiveStream();
      const activity = this.workspaceActivity.get(workspaceId);
      const isActiveWorkspace = this.activeOnChatWorkspaceId === workspaceId;
      const messages = aggregator.getAllMessages();
      const metadata = this.workspaceMetadata.get(workspaceId);
      const pendingStreamStartTime = aggregator.getPendingStreamStartTime();
      const streamLifecycle = aggregator.getStreamLifecycle();
      const bufferedActiveStreamStart =
        isActiveWorkspace && !transient.caughtUp
          ? getBufferedActiveStreamStart(transient.pendingStreamEvents)
          : null;
      // Trust the live aggregator only when it is both active AND has finished
      // replaying historical events (caughtUp). During the replay window after a
      // workspace switch, the aggregator is cleared and re-hydrating; fall back to
      // the activity snapshot so the UI continues to reflect the last known state.
      //
      // Replayed stream-start events arrive on onChat before the authoritative caught-up marker.
      // Surface that buffered active-stream context immediately so the transcript tail can show the
      // live streaming barrier during hydration instead of inserting it a moment later.
      //
      // For non-active workspaces, the aggregator's activeStreams may be stale since
      // they don't receive stream-end events when unsubscribed from onChat. Prefer the
      // activity snapshot's streaming state, which is updated via the lightweight activity
      // subscription for all workspaces.
      const useAggregatorState = isActiveWorkspace && transient.caughtUp;
      const canInterrupt = useAggregatorState
        ? hasInterruptibleActiveStream
        : bufferedActiveStreamStart !== null
          ? true
          : (activity?.streaming ?? hasInterruptibleActiveStream);
      const currentModel = useAggregatorState
        ? (aggregator.getCurrentModel() ?? null)
        : (bufferedActiveStreamStart?.model ??
          activity?.lastModel ??
          aggregator.getCurrentModel() ??
          null);
      const currentThinkingLevel = useAggregatorState
        ? (aggregator.getCurrentThinkingLevel() ?? null)
        : (bufferedActiveStreamStart?.thinkingLevel ??
          activity?.lastThinkingLevel ??
          aggregator.getCurrentThinkingLevel() ??
          null);
      const activePendingStreamStartTime = isActiveWorkspace ? pendingStreamStartTime : null;
      const aggregatorRecency = aggregator.getRecencyTimestamp();
      const recencyTimestamp =
        aggregatorRecency === null
          ? (activity?.recency ?? null)
          : Math.max(aggregatorRecency, activity?.recency ?? aggregatorRecency);
      // Keep the startup barrier mounted until stream-start makes the turn interruptible;
      // stream-lifecycle can report "streaming" slightly earlier.
      const isStreamStarting =
        isActiveWorkspace &&
        !canInterrupt &&
        (streamLifecycle?.phase === "preparing" || activePendingStreamStartTime !== null);
      // Only actively running init output should bypass transcript hydration. Completed init
      // rows are still replayed, but they should not suppress the normal catch-up placeholder
      // for stale cached transcript content on reconnect.
      const isHydratingTranscript =
        isActiveWorkspace &&
        transient.isHydratingTranscript &&
        !transient.caughtUp &&
        !hasRunningInitMessage;
      const aggregatorTodos = aggregator.getCurrentTodos();
      // Sidebar status precedence, split into four tiers so each signal
      // wins exactly when it should. Active and inactive workspaces draw
      // from different sources but resolve through the same priority.
      //
      //   1. displayStatus (inactive only): system-driven transient status
      //      from disk, e.g. "Compacting idle workspace…". Always wins.
      //   2. liveTodoStatus (active only): the agent's most recent
      //      `todo_write`, processed synchronously by the aggregator.
      //      Beats the aggregator's persisted status_set value because
      //      todo_write is the freshest explicit signal; beats persisted
      //      todoStatus because the live aggregator state is ahead of
      //      the async setTodoStatus + activity-emit round-trip.
      //   3. fallbackAgentStatus (active only): aggregator.getAgentStatus()
      //      — a blend of heartbeat / idle-compaction / background-turn
      //      `displayStatus` events (genuinely transient) and the agent's
      //      own `status_set` tool result (a pinned high-level intent).
      //      Wins over persisted todoStatus so an AI-generated summary
      //      doesn't mask an explicit system or agent-set message.
      //   4. persistedTodoStatus: activity.todoStatus from disk. Either
      //      a stale todo derivation or an AgentStatusService AI summary —
      //      both writers target the same slot, last write wins. The
      //      lowest tier so a newer in-memory signal always preempts.
      //      For inactive workspaces, `hasTodos === false` blocks the
      //      legacy aggregator-derive fallback so a freshly cleared todo
      //      list doesn't briefly resurrect the stale derivation.
      const displayStatus = useAggregatorState ? undefined : (activity?.displayStatus ?? undefined);
      const liveTodoStatus = useAggregatorState ? deriveTodoStatus(aggregatorTodos) : undefined;
      const fallbackAgentStatus = useAggregatorState ? aggregator.getAgentStatus() : undefined;
      const persistedTodoStatus = useAggregatorState
        ? (activity?.todoStatus ?? undefined)
        : (activity?.todoStatus ??
          (activity?.hasTodos === false ? undefined : deriveTodoStatus(aggregatorTodos)));
      const agentStatus =
        displayStatus ?? liveTodoStatus ?? fallbackAgentStatus ?? persistedTodoStatus;
      const activeWorkflowRunIds = activity?.activeWorkflowRunIds ?? EMPTY_ACTIVE_WORKFLOW_RUN_IDS;
      const activeWorkflowRunCount = activity?.activeWorkflowRunCount ?? 0;
      const activeBashMonitorCount = activity?.activeBashMonitorCount ?? 0;
      const goal = activity?.goal ?? null;

      return {
        name: metadata?.name ?? workspaceId, // Fall back to ID if metadata missing
        messages: displayedMessages,
        queuedMessage: transient.queuedMessage,
        pendingSend: transient.pendingSend?.message ?? null,
        canInterrupt,
        isCompacting: aggregator.isCompacting(),
        isStreamStarting,
        awaitingUserQuestion: aggregator.hasAwaitingUserQuestion(),
        loading: !hasMessages && !hasRunningInitMessage && !transient.caughtUp,
        isTranscriptCaughtUp: transient.caughtUp,
        isHydratingTranscript,
        hasOlderHistory: historyPagination.hasOlder,
        loadingOlderHistory: historyPagination.loading,
        muxMessages: messages,
        currentModel,
        currentThinkingLevel,
        recencyTimestamp,
        todos: aggregatorTodos,
        loadedSkills: aggregator.getLoadedSkills(),
        skillLoadErrors: aggregator.getSkillLoadErrors(),
        lastAbortReason: aggregator.getLastAbortReason(),
        agentStatus,
        activeWorkflowRunIds,
        activeWorkflowRunCount,
        activeBashMonitorCount,
        pendingStreamStartTime,
        pendingStreamModel: aggregator.getPendingStreamModel(),
        autoRetryStatus: transient.autoRetryStatus,
        runtimeStatus: aggregator.getRuntimeStatus(),
        goal,
      };
    });
  }

  getWorkspaceShellStatus(workspaceId: string): WorkspaceShellStatus {
    const aggregator = this.assertGet(workspaceId);
    const transient = this.assertChatTransientState(workspaceId);
    const hasMessages = aggregator.hasMessages();
    const isActiveWorkspace = this.activeOnChatWorkspaceId === workspaceId;

    // Keep this selector lighter than getWorkspaceState(): the shell only needs enough
    // state to decide placeholder vs mounted chat. Avoid rebuilding the full displayed
    // transcript on every streaming delta unless init/hydration placeholder behavior needs it.
    const hasRunningInitMessage =
      !hasMessages || (isActiveWorkspace && transient.isHydratingTranscript && !transient.caughtUp)
        ? aggregator
            .getDisplayedMessages()
            .some((message) => message.type === "workspace-init" && message.status === "running")
        : false;

    const activity = this.workspaceActivity.get(workspaceId);
    const hasInterruptibleActiveStream = aggregator.hasInterruptibleActiveStream();
    const pendingStreamStartTime = aggregator.getPendingStreamStartTime();
    const streamLifecycle = aggregator.getStreamLifecycle();
    const bufferedActiveStreamStart =
      isActiveWorkspace && !transient.caughtUp
        ? getBufferedActiveStreamStart(transient.pendingStreamEvents)
        : null;
    const useAggregatorState = isActiveWorkspace && transient.caughtUp;
    const canInterrupt = useAggregatorState
      ? hasInterruptibleActiveStream
      : bufferedActiveStreamStart !== null
        ? true
        : (activity?.streaming ?? hasInterruptibleActiveStream);
    const activePendingStreamStartTime = isActiveWorkspace ? pendingStreamStartTime : null;
    // Match getWorkspaceState so the shell does not flash between lifecycle and stream-start.
    const isStreamStarting =
      isActiveWorkspace &&
      !canInterrupt &&
      (streamLifecycle?.phase === "preparing" || activePendingStreamStartTime !== null);
    const isHydratingTranscript =
      isActiveWorkspace &&
      transient.isHydratingTranscript &&
      !transient.caughtUp &&
      !hasRunningInitMessage;
    const loading = !hasMessages && !hasRunningInitMessage && !transient.caughtUp;

    const cached = this.workspaceShellStatusCache.get(workspaceId);
    if (
      cached?.loading === loading &&
      cached.isHydratingTranscript === isHydratingTranscript &&
      cached.isStreamStarting === isStreamStarting
    ) {
      return cached;
    }

    const next = { loading, isHydratingTranscript, isStreamStarting };
    this.workspaceShellStatusCache.set(workspaceId, next);
    return next;
  }

  // Cache sidebar state objects to return stable references
  private sidebarStateCache = new Map<string, WorkspaceSidebarState>();
  // Map from workspaceId -> the WorkspaceState reference used to compute sidebarStateCache.
  // React's useSyncExternalStore may call getSnapshot() multiple times per render; this
  // ensures getWorkspaceSidebarState() returns a referentially stable snapshot for a given
  // MapStore version even when timingStats would otherwise change via Date.now().
  private sidebarStateSourceState = new Map<string, WorkspaceState>();

  /**
   * Get sidebar state for a workspace (subset of full state).
   * Returns cached reference if values haven't changed.
   * This is critical for useSyncExternalStore - must return stable references.
   */
  getWorkspaceSidebarState(workspaceId: string): WorkspaceSidebarState {
    const fullState = this.getWorkspaceState(workspaceId);
    const isStarting = fullState.isStreamStarting;
    const terminalActivity = this.workspaceTerminalActivity.get(workspaceId);
    const terminalActiveCount = terminalActivity?.activeCount ?? 0;
    const terminalSessionCount = terminalActivity?.totalSessions ?? 0;

    const cached = this.sidebarStateCache.get(workspaceId);
    if (cached && this.sidebarStateSourceState.get(workspaceId) === fullState) {
      return cached;
    }

    // Return cached if values match.
    // Note: timingStats/sessionStats are intentionally excluded - they change on every
    // streaming token and sidebar items don't use them. Components needing timing should
    // use useWorkspaceStatsSnapshot() which has its own subscription.
    if (
      cached?.canInterrupt === fullState.canInterrupt &&
      cached.isStarting === isStarting &&
      cached.awaitingUserQuestion === fullState.awaitingUserQuestion &&
      cached.lastAbortReason === fullState.lastAbortReason &&
      cached.currentModel === fullState.currentModel &&
      cached.pendingStreamModel === fullState.pendingStreamModel &&
      cached.recencyTimestamp === fullState.recencyTimestamp &&
      cached.loadedSkills === fullState.loadedSkills &&
      cached.skillLoadErrors === fullState.skillLoadErrors &&
      cached.agentStatus === fullState.agentStatus &&
      cached.activeWorkflowRunIds === fullState.activeWorkflowRunIds &&
      cached.activeWorkflowRunCount === fullState.activeWorkflowRunCount &&
      cached.activeBashMonitorCount === fullState.activeBashMonitorCount &&
      cached.terminalActiveCount === terminalActiveCount &&
      cached.terminalSessionCount === terminalSessionCount &&
      cached.goal === fullState.goal
    ) {
      // Even if we re-use the cached object, mark it as derived from the current
      // WorkspaceState so repeated getSnapshot() reads during this render are stable.
      this.sidebarStateSourceState.set(workspaceId, fullState);
      return cached;
    }

    // Create and cache new state
    const newState: WorkspaceSidebarState = {
      canInterrupt: fullState.canInterrupt,
      isStarting,
      awaitingUserQuestion: fullState.awaitingUserQuestion,
      lastAbortReason: fullState.lastAbortReason,
      currentModel: fullState.currentModel,
      pendingStreamModel: fullState.pendingStreamModel,
      recencyTimestamp: fullState.recencyTimestamp,
      loadedSkills: fullState.loadedSkills,
      skillLoadErrors: fullState.skillLoadErrors,
      agentStatus: fullState.agentStatus,
      activeWorkflowRunIds: fullState.activeWorkflowRunIds,
      activeWorkflowRunCount: fullState.activeWorkflowRunCount,
      activeBashMonitorCount: fullState.activeBashMonitorCount,
      terminalActiveCount,
      terminalSessionCount,
      goal: fullState.goal,
    };
    this.sidebarStateCache.set(workspaceId, newState);
    this.sidebarStateSourceState.set(workspaceId, fullState);
    return newState;
  }

  /**
   * Clear timing stats for a workspace.
   *
   * - Clears backend-persisted timing file (session-timing.json) when available.
   * - Clears in-memory timing derived from StreamingMessageAggregator.
   */
  clearTimingStats(workspaceId: string): void {
    if (this.client) {
      this.client.workspace.stats
        .clear({ workspaceId })
        .then((result) => {
          if (!result.success) {
            console.warn(`Failed to clear timing stats for ${workspaceId}:`, result.error);
            return;
          }

          this.workspaceStats.delete(workspaceId);
          this.statsStore.bump(workspaceId);
        })
        .catch((error) => {
          console.warn(`Failed to clear timing stats for ${workspaceId}:`, error);
        });
    }

    const aggregator = this.aggregators.get(workspaceId);
    if (aggregator) {
      aggregator.clearSessionTimingStats();
      this.states.bump(workspaceId);
    }
  }

  /**
   * Get all workspace states as a Map.
   * Returns a new Map on each call - not cached/reactive.
   * Used by imperative code, not for React subscriptions.
   */
  getAllStates(): Map<string, WorkspaceState> {
    const allStates = new Map<string, WorkspaceState>();
    for (const workspaceId of this.aggregators.keys()) {
      allStates.set(workspaceId, this.getWorkspaceState(workspaceId));
    }
    return allStates;
  }

  /**
   * Get recency timestamps for all workspaces (for sorting in command palette).
   * Derived on-demand from individual workspace states.
   */
  getWorkspaceRecency(): Record<string, number> {
    return this.derived.get("recency", () => {
      const timestamps: Record<string, number> = {};
      for (const workspaceId of this.aggregators.keys()) {
        const state = this.getWorkspaceState(workspaceId);
        if (state.recencyTimestamp !== null) {
          timestamps[workspaceId] = state.recencyTimestamp;
        }
      }
      return timestamps;
    }) as Record<string, number>;
  }

  getActiveGoalCount(): number {
    return this.activeGoalCount;
  }

  subscribeActiveGoalCount = (listener: () => void) => {
    return this.activeGoalCountStore.subscribeKey("count", listener);
  };

  /**
   * Get aggregator for a workspace (used by components that need direct access).
   * Returns undefined if workspace does not exist.
   */
  getAggregator(workspaceId: string): StreamingMessageAggregator | undefined {
    return this.aggregators.get(workspaceId);
  }

  /**
   * Clear stored abort reason so manual retries can re-enable auto-retry.
   */
  clearLastAbortReason(workspaceId: string): void {
    const aggregator = this.aggregators.get(workspaceId);
    if (!aggregator) {
      return;
    }
    aggregator.clearLastAbortReason();
    this.states.bump(workspaceId);
  }

  async loadOlderHistory(workspaceId: string): Promise<HistoryLoadResult> {
    assert(
      typeof workspaceId === "string" && workspaceId.length > 0,
      "loadOlderHistory requires a non-empty workspaceId"
    );

    const client = this.client;
    if (!client) {
      console.warn(`[WorkspaceStore] Cannot load older history for ${workspaceId}: no ORPC client`);
      return "unavailable";
    }

    const paginationState = this.historyPagination.get(workspaceId);
    if (!paginationState) {
      console.warn(
        `[WorkspaceStore] Cannot load older history for ${workspaceId}: pagination state is not initialized`
      );
      return "unavailable";
    }

    if (!paginationState.hasOlder) {
      return "exhausted";
    }
    if (paginationState.loading) {
      return "busy";
    }

    if (!this.aggregators.has(workspaceId)) {
      console.warn(
        `[WorkspaceStore] Cannot load older history for ${workspaceId}: workspace is not registered`
      );
      return "unavailable";
    }

    const requestedCursor = paginationState.nextCursor
      ? {
          beforeHistorySequence: paginationState.nextCursor.beforeHistorySequence,
          beforeMessageId: paginationState.nextCursor.beforeMessageId,
        }
      : null;

    this.historyPagination.set(workspaceId, {
      nextCursor: requestedCursor,
      hasOlder: paginationState.hasOlder,
      loading: true,
    });
    this.states.bump(workspaceId);

    try {
      const result = await client.workspace.history.loadMore({
        workspaceId,
        cursor: requestedCursor,
      });

      const aggregator = this.aggregators.get(workspaceId);
      const latestPagination = this.historyPagination.get(workspaceId);
      if (
        !aggregator ||
        !latestPagination ||
        !latestPagination.loading ||
        !areHistoryPaginationCursorsEqual(latestPagination.nextCursor, requestedCursor)
      ) {
        return "busy";
      }

      if (result.hasOlder) {
        assert(
          result.nextCursor,
          `[WorkspaceStore] loadMore for ${workspaceId} returned hasOlder=true without nextCursor`
        );
      }

      const historicalMessages = result.messages.filter(isMuxMessage);
      const ignoredCount = result.messages.length - historicalMessages.length;
      if (ignoredCount > 0) {
        console.warn(
          `[WorkspaceStore] Ignoring ${ignoredCount} non-message history rows for ${workspaceId}`
        );
      }

      if (historicalMessages.length > 0) {
        aggregator.loadHistoricalMessages(historicalMessages, false, {
          mode: "append",
          skipDerivedState: true,
        });
        this.consumerManager.scheduleCalculation(workspaceId, aggregator);
      }

      this.historyPagination.set(workspaceId, {
        nextCursor: result.nextCursor,
        hasOlder: result.hasOlder,
        loading: false,
      });
      if (historicalMessages.length > 0) {
        this.lastUserPromptStore.bump(workspaceId);
      }
      return "loaded";
    } catch (error) {
      console.error(`[WorkspaceStore] Failed to load older history for ${workspaceId}:`, error);

      const latestPagination = this.historyPagination.get(workspaceId);
      if (latestPagination) {
        this.historyPagination.set(workspaceId, {
          ...latestPagination,
          loading: false,
        });
      }
      return "failed";
    } finally {
      if (this.isWorkspaceRegistered(workspaceId)) {
        this.states.bump(workspaceId);
      }
    }
  }

  /**
   * Mark the current active stream as "interrupting" (transient state).
   * Call this before invoking interruptStream so the UI shows "interrupting..."
   * immediately, avoiding a visual flash when the backend confirmation arrives.
   */
  setInterrupting(workspaceId: string): void {
    const aggregator = this.aggregators.get(workspaceId);
    if (aggregator) {
      aggregator.setInterrupting();
      this.states.bump(workspaceId);
    }
  }

  getWorkspaceStatsSnapshot(workspaceId: string): WorkspaceStatsSnapshot | null {
    return this.statsStore.get(workspaceId, () => {
      return this.workspaceStats.get(workspaceId) ?? null;
    });
  }

  /**
   * Bump state for a workspace to trigger React re-renders.
   * Used by addEphemeralMessage for frontend-only messages.
   */
  bumpState(workspaceId: string): void {
    this.states.bump(workspaceId);
  }

  getWorkflowToolLiveRun(workspaceId: string, toolCallId: string): WorkflowToolLiveRunState | null {
    return this.chatTransientState.get(workspaceId)?.liveWorkflowRuns.get(toolCallId) ?? null;
  }

  /**
   * Get current Assisted Review hunks (agent-flagged) for a workspace.
   * Updated when `review_pane_update` tool succeeds; consumed by the
   * Review pane and ReviewControls to power the Assisted toggle.
   */
  getAssistedReviewHunks(workspaceId: string): AssistedReviewHunk[] {
    const aggregator = this.aggregators.get(workspaceId);
    return aggregator ? aggregator.getAssistedReviewHunks() : EMPTY_ASSISTED_REVIEW;
  }

  /**
   * Whether the active transcript replay has reached its authoritative caught-up marker.
   * Consumers use this to distinguish a still-hydrating empty derived list from an
   * intentionally empty persisted transcript state.
   */
  isWorkspaceTranscriptCaughtUp(workspaceId: string): boolean {
    return this.chatTransientState.get(workspaceId)?.caughtUp ?? false;
  }

  getWorkspaceHistoryEpoch(workspaceId: string): number {
    return this.aggregators.get(workspaceId)?.getHistoryEpoch() ?? 0;
  }

  getWorkspaceLastUserPromptInfo(workspaceId: string): WorkspaceLastUserPromptInfo | null {
    const aggregator = this.aggregators.get(workspaceId);
    if (!aggregator) {
      return null;
    }

    const messages = aggregator.getDisplayedMessages();
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.type !== "user" || message.isSynthetic === true) {
        continue;
      }
      // Generated attachment markup is provider context, not part of the user's prompt.
      const trimmed = stripStagedAttachmentNotice(message.content).trim();
      if (trimmed.length > 0) {
        return { text: trimmed, messageId: message.historyId };
      }
    }

    return null;
  }

  getWorkspaceLastUserPrompt(workspaceId: string): string | null {
    return this.getWorkspaceLastUserPromptInfo(workspaceId)?.text ?? null;
  }

  getWorkspaceLastUserPromptSnapshot(workspaceId: string): WorkspaceLastUserPromptSnapshot {
    return this.lastUserPromptStore.get(workspaceId, () => ({
      displayed: this.getWorkspaceLastUserPromptInfo(workspaceId),
      historyEpoch: this.getWorkspaceHistoryEpoch(workspaceId),
      isCaughtUp: this.isWorkspaceTranscriptCaughtUp(workspaceId),
    }));
  }

  subscribeLastUserPrompt(workspaceId: string, listener: () => void): () => void {
    return this.lastUserPromptStore.subscribeKey(workspaceId, listener);
  }

  async fetchLastUserPromptFromHistory(
    workspaceId: string
  ): Promise<WorkspaceLastUserPromptInfo | null> {
    const client = this.client;
    if (!client) {
      return null;
    }
    try {
      return await client.workspace.history.lastUserPrompt({ workspaceId });
    } catch {
      return null;
    }
  }

  /**
   * Extract usage from session-usage.json (no tokenization or message iteration).
   *
   * Returns empty state if workspace doesn't exist (e.g., creation mode).
   */
  getWorkspaceUsage(workspaceId: string): WorkspaceUsageState {
    return this.usageStore.get(workspaceId, () => {
      const aggregator = this.aggregators.get(workspaceId);
      if (!aggregator) {
        return { totalTokens: 0 };
      }

      const model = aggregator.getCurrentModel();
      const sessionData = this.sessionUsage.get(workspaceId);

      // Session total: sum all models from persisted data
      const sessionTotal =
        sessionData && Object.keys(sessionData.byModel).length > 0
          ? sumUsageHistory(Object.values(sessionData.byModel))
          : undefined;

      // Shallow copy: byModel is mutated in place on stream-end, so a fresh
      // record keeps memoized consumers from reading stale snapshots.
      const sessionByModel =
        sessionData && Object.keys(sessionData.byModel).length > 0
          ? { ...sessionData.byModel }
          : undefined;

      // Last request from persisted data
      const lastRequest = sessionData?.lastRequest;

      // Calculate total tokens from session total
      const totalTokens = sessionTotal
        ? sessionTotal.input.tokens +
          sessionTotal.cached.tokens +
          sessionTotal.cacheCreate.tokens +
          sessionTotal.output.tokens +
          sessionTotal.reasoning.tokens
        : 0;

      const messages = aggregator.getAllMessages();
      if (messages.length === 0) {
        const snapshot = this.preReplayUsageSnapshot.get(workspaceId);
        if (snapshot) {
          return snapshot;
        }
      }

      // Get last message's context usage — only search within the current
      // compaction epoch. Pre-boundary messages carry stale contextUsage from
      // before compaction; including them inflates the usage indicator and
      // triggers premature auto-compaction.
      const lastContextUsage = (() => {
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (isDurableCompactionBoundaryMarker(msg)) {
            // Idle/manual compaction boundary messages can include a post-compaction
            // context estimate. Read it before breaking so context usage does not
            // disappear when switching back to a compacted workspace.
            const rawUsage = msg.metadata?.contextUsage;
            if (rawUsage && msg.role === "assistant") {
              const msgModel = msg.metadata?.model ?? model ?? "unknown";
              return createDisplayUsage(rawUsage, msgModel, undefined);
            }
            break;
          }
          if (msg.role === "assistant") {
            if (msg.metadata?.compacted) continue;
            const rawUsage = msg.metadata?.contextUsage;
            const providerMeta =
              msg.metadata?.contextProviderMetadata ?? msg.metadata?.providerMetadata;
            if (rawUsage) {
              const msgModel = msg.metadata?.model ?? model ?? "unknown";
              return createDisplayUsage(
                rawUsage,
                msgModel,
                providerMeta,
                this.resolveMetadataModel(msgModel)
              );
            }
          }
        }
        return undefined;
      })();

      // Live streaming data (unchanged)
      const activeStreamId = aggregator.getActiveStreamMessageId();
      // Request-pinned identity stamped by the backend at stream start: a
      // Coder catalog refresh can remove/retag the instance mid-stream, and
      // re-resolving the raw model against the refreshed config would price
      // and bucket live usage differently from the backend ledger.
      const liveMetadataModel = aggregator.getActiveStreamMetadataModel();
      const rawContextUsage = activeStreamId
        ? aggregator.getActiveStreamUsage(activeStreamId)
        : undefined;
      const rawStepProviderMetadata = activeStreamId
        ? aggregator.getActiveStreamStepProviderMetadata(activeStreamId)
        : undefined;
      const liveUsage =
        rawContextUsage && model
          ? createDisplayUsage(
              rawContextUsage,
              model,
              rawStepProviderMetadata,
              liveMetadataModel ?? this.resolveMetadataModel(model)
            )
          : undefined;

      const rawCumulativeUsage = activeStreamId
        ? aggregator.getActiveStreamCumulativeUsage(activeStreamId)
        : undefined;
      const rawCumulativeProviderMetadata = activeStreamId
        ? aggregator.getActiveStreamCumulativeProviderMetadata(activeStreamId)
        : undefined;
      const liveCostUsage =
        rawCumulativeUsage && model
          ? createDisplayUsage(
              rawCumulativeUsage,
              model,
              rawCumulativeProviderMetadata,
              liveMetadataModel ?? this.resolveMetadataModel(model)
            )
          : undefined;

      return {
        sessionTotal,
        sessionByModel,
        lastRequest,
        lastContextUsage,
        totalTokens,
        liveUsage,
        liveCostUsage,
        liveMetadataModel,
      };
    });
  }

  private tryHydrateConsumersFromSessionUsageCache(
    workspaceId: string,
    aggregator: StreamingMessageAggregator
  ): boolean {
    const usage = this.sessionUsage.get(workspaceId);
    const tokenStatsCache = usage?.tokenStatsCache;
    if (!tokenStatsCache) {
      return false;
    }

    const messages = aggregator.getAllMessages();
    if (messages.length === 0) {
      return false;
    }

    const model = aggregator.getCurrentModel() ?? "unknown";
    if (tokenStatsCache.model !== model) {
      return false;
    }

    // Reject hydration if provider config hasn't loaded yet (fingerprint is null)
    // or if the cached fingerprint doesn't match the current config. This prevents
    // stale caches from being served before we know the real configuration.
    if (
      this.providersConfigFingerprint == null ||
      tokenStatsCache.providersConfigVersion !== this.providersConfigFingerprint
    ) {
      return false;
    }

    if (tokenStatsCache.history.messageCount !== messages.length) {
      return false;
    }

    const cachedMaxSeq = tokenStatsCache.history.maxHistorySequence;
    const currentMaxSeq = getMaxHistorySequence(messages);

    // Fall back to messageCount matching if either side lacks historySequence metadata.
    if (
      cachedMaxSeq !== undefined &&
      currentMaxSeq !== undefined &&
      cachedMaxSeq !== currentMaxSeq
    ) {
      return false;
    }

    this.consumerManager.hydrateFromCache(workspaceId, {
      consumers: tokenStatsCache.consumers,
      tokenizerName: tokenStatsCache.tokenizerName,
      totalTokens: tokenStatsCache.totalTokens,
      topFilePaths: tokenStatsCache.topFilePaths,
    });

    return true;
  }

  private ensureConsumersCached(workspaceId: string, aggregator: StreamingMessageAggregator): void {
    if (aggregator.getAllMessages().length === 0) {
      return;
    }

    const cached = this.consumerManager.getCachedState(workspaceId);
    const isPending = this.consumerManager.isPending(workspaceId);
    if (cached || isPending) {
      return;
    }

    if (this.tryHydrateConsumersFromSessionUsageCache(workspaceId, aggregator)) {
      return;
    }

    this.consumerManager.scheduleCalculation(workspaceId, aggregator);
  }

  /**
   * Get consumer breakdown (may be calculating).
   * Triggers lazy calculation if workspace is caught-up but no data exists.
   *
   * Architecture: Lazy trigger runs on EVERY access (outside MapStore.get())
   * so workspace switches trigger calculation even if MapStore has cached result.
   */
  getWorkspaceConsumers(workspaceId: string): WorkspaceConsumersState {
    const aggregator = this.aggregators.get(workspaceId);
    const isCaughtUp = this.chatTransientState.get(workspaceId)?.caughtUp ?? false;

    // Lazy trigger check (runs on EVERY access, not just when MapStore recomputes)
    const cached = this.consumerManager.getCachedState(workspaceId);
    const isPending = this.consumerManager.isPending(workspaceId);

    if (!cached && !isPending && isCaughtUp) {
      if (aggregator && aggregator.getAllMessages().length > 0) {
        // Defer scheduling/hydration to avoid setState-during-render warning
        // queueMicrotask ensures this runs after current render completes
        queueMicrotask(() => {
          this.ensureConsumersCached(workspaceId, aggregator);
        });
      }
    }

    // Return state (MapStore handles subscriptions, delegates to manager for actual state)
    return this.consumersStore.get(workspaceId, () => {
      return this.consumerManager.getStateSync(workspaceId);
    });
  }

  /**
   * Subscribe to usage store changes for a specific workspace.
   */
  subscribeUsage(workspaceId: string, listener: () => void): () => void {
    return this.usageStore.subscribeKey(workspaceId, listener);
  }

  /**
   * Subscribe to backend timing stats snapshots for a specific workspace.
   */
  subscribeStats(workspaceId: string, listener: () => void): () => void {
    const unsubscribeFromStore = this.statsStore.subscribeKey(workspaceId, listener);

    const previousCount = this.statsListenerCounts.get(workspaceId) ?? 0;
    const nextCount = previousCount + 1;
    this.statsListenerCounts.set(workspaceId, nextCount);

    if (previousCount === 0) {
      // Start the backend subscription only once we have an actual UI consumer.
      this.subscribeToStats(workspaceId);
    }

    return () => {
      unsubscribeFromStore();

      const currentCount = this.statsListenerCounts.get(workspaceId);
      if (!currentCount) {
        console.warn(
          `[WorkspaceStore] stats listener count underflow for ${workspaceId} (already 0)`
        );
        return;
      }

      if (currentCount === 1) {
        this.statsListenerCounts.delete(workspaceId);

        // No remaining listeners: stop the backend subscription and drop cached snapshot.
        const statsUnsubscribe = this.statsUnsubscribers.get(workspaceId);
        if (statsUnsubscribe) {
          statsUnsubscribe();
          this.statsUnsubscribers.delete(workspaceId);
        }
        this.workspaceStats.delete(workspaceId);

        // Clear MapStore caches for this workspace.
        // MapStore.delete() is version-gated, so bump first to ensure we clear even
        // if the key was only ever read (get()) and never bumped.
        this.statsStore.bump(workspaceId);
        this.statsStore.delete(workspaceId);
        return;
      }

      this.statsListenerCounts.set(workspaceId, currentCount - 1);
    };
  }

  getWorkspaceTimeline(workspaceId: string): WorkspaceTimelineSnapshot {
    return this.timelineStore.get(
      workspaceId,
      () => this.workspaceTimelines.get(workspaceId) ?? EMPTY_TIMELINE_SNAPSHOT
    );
  }

  retryTimeline(workspaceId: string): void {
    // Tear the failed subscription down first: subscribeToTimeline no-ops while an unsubscriber for
    // this workspace is still registered.
    this.timelineUnsubscribers.get(workspaceId)?.();
    this.timelineUnsubscribers.delete(workspaceId);
    this.workspaceTimelines.set(workspaceId, { ...EMPTY_TIMELINE_SNAPSHOT });
    this.timelineStore.bump(workspaceId);
    this.subscribeToTimeline(workspaceId);
  }

  async loadOlderTimeline(workspaceId: string): Promise<void> {
    const client = this.client;
    const current = this.workspaceTimelines.get(workspaceId);
    if (!client || !current?.hasOlder || current.loadingOlder || current.nextCursor == null) {
      return;
    }

    const requestedCursor = current.nextCursor;
    this.workspaceTimelines.set(workspaceId, {
      ...current,
      loadingOlder: true,
      loadError: null,
      loadErrorKind: null,
    });
    this.timelineStore.bump(workspaceId);

    try {
      const page = await client.workspace.timeline.list({
        workspaceId,
        cursor: requestedCursor,
      });
      const latest = this.workspaceTimelines.get(workspaceId);
      if (latest?.nextCursor !== requestedCursor || !latest.loadingOlder) return;

      this.workspaceTimelines.set(workspaceId, {
        ...latest,
        events: mergeTimelineEvents(latest.events, page.events),
        nextCursor: page.nextCursor,
        hasOlder: page.hasOlder,
        loadingOlder: false,
      });
      this.timelineStore.bump(workspaceId);
    } catch (error) {
      const latest = this.workspaceTimelines.get(workspaceId);
      if (latest?.nextCursor !== requestedCursor) return;
      this.workspaceTimelines.set(workspaceId, {
        ...latest,
        loadingOlder: false,
        loadError: error instanceof Error ? error.message : "Failed to load older events",
        loadErrorKind: "pagination",
      });
      this.timelineStore.bump(workspaceId);
    }
  }

  subscribeTimeline(workspaceId: string, listener: () => void): () => void {
    const unsubscribeFromStore = this.timelineStore.subscribeKey(workspaceId, listener);
    const previousCount = this.timelineListenerCounts.get(workspaceId) ?? 0;
    this.timelineListenerCounts.set(workspaceId, previousCount + 1);

    if (previousCount === 0) {
      this.subscribeToTimeline(workspaceId);
    }

    return () => {
      unsubscribeFromStore();
      const currentCount = this.timelineListenerCounts.get(workspaceId);
      if (!currentCount) return;

      if (currentCount === 1) {
        this.timelineListenerCounts.delete(workspaceId);
        this.timelineUnsubscribers.get(workspaceId)?.();
        this.timelineUnsubscribers.delete(workspaceId);
        this.workspaceTimelines.delete(workspaceId);
        this.timelineStore.bump(workspaceId);
        this.timelineStore.delete(workspaceId);
        return;
      }

      this.timelineListenerCounts.set(workspaceId, currentCount - 1);
    };
  }

  /**
   * Subscribe to consumer store changes for a specific workspace.
   */
  subscribeConsumers(workspaceId: string, listener: () => void): () => void {
    return this.consumersStore.subscribeKey(workspaceId, listener);
  }

  /**
   * Update usage and schedule consumer calculation after stream completion.
   *
   * CRITICAL ORDERING: This must be called AFTER the aggregator updates its messages.
   * If called before, the UI will re-render and read stale data from the aggregator,
   * causing a race condition where usage appears empty until refresh.
   *
   * Handles both:
   * - Instant usage display (from API metadata) - only if usage present
   * - Async consumer breakdown (tokenization via Web Worker) - normally scheduled,
   *   but skipped during history replay to avoid O(N) scheduling overhead
   */
  private finalizeUsageStats(
    workspaceId: string,
    metadata?: { usage?: LanguageModelV2Usage }
  ): void {
    // During history replay: only bump usage, skip scheduling (caught-up schedules once at end)
    if (this.chatTransientState.get(workspaceId)?.replayingHistory) {
      if (metadata?.usage) {
        this.usageStore.bump(workspaceId);
      }
      return;
    }

    // Normal real-time path: always bump usage.
    //
    // Even if total usage is missing (e.g. provider doesn't return it or it timed out),
    // we still need to recompute usage snapshots to:
    // - Clear liveUsage once the active stream ends
    // - Pick up lastContextUsage changes from merged message metadata
    this.usageStore.bump(workspaceId);

    // Always schedule consumer calculation (tool calls, text, etc. need tokenization)
    // Even streams without usage metadata need token counts recalculated
    const aggregator = this.aggregators.get(workspaceId);
    if (aggregator) {
      this.consumerManager.scheduleCalculation(workspaceId, aggregator);
    }
  }

  private isWorkspaceRegistered(workspaceId: string): boolean {
    return this.workspaceMetadata.has(workspaceId);
  }

  hasRegisteredWorkspace(workspaceId: string): boolean {
    return workspaceId.length > 0 && this.aggregators.has(workspaceId);
  }

  private refreshActiveGoalCount(): void {
    const nextCount = Array.from(this.workspaceActivity.values()).filter(
      (snapshot) => snapshot.goal?.status === "active" && !isGoalPendingPersistence(snapshot.goal)
    ).length;
    if (nextCount === this.activeGoalCount) {
      return;
    }

    this.activeGoalCount = nextCount;
    this.activeGoalCountStore.bump("count");
  }

  private applyWorkspaceActivitySnapshot(
    workspaceId: string,
    snapshot: WorkspaceActivitySnapshot | null
  ): void {
    const previous = this.workspaceActivity.get(workspaceId) ?? null;

    if (snapshot?.transientGoalOnly === true) {
      const snapshotWithoutHint: WorkspaceActivitySnapshot = { ...snapshot };
      delete snapshotWithoutHint.transientGoalOnly;
      snapshot = previous ? { ...previous, goal: snapshot.goal } : snapshotWithoutHint;
    }

    if (snapshot) {
      this.workspaceActivity.set(workspaceId, snapshot);
    } else {
      this.workspaceActivity.delete(workspaceId);
    }

    this.refreshActiveGoalCount();

    const changed =
      previous?.streaming !== snapshot?.streaming ||
      previous?.streamingGeneration !== snapshot?.streamingGeneration ||
      previous?.lastModel !== snapshot?.lastModel ||
      previous?.lastThinkingLevel !== snapshot?.lastThinkingLevel ||
      previous?.recency !== snapshot?.recency ||
      previous?.hasTodos !== snapshot?.hasTodos ||
      !areStringArraysEqual(previous?.activeWorkflowRunIds, snapshot?.activeWorkflowRunIds) ||
      (previous?.activeWorkflowRunCount ?? 0) !== (snapshot?.activeWorkflowRunCount ?? 0) ||
      (previous?.activeBashMonitorCount ?? 0) !== (snapshot?.activeBashMonitorCount ?? 0) ||
      !areAgentStatusesEqual(previous?.displayStatus, snapshot?.displayStatus) ||
      !areAgentStatusesEqual(previous?.todoStatus, snapshot?.todoStatus) ||
      previous?.goal?.goalId !== snapshot?.goal?.goalId ||
      previous?.goal?.status !== snapshot?.goal?.status ||
      previous?.goal?.objective !== snapshot?.goal?.objective ||
      previous?.goal?.costCents !== snapshot?.goal?.costCents ||
      previous?.goal?.turnsUsed !== snapshot?.goal?.turnsUsed ||
      previous?.goal?.budgetCents !== snapshot?.goal?.budgetCents ||
      previous?.goal?.turnCap !== snapshot?.goal?.turnCap ||
      previous?.goal?.pendingPersistence !== snapshot?.goal?.pendingPersistence;

    if (!changed) {
      return;
    }

    if (this.aggregators.has(workspaceId)) {
      this.states.bump(workspaceId);
    }

    const startedStreamingSnapshot =
      previous?.streaming !== true && snapshot?.streaming === true ? snapshot : null;
    if (startedStreamingSnapshot) {
      this.activityStreamingStartRecency.set(workspaceId, startedStreamingSnapshot.recency);
    }

    const didBackgroundStreamingGenerationAdvance =
      workspaceId !== this.activeWorkspaceId &&
      previous?.streaming === true &&
      snapshot?.streaming === true &&
      previous.streamingGeneration !== undefined &&
      snapshot.streamingGeneration !== undefined &&
      previous.streamingGeneration !== snapshot.streamingGeneration;
    if (didBackgroundStreamingGenerationAdvance) {
      // Background activity snapshots continue across handoffs even after onChat unsubscribes.
      // Let the aggregator decide whether any stream-scoped completion metadata should
      // survive the handoff before clearing stale live stream contexts.
      this.aggregators.get(workspaceId)?.handleBackgroundStreamingGenerationAdvance();
    }

    const stoppedStreamingSnapshot =
      previous?.streaming === true && snapshot?.streaming === false ? snapshot : null;
    // Activity snapshots only collapse for background workspaces — active workspaces
    // already collapse from onChat stream-end/stream-abort, which is faster and authoritative.
    // Firing here too would let a late async snapshot override the user re-expanding the panel.
    if (stoppedStreamingSnapshot && !this.isOnChatSubscriptionActive(workspaceId)) {
      collapsePinnedTodoOnStreamStop(workspaceId, stoppedStreamingSnapshot.hasTodos === true);
    }
    const isBackgroundStreamingStop =
      stoppedStreamingSnapshot !== null && workspaceId !== this.activeWorkspaceId;
    const streamStartRecency = this.activityStreamingStartRecency.get(workspaceId);
    const recencyAdvancedSinceStreamStart =
      stoppedStreamingSnapshot !== null &&
      streamStartRecency !== undefined &&
      stoppedStreamingSnapshot.recency > streamStartRecency;
    const backgroundCompletion = isBackgroundStreamingStop
      ? this.aggregators.get(workspaceId)?.getActiveResponseCompleteMetadata()
      : undefined;
    // The backend tags compaction stop snapshots with an authoritative stream
    // classification. Compaction is context-management rather than a response,
    // so background notification policy must not fall back to "normal" if the
    // frontend missed live compaction/follow-up events while unsubscribed.
    // Check both previous and current as defense-in-depth against update ordering.
    const wasCompaction =
      previous?.isCompaction === true ||
      snapshot?.isCompaction === true ||
      previous?.isIdleCompaction === true ||
      snapshot?.isIdleCompaction === true;

    // Trigger response completion notifications for background workspaces only when
    // activity indicates a true completion (streaming true -> false WITH recency advance).
    // stream-abort/error transitions also flip streaming to false, but recency stays
    // unchanged there, so suppress completion notifications in those cases.
    if (stoppedStreamingSnapshot && recencyAdvancedSinceStreamStart && isBackgroundStreamingStop) {
      // Activity snapshots don't include message/content metadata. Reuse any
      // still-active stream context captured before this workspace was backgrounded
      // so queued follow-up handoffs remain suppressible in App notifications.
      const completion = wasCompaction ? createCompactionCompletion() : backgroundCompletion;
      this.emitResponseComplete({
        workspaceId,
        isFinal: true,
        completion,
        completedAt: stoppedStreamingSnapshot.recency,
      });
    }

    if (isBackgroundStreamingStop) {
      // Inactive workspaces do not receive stream-end events via onChat. Once
      // activity confirms streaming stopped, clear stale stream contexts so they
      // cannot leak compaction metadata into future completion callbacks.
      this.aggregators.get(workspaceId)?.clearBackgroundHandoffCompletion();
      this.aggregators.get(workspaceId)?.clearActiveStreams();
      this.aggregators.get(workspaceId)?.clearPendingStreamStart();
      this.releaseStreamingMessageChannel(workspaceId);
    }

    if (snapshot?.streaming !== true) {
      this.activityStreamingStartRecency.delete(workspaceId);
    }

    if (previous?.recency !== snapshot?.recency && this.aggregators.has(workspaceId)) {
      this.derived.bump("recency");
    }
  }

  /** skipWorkspaceIds: ids whose live state is newer than this list (never overwritten or cleared). */
  private applyWorkspaceActivityList(
    snapshots: Record<string, WorkspaceActivitySnapshot>,
    skipWorkspaceIds?: ReadonlySet<string>
  ): void {
    const seenWorkspaceIds = new Set<string>();

    for (const [workspaceId, snapshot] of Object.entries(snapshots)) {
      seenWorkspaceIds.add(workspaceId);
      if (skipWorkspaceIds?.has(workspaceId)) {
        continue;
      }
      this.applyWorkspaceActivitySnapshot(workspaceId, snapshot);
    }

    // An empty list is a valid all-idle result (backend read failures arrive as null
    // and never reach this method), so clear any cached snapshots it no longer lists.
    for (const workspaceId of Array.from(this.workspaceActivity.keys())) {
      if (seenWorkspaceIds.has(workspaceId) || skipWorkspaceIds?.has(workspaceId)) {
        continue;
      }
      this.applyWorkspaceActivitySnapshot(workspaceId, null);
    }
  }

  private applyTerminalActivity(
    workspaceId: string,
    next: { activeCount: number; totalSessions: number }
  ): void {
    const prev = this.workspaceTerminalActivity.get(workspaceId);
    if (
      prev &&
      prev.activeCount === next.activeCount &&
      prev.totalSessions === next.totalSessions
    ) {
      return;
    }

    if (next.totalSessions === 0) {
      this.workspaceTerminalActivity.delete(workspaceId);
    } else {
      this.workspaceTerminalActivity.set(workspaceId, next);
    }

    // Bump sidebar snapshots so consumers see updated terminal activity counts.
    if (this.aggregators.has(workspaceId)) {
      this.states.bump(workspaceId);
    }
  }

  /**
   * Safely resolve terminal.activity.subscribe from a client that may be
   * a partial mock or an older server that doesn't expose this endpoint.
   * Returns null when the capability is absent — callers must treat this
   * as "terminal activity unsupported" rather than an error.
   */
  private resolveTerminalActivitySubscribe(
    client: RouterClient<AppRouter>
  ): typeof client.terminal.activity.subscribe | null {
    try {
      const subscribe = client.terminal?.activity?.subscribe;
      return typeof subscribe === "function" ? subscribe : null;
    } catch {
      return null;
    }
  }

  private clearAllTerminalActivitySnapshots(): void {
    if (this.workspaceTerminalActivity.size === 0) {
      return;
    }

    const workspaceIds = Array.from(this.workspaceTerminalActivity.keys());
    this.workspaceTerminalActivity.clear();

    for (const workspaceId of workspaceIds) {
      if (this.aggregators.has(workspaceId)) {
        this.states.bump(workspaceId);
      }
    }
  }

  private async runTerminalActivitySubscription(controller: AbortController): Promise<void> {
    const signal = controller.signal;
    try {
      await runSubscriptionLoop({
        name: "terminal activity subscription",
        signal,
        getClient: async (attemptSignal) =>
          this.client ?? (await this.waitForClient(attemptSignal)),
        getClientChangeSignal: () => this.clientChangeController.signal,
        subscribe: async (client, attemptSignal) => {
          const subscribe = this.resolveTerminalActivitySubscribe(client);
          if (!subscribe) {
            this.clearAllTerminalActivitySnapshots();
            return null;
          }
          return {
            events: await subscribe(undefined, { signal: attemptSignal }),
            context: undefined,
          };
        },
        onEvent: (event, _context, attemptSignal) => {
          if (event.type === "heartbeat") return;
          queueMicrotask(() => {
            if (signal.aborted || attemptSignal.aborted) return;
            if (event.type === "snapshot") {
              const seen = new Set<string>();
              for (const [workspaceId, activity] of Object.entries(event.workspaces)) {
                seen.add(workspaceId);
                this.applyTerminalActivity(workspaceId, activity);
              }
              for (const workspaceId of Array.from(this.workspaceTerminalActivity.keys())) {
                if (!seen.has(workspaceId))
                  this.applyTerminalActivity(workspaceId, { activeCount: 0, totalSessions: 0 });
              }
              return;
            }
            this.applyTerminalActivity(event.workspaceId, event.activity);
          });
        },
        onUnexpectedEnd: ({ attemptAborted }) => {
          if (!attemptAborted)
            console.warn(
              "[WorkspaceStore] terminal activity subscription ended unexpectedly; retrying..."
            );
        },
        onError: (error, { attemptAborted }) => {
          const abortError = isAbortError(error);
          if (attemptAborted) {
            if (!abortError)
              console.warn("[WorkspaceStore] terminal activity subscription aborted; retrying...");
          } else if (!abortError)
            console.warn("[WorkspaceStore] Error in terminal activity subscription:", error);
        },
        backoffAfterAbort: false,
      });
    } finally {
      this.releaseTerminalActivityController(controller);
    }
  }

  /**
   * Hydrated means the first-paint barrier may release — including the bootstrap
   * FAILURE path, which self-heals without activity data. Authoritative is set only
   * when a real activity snapshot list was applied ({} from an all-idle backend
   * counts; the null read-failure signal does not), so consumers that must not
   * mistake failure-path state for "no activity" (e.g. the Workflows tab
   * auto-activation baseline) gate on it instead.
   */
  private markActivityHydrated(authoritative: boolean): void {
    const hydratedChanged = !this.activityHydrated;
    const authoritativeChanged = authoritative && !this.activityAuthoritative;
    if (!hydratedChanged && !authoritativeChanged) {
      return;
    }
    this.activityHydrated = true;
    if (authoritative) {
      this.activityAuthoritative = true;
    }
    for (const listener of this.activityHydratedListeners) {
      listener();
    }
  }

  isActivityHydrated = (): boolean => this.activityHydrated;

  isActivityAuthoritative = (): boolean => this.activityAuthoritative;

  subscribeActivityHydrated = (listener: () => void): (() => void) => {
    this.activityHydratedListeners.add(listener);
    return () => {
      this.activityHydratedListeners.delete(listener);
    };
  };

  isSessionUsageKnown(workspaceId: string): boolean {
    return this.sessionUsageKnown.has(workspaceId);
  }

  private markSessionUsageKnown(workspaceId: string): void {
    if (this.sessionUsageKnown.has(workspaceId)) {
      return;
    }
    this.sessionUsageKnown.add(workspaceId);
    // Reuse the usage channel so useSessionUsageKnown subscribers wake up.
    this.usageStore.bump(workspaceId);
  }

  private async runActivitySubscription(signal: AbortSignal): Promise<void> {
    await runSubscriptionLoop({
      name: "activity subscription",
      signal,
      getClient: async (attemptSignal) => this.client ?? (await this.waitForClient(attemptSignal)),
      getClientChangeSignal: () => this.clientChangeController.signal,
      subscribe: async (client, attemptSignal) => {
        const iterator = await client.workspace.activity.subscribe(undefined, {
          signal: attemptSignal,
        });
        const snapshots = await client.workspace.activity.list();
        if (signal.aborted) return null;
        if (attemptSignal.aborted) return { retryImmediately: true };
        queueMicrotask(() => {
          if (signal.aborted || attemptSignal.aborted) return;
          if (snapshots != null) this.applyWorkspaceActivityList(snapshots);
          this.markActivityHydrated(snapshots != null);
        });
        if (snapshots == null) void this.retryActivityBootstrapList(client, signal, attemptSignal);
        return { events: iterator, context: undefined };
      },
      onEvent: (event, _context, attemptSignal) => {
        if (event.type === "heartbeat") return;
        queueMicrotask(() => {
          if (signal.aborted || attemptSignal.aborted) return;
          this.activityDeltaTouchesDuringRetry?.add(event.workspaceId);
          this.applyWorkspaceActivitySnapshot(event.workspaceId, event.activity);
        });
      },
      onUnexpectedEnd: () =>
        console.warn("[WorkspaceStore] activity subscription ended unexpectedly; retrying..."),
      onError: (error, { attemptAborted }) => {
        const abortError = isAbortError(error);
        if (attemptAborted) {
          if (!abortError)
            console.warn("[WorkspaceStore] activity subscription aborted; retrying...");
        } else if (!abortError) {
          console.warn("[WorkspaceStore] Error in activity subscription:", error);
          this.markActivityHydrated(false);
        }
      },
    });
  }

  /**
   * Bootstrap repair for a null (read-failure) activity list: retries list()
   * with the subscription backoff until a real list applies for this attempt or
   * the owning attempt/store aborts. Deliberately NOT gated on the store-lifetime
   * activityAuthoritative latch: after a reconnect, the fresh subscription does
   * not replay state that changed while disconnected, so the reconnect attempt's
   * failed bootstrap still needs its own successful list to resync (a stale
   * attempt's retry is stopped by its attemptSignal instead). Runs concurrently
   * with the live delta stream, so workspaces that receive a delta while a read
   * is in flight are skipped when the (older) response applies. Never throws, so
   * callers may fire-and-forget.
   */
  private async retryActivityBootstrapList(
    client: RouterClient<AppRouter>,
    signal: AbortSignal,
    attemptSignal: AbortSignal
  ): Promise<void> {
    let attempt = 0;
    while (!signal.aborted && !attemptSignal.aborted) {
      await sleepWithAbort(calculateSubscriptionBackoffMs(attempt), signal);
      attempt++;
      if (signal.aborted || attemptSignal.aborted) {
        return;
      }
      // Live deltas that land while this read is in flight are newer than the
      // response and must win: record them so the apply below skips their ids.
      const deltaTracker = new Set<string>();
      this.activityDeltaTouchesDuringRetry = deltaTracker;
      // Identity-guarded: a newer attempt's retry may have installed its own
      // tracker while this stale read was still pending — never clear that one.
      const releaseTracker = () => {
        if (this.activityDeltaTouchesDuringRetry === deltaTracker) {
          this.activityDeltaTouchesDuringRetry = null;
        }
      };
      let snapshots: Record<string, WorkspaceActivitySnapshot> | null = null;
      try {
        snapshots = await client.workspace.activity.list();
      } catch {
        // Transient transport failure: keep retrying; terminal subscription
        // failures are owned by the outer attempt loop.
        releaseTracker();
        continue;
      }
      if (snapshots == null) {
        releaseTracker();
        continue;
      }
      const appliedSnapshots = snapshots;
      queueMicrotask(() => {
        // Released inside the microtask so delta microtasks already queued ahead
        // of it still register; deltas queued after it run later and overwrite
        // the list values anyway (newest wins in both directions).
        releaseTracker();
        if (signal.aborted || attemptSignal.aborted) {
          return;
        }
        this.applyWorkspaceActivityList(appliedSnapshots, deltaTracker);
        this.markActivityHydrated(true);
      });
      return;
    }
  }

  private async waitForClient(signal: AbortSignal): Promise<RouterClient<AppRouter> | null> {
    while (!signal.aborted) {
      if (this.client) {
        return this.client;
      }

      // Wait for a client to be attached (e.g., initial connect or reconnect).
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }

        const clientChangeSignal = this.clientChangeController.signal;
        const onAbort = () => {
          cleanup();
          resolve();
        };

        const timeout = setTimeout(() => {
          cleanup();
          resolve();
        }, SUBSCRIPTION_RETRY_BASE_MS);

        const cleanup = () => {
          clearTimeout(timeout);
          signal.removeEventListener("abort", onAbort);
          clientChangeSignal.removeEventListener("abort", onAbort);
        };

        signal.addEventListener("abort", onAbort, { once: true });
        clientChangeSignal.addEventListener("abort", onAbort, { once: true });
      });
    }

    return null;
  }

  /**
   * Reset derived UI state for a workspace so a fresh onChat replay can rebuild it.
   *
   * This is used when an onChat subscription ends unexpectedly (MessagePort/WebSocket hiccup).
   * Without clearing, replayed history would be merged into stale state (loadHistoricalMessages
   * only adds/overwrites, it doesn't delete messages that disappeared due to compaction/truncation).
   */
  private resetChatStateForReplay(workspaceId: string): void {
    const aggregator = this.aggregators.get(workspaceId);
    if (!aggregator) {
      return;
    }

    // Clear any pending UI bumps from deltas - we're about to rebuild the message list.
    this.cancelPendingIdleBump(workspaceId);
    this.cancelPendingStreamingBump(workspaceId);

    // Preserve last-known usage while replay rebuilds the aggregator.
    // Without this, getWorkspaceUsage() can briefly return an empty state and hide
    // context/cost indicators until replayed usage catches up.
    const currentUsage = this.getWorkspaceUsage(workspaceId);
    const hasUsageSnapshot =
      currentUsage.totalTokens > 0 ||
      currentUsage.lastContextUsage !== undefined ||
      currentUsage.liveUsage !== undefined ||
      currentUsage.liveCostUsage !== undefined;
    if (hasUsageSnapshot) {
      this.preReplayUsageSnapshot.set(workspaceId, currentUsage);
    } else {
      this.preReplayUsageSnapshot.delete(workspaceId);
    }

    aggregator.resetForReplay();

    // Reset per-workspace transient state so the next replay rebuilds from the backend source of truth.
    const previousTransient = this.chatTransientState.get(workspaceId);
    // Release keyed advisor channels before the transient maps are replaced:
    // they are the only record of these tool-call IDs, so the caught-up and
    // workspace-removal sweeps can never rediscover the keys afterwards.
    if (previousTransient) {
      for (const toolCallId of new Set([
        ...previousTransient.liveAdvisorOutput.keys(),
        ...previousTransient.liveAdvisorReasoning.keys(),
      ])) {
        this.advisorLiveStore.delete(getAdvisorLiveKey(workspaceId, toolCallId));
      }
    }
    const nextTransient = createInitialChatTransientState();

    // Preserve active hydration across full replay resets so workspace-switch catch-up
    // remains in loading state until we receive an authoritative caught-up marker.
    if (previousTransient?.isHydratingTranscript) {
      nextTransient.isHydratingTranscript = true;
    }
    // A send begun before the first replay (new workspace) is retired by the replay itself.
    nextTransient.pendingSend = previousTransient?.pendingSend ?? null;

    this.chatTransientState.set(workspaceId, nextTransient);

    this.historyPagination.set(workspaceId, createInitialHistoryPaginationState());

    this.lastUserPromptStore.bump(workspaceId);
    this.states.bump(workspaceId);
    this.checkAndBumpRecencyIfChanged();
  }

  private getStartupAutoCompactionThreshold(
    workspaceId: string,
    retryModelHint?: string | null
  ): number {
    const metadata = this.workspaceMetadata.get(workspaceId);
    const modelFromActiveAgent = metadata?.agentId
      ? metadata.aiSettingsByAgent?.[metadata.agentId]?.model
      : undefined;
    const pendingModel =
      retryModelHint ??
      modelFromActiveAgent ??
      metadata?.aiSettingsByAgent?.exec?.model ??
      metadata?.aiSettings?.model;
    const thresholdKey = getAutoCompactionThresholdKey(pendingModel ?? "default");
    const persistedThreshold = readPersistedState<unknown>(
      thresholdKey,
      DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT
    );
    const thresholdPercent =
      typeof persistedThreshold === "number" && Number.isFinite(persistedThreshold)
        ? persistedThreshold
        : DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT;

    if (thresholdPercent !== persistedThreshold) {
      // Self-heal malformed localStorage so future startup syncs remain valid.
      updatePersistedState<number>(thresholdKey, DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT);
    }

    return Math.max(0.1, Math.min(1, thresholdPercent / 100));
  }

  /**
   * Best-effort startup threshold sync so backend recovery uses the user's persisted
   * per-model threshold before AgentSession startup recovery kicks in.
   */
  private async syncAutoCompactionThresholdAtStartup(
    client: RouterClient<AppRouter>,
    workspaceId: string
  ): Promise<void> {
    try {
      // Startup auto-retry can resume a turn with a model different from the current
      // workspace selector. Ask backend for that retry-turn model first so threshold
      // sync uses the matching per-model localStorage key.
      const startupRetryModelResult = await client.workspace.getStartupAutoRetryModel?.({
        workspaceId,
      });
      const startupRetryModel = startupRetryModelResult?.success
        ? startupRetryModelResult.data
        : null;

      // Defensive: in some test environments the orpc client mock can be incomplete.
      // Treat a missing method as a no-op so a single missing mock entry can't cascade
      // into unrelated test failures.
      if (typeof client.workspace?.setAutoCompactionThreshold !== "function") {
        return;
      }

      await client.workspace.setAutoCompactionThreshold({
        workspaceId,
        threshold: this.getStartupAutoCompactionThreshold(workspaceId, startupRetryModel),
      });
    } catch (error) {
      console.warn(
        `[WorkspaceStore] Failed to sync startup auto-compaction threshold for ${workspaceId}:`,
        error
      );
    }
  }

  /**
   * Subscribe to workspace chat events (history replay + live streaming).
   * Retries on unexpected iterator termination to avoid requiring a full app restart.
   */
  private async runOnChatSubscription(workspaceId: string, signal: AbortSignal): Promise<void> {
    await runSubscriptionLoop({
      name: "onChat(" + workspaceId + ")",
      signal,
      getClient: async (attemptSignal) => this.client ?? (await this.waitForClient(attemptSignal)),
      getClientChangeSignal: () => this.clientChangeController.signal,
      subscribe: async (client, attemptSignal, abortAttempt) => {
        const transient = this.chatTransientState.get(workspaceId);
        if (transient) {
          transient.caughtUp = false;
          // Every attempt replays, including retries that keep the same client and cached rows.
          if (!transient.isHydratingTranscript) {
            transient.isHydratingTranscript = true;
            this.states.bump(workspaceId);
          }
        }
        const aggregator = this.aggregators.get(workspaceId);
        let mode: OnChatMode | undefined;
        const attemptContext: OnChatAttemptContext = { abort: abortAttempt };
        if (aggregator) {
          const cursor = aggregator.getOnChatCursor();
          if (cursor?.history) {
            mode = { type: "since", cursor: { history: cursor.history, stream: cursor.stream } };
            attemptContext.since = {
              requestedAnchorSequence: cursor.history.historySequence,
              localActiveStreamMessageId: cursor.stream?.messageId,
            };
          }
        }
        await this.syncAutoCompactionThresholdAtStartup(client, workspaceId);
        const autoRetryKey = getAutoRetryKey(workspaceId);
        const legacyRaw = readPersistedState<unknown>(autoRetryKey, undefined);
        const legacyAutoRetryEnabled = typeof legacyRaw === "boolean" ? legacyRaw : undefined;
        if (legacyRaw !== undefined && legacyAutoRetryEnabled === undefined)
          updatePersistedState<boolean | undefined>(autoRetryKey, undefined);
        const input =
          legacyAutoRetryEnabled === undefined
            ? { workspaceId, mode }
            : { workspaceId, mode, legacyAutoRetryEnabled };
        const iterator = await client.workspace.onChat(input, { signal: attemptSignal });
        if (legacyAutoRetryEnabled !== undefined)
          updatePersistedState<boolean | undefined>(autoRetryKey, undefined);
        if (!mode || mode.type === "full") this.resetChatStateForReplay(workspaceId);
        return { events: iterator, context: attemptContext };
      },
      onEvent: (data, attemptContext, attemptSignal) =>
        queueMicrotask(() => {
          if (!signal.aborted && !attemptSignal.aborted)
            this.handleChatMessage(workspaceId, data, attemptContext);
        }),
      onUnexpectedEnd: ({ attemptAborted }) =>
        console.warn(
          attemptAborted
            ? "[WorkspaceStore] onChat subscription aborted for " + workspaceId + "; retrying..."
            : "[WorkspaceStore] onChat subscription ended unexpectedly for " +
                workspaceId +
                "; retrying..."
        ),
      onError: (error, { attemptAborted }) => {
        const abortError = isAbortError(error);
        if (attemptAborted) {
          if (!abortError)
            console.warn(
              "[WorkspaceStore] onChat subscription aborted for " + workspaceId + "; retrying..."
            );
        } else if (isIteratorValidationFailed(error)) {
          if (!this.isWorkspaceRegistered(workspaceId)) return true;
          console.error(
            "[WorkspaceStore] Event validation failed for " +
              workspaceId +
              ": " +
              formatValidationError(error)
          );
        } else if (!abortError)
          console.error(
            "[WorkspaceStore] Error in onChat subscription for " + workspaceId + ":",
            error
          );
      },
      onAttemptFinished: () => {
        if (!this.isWorkspaceRegistered(workspaceId)) return;
        this.clearReplayBuffers(workspaceId);
        const transient = this.chatTransientState.get(workspaceId);
        if (transient) {
          // Backoff is still catch-up; cleared stream buffers must also invalidate cached barriers.
          transient.isHydratingTranscript = true;
          this.states.bump(workspaceId);
        }
        if (transient && !transient.caughtUp && this.preReplayUsageSnapshot.delete(workspaceId))
          this.usageStore.bump(workspaceId);
        const existingPagination =
          this.historyPagination.get(workspaceId) ?? createInitialHistoryPaginationState();
        this.historyPagination.set(workspaceId, { ...existingPagination, loading: false });
      },
    });
  }

  /**
   * Register a workspace and initialize local state.
   */

  /**
   * Imperative metadata lookup — no React subscription. Safe to call from
   * event handlers / callbacks without causing re-renders.
   */
  getWorkspaceMetadata(workspaceId: string): FrontendWorkspaceMetadata | undefined {
    return this.workspaceMetadata.get(workspaceId);
  }

  addWorkspace(metadata: FrontendWorkspaceMetadata): void {
    const workspaceId = metadata.id;

    // Skip if already registered
    if (this.workspaceMetadata.has(workspaceId)) {
      return;
    }

    // Store metadata for name lookup
    this.workspaceMetadata.set(workspaceId, metadata);
    this.derived.bump("workspaces");

    // Backend guarantees createdAt via config.ts - this should never be undefined
    assert(
      metadata.createdAt,
      `Workspace ${workspaceId} missing createdAt - backend contract violated`
    );

    const aggregator = this.getOrCreateAggregator(
      workspaceId,
      metadata.createdAt,
      metadata.unarchivedAt
    );

    // Initialize recency cache and bump derived store immediately
    // This ensures UI sees correct workspace order before messages load
    const initialRecency = aggregator.getRecencyTimestamp();
    if (initialRecency !== null) {
      this.recencyCache.set(workspaceId, initialRecency);
      this.derived.bump("recency");
    }

    // Initialize transient chat state
    if (!this.chatTransientState.has(workspaceId)) {
      this.chatTransientState.set(workspaceId, createInitialChatTransientState());
    }

    if (!this.historyPagination.has(workspaceId)) {
      this.historyPagination.set(workspaceId, createInitialHistoryPaginationState());
    }

    // Clear stale streaming state
    aggregator.clearActiveStreams();

    // Fetch persisted session usage (fire-and-forget)
    this.refreshSessionUsage(workspaceId);

    // Stats snapshots are subscribed lazily via subscribeStats().
    this.subscribeToStats(workspaceId);
    this.subscribeToTimeline(workspaceId);

    this.ensureActiveOnChatSubscription();

    if (!this.client) {
      console.warn(`[WorkspaceStore] No ORPC client available for workspace ${workspaceId}`);
    }
  }

  markPendingInitialSend(workspaceId: string, pendingStreamModel: string | null): void {
    const aggregator = this.aggregators.get(workspaceId);
    if (!aggregator) {
      return;
    }

    aggregator.markOptimisticPendingStreamStart(pendingStreamModel);
    this.states.bump(workspaceId);
  }

  clearPendingInitialSendState(workspaceId: string, pendingSendId?: string | null): void {
    if (pendingSendId != null) {
      this.clearPendingSend(workspaceId, pendingSendId);
    }

    // Only the optimistic barrier belongs to the creation send; an echoed later send owns it after.
    const aggregator = this.aggregators.get(workspaceId);
    if (
      aggregator?.getPendingStreamStartTime() == null ||
      !aggregator.isOptimisticPendingStreamStart()
    ) {
      return;
    }

    aggregator.clearPendingStreamStart();
    this.states.bump(workspaceId);
  }

  /**
   * Show the composer content in the transcript tail while the send request is in flight.
   * Retired by the backend acknowledgement (a user echo or a queue update), by a replay that
   * must contain the echo, or by clearPendingSend after a failed send.
   */
  beginPendingSend(workspaceId: string, message: PendingSendMessage): void {
    const transient = this.chatTransientState.get(workspaceId);
    const aggregator = this.aggregators.get(workspaceId);
    if (!transient || !aggregator) {
      return;
    }

    transient.pendingSend = {
      message,
      knownUserEchoIds: transient.caughtUp
        ? new Set(
            aggregator
              .getAllMessages()
              .filter(isUserEcho)
              .map((echo) => echo.id)
          )
        : null,
      beganAtMs: Date.now(),
      accepted: false,
      deferredBehindSyntheticTurn: false,
    };
    this.states.bump(workspaceId);
  }

  /** Replace the displayed content of an in-flight pending send (e.g. once files are staged). */
  updatePendingSend(workspaceId: string, message: PendingSendMessage): void {
    const pending = this.chatTransientState.get(workspaceId)?.pendingSend;
    if (pending?.message.id !== message.id) {
      return;
    }

    pending.message = message;
    this.states.bump(workspaceId);
  }

  /**
   * Record that the backend accepted the send, so the next replay is known to contain its echo.
   * A direct send's echo always precedes the response, so an echo displayed by now retires the
   * row; a row still standing belongs to a queued send whose queue update is in flight. Without a
   * baseline the echo cannot be told apart by id, so a caught-up transcript is trusted instead.
   */
  markPendingSendAccepted(workspaceId: string, id: string): void {
    const transient = this.chatTransientState.get(workspaceId);
    const aggregator = this.aggregators.get(workspaceId);
    const pending = transient?.pendingSend;
    if (!transient || !aggregator || pending?.message.id !== id) {
      return;
    }

    pending.accepted = true;
    if (
      transient.caughtUp &&
      (pending.knownUserEchoIds === null || this.hasUnseenUserEcho(aggregator, pending))
    ) {
      transient.pendingSend = null;
      this.states.bump(workspaceId);
    }
  }

  /** Remove the pending send row; a mismatched id means a newer send already replaced it. */
  clearPendingSend(workspaceId: string, id: string): void {
    const transient = this.chatTransientState.get(workspaceId);
    if (transient?.pendingSend?.message.id !== id) {
      return;
    }

    transient.pendingSend = null;
    this.states.bump(workspaceId);
  }

  private hasUnseenUserEcho(
    aggregator: StreamingMessageAggregator,
    pending: PendingSendState
  ): boolean {
    const known = pending.knownUserEchoIds;
    return aggregator
      .getAllMessages()
      .some(
        (message) =>
          isUserEcho(message) &&
          (known ? !known.has(message.id) : (message.metadata?.timestamp ?? 0) >= pending.beganAtMs)
      );
  }

  /**
   * A live user row arrived. A synthetic pre-send compaction request defers the echo behind its
   * turn, drained queue entries echo their own rows, and other synthetic rows (monitor wakes,
   * continuations) are unrelated; anything else is this send's echo.
   */
  private acknowledgePendingSendEcho(
    transient: WorkspaceChatTransientState,
    echo: MuxMessage
  ): void {
    if (echo.metadata?.synthetic === true) {
      if (transient.pendingSend && echo.metadata.muxMetadata?.type === "compaction-request") {
        transient.pendingSend.deferredBehindSyntheticTurn = true;
      }
      return;
    }
    if (transient.queueDispatchesAwaitingEcho > 0) {
      transient.queueDispatchesAwaitingEcho -= 1;
      return;
    }
    transient.pendingSend = null;
  }

  /** A turn that took over the send (pre-send compaction) ended without echoing it. */
  private retirePendingSendAfterAbandonedTurn(workspaceId: string): void {
    const transient = this.chatTransientState.get(workspaceId);
    if (
      transient?.pendingSend?.deferredBehindSyntheticTurn &&
      transient.caughtUp &&
      !transient.replayingHistory
    ) {
      transient.pendingSend = null;
    }
  }

  /**
   * Remove a workspace and clean up subscriptions.
   */
  removeWorkspace(workspaceId: string): void {
    // Clean up consumer manager state
    this.consumerManager.removeWorkspace(workspaceId);

    // Clean up idle callback to prevent stale callbacks
    this.cancelPendingIdleBump(workspaceId);
    this.cancelPendingStreamingBump(workspaceId);
    this.streamingStatsStore.delete(workspaceId);
    this.releaseStreamingMessageChannel(workspaceId);
    const transientForRemoval = this.chatTransientState.get(workspaceId);
    if (transientForRemoval) {
      for (const toolCallId of new Set([
        ...transientForRemoval.liveAdvisorOutput.keys(),
        ...transientForRemoval.liveAdvisorReasoning.keys(),
      ])) {
        this.advisorLiveStore.delete(getAdvisorLiveKey(workspaceId, toolCallId));
      }
    }
    this.lastUserPromptStore.bump(workspaceId);
    this.lastUserPromptStore.delete(workspaceId);

    if (this.activeWorkspaceId === workspaceId) {
      this.activeWorkspaceId = null;
    }

    const statsUnsubscribe = this.statsUnsubscribers.get(workspaceId);
    if (statsUnsubscribe) {
      statsUnsubscribe();
      this.statsUnsubscribers.delete(workspaceId);
    }
    const timelineUnsubscribe = this.timelineUnsubscribers.get(workspaceId);
    if (timelineUnsubscribe) {
      timelineUnsubscribe();
      this.timelineUnsubscribers.delete(workspaceId);
    }

    const unsubscribe = this.ipcUnsubscribers.get(workspaceId);
    if (unsubscribe) {
      unsubscribe();
      this.ipcUnsubscribers.delete(workspaceId);
    }
    if (this.activeOnChatWorkspaceId === workspaceId) {
      this.activeOnChatWorkspaceId = null;
    }

    this.pendingReplayReset.delete(workspaceId);

    // Clean up state
    this.states.delete(workspaceId);
    this.usageStore.delete(workspaceId);
    this.consumersStore.delete(workspaceId);
    this.aggregators.delete(workspaceId);
    this.chatTransientState.delete(workspaceId);
    this.workspaceMetadata.delete(workspaceId);
    this.derived.bump("workspaces");
    this.workspaceActivity.delete(workspaceId);
    this.refreshActiveGoalCount();
    this.workspaceTerminalActivity.delete(workspaceId);
    this.activityStreamingStartRecency.delete(workspaceId);
    this.recencyCache.delete(workspaceId);
    this.workspaceShellStatusCache.delete(workspaceId);
    this.sidebarStateCache.delete(workspaceId);
    this.sidebarStateSourceState.delete(workspaceId);
    this.workspaceCreatedAt.delete(workspaceId);
    this.workspaceStats.delete(workspaceId);
    this.statsStore.delete(workspaceId);
    this.statsListenerCounts.delete(workspaceId);
    this.workspaceTimelines.delete(workspaceId);
    this.timelineStore.delete(workspaceId);
    this.timelineListenerCounts.delete(workspaceId);
    this.historyPagination.delete(workspaceId);
    this.preReplayUsageSnapshot.delete(workspaceId);
    this.sessionUsage.delete(workspaceId);
    this.sessionUsageRequestVersion.delete(workspaceId);

    this.ensureActiveOnChatSubscription();
    this.derived.bump("recency");
  }

  /**
   * Sync workspaces with metadata - add new, remove deleted.
   */
  syncWorkspaces(workspaceMetadata: Map<string, FrontendWorkspaceMetadata>): void {
    const metadataIds = new Set(Array.from(workspaceMetadata.values()).map((m) => m.id));
    const currentIds = new Set(this.workspaceMetadata.keys());

    // Add new workspaces; refresh the metadata snapshot for existing ones so
    // imperative readers (getWorkspaceMetadata) don't act on stale fields
    // (e.g. the pin keybind toggling off a pinnedAt set after initial load).
    for (const metadata of workspaceMetadata.values()) {
      if (!currentIds.has(metadata.id)) {
        this.addWorkspace(metadata);
      } else {
        this.workspaceMetadata.set(metadata.id, metadata);
      }
    }

    // Remove deleted workspaces
    for (const workspaceId of currentIds) {
      if (!metadataIds.has(workspaceId)) {
        this.removeWorkspace(workspaceId);
      }
    }

    // Re-evaluate the active subscription after additions/removals.
    // removeWorkspace can null activeWorkspaceId when the removed workspace
    // was active (e.g., stale singleton state between integration tests),
    // leaving addWorkspace's ensureActiveOnChatSubscription targeting the
    // old workspace. This final call reconciles the subscription with the
    // current activeWorkspaceId + registration state.
    this.ensureActiveOnChatSubscription();
  }

  /**
   * Cleanup all subscriptions (call on unmount).
   */
  dispose(): void {
    // Clean up consumer manager
    this.consumerManager.dispose();

    for (const unsubscribe of this.statsUnsubscribers.values()) {
      unsubscribe();
    }
    this.statsUnsubscribers.clear();
    for (const unsubscribe of this.timelineUnsubscribers.values()) {
      unsubscribe();
    }
    this.timelineUnsubscribers.clear();

    for (const unsubscribe of this.ipcUnsubscribers.values()) {
      unsubscribe();
    }
    this.ipcUnsubscribers.clear();

    if (this.activityAbortController) {
      this.activityAbortController.abort();
      this.activityAbortController = null;
    }

    if (this.terminalActivityAbortController) {
      this.terminalActivityAbortController.abort();
      this.terminalActivityAbortController = null;
    }

    // Abort client-scoped subscriptions (providers.onConfigChanged, stats, etc.)
    // so async iterators/timers cannot mutate cleared state after disposal.
    this.clientChangeController.abort();

    this.activeWorkspaceId = null;
    this.activeOnChatWorkspaceId = null;
    this.pendingReplayReset.clear();
    this.states.clear();
    this.derived.clear();
    this.usageStore.clear();
    this.consumersStore.clear();
    this.aggregators.clear();
    this.chatTransientState.clear();
    this.workspaceMetadata.clear();
    this.workspaceActivity.clear();
    this.activeGoalCount = 0;
    this.activeGoalCountStore.clear();
    this.workspaceTerminalActivity.clear();
    this.activityStreamingStartRecency.clear();
    this.workspaceStats.clear();
    this.statsStore.clear();
    this.statsListenerCounts.clear();
    this.workspaceTimelines.clear();
    this.timelineStore.clear();
    this.timelineListenerCounts.clear();
    this.historyPagination.clear();
    this.preReplayUsageSnapshot.clear();
    this.sessionUsage.clear();
    this.recencyCache.clear();
    this.sidebarStateCache.clear();
    this.workspaceCreatedAt.clear();
  }

  /**
   * Subscribe to file-modifying tool completions.
   * @param listener Called with workspaceId when a file-modifying tool completes
   * @param workspaceId If provided, only notify for this workspace
   */
  subscribeFileModifyingTool(
    listener: (workspaceId: string) => void,
    workspaceId?: string
  ): () => void {
    if (workspaceId) {
      // Per-workspace: wrap listener to match subscribeKey signature
      return this.fileModifyingToolSubs.subscribeKey(workspaceId, () => listener(workspaceId));
    }
    // All workspaces: subscribe to global notifications
    return this.fileModifyingToolSubs.subscribeAny(() => {
      // Notify for all workspaces that have pending changes
      for (const wsId of this.fileModifyingToolMs.keys()) {
        listener(wsId);
      }
    });
  }

  /**
   * Get when a file-modifying tool last completed for this workspace.
   * Returns undefined if no tools have completed since last clear.
   */
  getFileModifyingToolMs(workspaceId: string): number | undefined {
    return this.fileModifyingToolMs.get(workspaceId);
  }

  /**
   * Clear the file-modifying tool timestamp after ReviewPanel has consumed it.
   */
  clearFileModifyingToolMs(workspaceId: string): void {
    this.fileModifyingToolMs.delete(workspaceId);
  }

  /**
   * Simulate a file-modifying tool completion for testing.
   * Triggers the same subscription as a real tool-call-end for file_edit_* or bash.
   */
  simulateFileModifyingToolEnd(workspaceId: string): void {
    this.fileModifyingToolMs.set(workspaceId, Date.now());
    this.fileModifyingToolSubs.bump(workspaceId);
  }

  // Private methods

  /**
   * Get or create aggregator for a workspace.
   *
   * REQUIRES: createdAt must be provided for new aggregators.
   * Backend guarantees every workspace has createdAt via config.ts.
   *
   * If aggregator already exists, createdAt is optional (it was already set during creation).
   */
  private getOrCreateAggregator(
    workspaceId: string,
    createdAt: string,
    unarchivedAt?: string
  ): StreamingMessageAggregator {
    if (!this.aggregators.has(workspaceId)) {
      // Create new aggregator with required createdAt and workspaceId for localStorage persistence
      const aggregator = new StreamingMessageAggregator(createdAt, workspaceId, unarchivedAt);
      // Wire up navigation callback for notification clicks
      if (this.navigateToWorkspaceCallback) {
        aggregator.onNavigateToWorkspace = this.navigateToWorkspaceCallback;
      }
      // Wire up response-complete forwarding for the "notify on response" feature.
      aggregator.onResponseComplete = this.forwardResponseComplete;
      this.aggregators.set(workspaceId, aggregator);
      this.workspaceCreatedAt.set(workspaceId, createdAt);
    } else if (unarchivedAt) {
      // Update unarchivedAt on existing aggregator (e.g., after restore from archive)
      this.aggregators.get(workspaceId)!.setUnarchivedAt(unarchivedAt);
    }

    return this.aggregators.get(workspaceId)!;
  }

  private shouldBumpStateForBufferedStreamFallback(data: WorkspaceChatMessage): boolean {
    if (!("type" in data)) {
      return false;
    }

    return (
      data.type === "stream-start" ||
      data.type === "stream-end" ||
      data.type === "stream-abort" ||
      data.type === "stream-error"
    );
  }

  /**
   * Check if data is a buffered event type by checking the handler map.
   * This ensures isStreamEvent() and processStreamEvent() can never fall out of sync.
   */
  private isBufferedEvent(data: WorkspaceChatMessage): boolean {
    if (!("type" in data)) {
      return false;
    }

    // Buffer high-frequency stream events (including bash/task/advisor live updates) until
    // caught-up so full-replay reconnects can deterministically rebuild transient state.
    return (
      data.type in this.bufferedEventHandlers ||
      data.type === "bash-output" ||
      data.type === "advisor-output" ||
      data.type === "advisor-reasoning-output" ||
      data.type === "advisor-phase" ||
      data.type === "task-created" ||
      data.type === "workflow-run-attached"
    );
  }

  private handleChatMessage(
    workspaceId: string,
    data: WorkspaceChatMessage,
    attemptContext?: OnChatAttemptContext
  ): void {
    // Aggregator must exist - workspaces are initialized in addWorkspace() before subscriptions run.
    const aggregator = this.assertGet(workspaceId);

    const transient = this.assertChatTransientState(workspaceId);

    if (isCaughtUpMessage(data)) {
      const replay = data.replay ?? "full";

      if (data.downgradeReason !== undefined) {
        // Dev observability: a requested since reconnect was downgraded to a full
        // replay server-side. Silent downgrades previously hid full re-transfers.
        console.debug(
          `[WorkspaceStore] onChat replay downgraded to full for ${workspaceId}: ${data.downgradeReason}`
        );
      }

      // The server reports since only when this client requested it, so the attempt
      // context must carry the requested anchor. If it is somehow missing, appending
      // would let stale suffix rows survive and replace-mode would drop rows below the
      // anchor — force a clean full resubscribe instead. The deferred reset behavior
      // (resetChatStateForReplay runs only after the next attempt's iterator is
      // established) keeps the current UI visible until the full replay lands.
      const sinceContext = replay === "since" ? attemptContext?.since : undefined;
      if (replay === "since" && !sinceContext) {
        console.warn(
          `[WorkspaceStore] since caught-up without an attempt anchor for ${workspaceId}; forcing full resubscribe`
        );
        aggregator.setServerHistoryCursor(null);
        this.clearReplayBuffers(workspaceId);
        attemptContext?.abort();
        return;
      }

      // Check if there's an active stream in buffered events (reconnection scenario).
      const pendingEvents = transient.pendingStreamEvents;
      const hasActiveStream = getBufferedActiveStreamStart(pendingEvents) !== null;

      const serverActiveStreamMessageId = data.cursor?.stream?.messageId;
      const localActiveStreamMessageId = aggregator.getActiveStreamMessageId();
      const streamContextMismatched =
        serverActiveStreamMessageId !== undefined &&
        serverActiveStreamMessageId !== localActiveStreamMessageId;

      // Track the server's replay window start for accurate reconnect cursors.
      // This prevents loadOlderHistory-prepended pages from polluting the cursor.
      const serverOldestSeq = data.cursor?.history?.oldestHistorySequence;
      if (typeof serverOldestSeq === "number") {
        aggregator.setEstablishedOldestHistorySequence(serverOldestSeq);
      }

      // Defensive cleanup:
      // - full replay means backend rebuilt state from scratch, so stale local stream contexts
      //   must be cleared even if a stream cursor is present in caught-up metadata.
      // - no stream cursor means no active stream exists server-side.
      // - mismatched stream IDs means local context is stale (e.g., stream A ended while
      //   disconnected and stream B is now active), so clear before replaying pending events.
      if (
        replay === "full" ||
        serverActiveStreamMessageId === undefined ||
        streamContextMismatched
      ) {
        aggregator.clearActiveStreams();
      }
      // When server confirms no active stream, a normal pending-start is stale and should end.
      // Preserve exactly one optimistic new-chat catch-up cycle: the first authoritative idle
      // caught-up can arrive before the delayed first send is replayed, but if a later catch-up
      // still reports no active stream then the optimistic barrier was stale and must clear.
      if (serverActiveStreamMessageId === undefined) {
        aggregator.clearPendingStreamStartIfNotOptimistic();
      }

      if (replay === "full") {
        // Full replay replaces backend-derived history state. Reset transient UI-only
        // fields before replay hydration so stale values do not survive reconnect fallback.
        // queuedMessage is safe to clear because backend now replays a fresh
        // queued-message-changed snapshot before caught-up.
        transient.queuedMessage = null;

        // Auto-retry status is ephemeral and may have resolved while disconnected.
        // Clear stale banners so reconnect UI reflects replayed events only.
        transient.autoRetryStatus = null;

        // Server can downgrade a requested since reconnect to full replay.
        // Clear stale interruption suppression state so retry UI is derived solely
        // from the replayed transcript instead of a pre-disconnect abort reason.
        aggregator.clearLastAbortReason();
      }

      if (replay === "full" || !data.cursor?.stream || streamContextMismatched) {
        // Live tool-call UI is tied to the active stream context; clear it when replay
        // replaces history, reports no active stream, or reports a different stream ID.
        const clearedAdvisorToolCallIds = new Set([
          ...transient.liveAdvisorOutput.keys(),
          ...transient.liveAdvisorReasoning.keys(),
        ]);
        transient.liveBashOutput.clear();
        transient.liveAdvisorOutput.clear();
        transient.liveAdvisorReasoning.clear();
        transient.liveAdvisorPhase.clear();
        transient.liveWorkflowRuns.clear();
        transient.liveTaskIds.clear();
        // delete() notifies subscribers, so mounted advisor cards re-read null
        // instead of keeping pre-reconnect live output.
        for (const toolCallId of clearedAdvisorToolCallIds) {
          this.advisorLiveStore.delete(getAdvisorLiveKey(workspaceId, toolCallId));
        }
      }

      if (sinceContext) {
        // Since replay: the replayed rows are the authoritative suffix for
        // rows at/above the requested anchor. Preserve the richer local assembly of
        // the active stream only when the server-confirmed stream matches the local
        // stream the attempt's cursor was built from; otherwise replayed rows plus
        // subsequently replayed stream events rebuild the stream message (stale local
        // contexts were already cleared above).
        const preservedActiveStreamMessageId =
          serverActiveStreamMessageId !== undefined &&
          serverActiveStreamMessageId === sinceContext.localActiveStreamMessageId
            ? serverActiveStreamMessageId
            : undefined;
        aggregator.reconcileSinceReplay({
          requestedAnchorSequence: sinceContext.requestedAnchorSequence,
          messages: transient.historicalMessages,
          preservedActiveStreamMessageId,
          hasActiveStream,
        });
        transient.historicalMessages.length = 0;
      } else if (transient.historicalMessages.length > 0) {
        const loadMode = replay === "full" ? "replace" : "append";
        aggregator.loadHistoricalMessages(transient.historicalMessages, hasActiveStream, {
          mode: loadMode,
        });
        transient.historicalMessages.length = 0;
      } else if (replay === "full") {
        // Full replay can legitimately contain zero messages (e.g. compacted to empty).
        aggregator.loadHistoricalMessages([], hasActiveStream, { mode: "replace" });
      }

      // Store the server-issued cursor for the next reconnect (full and since replays
      // both refresh it). A caught-up without a cursor means the server could not
      // advertise a trustworthy reconnect point (e.g. replay failure), so clear the
      // stored cursor and let the next subscribe fall back to a full replay.
      aggregator.setServerHistoryCursor(data.cursor?.history ?? null);

      // Mark that we're replaying buffered history (prevents O(N) scheduling)
      transient.replayingHistory = true;

      // Process buffered stream events now that history is loaded
      for (const event of pendingEvents) {
        this.processStreamEvent(workspaceId, aggregator, event);
      }
      pendingEvents.length = 0;

      // Done replaying buffered events.
      transient.replayingHistory = false;

      if (replay === "since" && data.hasOlderHistory === undefined) {
        // Since reconnects keep the pre-disconnect pagination state. The server
        // omits hasOlderHistory for this mode because the client already knows it.
        if (!this.historyPagination.has(workspaceId)) {
          this.historyPagination.set(workspaceId, createInitialHistoryPaginationState());
        }
      } else {
        this.historyPagination.set(
          workspaceId,
          this.deriveHistoryPaginationState(aggregator, data.hasOlderHistory)
        );
      }
      // Mark as caught up
      transient.caughtUp = true;
      transient.isHydratingTranscript = false;
      // An accepted send is in the replayed history; an unaccepted one is only retired when
      // the replay shows its echo, so a reconnect during preflight keeps the row.
      const pendingSend = transient.pendingSend;
      if (
        pendingSend &&
        (pendingSend.accepted || this.hasUnseenUserEcho(aggregator, pendingSend))
      ) {
        transient.pendingSend = null;
      }
      this.lastUserPromptStore.bump(workspaceId);
      this.states.bump(workspaceId);
      this.checkAndBumpRecencyIfChanged(); // Messages loaded, update recency

      // Replay resets clear the aggregator before history is rebuilt. Drop the temporary
      // fallback snapshot and recompute usage immediately once catch-up is authoritative.
      this.preReplayUsageSnapshot.delete(workspaceId);
      this.usageStore.bump(workspaceId);

      // Hydrate consumer breakdown from persisted cache when possible.
      // Fall back to tokenization when no cache (or stale cache) exists.
      if (aggregator.getAllMessages().length > 0) {
        this.ensureConsumersCached(workspaceId, aggregator);
      }

      // The requested anchor is consumed by exactly one caught-up. A duplicate
      // caught-up in the same attempt would be anomalous; dropping the anchor makes
      // it hit the hard fallback above instead of reconciling against a stale anchor.
      if (attemptContext) {
        attemptContext.since = undefined;
      }

      return;
    }

    // Heartbeat events are no-ops for UI state - they exist only for connection liveness detection
    if ("type" in data && data.type === "heartbeat") {
      return;
    }

    // OPTIMIZATION: Buffer stream events until caught-up to reduce excess re-renders
    // When first subscribing to a workspace, we receive:
    // 1. Historical messages from chat.jsonl (potentially hundreds of messages)
    // 2. Partial stream state (if stream was interrupted)
    // 3. Active stream events (if currently streaming)
    //
    // Without buffering, each event would trigger a separate re-render as messages
    // arrive one-by-one over IPC. By buffering until "caught-up", we:
    // - Load all historical messages in one batch (O(1) render instead of O(N))
    // - Replay buffered stream events after history is loaded
    // - Provide correct context for stream continuation (history is complete)
    //
    // This is especially important for workspaces with long histories (100+ messages),
    // where unbuffered rendering would cause visible lag and UI stutter.
    if (!transient.caughtUp && isStreamError(data) && data.replay === true) {
      // Show replayed terminal errors immediately so reconnect UIs preserve the same
      // failure classification/copy as the live session, then replay them again after
      // history loads so full-replay replacement does not wipe the error back out.
      applyWorkspaceChatEventToAggregator(aggregator, data, { allowSideEffects: false });
      transient.pendingStreamEvents.push(data);
      // WorkspaceState may now clear its buffered active-stream fallback based on the appended
      // terminal error, so invalidate after the pending-events snapshot is up to date.
      this.states.bump(workspaceId);
      return;
    }

    if (!transient.caughtUp && this.isBufferedEvent(data)) {
      const shouldApplyImmediately =
        isStreamLifecycle(data) ||
        isStreamAbort(data) ||
        isRuntimeStatus(data) ||
        isInitStart(data) ||
        isInitOutput(data) ||
        isInitEnd(data);

      if (shouldApplyImmediately) {
        // SSH/Coder init replay can be the only transcript content for a new workspace.
        // Apply it immediately so reconnects show the latest init snapshot before caught-up;
        // the aggregator treats replayed init-start/output as idempotent, so the buffered
        // catch-up pass can reuse the same events without blanking or duplicating the row.
        applyWorkspaceChatEventToAggregator(aggregator, data, { allowSideEffects: false });
        if (isInitOutput(data)) {
          aggregator.flushPendingInitOutput();
          this.scheduleIdleStateBump(workspaceId);
        } else {
          this.states.bump(workspaceId);
        }
      }

      transient.pendingStreamEvents.push(data);
      if (this.shouldBumpStateForBufferedStreamFallback(data)) {
        // WorkspaceState now derives the streaming barrier fallback from pending stream events,
        // so buffered start/terminal transitions must invalidate the memoized hydration snapshot.
        this.states.bump(workspaceId);
      }
      return;
    }

    // Process event immediately (already caught up or not a stream event)
    this.processStreamEvent(workspaceId, aggregator, data);
  }

  private processStreamEvent(
    workspaceId: string,
    aggregator: StreamingMessageAggregator,
    data: WorkspaceChatMessage
  ): void {
    // Handle special events first
    if (isStreamError(data)) {
      const transient = this.assertChatTransientState(workspaceId);

      // Suppress side effects during buffered replay (we're just hydrating UI state), but allow
      // live errors to trigger mux-gateway session-expired handling even before we're "caught up".
      // In particular, mux-gateway 401s can surface as a pre-stream stream-error (before any
      // stream-start) during startup/reconnect.
      const allowSideEffects = !transient.replayingHistory;

      applyWorkspaceChatEventToAggregator(aggregator, data, { allowSideEffects });

      // stream-error is a terminal stream event, just like stream-end/stream-abort.
      // Mirror their cleanup so subscribers don't see stale streaming stats from the
      // failed stream — applyWorkspaceChatEventToAggregator already cleared token
      // state; we now flush any pending coalesced bump and invalidate the
      // streamingStatsStore cache so useWorkspaceStreamingStats returns null.
      this.cancelPendingIdleBump(workspaceId);
      this.cancelPendingStreamingBump(workspaceId);
      this.releaseStreamingMessageChannel(workspaceId);
      this.retirePendingSendAfterAbandonedTurn(workspaceId);
      this.states.bump(workspaceId);
      this.streamingStatsStore.bump(workspaceId);
      return;
    }

    if (isDeleteMessage(data)) {
      applyWorkspaceChatEventToAggregator(aggregator, data);
      this.cleanupStaleLiveToolState(workspaceId, aggregator);
      this.lastUserPromptStore.bump(workspaceId);
      this.states.bump(workspaceId);
      this.checkAndBumpRecencyIfChanged();
      this.usageStore.bump(workspaceId);
      this.consumerManager.scheduleCalculation(workspaceId, aggregator);
      return;
    }

    if (isBashOutputEvent(data)) {
      if (data.text.length === 0) return;

      const transient = this.assertChatTransientState(workspaceId);

      const prev = transient.liveBashOutput.get(data.toolCallId);
      const next = appendLiveBashOutputChunk(
        prev,
        { text: data.text, isError: data.isError },
        BASH_TRUNCATE_MAX_TOTAL_BYTES
      );

      // Avoid unnecessary re-renders if this event didn't change the stored state.
      if (next === prev) return;

      transient.liveBashOutput.set(data.toolCallId, next);

      // High-frequency: throttle UI updates like other delta-style events.
      this.scheduleIdleStateBump(workspaceId);
      return;
    }

    if (isAdvisorOutputEvent(data)) {
      if (data.text.length === 0) return;

      const transient = this.assertChatTransientState(workspaceId);
      if (
        !appendAdvisorLiveText(
          transient.liveAdvisorOutput,
          data.toolCallId,
          data.text,
          data.timestamp
        )
      ) {
        return;
      }

      this.advisorLiveStore.bump(getAdvisorLiveKey(workspaceId, data.toolCallId));
      return;
    }

    if (isAdvisorReasoningOutputEvent(data)) {
      if (data.text.length === 0) return;

      const transient = this.assertChatTransientState(workspaceId);
      if (
        !appendAdvisorLiveText(
          transient.liveAdvisorReasoning,
          data.toolCallId,
          data.text,
          data.timestamp
        )
      ) {
        return;
      }

      this.advisorLiveStore.bump(getAdvisorLiveKey(workspaceId, data.toolCallId));
      return;
    }

    if (isAdvisorPhaseEvent(data)) {
      const transient = this.assertChatTransientState(workspaceId);
      const prev = transient.liveAdvisorPhase.get(data.toolCallId);

      // Avoid unnecessary re-renders if the phase is unchanged.
      if (prev?.phase === data.phase) return;

      transient.liveAdvisorPhase.set(data.toolCallId, {
        phase: data.phase,
        timestamp: data.timestamp,
      });

      // Low-frequency: bump immediately so advisor progress updates feel responsive.
      this.states.bump(workspaceId);
      return;
    }

    if (isWorkflowRunAttachedEvent(data)) {
      const transient = this.assertChatTransientState(workspaceId);
      const current = transient.liveWorkflowRuns.get(data.toolCallId);
      const nextRun = data.run ?? (current?.runId === data.runId ? current.run : undefined);
      if (current?.runId === data.runId && current.run === nextRun) {
        return;
      }

      transient.liveWorkflowRuns.set(data.toolCallId, {
        runId: data.runId,
        ...(nextRun != null ? { run: nextRun } : {}),
      });

      this.states.bump(workspaceId);
      return;
    }

    if (isTaskCreatedEvent(data)) {
      const transient = this.assertChatTransientState(workspaceId);

      const prev = transient.liveTaskIds.get(data.toolCallId) ?? [];
      if (prev.includes(data.taskId)) return;

      transient.liveTaskIds.set(data.toolCallId, [...prev, data.taskId]);

      // Low-frequency: bump immediately so the user can open the child workspace quickly.
      this.states.bump(workspaceId);
      return;
    }
    // Try buffered event handlers (single source of truth)
    if ("type" in data && data.type in this.bufferedEventHandlers) {
      this.bufferedEventHandlers[data.type](workspaceId, aggregator, data);
      return;
    }

    // Regular messages (XumMessage without type field)
    if (isMuxMessage(data)) {
      const transient = this.assertChatTransientState(workspaceId);

      if (!transient.caughtUp) {
        // Buffer historical XumMessages
        transient.historicalMessages.push(data);
      } else {
        // Process live events immediately (after history loaded)
        applyWorkspaceChatEventToAggregator(aggregator, data);

        if (data.role === "user") {
          this.acknowledgePendingSendEcho(transient, data);
        }

        const muxMeta = data.metadata?.muxMetadata as { type?: string } | undefined;
        const isCompactionBoundarySummary =
          data.role === "assistant" &&
          (data.metadata?.compactionBoundary === true || muxMeta?.type === "compaction-summary");

        if (isCompactionBoundarySummary) {
          // Live compaction prunes older messages inside the aggregator; refresh the
          // pagination cursor so "Load more" starts from the new oldest visible sequence.
          this.historyPagination.set(workspaceId, this.deriveHistoryPaginationState(aggregator));
        }

        // Whole messages can change the last human prompt; token/tool deltas cannot.
        this.lastUserPromptStore.bump(workspaceId);
        this.states.bump(workspaceId);
        this.usageStore.bump(workspaceId);
        this.checkAndBumpRecencyIfChanged();
      }
      return;
    }

    // If we reach here, unknown message type - log for debugging
    if ("role" in data || "type" in data) {
      console.error("[WorkspaceStore] Unknown message type - not processed", {
        workspaceId,
        hasRole: "role" in data,
        hasType: "type" in data,
        type: "type" in data ? (data as { type: string }).type : undefined,
        role: "role" in data ? (data as { role: string }).role : undefined,
      });
    }
    // Note: Messages without role/type are silently ignored (expected for some IPC events)
  }
}

// ============================================================================
// React Integration with useSyncExternalStore
// ============================================================================

// Singleton store instance
let storeInstance: WorkspaceStore | null = null;

/**
 * Get or create the singleton WorkspaceStore instance.
 */
function getStoreInstance(): WorkspaceStore {
  storeInstance ??= new WorkspaceStore(() => {
    // Model tracking callback - can hook into other systems if needed
  });
  return storeInstance;
}

/**
 * Direct access to the singleton store instance.
 * Use this for non-hook subscriptions (e.g., in useEffect callbacks).
 */
export const workspaceStore = {
  subscribeFileModifyingTool: (listener: (workspaceId: string) => void, workspaceId?: string) =>
    getStoreInstance().subscribeFileModifyingTool(listener, workspaceId),
  getFileModifyingToolMs: (workspaceId: string) =>
    getStoreInstance().getFileModifyingToolMs(workspaceId),
  clearFileModifyingToolMs: (workspaceId: string) =>
    getStoreInstance().clearFileModifyingToolMs(workspaceId),
  /**
   * Simulate a file-modifying tool completion for testing.
   * Triggers the same subscription as a real tool-call-end for file_edit_* or bash.
   */
  simulateFileModifyingToolEnd: (workspaceId: string) =>
    getStoreInstance().simulateFileModifyingToolEnd(workspaceId),
  /**
   * Get sidebar-specific state for a workspace.
   * Useful in tests for checking recencyTimestamp without hooks.
   */
  getWorkspaceSidebarState: (workspaceId: string) =>
    getStoreInstance().getWorkspaceSidebarState(workspaceId),
  /**
   * Register a workspace in the store (idempotent).
   * Exposed for test helpers that need to ensure workspace registration
   * before setting it as active.
   */
  addWorkspace: (metadata: FrontendWorkspaceMetadata) => getStoreInstance().addWorkspace(metadata),
  /**
   * Mark a newly-created workspace as having its first send in flight.
   * Used by creation mode so the transcript can show the starting barrier immediately.
   */
  markPendingInitialSend: (workspaceId: string, pendingStreamModel: string | null) =>
    getStoreInstance().markPendingInitialSend(workspaceId, pendingStreamModel),
  clearPendingInitialSendState: (workspaceId: string, pendingSendId?: string | null) =>
    getStoreInstance().clearPendingInitialSendState(workspaceId, pendingSendId),
  beginPendingSend: (workspaceId: string, message: PendingSendMessage) =>
    getStoreInstance().beginPendingSend(workspaceId, message),
  updatePendingSend: (workspaceId: string, message: PendingSendMessage) =>
    getStoreInstance().updatePendingSend(workspaceId, message),
  markPendingSendAccepted: (workspaceId: string, id: string) =>
    getStoreInstance().markPendingSendAccepted(workspaceId, id),
  /**
   * Set the active workspace for onChat subscription management.
   * Exposed for test helpers that bypass React routing effects.
   */
  setActiveWorkspaceId: (workspaceId: string | null) =>
    getStoreInstance().setActiveWorkspaceId(workspaceId),
};

/**
 * Hook to get state for a specific workspace.
 * Only re-renders when THIS workspace's state changes.
 *
 * Uses per-key subscription for surgical updates - only notified when
 * this specific workspace's state changes.
 */
export function useWorkspaceState(workspaceId: string): WorkspaceState {
  const store = getStoreInstance();

  return useSyncExternalStore(
    (listener) => store.subscribeKey(workspaceId, listener),
    () => store.getWorkspaceState(workspaceId)
  );
}

/**
 * Hook to get the shell-only workspace status.
 *
 * WorkspaceShell only needs placeholder/hydration gates; subscribing to the full
 * WorkspaceState would cascade every transcript delta through the shell and sidebars.
 */
export function useWorkspaceShellStatus(workspaceId: string): WorkspaceShellStatus {
  const store = getStoreInstance();

  return useSyncExternalStore(
    (listener) => store.subscribeKey(workspaceId, listener),
    () => store.getWorkspaceShellStatus(workspaceId)
  );
}

/**
 * Hook to access the raw store for imperative operations.
 */
export function useWorkspaceStoreRaw(): WorkspaceStore {
  return getStoreInstance();
}

/**
 * Hook to get workspace recency timestamps.
 * Subscribes to derived state since recency is updated via derived.bump("recency").
 */
export function useWorkspaceRecency(): Record<string, number> {
  const store = getStoreInstance();

  return useSyncExternalStore(store.subscribeDerived, () => store.getWorkspaceRecency());
}

export function useActiveGoalCount(): number {
  const store = getStoreInstance();

  return useSyncExternalStore(
    store.subscribeActiveGoalCount,
    () => store.getActiveGoalCount(),
    () => 0
  );
}

export function useWorkspaceLastUserPromptInfo(
  workspaceId: string
): WorkspaceLastUserPromptInfo | null {
  const store = getStoreInstance();
  const { displayed, historyEpoch, isCaughtUp } = useSyncExternalStore(
    (listener) => store.subscribeLastUserPrompt(workspaceId, listener),
    () => store.getWorkspaceLastUserPromptSnapshot(workspaceId)
  );

  // Compaction can hide the latest user prompt behind the replay boundary.
  const [fallback, setFallback] = useState<{
    workspaceId: string;
    historyEpoch: number;
    prompt: WorkspaceLastUserPromptInfo | null;
  } | null>(null);

  useEffect(() => {
    if (displayed !== null || !isCaughtUp) {
      return;
    }
    let cancelled = false;
    void store.fetchLastUserPromptFromHistory(workspaceId).then((prompt) => {
      if (!cancelled) {
        setFallback({ workspaceId, historyEpoch, prompt });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [store, workspaceId, displayed, historyEpoch, isCaughtUp]);

  // Ignore fallback results from a superseded replay or deletion.
  return fallback?.workspaceId === workspaceId && fallback.historyEpoch === historyEpoch
    ? (displayed ?? fallback.prompt)
    : displayed;
}

export function useWorkspaceLastUserPrompt(workspaceId: string): string | null {
  return useWorkspaceLastUserPromptInfo(workspaceId)?.text ?? null;
}

/**
 * Hook to get sidebar-specific state for a workspace.
 * Only re-renders when sidebar-relevant fields change (not on every message).
 *
 * getWorkspaceSidebarState returns cached references, so this won't cause
 * unnecessary re-renders even when the subscription fires.
 */
export function useWorkspaceSidebarState(workspaceId: string): WorkspaceSidebarState {
  const store = getStoreInstance();

  return useSyncExternalStore(
    (listener) => store.subscribeKey(workspaceId, listener),
    () => store.getWorkspaceSidebarState(workspaceId)
  );
}

export function useOptionalWorkspaceSidebarState(
  workspaceId: string | null | undefined
): WorkspaceSidebarState | null {
  const store = getStoreInstance();
  const id = workspaceId ?? "";

  return useSyncExternalStore(
    (listener) => {
      if (!store.hasRegisteredWorkspace(id)) {
        return () => undefined;
      }
      return store.subscribeKey(id, listener);
    },
    () => {
      if (!store.hasRegisteredWorkspace(id)) {
        return null;
      }
      return store.getWorkspaceSidebarState(id);
    }
  );
}

/**
 * Hook to get UI-only live stdout/stderr for a running bash tool call.
 */
export function useBashToolLiveOutput(
  workspaceId: string | undefined,
  toolCallId: string | undefined
): LiveBashOutputView | null {
  const store = getStoreInstance();

  return useSyncExternalStore(
    (listener) => {
      if (!workspaceId) return () => undefined;
      return store.subscribeKey(workspaceId, listener);
    },
    () => {
      if (!workspaceId || !toolCallId) return null;
      return store.getBashToolLiveOutput(workspaceId, toolCallId);
    }
  );
}

/**
 * Hook to get UI-only live output for a running advisor tool call.
 */
export function useAdvisorToolLiveOutput(
  workspaceId: string | undefined,
  toolCallId: string | undefined
): AdvisorLiveOutputState | null {
  const store = getStoreInstance();

  return useSyncExternalStore(
    (listener) => {
      if (!workspaceId || !toolCallId) return () => undefined;
      return store.subscribeAdvisorLive(workspaceId, toolCallId, listener);
    },
    () => {
      if (!workspaceId || !toolCallId) return null;
      return store.getAdvisorToolLiveOutput(workspaceId, toolCallId);
    }
  );
}

/**
 * Hook to get UI-only live reasoning for a running advisor tool call.
 */
export function useAdvisorToolLiveReasoning(
  workspaceId: string | undefined,
  toolCallId: string | undefined
): AdvisorLiveReasoningState | null {
  const store = getStoreInstance();

  return useSyncExternalStore(
    (listener) => {
      if (!workspaceId || !toolCallId) return () => undefined;
      return store.subscribeAdvisorLive(workspaceId, toolCallId, listener);
    },
    () => {
      if (!workspaceId || !toolCallId) return null;
      return store.getAdvisorToolLiveReasoning(workspaceId, toolCallId);
    }
  );
}

/**
 * Hook to get UI-only live advisor phase for a running advisor tool call.
 */
export function useAdvisorToolLivePhase(
  workspaceId: string | undefined,
  toolCallId: string | undefined
): AdvisorLivePhaseState | undefined {
  const store = getStoreInstance();

  return useSyncExternalStore(
    (listener) => {
      if (!workspaceId) return () => undefined;
      return store.subscribeKey(workspaceId, listener);
    },
    () => {
      if (!workspaceId || !toolCallId) return undefined;
      return store.getAdvisorToolLivePhase(workspaceId, toolCallId);
    }
  );
}

/**
 * Hook to get UI-only taskId for a running task tool call.
 *
 * This exists because foreground tasks (run_in_background=false) won't return a tool result
 * until the child workspace finishes, but we still want to expose the spawned taskId ASAP.
 */
export function useTaskToolLiveTaskIds(
  workspaceId: string | undefined,
  toolCallId: string | undefined
): string[] | null {
  const store = getStoreInstance();

  return useSyncExternalStore(
    (listener) => {
      if (!workspaceId) return () => undefined;
      return store.subscribeKey(workspaceId, listener);
    },
    () => {
      if (!workspaceId || !toolCallId) return null;
      return store.getTaskToolLiveTaskIds(workspaceId, toolCallId);
    }
  );
}

/**
 * Hook to get the exact durable workflow run attached to a running workflow tool call.
 */
export function useWorkflowToolLiveRun(
  workspaceId: string | undefined,
  toolCallId: string | undefined
): WorkflowToolLiveRunState | null {
  const store = getStoreInstance();

  return useSyncExternalStore(
    (listener) => {
      if (!workspaceId || !toolCallId) return () => undefined;
      return store.subscribeKey(workspaceId, listener);
    },
    () => {
      if (!workspaceId || !toolCallId) return null;
      return store.getWorkflowToolLiveRun(workspaceId, toolCallId);
    }
  );
}

/**
 * Hook to get an aggregator for a workspace.
 */
export function useWorkspaceAggregator(
  workspaceId: string
): StreamingMessageAggregator | undefined {
  const store = useWorkspaceStoreRaw();
  return store.getAggregator(workspaceId);
}

/** Keep a Timeline reveal target renderable while preserving transcript DOM capping. */
export function pinTimelineRevealTarget(
  workspaceId: string,
  target: { messageId?: string; toolCallId?: string }
): void {
  const store = getStoreInstance();
  const aggregator = store.getAggregator(workspaceId);
  if (aggregator) {
    aggregator.setTranscriptRevealTarget(target);
    store.bumpState(workspaceId);
  }
}

/**
 * Disable the displayed message cap for a workspace and trigger a re-render.
 * Used by HistoryHiddenMessage “Load all”.
 */
export function showAllMessages(workspaceId: string): void {
  assert(
    typeof workspaceId === "string" && workspaceId.length > 0,
    "showAllMessages requires workspaceId"
  );

  const store = getStoreInstance();
  const aggregator = store.getAggregator(workspaceId);
  if (aggregator) {
    aggregator.setShowAllMessages(true);
    store.bumpState(workspaceId);
  }
}

/**
 * Newest staged /refine proposal hash RENDERED in this window (r64).
 * /refine apply must bind approval to the proposal THIS user saw: with
 * XUM_ALLOW_MULTIPLE_INSTANCES=1 the shared chat transcript can contain a
 * newer proposal from another backend that this renderer never displayed,
 * so the backend cannot infer the displayed proposal from the transcript
 * alone. Scans newest-first for a refine-summary row carrying a
 * stagedSetHash, restricted to rows the transcript actually RENDERS (r68):
 * the DOM display cap can hide a proposal row from internal history (e.g. a
 * window opened after a foreign backend staged it, with enough later chat
 * to push it past the cap), and approving a hidden proposal would apply
 * memory/skill edits the user never saw. A hidden newer proposal also
 * cannot be applied via an older visible hash — the backend re-hashes the
 * staged set and refuses the mismatch — so filtering here fails safe.
 */
export function getDisplayedRefineProposalHash(workspaceId: string): string | null {
  const aggregator = getStoreInstance().getAggregator(workspaceId);
  return aggregator ? findRenderedRefineProposalHash(aggregator) : null;
}

/** Pure scan behind getDisplayedRefineProposalHash, exported for tests. */
export function findRenderedRefineProposalHash(
  aggregator: StreamingMessageAggregator
): string | null {
  // The rendered row set: display-capped unless "Load all" disabled the cap.
  const renderedHistoryIds = new Set<string>();
  for (const displayed of aggregator.getDisplayedMessages()) {
    if ("historyId" in displayed) {
      renderedHistoryIds.add(displayed.historyId);
    }
  }
  const messages = aggregator.getAllMessages();
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const muxMetadata = message.metadata?.muxMetadata;
    if (
      muxMetadata?.type === "refine-summary" &&
      typeof muxMetadata.stagedSetHash === "string" &&
      muxMetadata.stagedSetHash.length > 0 &&
      renderedHistoryIds.has(message.id)
    ) {
      return muxMetadata.stagedSetHash;
    }
  }
  return null;
}

/**
 * Add an ephemeral message to a workspace and trigger a re-render.
 * Used for displaying frontend-only messages like /plan output.
 */
export function addEphemeralMessage(workspaceId: string, message: MuxMessage): void {
  const store = getStoreInstance();
  const aggregator = store.getAggregator(workspaceId);
  if (aggregator) {
    aggregator.addMessage(message);
    store.bumpState(workspaceId);
  }
}

/**
 * Remove an ephemeral message from a workspace and trigger a re-render.
 * Used for dismissing frontend-only messages like /plan output.
 */
export function removeEphemeralMessage(workspaceId: string, messageId: string): void {
  const store = getStoreInstance();
  const aggregator = store.getAggregator(workspaceId);
  if (aggregator) {
    aggregator.removeMessage(messageId);
    store.bumpState(workspaceId);
  }
}

/**
 * Hook for usage metadata (instant, no tokenization).
 * Updates immediately when usage metadata arrives from API responses.
 */
export function useWorkspaceUsage(workspaceId: string): WorkspaceUsageState {
  const store = getStoreInstance();
  return useSyncExternalStore(
    (listener) => store.subscribeUsage(workspaceId, listener),
    () => store.getWorkspaceUsage(workspaceId)
  );
}

/**
 * True once the workspace's persisted session-usage fetch has settled this
 * app session (success or failure). Lets the chat view's first-paint barrier
 * distinguish "usage unknown" from "no usage" so usage-derived banners
 * (CompactionWarning) can't pop in after the transcript reveals.
 */
export function useSessionUsageKnown(workspaceId: string): boolean {
  const store = getStoreInstance();
  return useSyncExternalStore(
    (listener) => store.subscribeUsage(workspaceId, listener),
    () => store.isSessionUsageKnown(workspaceId)
  );
}

/**
 * True once the initial cross-workspace activity snapshot has been applied
 * (or its subscription self-healed after failure). See activityHydrated.
 */
export function useWorkspaceActivityHydrated(): boolean {
  const store = getStoreInstance();
  return useSyncExternalStore(store.subscribeActivityHydrated, store.isActivityHydrated);
}

/**
 * True only after a REAL activity snapshot list was applied — never via the
 * failure-path self-heal. Gate logic that must not misread the empty failure-path
 * map as "no activity" (e.g. auto-activation baselines) on this, not on hydrated.
 */
export function useWorkspaceActivityAuthoritative(): boolean {
  const store = getStoreInstance();
  return useSyncExternalStore(store.subscribeActivityHydrated, store.isActivityAuthoritative);
}

/** Rounded chrome value: identical raw-stat updates keep the snapshot primitive stable. */
export function useWorkspaceRoundedStreamingTps(workspaceId: string): number | null {
  const store = getStoreInstance();
  return useSyncExternalStore(
    (listener: () => void) => store.subscribeStreamingStats(workspaceId, listener),
    () => store.getWorkspaceRoundedStreamingTps(workspaceId)
  );
}

export function useStreamingMessageDelta(
  workspaceId: string | undefined,
  message: DisplayedMessage
): DisplayedMessage {
  const store = getStoreInstance();
  const messageId = "historyId" in message ? message.historyId : null;
  return useSyncExternalStore(
    (listener) => {
      if (!workspaceId || !messageId) return () => undefined;
      return store.subscribeStreamingMessage(workspaceId, message.id, listener);
    },
    () => {
      if (!workspaceId || !messageId) return message;
      return store.getStreamingMessage(workspaceId, message.id, messageId) ?? message;
    }
  );
}

/**
 * Hook for full-resolution live token-count / TPS stats during streaming.
 *
 * Subscribed as a separate leaf so smoothing-sensitive consumers can update on every
 * coalesced stream-delta WITHOUT cascading a re-render through the entire chat subtree.
 */
export function useWorkspaceStreamingStats(workspaceId: string): WorkspaceStreamingStats | null {
  const store = getStoreInstance();
  const subscribe = useCallback(
    (listener: () => void) => store.subscribeStreamingStats(workspaceId, listener),
    [store, workspaceId]
  );
  const getSnapshot = useCallback(
    () => store.getWorkspaceStreamingStats(workspaceId),
    [store, workspaceId]
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * Hook for backend timing stats snapshots.
 */
export function useWorkspaceStatsSnapshot(workspaceId: string): WorkspaceStatsSnapshot | null {
  const store = getStoreInstance();

  // NOTE: subscribeStats() starts/stops a backend subscription; if React re-subscribes on every
  // render (because the subscribe callback is unstable), we can trigger an infinite loop.
  // This useCallback is for correctness, not performance.
  const subscribe = useCallback(
    (listener: () => void) => store.subscribeStats(workspaceId, listener),
    [store, workspaceId]
  );
  const getSnapshot = useCallback(
    () => store.getWorkspaceStatsSnapshot(workspaceId),
    [store, workspaceId]
  );

  return useSyncExternalStore(subscribe, getSnapshot);
}

export function useWorkspaceTimeline(workspaceId: string): WorkspaceTimelineSnapshot {
  const store = getStoreInstance();

  // NOTE: subscribeTimeline() is refcounted; dropping the last listener closes the ORPC
  // subscription and discards the loaded page. useSyncExternalStore resubscribes whenever this
  // identity changes, so this useCallback is for correctness, not performance.
  const subscribe = useCallback(
    (listener: () => void) => store.subscribeTimeline(workspaceId, listener),
    [store, workspaceId]
  );

  return useSyncExternalStore(subscribe, () => store.getWorkspaceTimeline(workspaceId));
}

/**
 * Hook for consumer breakdown (lazy, with tokenization).
 * Updates after async Web Worker calculation completes.
 */
export function useWorkspaceConsumers(workspaceId: string): WorkspaceConsumersState {
  const store = getStoreInstance();
  return useSyncExternalStore(
    (listener) => store.subscribeConsumers(workspaceId, listener),
    () => store.getWorkspaceConsumers(workspaceId)
  );
}

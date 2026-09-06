import type {
  MuxMessage,
  MuxMetadata,
  DisplayedMessage,
  CompactionRequestData,
  InlineSkillSnapshotMap,
} from "@/common/types/message";
import {
  createMuxMessage,
  getMcpPromptReferenceKey,
  isCompactionSummaryMetadata,
  sanitizeAgentSkillRefs,
  sanitizeMcpPromptRefs,
} from "@/common/types/message";

import {
  copyStreamLifecycleSnapshot,
  type StreamStartEvent,
  type StreamModelUpdateEvent,
  type StreamDeltaEvent,
  type UsageDeltaEvent,
  type StreamEndEvent,
  type StreamAbortEvent,
  type StreamAbortReasonSnapshot,
  type ToolCallExecutionStartEvent,
  type ToolCallStartEvent,
  type ToolCallDeltaEvent,
  type ToolCallEndEvent,
  type ReasoningDeltaEvent,
  type ReasoningEndEvent,
  type RuntimeStatusEvent,
  type StreamLifecycleEvent,
  type StreamLifecycleSnapshot,
} from "@/common/types/stream";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import type {
  TodoItem,
  StatusSetToolResult,
  NotifyToolResult,
  AgentSkillReadToolResult,
} from "@/common/types/tools";
import type { AssistedReviewHunk } from "@/common/types/review";
import { formatAssistedFilter, parseAssistedFilter } from "@/common/utils/review/assistedReview";
import {
  isCompletedSubagentReportEnvelope,
  parseSubagentReportEnvelope,
} from "@/common/utils/subagentReportEnvelope";
import { completeInProgressTodoItems } from "@/common/utils/todoList";
import { AgentSkillReadToolResultSchema } from "@/common/utils/tools/toolDefinitions";
import { getToolOutputUiOnly } from "@/common/utils/tools/toolOutputUiOnly";

import type {
  WorkspaceChatMessage,
  StreamErrorMessage,
  DeleteMessage,
  OnChatCursor,
  OnChatHistoryCursor,
} from "@/common/orpc/types";
import { isInitStart, isInitOutput, isInitEnd, isMuxMessage } from "@/common/orpc/types";
import {
  buildAggregateResponseCompleteMetadata,
  buildResponseCompleteMetadata,
  type ResponseCompleteHandler,
} from "./responseCompletionMetadata";
import {
  buildDisplayedMessagesForMessage,
  getTextPartContent,
  hasSuccessResult,
  mergeAdjacentParts,
  normalizeMessageRouteProvider,
  resolveRouteProvider,
} from "./displayedMessageBuilder";
import { showBrowserNotification } from "@/browser/utils/ui/showBrowserNotification";
import type { DynamicToolPart, DynamicToolPartPending } from "@/common/types/toolParts";
import type { AgentSkillDescriptor, AgentSkillScope } from "@/common/types/agentSkill";
import { INIT_HOOK_MAX_LINES } from "@/common/constants/toolLimits";
import { isDynamicToolPart } from "@/common/types/toolParts";
import { z } from "zod";
import { createDeltaStorage, type DeltaRecordStorage } from "./StreamingTPSCalculator";
import { buildTranscriptTruncationPlan } from "./transcriptTruncationPlan";
import { computeRecencyTimestamp } from "./recency";
import { assert } from "@/common/utils/assert";
import { getStatusStateKey } from "@/common/constants/storage";
import {
  CONTEXT_BOUNDARY_KINDS,
  getContextBoundaryKind,
} from "@/common/utils/messages/compactionBoundary";
import { isWorkflowResultMessage } from "@/common/utils/workflowRunMessages";

function isDisplayOnlyCompletedSubagentReport(message: MuxMessage): boolean {
  if (
    message.role !== "user" ||
    message.metadata?.synthetic !== true ||
    message.metadata.uiVisible !== true
  ) {
    return false;
  }

  return isCompletedSubagentReportEnvelope(getTextPartContent(message.parts));
}

// Maximum number of messages to display in the DOM for performance
// Full history is still maintained internally for token counting and stats
const AgentStatusSchema = z.object({
  emoji: z.string(),
  message: z.string(),
  url: z.string().optional(),
});

// Synthetic agent-skill snapshot messages include metadata.agentSkillSnapshot.
// We use this to keep the SkillIndicator in sync for /{skillName} invocations.
const AgentSkillSnapshotMetadataSchema = z.object({
  skillName: z.string().min(1),
  scope: z.enum(["project", "global", "built-in"]),
  sha256: z.string().optional(),
  frontmatterYaml: z.string().optional(),
});

const TodoWriteInputSchema = z.object({
  todos: z.array(
    z.object({
      content: z.string(),
      status: z.enum(["pending", "in_progress", "completed"]),
    })
  ),
});

const StatusSetSuccessResultSchema = z.object({
  success: z.literal(true),
  emoji: z.string(),
  message: z.string(),
  url: z.string().optional(),
}) satisfies z.ZodType<Extract<StatusSetToolResult, { success: true }>>;

const ReviewPaneUpdateSuccessResultSchema = z.object({
  success: z.literal(true),
  operation: z.enum(["add", "replace"]),
  hunks: z.array(
    z.object({
      path: z.string(),
      comment: z.string().nullable().optional(),
    })
  ),
});

const NotifySuccessResultSchema = z.object({
  success: z.literal(true),
  title: z.string(),
  message: z.string().optional(),
}) satisfies z.ZodType<Extract<NotifyToolResult, { success: true }>>;

const AgentSkillReadInputSchema = z.object({
  name: z.string().optional(),
});

function parseLegacyNotifyRouting(
  output: unknown
): { notifiedVia?: string; workspaceId?: string } | null {
  if (typeof output !== "object" || output === null) {
    return null;
  }
  const record = output as Record<string, unknown>;
  return {
    notifiedVia: typeof record.notifiedVia === "string" ? record.notifiedVia : undefined,
    workspaceId: typeof record.workspaceId === "string" ? record.workspaceId : undefined,
  };
}

function parseAgentSkillReadToolResult(output: unknown): AgentSkillReadToolResult | null {
  const parsed = AgentSkillReadToolResultSchema.safeParse(output);
  return parsed.success ? parsed.data : null;
}

function parseTodoWriteInput(input: unknown): { todos: TodoItem[] } | null {
  const parsed = TodoWriteInputSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

function parseStatusSetSuccessResult(
  output: unknown
): Extract<StatusSetToolResult, { success: true }> | null {
  const parsed = StatusSetSuccessResultSchema.safeParse(output);
  return parsed.success ? parsed.data : null;
}

function parseNotifySuccessResult(
  output: unknown
): Extract<NotifyToolResult, { success: true }> | null {
  const parsed = NotifySuccessResultSchema.safeParse(output);
  return parsed.success ? parsed.data : null;
}

/** Re-export for consumers that need the loaded skill type */
export type LoadedSkill = AgentSkillDescriptor;

/** A runtime skill load failure (agent_skill_read returned { success: false }) */
export interface SkillLoadError {
  /** Skill name that was requested */
  name: string;
  /** Error message from the backend */
  error: string;
}

type AgentStatus = z.infer<typeof AgentStatusSchema>;

/**
 * Maximum number of DisplayedMessages to render before truncation kicks in.
 * We keep all user prompts and structural markers, while allowing older assistant
 * content to collapse behind history-hidden markers for faster initial paint.
 */
const MAX_DISPLAYED_MESSAGES = 64;

/**
 * Message types that are always preserved even in truncated history.
 * Older assistant/tool/reasoning rows may be omitted until the user clicks “Load all”.
 */
const ALWAYS_KEEP_MESSAGE_TYPES = new Set<DisplayedMessage["type"]>([
  "user",
  "stream-error",
  "compaction-boundary",
  "plan-display",
  "workspace-init",
]);

interface StreamingContext {
  /** Backend timestamp when stream started (Date.now()) */
  serverStartTime: number;
  /**
   * Offset to translate backend timestamps into the renderer clock.
   * Computed as: `Date.now() - lastServerTimestamp`.
   */
  clockOffsetMs: number;
  /** Most recent backend timestamp observed for this stream */
  lastServerTimestamp: number;

  isComplete: boolean;
  isCompacting: boolean;
  // Track the last known queued-follow-up state on the active stream itself so
  // background activity completion can still suppress intermediate notifications
  // after the workspace loses its live queued-message subscription.
  hasQueuedFollowUp: boolean;
  suppressNotification: boolean;
  isReplay: boolean;
  model: string;
  /**
   * Request-pinned pricing/metadata identity stamped by the backend at
   * stream start. Live pricing must prefer it over re-resolving the raw
   * model: a Coder catalog refresh can remove/retag the instance while the
   * stream is active.
   */
  metadataModel?: string;
  effectiveContextLimit?: number | null;
  modelFallback?: MuxMetadata["modelFallback"];
  routedThroughGateway?: boolean;
  routeProvider?: string;

  /** Timestamp of first content token (text or reasoning delta) - backend Date.now() */
  serverFirstTokenTime: number | null;

  /** Accumulated tool execution time in ms */
  toolExecutionMs: number;
  /** Map of tool call start times for in-progress tool calls (backend timestamps) */
  pendingToolStarts: Map<string, number>;

  /** Agent id active for this stream. */
  agentId?: string;

  /** Legacy base mode (plan/exec/compact). */
  mode?: string;

  /** Effective thinking level after model policy clamping */
  thinkingLevel?: string;
}

interface PendingCompactionRequest {
  parsed: CompactionRequestData;
  source?: "idle-compaction" | "auto-compaction";
}

function markRowsBeforeLatestContextBoundary(messages: DisplayedMessage[]): DisplayedMessage[] {
  let latestBoundarySequence: number | null = null;
  for (const message of messages) {
    if (message.type !== "compaction-boundary") {
      continue;
    }
    if (latestBoundarySequence === null || message.historySequence > latestBoundarySequence) {
      latestBoundarySequence = message.historySequence;
    }
  }

  if (latestBoundarySequence === null) {
    return messages;
  }

  let changed = false;
  const marked = messages.map((message) => {
    if (message.type !== "user" && message.type !== "assistant") {
      return message;
    }

    const isBeforeLatestContextBoundary = message.historySequence < latestBoundarySequence;
    if (message.isBeforeLatestContextBoundary === isBeforeLatestContextBoundary) {
      return message;
    }

    changed = true;
    return {
      ...message,
      isBeforeLatestContextBoundary: isBeforeLatestContextBoundary ? true : undefined,
    };
  });

  return changed ? marked : messages;
}

function extractAgentSkillSnapshotBody(snapshotText: string): string | null {
  assert(typeof snapshotText === "string", "extractAgentSkillSnapshotBody requires snapshotText");

  // Expected format (backend):
  // <agent-skill ...>\n{body}\n</agent-skill>
  if (!snapshotText.startsWith("<agent-skill")) {
    return null;
  }

  const openTagEnd = snapshotText.indexOf(">\n");
  if (openTagEnd === -1) {
    return null;
  }

  const closeTag = "\n</agent-skill>";
  const closeTagStart = snapshotText.lastIndexOf(closeTag);
  if (closeTagStart === -1) {
    return null;
  }

  const bodyStart = openTagEnd + ">\n".length;
  if (closeTagStart < bodyStart) {
    return null;
  }

  // Be strict about trailing content: if we can't confidently extract the body,
  // avoid showing a misleading preview.
  const trailing = snapshotText.slice(closeTagStart + closeTag.length);
  if (trailing.trim().length > 0) {
    return null;
  }

  return snapshotText.slice(bodyStart, closeTagStart);
}

interface AgentSkillSnapshotContent {
  sha256?: string;
  frontmatterYaml?: string;
  body?: string;
}

interface MCPPromptSnapshotContent {
  serverName: string;
  promptName: string;
  commandKey: string;
  invokingMessageId?: string;
  description?: string;
  body: string;
}

function maybeCollectMcpPromptSnapshot(
  message: MuxMessage,
  snapshots: Map<string, MCPPromptSnapshotContent>
): void {
  const metadata = message.metadata?.mcpPromptSnapshot;
  if (!metadata) return;
  snapshots.set(getMcpPromptReferenceKey(metadata.serverName, metadata.promptName), {
    ...metadata,
    body: getTextPartContent(message.parts),
  });
}

interface InlineSkillSnapshotDisplayState {
  snapshots?: InlineSkillSnapshotMap;
  cacheKey?: string;
}

function getAgentSkillSnapshotDisplayCacheKey(snapshot: AgentSkillSnapshotContent): string {
  // Displayed skill rows render both frontmatter and body. Include all rendered
  // fields rather than trusting optional legacy sha256, so cache reuse is safe
  // for old histories and synthetic snapshot edits.
  return JSON.stringify({
    sha256: snapshot.sha256 ?? "",
    frontmatterYaml: snapshot.frontmatterYaml ?? "",
    body: snapshot.body ?? "",
  });
}

function getAgentSkillSnapshotKey(scope: AgentSkillScope, skillName: string): string {
  return `${scope}:${skillName}`;
}

function maybeCollectAgentSkillSnapshot(
  message: MuxMessage,
  snapshots: Map<string, AgentSkillSnapshotContent>
): void {
  const snapshotMeta = message.metadata?.agentSkillSnapshot;
  if (!snapshotMeta) {
    return;
  }

  const parsed = AgentSkillSnapshotMetadataSchema.safeParse(snapshotMeta);
  if (!parsed.success) {
    return;
  }

  const body = extractAgentSkillSnapshotBody(getTextPartContent(message.parts));
  if (body === null) {
    return;
  }

  snapshots.set(getAgentSkillSnapshotKey(parsed.data.scope, parsed.data.skillName), {
    sha256: parsed.data.sha256,
    frontmatterYaml: parsed.data.frontmatterYaml,
    body,
  });
}

function deriveInlineSkillSnapshotDisplayState(
  messageId: string,
  rawRefs: unknown,
  latestAgentSkillSnapshotByKey: ReadonlyMap<string, AgentSkillSnapshotContent>,
  rawMcpRefs: unknown,
  latestMcpPromptSnapshotByKey: ReadonlyMap<string, MCPPromptSnapshotContent>
): InlineSkillSnapshotDisplayState {
  const snapshotsBySkillName: InlineSkillSnapshotMap = {};
  const cacheEntryBySkillName = new Map<string, string>();

  for (const ref of sanitizeAgentSkillRefs(rawRefs)) {
    if (ref.source !== "inline") continue;
    const snapshot = latestAgentSkillSnapshotByKey.get(
      getAgentSkillSnapshotKey(ref.scope, ref.skillName)
    );
    if (!snapshot || (snapshot.frontmatterYaml === undefined && snapshot.body === undefined)) {
      continue;
    }
    snapshotsBySkillName[ref.skillName] = {
      skillName: ref.skillName,
      scope: ref.scope,
      snapshot: { frontmatterYaml: snapshot.frontmatterYaml, body: snapshot.body },
    };
    cacheEntryBySkillName.set(ref.skillName, getAgentSkillSnapshotDisplayCacheKey(snapshot));
  }

  for (const ref of sanitizeMcpPromptRefs(rawMcpRefs)) {
    if (ref.source !== "inline") continue;
    const snapshot = latestMcpPromptSnapshotByKey.get(
      getMcpPromptReferenceKey(ref.serverName, ref.promptName)
    );
    // Same exact-correlation rule as the slash surface (crash orphans).
    if (snapshot?.invokingMessageId !== messageId) continue;
    snapshotsBySkillName[ref.commandKey] = {
      skillName: ref.commandKey,
      scope: "built-in",
      snapshot: { body: snapshot.body },
    };
    cacheEntryBySkillName.set(ref.commandKey, snapshot.body);
  }

  if (cacheEntryBySkillName.size === 0) return {};
  return {
    snapshots: snapshotsBySkillName,
    cacheKey: Array.from(cacheEntryBySkillName.entries())
      .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
      .map(([, cacheEntry]) => cacheEntry)
      .join("\n"),
  };
}

interface MessagePartSplitCut {
  textLength: number;
  reasoningLength: number;
  partIndex: number;
}

interface TranscriptInsertionPlan {
  insertionsByTargetId: Map<string, TranscriptInsertion[]>;
  inlineMessageIds: Set<string>;
}

interface TranscriptInsertion extends MessagePartSplitCut {
  insertionMessage: MuxMessage;
}

export interface TranscriptRevealTarget {
  messageId?: string;
  toolCallId?: string;
}

export class StreamingMessageAggregator {
  private messages = new Map<string, MuxMessage>();
  private activeStreams = new Map<string, StreamingContext>();

  private backgroundHandoffCompletion: ReturnType<typeof buildAggregateResponseCompleteMetadata> =
    undefined;

  // Derived value cache - invalidated as a unit on every mutation.
  // Adding a new cached value? Add it here and it will auto-invalidate.
  private displayedMessageCache = new Map<
    string,
    {
      version: number;
      agentSkillSnapshotCacheKey?: string;
      inlineSkillSnapshotsCacheKey?: string;
      messages: DisplayedMessage[];
    }
  >();
  private messageVersions = new Map<string, number>();
  private cache: {
    allMessages?: MuxMessage[];
    displayedMessages?: DisplayedMessage[];
  } = {};
  private recencyTimestamp: number | null = null;
  private lastResponseCompletedAt: number | null = null;
  private historyEpoch = 0;

  /** Oldest historySequence from the server's last replay window.
   *  Used for reconnect cursors instead of the absolute minimum (which
   *  includes user-loaded older pages via loadOlderHistory). */
  private establishedOldestHistorySequence: number | null = null;

  /** Server-issued history cursor from the last caught-up, reused verbatim on reconnect.
   *  The client's in-memory representation intentionally diverges from persisted rows
   *  (compact-on-append parts, adopted tool outputs, client timestamps), so recomputing
   *  cursor fingerprints locally would mismatch and silently downgrade every since
   *  reconnect to a full replay. */
  private lastServerHistoryCursor: OnChatHistoryCursor | null = null;

  // Delta history for token counting and TPS calculation
  private deltaHistory = new Map<string, DeltaRecordStorage>();

  // Active stream usage tracking (updated on each usage-delta event)
  // Consolidates step-level (context window) and cumulative (cost) usage by messageId
  private activeStreamUsage = new Map<
    string,
    {
      // Step-level: this step only (for context window display)
      step: { usage: LanguageModelV2Usage; providerMetadata?: Record<string, unknown> };
      // Cumulative: sum across all steps (for live cost display)
      cumulative: { usage: LanguageModelV2Usage; providerMetadata?: Record<string, unknown> };
    }
  >();

  // Current TODO list (updated when todo_write succeeds)
  // Incomplete lists persist across streams and reloads; fully completed lists clear
  // once the final stream finishes so stale plans do not linger in the UI.
  private currentTodos: TodoItem[] = [];

  // Current agent status (updated when status_set is called)
  // Unlike todos, this persists after stream completion to show last activity
  private agentStatus: AgentStatus | undefined = undefined;

  // Agent-flagged "Assisted review" hunks (updated by review_pane_update).
  // Reconstructed from chat history on reload via processToolResult so the
  // pinned set survives restarts; not persisted to disk.
  //
  // Each entry carries optional `addedAt` metadata so the UI can render a
  // "new since last update" badge. The timestamp is populated only during
  // live tool-call processing (not history replay); legacy paths and tests
  // can omit it.
  private assistedReviewHunks: AssistedReviewHunk[] = [];

  // Loaded skills (updated when agent_skill_read succeeds)
  // Persists after stream completion (like agentStatus) to show which skills were loaded
  // Keyed by skill name to avoid duplicates
  private loadedSkills = new Map<string, LoadedSkill>();
  // Cached array for getLoadedSkills() to preserve reference identity for memoization
  private loadedSkillsCache: LoadedSkill[] = [];

  // Runtime skill load errors (updated when agent_skill_read fails)
  // Keyed by skill name; cleared when the skill is later loaded successfully
  private skillLoadErrors = new Map<string, SkillLoadError>();
  private skillLoadErrorsCache: SkillLoadError[] = [];

  // Last URL set via status_set - kept in memory to reuse when later calls omit url
  private lastStatusUrl: string | undefined = undefined;

  // Keep the most recently revealed Timeline row renderable without disabling transcript capping.
  private transcriptRevealTarget: TranscriptRevealTarget | null = null;

  // Whether to disable DOM message capping for this workspace.
  // Controlled via the HistoryHiddenMessage “Load all” button.
  private showAllMessages = false;
  // Workspace ID (used for status persistence)
  private readonly workspaceId: string | undefined;

  // Workspace init hook state (ephemeral, not persisted to history)
  private initState: {
    status: "running" | "success" | "error";
    hookPath: string;
    lines: Array<{ line: string; isError: boolean }>;
    exitCode: number | null;
    startTime: number;
    endTime: number | null;
    truncatedLines?: number; // Lines dropped from middle when output exceeded limit
  } | null = null;

  // When reconnect replay re-emits init-start for the same running init, keep the existing row and
  // treat replayed init-output as a continuation. Snapshot the already-visible prefix so replay can
  // skip only those previously rendered lines without collapsing legitimate duplicates later on.
  private replayInitVisiblePrefix: Array<{ line: string; isError: boolean }> | null = null;
  private replayInitVisiblePrefixIndex = 0;

  // Replay reconnects apply the same init events twice: once immediately before caught-up and
  // once again from the buffered catch-up pass. Track replay event identity so the second pass can
  // skip the exact same event object without collapsing legitimate duplicate log lines.
  private appliedReplayInitEvents = new WeakSet<object>();

  // Throttle init-output cache invalidation to avoid re-render per line during fast streaming
  private initOutputThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly INIT_OUTPUT_THROTTLE_MS = 100;

  // Track when we're waiting for stream-start after user message
  // Prevents retry barrier flash during normal send flow
  // Stores timestamp of when user message was sent (null = no pending stream)
  // IMPORTANT: We intentionally keep this timestamp until a stream actually starts
  // (or the user retries) so retry UI/backoff logic doesn't misfire on send failures.
  private pendingStreamStartTime: number | null = null;

  // Canonical backend-owned stream lifecycle. This distinguishes slow startup from a
  // genuinely interrupted/failed turn, including reconnects while PREPARING is still in flight.
  private streamLifecycle: StreamLifecycleSnapshot | null = null;

  // Last observed stream-abort reason (used to gate auto-retry).
  private lastAbortReason: StreamAbortReasonSnapshot | null = null;

  // Current pre-stream startup status.
  // This begins with runtime readiness for Coder, but also carries generic
  // startup breadcrumbs like "Loading tools..." while the request is preparing.
  private runtimeStatus: RuntimeStatusEvent | null = null;

  // Pending compaction request metadata for the next stream (set when user message arrives).
  // Used to infer compaction state before stream-start arrives.
  private pendingCompactionRequest: PendingCompactionRequest | null = null;

  // Model used for the pending send (set on user message) so the "starting" UI
  // reflects one-shot/compaction overrides instead of stale localStorage values.
  private pendingStreamModel: string | null = null;

  // A brand-new workspace can auto-navigate before onChat replays the first user turn.
  // Keep the startup barrier alive through that empty catch-up window until we see
  // either the real user message or a terminal stream event.
  private optimisticPendingStreamStart = false;
  private optimisticPendingStreamStartIdleCaughtUpCount = 0;

  // Last completed stream timing stats (preserved after stream ends for display)
  // Unlike activeStreams, this persists until the next stream starts
  private lastCompletedStreamStats: {
    startTime: number;
    endTime: number;
    firstTokenTime: number | null;
    toolExecutionMs: number;
    model: string;
    outputTokens: number;
    reasoningTokens: number;
    streamingMs: number; // Time from first token to end (for accurate tok/s)
    mode?: string; // Mode in which this response occurred
  } | null = null;

  // Optimistic "interrupting" state: set before calling interruptStream
  // Shows "interrupting..." in StreamingBarrier until real stream-abort arrives
  private interruptingMessageId: string | null = null;

  // Execution starts that arrived before their tool part exists (messageId → toolCallId →
  // timestamp). During reconnect replay, live tool-call-execution-start events are not
  // replay-buffered and can beat the replayed tool-call-start that creates the part;
  // dropping them would leave the running tool's elapsed timer hidden until the next
  // reconnect. Consumed in handleToolCallStart, cleared in cleanupStreamState.
  private stashedToolExecutionStarts = new Map<string, Map<string, number>>();

  // Session-level timing stats: model -> stats (totals computed on-the-fly)
  private sessionTimingStats: Record<
    string,
    {
      totalDurationMs: number;
      totalToolExecutionMs: number;
      totalTtftMs: number;
      ttftCount: number;
      responseCount: number;
      totalOutputTokens: number;
      totalReasoningTokens: number;
      totalStreamingMs: number; // Cumulative streaming time (for accurate tok/s)
    }
  > = {};

  // Workspace creation timestamp (used for recency calculation)
  // REQUIRED: Backend guarantees every workspace has createdAt via config.ts
  private readonly createdAt: string;
  // Workspace unarchived timestamp (used for recency calculation to bump restored workspaces)
  private unarchivedAt?: string;

  // Optional callback for navigating to a workspace (set by parent component)
  // Used for notification click handling in browser mode
  onNavigateToWorkspace?: (workspaceId: string) => void;

  // Optional callback when an assistant response completes (used for "notify on response" feature).
  // completedAt is non-null for all final streams and drives read-marking in App.tsx.
  // Only non-compaction completions also bump lastResponseCompletedAt (recency).
  onResponseComplete?: ResponseCompleteHandler;

  constructor(createdAt: string, workspaceId?: string, unarchivedAt?: string) {
    this.createdAt = createdAt;
    this.workspaceId = workspaceId;
    this.unarchivedAt = unarchivedAt;
    // Load persisted agent status from localStorage
    if (workspaceId) {
      const persistedStatus = this.loadPersistedAgentStatus();
      if (persistedStatus) {
        this.agentStatus = persistedStatus;
        this.lastStatusUrl = persistedStatus.url;
      }
    }
    this.updateRecency();
  }

  /** Update unarchivedAt timestamp (called when workspace is restored from archive) */
  setUnarchivedAt(unarchivedAt: string | undefined): void {
    this.unarchivedAt = unarchivedAt;
    this.updateRecency();
  }

  /** Pin one Timeline target into the capped transcript projection. */
  setTranscriptRevealTarget(target: TranscriptRevealTarget): void {
    assert(
      typeof target.messageId === "string" || typeof target.toolCallId === "string",
      "setTranscriptRevealTarget requires a messageId or toolCallId"
    );
    const currentTarget = this.transcriptRevealTarget;
    if (
      currentTarget?.messageId === target.messageId &&
      currentTarget?.toolCallId === target.toolCallId
    ) {
      return;
    }
    this.transcriptRevealTarget = target;
    this.invalidateCache();
  }

  /**
   * Disable the displayed message cap for this workspace.
   * Intended for user-triggered “Load all” UI.
   */
  setShowAllMessages(showAllMessages: boolean): void {
    assert(typeof showAllMessages === "boolean", "setShowAllMessages requires boolean");
    if (this.showAllMessages === showAllMessages) {
      return;
    }
    this.showAllMessages = showAllMessages;
    this.invalidateCache();
  }

  /** Load persisted agent status from localStorage */
  private loadPersistedAgentStatus(): AgentStatus | undefined {
    if (!this.workspaceId) return undefined;
    try {
      const stored = localStorage.getItem(getStatusStateKey(this.workspaceId));
      if (!stored) return undefined;
      const parsed = AgentStatusSchema.safeParse(JSON.parse(stored));
      return parsed.success ? parsed.data : undefined;
    } catch {
      // Ignore localStorage errors or JSON parse failures
    }
    return undefined;
  }

  /** Persist agent status to localStorage */
  private savePersistedAgentStatus(status: AgentStatus): void {
    if (!this.workspaceId) return;
    const parsed = AgentStatusSchema.safeParse(status);
    if (!parsed.success) return;
    try {
      localStorage.setItem(getStatusStateKey(this.workspaceId), JSON.stringify(parsed.data));
    } catch {
      // Ignore localStorage errors
    }
  }

  /** Remove persisted agent status from localStorage */
  private clearPersistedAgentStatus(): void {
    if (!this.workspaceId) return;
    try {
      localStorage.removeItem(getStatusStateKey(this.workspaceId));
    } catch {
      // Ignore localStorage errors
    }
  }

  /** Clear all session timing stats (in-memory only). */
  clearSessionTimingStats(): void {
    this.sessionTimingStats = {};
    this.lastCompletedStreamStats = null;
  }

  private updateStreamClock(context: StreamingContext, serverTimestamp: number): void {
    assert(context, "updateStreamClock requires context");
    assert(typeof serverTimestamp === "number", "updateStreamClock requires serverTimestamp");

    // Only update if this timestamp is >= the most recent one we've seen.
    // During stream replay, older historical parts may be re-emitted out of order.
    //
    // NOTE: This is a display-oriented clock translation (not true synchronization).
    // We refresh the offset whenever we see a newer backend timestamp. If the renderer clock
    // drifts significantly during a very long stream, the translated times may be off by a
    // small amount, which is acceptable for UI stats.
    if (serverTimestamp < context.lastServerTimestamp) {
      return;
    }

    context.lastServerTimestamp = serverTimestamp;
    context.clockOffsetMs = Date.now() - serverTimestamp;
  }

  /**
   * Detect the replay→live transition for reconnect streams.
   *
   * During reconnect, `replayStream()` emits all catch-up events with `replay: true`.
   * Once the catch-up phase is over, fresh live deltas arrive without the flag.
   * This helper flips `isReplay` to false on the first non-replay event so that
   * `streamPresentation.source` correctly transitions to "live" and smoothing
   * resumes instead of staying bypassed.
   *
   * IMPORTANT: Only call from content handlers (handleStreamDelta, handleReasoningDelta).
   * Tool events are not buffered by the reconnect relay and can arrive before replay
   * text finishes flushing — calling this from tool handlers would prematurely end
   * replay phase and reclassify catch-up content as live.
   */
  private syncReplayPhase(messageId: string, replay?: boolean): void {
    const context = this.activeStreams.get(messageId);
    if (context && context.isReplay && replay !== true) {
      context.isReplay = false;
    }
  }

  private translateServerTime(context: StreamingContext, serverTimestamp: number): number {
    assert(context, "translateServerTime requires context");
    assert(typeof serverTimestamp === "number", "translateServerTime requires serverTimestamp");

    return serverTimestamp + context.clockOffsetMs;
  }

  private bumpMessageVersion(messageId: string): void {
    const current = this.messageVersions.get(messageId) ?? 0;
    this.messageVersions.set(messageId, current + 1);
  }

  private markMessageDirty(messageId: string): void {
    this.bumpMessageVersion(messageId);
    this.invalidateCache();
  }

  private deleteMessage(messageId: string): boolean {
    const didDelete = this.messages.delete(messageId);
    if (didDelete) {
      this.displayedMessageCache.delete(messageId);
      this.messageVersions.delete(messageId);
      // Clean up token tracking state to prevent memory leaks
      this.deltaHistory.delete(messageId);
      this.activeStreamUsage.delete(messageId);
    }
    return didDelete;
  }
  private invalidateCache(): void {
    this.cache = {};
    this.updateRecency();
  }

  /**
   * Recompute and cache recency from current messages.
   * Called automatically when messages change.
   */
  private updateRecency(): void {
    const messages = this.getAllMessages();
    const messageRecency = computeRecencyTimestamp(messages, this.createdAt, this.unarchivedAt);
    const candidates = [messageRecency, this.lastResponseCompletedAt].filter(
      (t): t is number => t !== null
    );
    this.recencyTimestamp = candidates.length > 0 ? Math.max(...candidates) : null;
  }

  /**
   * Get the current recency timestamp (O(1) accessor).
   * Used for workspace sorting by last user interaction.
   */
  getRecencyTimestamp(): number | null {
    return this.recencyTimestamp;
  }

  /**
   * Check if two TODO lists are equal (deep comparison).
   * Prevents unnecessary re-renders when todo_write is called with identical content.
   */
  private todosEqual(a: TodoItem[], b: TodoItem[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((todoA, i) => {
      const todoB = b[i];
      return todoA.content === todoB.content && todoA.status === todoB.status;
    });
  }

  /**
   * Get the current TODO list.
   * Updated whenever todo_write succeeds.
   */
  getCurrentTodos(): TodoItem[] {
    return this.currentTodos;
  }

  /**
   * Get the current set of agent-flagged Assisted Review hunks.
   * Updated whenever `review_pane_update` succeeds.
   */
  getAssistedReviewHunks(): AssistedReviewHunk[] {
    return this.assistedReviewHunks;
  }

  /**
   * Get the current agent status.
   * Updated whenever status_set is called.
   * Persists after stream completion (unlike todos).
   */
  getAgentStatus(): AgentStatus | undefined {
    return this.agentStatus;
  }

  /**
   * Get the list of loaded skills for this workspace.
   * Updated whenever agent_skill_read succeeds.
   * Persists after stream completion (like agentStatus).
   * Returns a stable array reference for memoization (only changes when skills change).
   */
  getLoadedSkills(): LoadedSkill[] {
    return this.loadedSkillsCache;
  }

  /**
   * Get runtime skill load errors (agent_skill_read failures).
   * Errors are cleared for a skill when it later loads successfully.
   * Returns a stable array reference for memoization.
   */
  getSkillLoadErrors(): SkillLoadError[] {
    return this.skillLoadErrorsCache;
  }

  /**
   * Check if there's an executing ask_user_question tool awaiting user input.
   * Used to show "Awaiting your input" instead of "streaming..." in the UI.
   */
  hasAwaitingUserQuestion(): boolean {
    // Only treat the workspace as "awaiting input" when the *latest* displayed
    // message is an executing ask_user_question tool.
    //
    // This avoids false positives from stale historical partials if the user
    // continued the chat after skipping/canceling the questions.
    const displayed = this.getDisplayedMessages();
    const last = displayed[displayed.length - 1];

    if (last?.type !== "tool") {
      return false;
    }

    return last.toolName === "ask_user_question" && last.status === "executing";
  }

  /**
   * Extract compaction summary text from a completed assistant message.
   * Used when a compaction stream completes to get the summary for history replacement.
   * @param messageId The ID of the assistant message to extract text from
   * @returns The concatenated text from all text parts, or undefined if message not found
   */
  getCompactionSummary(messageId: string): string | undefined {
    const message = this.messages.get(messageId);
    if (!message) return undefined;

    // Concatenate all text parts (ignore tool calls and reasoning)
    return getTextPartContent(message.parts);
  }

  /**
   * Clean up stream-scoped state when stream ends (normally or abnormally).
   * Called by handleStreamEnd, handleStreamAbort, and handleStreamError.
   *
   * Clears:
   * - Active stream tracking (this.activeStreams)
   * - Transient agentStatus (from displayStatus) - restored to persisted value
   *
   * Preserves:
   * - currentTodos (incomplete lists stay visible; handleStreamEnd may clear fully completed lists)
   * - lastCompletedStreamStats - timing stats from this stream for display after completion
   */
  private cleanupStreamState(messageId: string): void {
    // Clear optimistic interrupt flag if this stream was being interrupted.
    // This handles cases where streams end normally or with errors (not just abort).
    if (this.interruptingMessageId === messageId) {
      this.interruptingMessageId = null;
    }

    // Drop unconsumed execution starts (e.g. the tool part never materialized).
    this.stashedToolExecutionStarts.delete(messageId);

    // Capture timing stats before removing the stream context
    const context = this.activeStreams.get(messageId);
    if (context) {
      const endTime = Date.now();
      const message = this.messages.get(messageId);

      // Prefer backend-provided duration (computed in the same clock domain as tool/delta timestamps).
      // Fall back to renderer-based timing translated into the renderer clock.
      const durationMsFromMetadata = message?.metadata?.duration;
      const fallbackStartTime = this.translateServerTime(context, context.serverStartTime);
      const fallbackDurationMs = Math.max(0, endTime - fallbackStartTime);
      const durationMs =
        typeof durationMsFromMetadata === "number" && Number.isFinite(durationMsFromMetadata)
          ? durationMsFromMetadata
          : fallbackDurationMs;

      const ttftMs =
        context.serverFirstTokenTime !== null
          ? Math.max(0, context.serverFirstTokenTime - context.serverStartTime)
          : null;

      // Get output tokens from cumulative usage (if available).
      // Fall back to message metadata for abort/error cases where clearTokenState was
      // called before cleanupStreamState (e.g., stream abort event handler ordering).
      const cumulativeUsage = this.activeStreamUsage.get(messageId)?.cumulative.usage;
      const metadataUsage = message?.metadata?.usage;
      const outputTokens = cumulativeUsage?.outputTokens ?? metadataUsage?.outputTokens ?? 0;
      const reasoningTokens =
        cumulativeUsage?.reasoningTokens ?? metadataUsage?.reasoningTokens ?? 0;

      // Account for in-progress tool calls (can happen on abort/error)
      let totalToolExecutionMs = context.toolExecutionMs;
      if (context.pendingToolStarts.size > 0) {
        const serverEndTime = context.serverStartTime + durationMs;
        for (const toolStartTime of context.pendingToolStarts.values()) {
          const toolMs = serverEndTime - toolStartTime;
          if (toolMs > 0) {
            totalToolExecutionMs += toolMs;
          }
        }
      }

      // Streaming duration excludes TTFT and tool execution - used for avg tok/s
      const streamingMs = Math.max(0, durationMs - (ttftMs ?? 0) - totalToolExecutionMs);

      const mode = message?.metadata?.mode ?? context.mode;

      // Store last completed stream stats (include durations anchored in the renderer clock)
      const startTime = endTime - durationMs;
      const firstTokenTime = ttftMs !== null ? startTime + ttftMs : null;
      this.lastCompletedStreamStats = {
        startTime,
        endTime,
        firstTokenTime,
        toolExecutionMs: totalToolExecutionMs,
        model: context.model,
        outputTokens,
        reasoningTokens,
        streamingMs,
        mode,
      };

      // Use composite key model:mode for per-model+mode stats
      // Old data (no mode) will just use model as key, maintaining backward compat
      const statsKey = mode ? `${context.model}:${mode}` : context.model;

      // Accumulate into per-model stats (totals computed on-the-fly in getSessionTimingStats)
      const modelStats = this.sessionTimingStats[statsKey] ?? {
        totalDurationMs: 0,
        totalToolExecutionMs: 0,
        totalTtftMs: 0,
        ttftCount: 0,
        responseCount: 0,
        totalOutputTokens: 0,
        totalReasoningTokens: 0,
        totalStreamingMs: 0,
      };
      modelStats.totalDurationMs += durationMs;
      modelStats.totalToolExecutionMs += totalToolExecutionMs;
      modelStats.responseCount += 1;
      modelStats.totalOutputTokens += outputTokens;
      modelStats.totalReasoningTokens += reasoningTokens;
      modelStats.totalStreamingMs += streamingMs;
      if (ttftMs !== null) {
        modelStats.totalTtftMs += ttftMs;
        modelStats.ttftCount += 1;
      }
      this.sessionTimingStats[statsKey] = modelStats;
    }

    this.activeStreams.delete(messageId);
    // Restore persisted status - clears transient displayStatus, preserves status_set values
    this.agentStatus = this.loadPersistedAgentStatus();
  }

  /**
   * Compact a message's parts array by merging adjacent text/reasoning parts.
   * Called when streaming ends to convert thousands of delta parts into single strings.
   * This reduces memory from O(deltas) small objects to O(content_types) merged objects.
   */

  /**
   * Extract the final response text from a message (text after the last tool call).
   * Used for notification body content.
   */
  private extractFinalResponseText(message: MuxMessage | undefined): string {
    if (!message) return "";
    const parts = message.parts;
    const lastToolIndex = parts.findLastIndex((part) => part.type === "dynamic-tool");
    const textPartsAfterTools = lastToolIndex >= 0 ? parts.slice(lastToolIndex + 1) : parts;
    return getTextPartContent(textPartsAfterTools).trim();
  }

  private compactMessageParts(message: MuxMessage): void {
    message.parts = mergeAdjacentParts(message.parts);
  }

  addMessage(message: MuxMessage): void {
    const normalizedMessage = normalizeMessageRouteProvider(message);
    const existing = this.messages.get(normalizedMessage.id);
    if (existing) {
      const existingParts = Array.isArray(existing.parts) ? existing.parts.length : 0;
      const incomingParts = Array.isArray(normalizedMessage.parts)
        ? normalizedMessage.parts.length
        : 0;

      // Prefer richer content when duplicates arrive (e.g., placeholder vs completed message)
      if (incomingParts < existingParts) {
        return;
      }
    }

    // Just store the message - backend assigns historySequence
    this.messages.set(normalizedMessage.id, normalizedMessage);
    this.markMessageDirty(normalizedMessage.id);
  }

  /**
   * Remove a message from the aggregator.
   * Used for dismissing ephemeral messages like /plan output.
   * Rebuilds detected links to remove any that only existed in the removed message.
   */
  removeMessage(messageId: string): void {
    if (this.deleteMessage(messageId)) {
      this.invalidateCache();
    }
  }

  /**
   * Load historical messages in batch, preserving their historySequence numbers.
   * This is more efficient than calling addMessage() repeatedly.
   *
   * @param messages - Historical messages to load
   * @param hasActiveStream - Whether there's an active stream in buffered events (for reconnection scenario)
   * @param opts.mode - "replace" clears existing state first, "append" merges into existing state
   * @param opts.skipDerivedState - Skip replaying messages into derived state when appending older history
   */
  loadHistoricalMessages(
    messages: MuxMessage[],
    hasActiveStream = false,
    opts?: { mode?: "replace" | "append"; skipDerivedState?: boolean }
  ): void {
    const mode = opts?.mode ?? "replace";

    if (mode === "replace") {
      this.historyEpoch++;
      // Clear existing state to prevent stale messages from persisting.
      this.messages.clear();
      this.displayedMessageCache.clear();
      this.messageVersions.clear();
      this.deltaHistory.clear();
      this.activeStreamUsage.clear();
      this.loadedSkills.clear();
      this.loadedSkillsCache = [];
      this.skillLoadErrors.clear();
      this.skillLoadErrorsCache = [];
      this.lastResponseCompletedAt = null;

      // Track the replay window's oldest sequence for reconnect cursors.
      let minSeq: number | null = null;
      for (const msg of messages) {
        const seq = msg.metadata?.historySequence;
        if (typeof seq === "number" && (minSeq === null || seq < minSeq)) {
          minSeq = seq;
        }
      }
      this.establishedOldestHistorySequence = minSeq;
    }

    const overwrittenMessageIds: string[] = [];
    const appliedMessages: MuxMessage[] = [];

    // Add/overwrite messages in the map
    for (const message of messages) {
      const normalizedMessage = normalizeMessageRouteProvider(message);
      const existing = mode === "append" ? this.messages.get(normalizedMessage.id) : undefined;

      if (existing) {
        const existingParts = Array.isArray(existing.parts) ? existing.parts.length : 0;
        const incomingParts = Array.isArray(normalizedMessage.parts)
          ? normalizedMessage.parts.length
          : 0;

        // Since-replay can include a stale boundary row for an active stream message while
        // richer in-memory parts already exist. Keep the richer message to avoid dropping
        // in-flight tool/text parts that filtered replay deltas may not resend.
        if (incomingParts < existingParts) {
          continue;
        }

        overwrittenMessageIds.push(normalizedMessage.id);
      }

      this.messages.set(normalizedMessage.id, normalizedMessage);
      appliedMessages.push(normalizedMessage);
    }

    if (mode === "append") {
      for (const messageId of overwrittenMessageIds) {
        // Append replay can overwrite an existing message ID (e.g., partial -> finalized).
        // Bump per-message version so displayed row caches are invalidated and rebuilt.
        this.bumpMessageVersion(messageId);
        this.displayedMessageCache.delete(messageId);
      }
    }

    // Sort applied messages in chronological order for processing
    const chronologicalMessages = [...appliedMessages].sort(
      (a, b) => (a.metadata?.historySequence ?? 0) - (b.metadata?.historySequence ?? 0)
    );

    this.replayDerivedState(chronologicalMessages, hasActiveStream, opts);
  }

  /**
   * Replay message-derived state (skills, todos, agent status, review pins) from rows
   * in chronological order, then run the shared post-replay normalization: persisted
   * agent-status fallback, completed-todo cleanup on idle replays, cache invalidation,
   * and pending-stream settle detection.
   *
   * Shared by loadHistoricalMessages and reconcileSinceReplay so batch loads and
   * since-replay reconciliation keep identical derived-state semantics.
   */
  private replayDerivedState(
    chronologicalMessages: readonly MuxMessage[],
    hasActiveStream: boolean,
    opts?: { skipDerivedState?: boolean }
  ): void {
    let shouldClearCompletedTodosOnIdleReplay = false;
    if (!opts?.skipDerivedState) {
      // Replay historical messages in order to reconstruct derived state
      for (const message of chronologicalMessages) {
        this.maybeTrackLoadedSkillFromAgentSkillSnapshot(message.metadata?.agentSkillSnapshot);

        if (message.role === "user") {
          // Mirror live behavior for status: clear transient status on new user turn
          // but keep persisted status for fallback on reload.
          this.agentStatus = undefined;
          continue;
        }

        if (message.role === "assistant") {
          let assistantUpdatedTodos = false;
          for (const part of message.parts) {
            if (isDynamicToolPart(part) && part.state === "output-available") {
              // Replay deliberately omits the live context so historical
              // events don't re-fire user-visible side effects: assisted-review
              // pins don't light up as "new" and notify results don't re-send
              // browser notifications on every hydration.
              this.processToolResult(part.toolName, part.input, part.output);
              if (
                part.toolName === "todo_write" &&
                hasSuccessResult(part.output) &&
                parseTodoWriteInput(part.input)
              ) {
                assistantUpdatedTodos = true;
              }
            }
          }

          if (!hasActiveStream && assistantUpdatedTodos) {
            shouldClearCompletedTodosOnIdleReplay = message.metadata?.partial !== true;
          }
        }
      }
    }

    // If history was compacted away from the last status_set, fall back to persisted status
    if (!this.agentStatus) {
      const persistedStatus = this.loadPersistedAgentStatus();
      if (persistedStatus) {
        this.agentStatus = persistedStatus;
        this.lastStatusUrl = persistedStatus.url;
      }
    }

    // Mirror live stream-end cleanup for idle reloads: a completed plan should not reappear
    // just because we reconstructed it from historical tool output after a successful final stream.
    if (
      !opts?.skipDerivedState &&
      !hasActiveStream &&
      this.activeStreams.size === 0 &&
      shouldClearCompletedTodosOnIdleReplay &&
      this.currentTodos.length > 0 &&
      this.currentTodos.every((todo) => todo.status === "completed")
    ) {
      this.currentTodos = [];
    }

    this.invalidateCache();

    if (!opts?.skipDerivedState && !hasActiveStream && this.pendingStreamStartTime !== null) {
      const latestMessage = this.getAllMessages().at(-1);
      const historySettledThePendingTurn =
        latestMessage?.role === "assistant" ||
        (latestMessage?.role === "user" && this.optimisticPendingStreamStart) ||
        (latestMessage == null && !this.optimisticPendingStreamStart);
      if (historySettledThePendingTurn) {
        // User rationale: optimistic startup for a brand-new chat should survive an
        // empty caught-up cycle, but once history shows the first turn (or an assistant
        // response), the normal transcript can take over and the local barrier should end.
        this.clearPendingStreamLifecycleState();
      }
    }
  }

  /** Tools whose replayed outputs feed aggregator derived state (see processToolResult). */
  private static readonly DERIVED_STATE_TOOL_NAMES = new Set([
    "todo_write",
    "propose_plan",
    "status_set",
    "agent_skill_read",
    "review_pane_update",
  ]);

  private messageContributesDerivedState(message: MuxMessage): boolean {
    if (message.metadata?.agentSkillSnapshot != null) {
      return true;
    }
    return message.parts.some(
      (part) =>
        isDynamicToolPart(part) &&
        part.state === "output-available" &&
        StreamingMessageAggregator.DERIVED_STATE_TOOL_NAMES.has(part.toolName)
    );
  }

  /**
   * Reconcile a since-mode replay: the replayed rows are the authoritative suffix for
   * historySequence >= requestedAnchorSequence.
   *
   * The server-issued cursor anchor can be older than the client's cached transcript
   * (rows streamed live since the last caught-up sit above it), and server-side cursor
   * validation only protects rows below the anchor. Rows in [anchor, client-max] can be
   * deleted or rewritten server-side while the client is unsubscribed, so plain append
   * semantics would retain them as stale ghosts. Here the replayed set wins: stale rows
   * are removed, rewritten rows are replaced by their persisted forms, and the client
   * converges exactly to persisted state.
   */
  reconcileSinceReplay(args: {
    requestedAnchorSequence: number;
    messages: MuxMessage[];
    /**
     * Server-confirmed active stream that matches the local stream context from when
     * this reconnect's cursor was built. Kept as the richer local assembly: its
     * persisted placeholder row has empty/partial parts and stream replay only
     * re-sends deltas after the stream cursor, so hard-replacing it would lose
     * already-rendered content.
     */
    preservedActiveStreamMessageId?: string;
    hasActiveStream: boolean;
  }): void {
    const { requestedAnchorSequence, preservedActiveStreamMessageId, hasActiveStream } = args;
    assert(
      Number.isFinite(requestedAnchorSequence) && requestedAnchorSequence >= 0,
      `reconcileSinceReplay requires a non-negative anchor, got ${requestedAnchorSequence}`
    );

    const replayed = args.messages.map(normalizeMessageRouteProvider);
    const replayedIds = new Set(replayed.map((message) => message.id));

    // Incremental derived-state replay cannot "unapply" a discarded todo_write /
    // status_set / review pin, so track whether any discarded local row could have
    // fed derived state and rebuild from the full window when one did.
    let removedDerivedStateSource = false;
    let deletedRows = false;

    // 1) Delete stale suffix rows: any local row at/above the anchor that the server
    // did not re-send was deleted or rewritten while the client was unsubscribed.
    // Rows without a historySequence (optimistic sends awaiting ack) are never
    // touched, nor is the preserved active-stream row.
    for (const [messageId, existing] of Array.from(this.messages.entries())) {
      const historySequence = existing.metadata?.historySequence;
      if (historySequence === undefined || historySequence < requestedAnchorSequence) {
        continue;
      }
      if (messageId === preservedActiveStreamMessageId || replayedIds.has(messageId)) {
        continue;
      }
      removedDerivedStateSource ||= this.messageContributesDerivedState(existing);
      this.deleteMessage(messageId);
      deletedRows = true;
    }

    // 2) Apply replayed rows with replace-by-id semantics: persisted rows are
    // authoritative for finalized turns, including rewrites with FEWER parts than the
    // local compacted copy (so these must not go through addMessage's "prefer richer
    // content" guard). Exceptions that keep the richer local copy:
    // - the preserved active-stream row (see preservedActiveStreamMessageId doc), and
    // - defensive: rows below the anchor (e.g. a stale disk partial), which have no
    //   suffix authority and follow append-mode update semantics instead.
    const applied: MuxMessage[] = [];
    for (const incoming of replayed) {
      const incomingSequence = incoming.metadata?.historySequence;
      const belowAnchor =
        incomingSequence === undefined || incomingSequence < requestedAnchorSequence;
      const existing = this.messages.get(incoming.id);

      if (existing && (incoming.id === preservedActiveStreamMessageId || belowAnchor)) {
        const existingParts = Array.isArray(existing.parts) ? existing.parts.length : 0;
        const incomingParts = Array.isArray(incoming.parts) ? incoming.parts.length : 0;
        if (incomingParts < existingParts) {
          continue;
        }
      }

      if (existing) {
        removedDerivedStateSource ||= this.messageContributesDerivedState(existing);
      }
      this.messages.set(incoming.id, incoming);
      this.bumpMessageVersion(incoming.id);
      this.displayedMessageCache.delete(incoming.id);
      applied.push(incoming);
    }

    // Flush the whole-transcript cache before the derived rebuild: deleteMessage only
    // evicts per-message caches, and rebuildDerivedStateFromWindow must see the
    // post-mutation message set, not a stale getAllMessages() array.
    this.invalidateCache();

    // 3) Rebuild derived state deterministically from the post-reconcile message set
    // when a discarded row could have contributed to it; otherwise replay just the
    // applied rows incrementally (same semantics as append-mode loads).
    if (removedDerivedStateSource) {
      this.rebuildDerivedStateFromWindow(hasActiveStream);
    } else {
      const chronologicalApplied = [...applied].sort(
        (a, b) => (a.metadata?.historySequence ?? 0) - (b.metadata?.historySequence ?? 0)
      );
      this.replayDerivedState(chronologicalApplied, hasActiveStream);
    }

    if (deletedRows) {
      // Match handleDeleteMessage: deletions invalidate async last-user-prompt fallbacks.
      this.historyEpoch++;
    }
  }

  /**
   * Deterministically rebuild message-derived state from the current replay window
   * (rows at/above the server replay-window floor). Resets the derived stores first
   * because incremental replay cannot "unapply" contributions from rows that
   * reconciliation discarded. Scoped to the established window so
   * loadOlderHistory-paginated rows (loaded with skipDerivedState) stay excluded,
   * matching full-replay semantics.
   */
  private rebuildDerivedStateFromWindow(hasActiveStream: boolean): void {
    this.loadedSkills.clear();
    this.loadedSkillsCache = [];
    this.skillLoadErrors.clear();
    this.skillLoadErrorsCache = [];
    this.currentTodos = [];
    this.assistedReviewHunks = [];
    this.agentStatus = undefined;
    this.lastStatusUrl = undefined;

    const windowFloor = this.establishedOldestHistorySequence ?? Number.NEGATIVE_INFINITY;
    const windowRows = this.getAllMessages().filter((message) => {
      const historySequence = message.metadata?.historySequence;
      return historySequence !== undefined && historySequence >= windowFloor;
    });
    this.replayDerivedState(windowRows, hasActiveStream);
  }

  setEstablishedOldestHistorySequence(sequence: number | null): void {
    this.establishedOldestHistorySequence = sequence;
  }

  getHistoryEpoch(): number {
    return this.historyEpoch;
  }

  getAllMessages(): MuxMessage[] {
    this.cache.allMessages ??= Array.from(this.messages.values()).sort(
      (a, b) => (a.metadata?.historySequence ?? 0) - (b.metadata?.historySequence ?? 0)
    );
    return this.cache.allMessages;
  }

  /**
   * Record the server-issued history cursor from a caught-up payload. Pass null when
   * the server did not advertise a trustworthy cursor (e.g. replay failure), which
   * forces the next reconnect to request a full replay.
   */
  setServerHistoryCursor(cursor: OnChatHistoryCursor | null): void {
    this.lastServerHistoryCursor = cursor;
  }

  /**
   * Build a cursor for incremental onChat reconnection.
   * Returns undefined when we cannot safely represent the current state,
   * forcing a full replay.
   *
   * The history segment is the server-issued cursor reused verbatim (see
   * lastServerHistoryCursor); the client-computed stream segment is advisory and
   * clamped server-side.
   */
  getOnChatCursor(): OnChatCursor | undefined {
    if (this.activeStreams.size > 1) {
      // Defensive fallback: multiple active streams is anomalous, so force a full replay.
      return undefined;
    }

    const cursor: OnChatCursor = {};
    if (this.lastServerHistoryCursor) {
      cursor.history = this.lastServerHistoryCursor;
    }

    if (this.activeStreams.size === 1) {
      const activeStreamEntry = this.activeStreams.entries().next().value;
      assert(activeStreamEntry, "activeStreams size reported 1 but no entry found");
      const [messageId, context] = activeStreamEntry;
      cursor.stream = {
        messageId,
        lastTimestamp: context.lastServerTimestamp,
      };
    }

    if (!cursor.history && !cursor.stream) {
      return undefined;
    }

    return cursor;
  }
  // Efficient methods to check message state without creating arrays
  getMessageCount(): number {
    return this.messages.size;
  }

  hasMessages(): boolean {
    return this.messages.size > 0;
  }

  clearLastAbortReason(): void {
    this.lastAbortReason = null;
  }
  getLastAbortReason(): StreamAbortReasonSnapshot | null {
    return this.lastAbortReason;
  }

  getStreamLifecycle(): StreamLifecycleSnapshot | null {
    return this.streamLifecycle;
  }

  getPendingStreamStartTime(): number | null {
    return this.pendingStreamStartTime;
  }

  /**
   * Get the current pre-stream startup status.
   * Returns null if no startup breadcrumb is active.
   */
  getRuntimeStatus(): RuntimeStatusEvent | null {
    return this.runtimeStatus;
  }

  handleStreamLifecycle(event: StreamLifecycleEvent): void {
    this.streamLifecycle = copyStreamLifecycleSnapshot(event);

    if (event.phase === "interrupted" && event.abortReason) {
      this.lastAbortReason = {
        reason: event.abortReason,
        at: Date.now(),
      };
      return;
    }

    this.lastAbortReason = null;
  }

  private clearInFlightStreamLifecycle(): void {
    if (
      this.streamLifecycle?.phase === "preparing" ||
      this.streamLifecycle?.phase === "streaming" ||
      this.streamLifecycle?.phase === "completing"
    ) {
      this.streamLifecycle = null;
    }
  }

  /**
   * Handle runtime-status event.
   * Used to show both runtime readiness and generic startup breadcrumbs in StreamingBarrier.
   */
  handleRuntimeStatus(status: RuntimeStatusEvent): void {
    // Keep stream lifecycle code focused on when runtime status becomes irrelevant.
    if (status.phase === "ready" || status.phase === "error") {
      this.clearRuntimeStatus();
      return;
    }

    this.runtimeStatus = status;
  }

  private clearRuntimeStatus(): void {
    this.runtimeStatus = null;
  }

  private clearPendingStreamLifecycleState(): void {
    this.setPendingStreamStartTime(null);
    this.clearRuntimeStatus();
  }

  getPendingStreamModel(): string | null {
    if (this.pendingStreamStartTime === null) return null;
    return this.pendingStreamModel;
  }

  markOptimisticPendingStreamStart(model: string | null): void {
    this.optimisticPendingStreamStart = true;
    this.optimisticPendingStreamStartIdleCaughtUpCount = 0;
    this.pendingCompactionRequest = null;
    this.pendingStreamModel = model;
    this.setPendingStreamStartTime(Date.now());
  }

  clearPendingStreamStartIfNotOptimistic(): void {
    if (!this.optimisticPendingStreamStart) {
      this.clearPendingStreamStart();
      return;
    }

    // Preserve exactly one authoritative idle caught-up cycle for a just-created workspace.
    // If the server later still reports no active stream and no replayed turn has arrived,
    // the optimistic startup barrier is stale and should clear so recovery UI can reappear.
    if (this.optimisticPendingStreamStartIdleCaughtUpCount > 0) {
      this.clearPendingStreamStart();
      return;
    }

    this.optimisticPendingStreamStartIdleCaughtUpCount += 1;
  }

  private getLatestHistoricalCompactionRequest(): PendingCompactionRequest | null {
    let sawCompletedCompaction = false;
    const messages = this.getAllMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === "assistant" && this.isCompactionBoundaryMessage(message)) {
        // A completed summary closes the earlier /compact request, so later auto-continue
        // streams must not inherit a stale "compacting" UI state from that older turn.
        sawCompletedCompaction = true;
        continue;
      }
      if (message.role !== "user") continue;
      const muxMetadata = message.metadata?.muxMetadata;
      if (muxMetadata?.type === "compaction-request") {
        return sawCompletedCompaction
          ? null
          : {
              parsed: muxMetadata.parsed,
              source: muxMetadata.source,
            };
      }
      return null;
    }

    return null;
  }

  private getLatestUnresolvedCompactionRequest(): PendingCompactionRequest | null {
    return this.pendingCompactionRequest ?? this.getLatestHistoricalCompactionRequest();
  }

  private resolveStreamStartCompaction(data: StreamStartEvent): boolean {
    // Keep stream classification separate from stream context construction so
    // continue turns after /compact do not inherit stale UI state from history.
    const streamSignalsCompaction = data.agentId === "compact" || data.mode === "compact";
    if (!streamSignalsCompaction && data.agentId != null) {
      return false;
    }

    return streamSignalsCompaction || this.getLatestUnresolvedCompactionRequest() !== null;
  }

  private isDefaultPostCompactionContinueTurn(): boolean {
    const messages = this.getAllMessages();
    const latestMessage = messages.at(-1);
    const previousMessage = messages.at(-2);
    if (latestMessage?.role !== "user" || previousMessage?.role !== "assistant") {
      return false;
    }

    if (latestMessage.metadata?.synthetic !== true) {
      return false;
    }

    const summaryMetadata = previousMessage.metadata?.muxMetadata;
    if (!isCompactionSummaryMetadata(summaryMetadata)) {
      return false;
    }

    // The backend marks internal post-compaction resumes at the compaction follow-up
    // source. This frontend check preserves the policy for replay/tests where only
    // the synthetic user row and compaction summary are available.
    return summaryMetadata.pendingFollowUp?.dispatchOptions?.source === "internal-resume";
  }

  private setPendingStreamStartTime(time: number | null): void {
    this.pendingStreamStartTime = time;
    if (time === null) {
      this.pendingCompactionRequest = null;
      this.pendingStreamModel = null;
      this.optimisticPendingStreamStart = false;
      this.optimisticPendingStreamStartIdleCaughtUpCount = 0;
    }
  }

  private getActiveStreamEntry(): [string, StreamingContext] | undefined {
    return this.activeStreams.entries().next().value;
  }

  /**
   * Get timing statistics for the active stream (if any).
   * Returns null if no active stream exists.
   * Includes live token count and TPS for real-time display.
   */
  getActiveStreamTimingStats(): {
    startTime: number;
    firstTokenTime: number | null;
    toolExecutionMs: number;
    model: string;
    /** Live token count from streaming deltas */
    liveTokenCount: number;
    /** Live tokens-per-second (trailing window) */
    liveTPS: number;
    /** Mode (plan/exec) for this stream */
    mode?: string;
  } | null {
    const activeStream = this.getActiveStreamEntry();
    if (!activeStream) return null;
    const [messageId, context] = activeStream;

    const now = Date.now();

    const startTime = this.translateServerTime(context, context.serverStartTime);
    const firstTokenTime =
      context.serverFirstTokenTime !== null
        ? this.translateServerTime(context, context.serverFirstTokenTime)
        : null;

    // Include time from currently-executing tools (not just completed ones)
    let totalToolMs = context.toolExecutionMs;
    for (const toolStartServerTime of context.pendingToolStarts.values()) {
      const toolStartTime = this.translateServerTime(context, toolStartServerTime);
      totalToolMs += Math.max(0, now - toolStartTime);
    }

    return {
      startTime,
      firstTokenTime,
      toolExecutionMs: totalToolMs,
      model: context.model,
      liveTokenCount: this.getStreamingTokenCount(messageId),
      liveTPS: this.getStreamingTPS(messageId),
      mode: context.mode,
    };
  }

  /**
   * Get timing statistics from the last completed stream.
   * Returns null if no stream has completed yet in this session.
   * Unlike getActiveStreamTimingStats, this includes endTime and token counts.
   */
  getLastCompletedStreamStats(): {
    startTime: number;
    endTime: number;
    firstTokenTime: number | null;
    toolExecutionMs: number;
    model: string;
    outputTokens: number;
    reasoningTokens: number;
    streamingMs: number;
    mode?: string;
  } | null {
    return this.lastCompletedStreamStats;
  }

  /**
   * Get aggregate timing statistics across all completed streams in this session.
   * Totals are computed on-the-fly from per-model data.
   * Returns null if no streams have completed yet.
   *
   * Session timing keys use format "model" or "model:mode" (e.g., "claude-opus-4:plan").
   * The byModelAndMode map preserves this structure for mode breakdown display.
   */
  getSessionTimingStats(): {
    totalDurationMs: number;
    totalToolExecutionMs: number;
    totalStreamingMs: number;
    averageTtftMs: number | null;
    responseCount: number;
    totalOutputTokens: number;
    totalReasoningTokens: number;
    /** Per-model timing breakdown (keys are composite: "model" or "model:mode") */
    byModel: Record<
      string,
      {
        totalDurationMs: number;
        totalToolExecutionMs: number;
        totalStreamingMs: number;
        averageTtftMs: number | null;
        responseCount: number;
        totalOutputTokens: number;
        totalReasoningTokens: number;
        /** Mode extracted from composite key, undefined for old data */
        mode?: string;
      }
    >;
  } | null {
    const modelEntries = Object.entries(this.sessionTimingStats);
    if (modelEntries.length === 0) return null;

    // Aggregate totals from per-model stats
    let totalDurationMs = 0;
    let totalToolExecutionMs = 0;
    let totalStreamingMs = 0;
    let totalTtftMs = 0;
    let ttftCount = 0;
    let responseCount = 0;
    let totalOutputTokens = 0;
    let totalReasoningTokens = 0;

    const byModel: Record<
      string,
      {
        totalDurationMs: number;
        totalToolExecutionMs: number;
        totalStreamingMs: number;
        averageTtftMs: number | null;
        responseCount: number;
        totalOutputTokens: number;
        totalReasoningTokens: number;
        mode?: string;
      }
    > = {};

    for (const [key, stats] of modelEntries) {
      // Parse composite key: "model" or "model:mode"
      // Model names can contain colons (e.g., "mux-gateway:provider/model")
      // so we look for ":plan" or ":exec" suffix specifically
      let mode: string | undefined;
      if (key.endsWith(":plan")) {
        mode = "plan";
      } else if (key.endsWith(":exec")) {
        mode = "exec";
      }

      // Accumulate totals
      totalDurationMs += stats.totalDurationMs;
      totalToolExecutionMs += stats.totalToolExecutionMs;
      totalStreamingMs += stats.totalStreamingMs ?? 0;
      totalTtftMs += stats.totalTtftMs;
      ttftCount += stats.ttftCount;
      responseCount += stats.responseCount;
      totalOutputTokens += stats.totalOutputTokens;
      totalReasoningTokens += stats.totalReasoningTokens;

      // Convert to display format (with computed average)
      // Keep composite key as-is - StatsTab will parse/aggregate as needed
      byModel[key] = {
        totalDurationMs: stats.totalDurationMs,
        totalToolExecutionMs: stats.totalToolExecutionMs,
        totalStreamingMs: stats.totalStreamingMs ?? 0,
        averageTtftMs: stats.ttftCount > 0 ? stats.totalTtftMs / stats.ttftCount : null,
        responseCount: stats.responseCount,
        totalOutputTokens: stats.totalOutputTokens,
        totalReasoningTokens: stats.totalReasoningTokens,
        mode,
      };
    }

    return {
      totalDurationMs,
      totalToolExecutionMs,
      totalStreamingMs,
      averageTtftMs: ttftCount > 0 ? totalTtftMs / ttftCount : null,
      responseCount,
      totalOutputTokens,
      totalReasoningTokens,
      byModel,
    };
  }

  getActiveStreams(): StreamingContext[] {
    return Array.from(this.activeStreams.values());
  }

  getActiveResponseCompleteMetadata() {
    return (
      buildAggregateResponseCompleteMetadata(this.activeStreams.values()) ??
      this.backgroundHandoffCompletion
    );
  }

  handleBackgroundStreamingGenerationAdvance(): void {
    const completion = buildAggregateResponseCompleteMetadata(this.activeStreams.values());
    this.backgroundHandoffCompletion =
      completion?.suppressNotification === true ? completion : undefined;
    this.clearActiveStreams();
  }

  clearBackgroundHandoffCompletion(): void {
    this.backgroundHandoffCompletion = undefined;
  }

  setActiveQueuedFollowUp(hasQueuedFollowUp: boolean): void {
    for (const context of this.activeStreams.values()) {
      context.hasQueuedFollowUp = hasQueuedFollowUp;
    }
  }

  /**
   * Get the active main-agent stream id (for interrupt, live usage, and token tracking).
   * Returns undefined when no interruptible stream is active.
   */
  getMessagePartCount(messageId: string): number {
    return this.messages.get(messageId)?.parts.length ?? 0;
  }

  getActiveStreamMessageId(): string | undefined {
    return this.getActiveStreamEntry()?.[0];
  }

  isStreamActive(messageId: string): boolean {
    return this.activeStreams.has(messageId);
  }

  /**
   * Mark the current active stream as "interrupting" (transient state).
   * Called before interruptStream so UI shows "interrupting..." immediately.
   * Cleared when real stream-abort arrives, at which point "interrupted" shows.
   */
  setInterrupting(): void {
    const activeMessageId = this.getActiveStreamMessageId();
    if (activeMessageId) {
      this.interruptingMessageId = activeMessageId;
      this.invalidateCache();
    }
  }

  /**
   * Check if a message is in the "interrupting" transient state.
   */
  isInterrupting(messageId: string): boolean {
    return this.interruptingMessageId === messageId;
  }

  /**
   * Check if any stream is currently being interrupted.
   */
  hasInterruptingStream(): boolean {
    return this.interruptingMessageId !== null;
  }

  isCompacting(): boolean {
    for (const context of this.activeStreams.values()) {
      if (context.isCompacting) {
        return true;
      }
    }
    return false;
  }

  /** Active streams that can be interrupted via the backend StreamManager. */
  hasInterruptibleActiveStream(): boolean {
    return this.getActiveStreamEntry() !== undefined;
  }

  /**
   * Request-pinned metadata identity of the ACTIVE stream (see
   * StreamingContext.metadataModel). undefined when no stream is active or
   * the backend did not stamp one.
   */
  getActiveStreamMetadataModel(): string | undefined {
    return this.getActiveStreamEntry()?.[1].metadataModel;
  }

  getCurrentModel(): string | undefined {
    const activeStream = this.getActiveStreamEntry();
    if (activeStream) {
      return activeStream[1].model;
    }

    const messages = this.getAllMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === "assistant" && message.metadata?.model) {
        return message.metadata.model;
      }
    }

    return undefined;
  }

  /**
   * Returns the effective thinking level for the current or most recent stream.
   * This reflects the actual level used after model policy clamping, not the
   * user-configured level.
   */
  getCurrentThinkingLevel(): string | undefined {
    const activeStream = this.getActiveStreamEntry();
    if (activeStream) {
      return activeStream[1].thinkingLevel;
    }

    // Only check the most recent assistant message to avoid returning stale
    // values from older turns where settings may have differed. If it lacks
    // thinkingLevel (e.g. error/abort), callers fall back to persisted settings.
    const messages = this.getAllMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === "assistant") {
        return message.metadata?.thinkingLevel;
      }
    }

    return undefined;
  }

  clearActiveStreams(): void {
    const activeMessageIds = Array.from(this.activeStreams.keys());
    this.activeStreams.clear();

    // Clear optimistic interrupt flag since all streams are cleared
    this.interruptingMessageId = null;

    if (activeMessageIds.length > 0) {
      for (const messageId of activeMessageIds) {
        this.bumpMessageVersion(messageId);
      }
      this.invalidateCache();
    }
  }

  /**
   * Replay-visible init output needs a synchronous cache flush. WorkspaceStore can
   * bump subscribers before the normal 100ms init-output throttle fires, and in
   * reconnects that would otherwise leave the newest line hidden until caught-up.
   */
  flushPendingInitOutput(): void {
    if (this.initOutputThrottleTimer) {
      clearTimeout(this.initOutputThrottleTimer);
      this.initOutputThrottleTimer = null;
    }

    this.invalidateCache();
  }

  clearPendingStreamStart(): void {
    this.setPendingStreamStartTime(null);
  }

  resetForReplay(): void {
    const pendingStreamSnapshot =
      this.pendingStreamStartTime === null
        ? null
        : {
            pendingStreamStartTime: this.pendingStreamStartTime,
            pendingCompactionRequest: this.pendingCompactionRequest,
            pendingStreamModel: this.pendingStreamModel,
            optimisticPendingStreamStart: this.optimisticPendingStreamStart,
            optimisticPendingStreamStartIdleCaughtUpCount:
              this.optimisticPendingStreamStartIdleCaughtUpCount,
          };

    this.clear();

    if (!pendingStreamSnapshot) {
      return;
    }

    this.pendingStreamStartTime = pendingStreamSnapshot.pendingStreamStartTime;
    this.pendingCompactionRequest = pendingStreamSnapshot.pendingCompactionRequest;
    this.pendingStreamModel = pendingStreamSnapshot.pendingStreamModel;
    this.optimisticPendingStreamStart = pendingStreamSnapshot.optimisticPendingStreamStart;
    this.optimisticPendingStreamStartIdleCaughtUpCount =
      pendingStreamSnapshot.optimisticPendingStreamStartIdleCaughtUpCount;
  }

  clear(): void {
    this.messages.clear();
    this.activeStreams.clear();
    this.displayedMessageCache.clear();
    this.messageVersions.clear();
    this.clearPendingStreamLifecycleState();
    this.interruptingMessageId = null;
    this.streamLifecycle = null;
    this.lastAbortReason = null;
    this.lastResponseCompletedAt = null;
    this.establishedOldestHistorySequence = null;
    // A since cursor is only safe while rows below its anchor are present locally.
    // Clearing the transcript invalidates that premise, so force a full reconnect.
    this.lastServerHistoryCursor = null;
    this.invalidateCache();
  }

  /**
   * Remove messages with specific historySequence numbers
   * Used when backend truncates history
   */
  handleDeleteMessage(deleteMsg: DeleteMessage): void {
    const sequencesToDelete = new Set(deleteMsg.historySequences);

    // Remove messages that match the historySequence numbers
    for (const [messageId, message] of this.messages.entries()) {
      const historySeq = message.metadata?.historySequence;
      if (historySeq !== undefined && sequencesToDelete.has(historySeq)) {
        this.deleteMessage(messageId);
      }
    }

    // Deleted rows may fall outside the replay window, so invalidate even with no local match.
    this.historyEpoch++;
    this.invalidateCache();
  }

  // Unified event handlers that encapsulate all complex logic
  handleStreamStart(data: StreamStartEvent): void {
    const isCompacting = this.resolveStreamStartCompaction(data);

    this.clearPendingStreamLifecycleState();
    this.lastAbortReason = null;

    // NOTE: We do NOT clear agentStatus or currentTodos here.
    // They are cleared when a new user message arrives (see handleMessage),
    // ensuring consistent behavior whether loading from history or processing live events.

    for (const activeStream of this.activeStreams.values()) {
      activeStream.hasQueuedFollowUp = false;
    }
    this.backgroundHandoffCompletion = undefined;
    const routeProvider = resolveRouteProvider(data.routeProvider, data.routedThroughGateway);

    const suppressNotification =
      this.isDefaultPostCompactionContinueTurn() ||
      this.getLatestUnresolvedCompactionRequest()?.parsed.followUpContent?.dispatchOptions
        ?.source === "internal-resume";
    const now = Date.now();
    const existingContext = this.activeStreams.get(data.messageId);
    // A reconnect can skip the update event while the backend accepts a fallback attempt.
    if (
      data.replay &&
      existingContext &&
      (existingContext.model !== data.model ||
        existingContext.modelFallback?.refusedModels.length !==
          data.modelFallback?.refusedModels.length)
    ) {
      this.activeStreamUsage.delete(data.messageId);
    }
    const context: StreamingContext = {
      serverStartTime: data.startTime,
      clockOffsetMs: now - data.startTime,
      lastServerTimestamp: data.startTime,
      isComplete: false,
      isCompacting,
      hasQueuedFollowUp: false,
      suppressNotification,
      isReplay: data.replay === true,
      model: data.model,
      metadataModel: data.metadataModel,
      modelFallback: data.modelFallback,
      effectiveContextLimit:
        data.effectiveContextLimit !== undefined
          ? data.effectiveContextLimit
          : data.replay
            ? existingContext?.effectiveContextLimit
            : undefined,
      routedThroughGateway: data.routedThroughGateway,
      routeProvider,
      serverFirstTokenTime: null,
      toolExecutionMs: 0,
      pendingToolStarts: new Map(),
      agentId: data.agentId,
      mode: data.mode,
      thinkingLevel: data.thinkingLevel,
    };

    // For incremental replay: stream-start may be re-emitted to re-establish context.
    // If we already have this message with accumulated parts, don't wipe its content.
    const existingMessage = this.messages.get(data.messageId);
    if (data.replay && existingMessage && existingMessage.parts.length > 0) {
      if (existingContext) {
        // Preserve the highest observed server timestamp across reconnect boundaries.
        // If replay emits only stream-start (no newer parts), regressing this value
        // would cause the next since cursor to request already-seen stream events.
        context.lastServerTimestamp = Math.max(
          context.lastServerTimestamp,
          existingContext.lastServerTimestamp
        );
        context.clockOffsetMs = Date.now() - context.lastServerTimestamp;

        context.agentId = data.agentId ?? existingContext.agentId;

        // Preserve in-flight timing context so reconnect doesn't reset active tool timing stats.
        context.serverFirstTokenTime = existingContext.serverFirstTokenTime;
        context.toolExecutionMs = existingContext.toolExecutionMs;
        context.pendingToolStarts = new Map(existingContext.pendingToolStarts);
      }

      this.activeStreams.set(data.messageId, context);
      if (existingMessage.metadata) {
        existingMessage.metadata.model = data.model;
        existingMessage.metadata.metadataModel = data.metadataModel;
        existingMessage.metadata.modelFallback = data.modelFallback;
        existingMessage.metadata.routedThroughGateway = data.routedThroughGateway;
        existingMessage.metadata.routeProvider = routeProvider;
        if (data.agentId != null) {
          existingMessage.metadata.agentId = data.agentId;
        }
        existingMessage.metadata.mode = data.mode;
        existingMessage.metadata.thinkingLevel = data.thinkingLevel;
      }
      this.markMessageDirty(data.messageId);
      return;
    }

    // Use messageId as key - ensures only ONE stream per message
    // If called twice, second call safely overwrites first
    this.activeStreams.set(data.messageId, context);

    // Create initial streaming message with empty parts (deltas will append)
    const streamingMessage = createMuxMessage(data.messageId, "assistant", "", {
      historySequence: data.historySequence,
      timestamp: Date.now(),
      model: data.model,
      metadataModel: data.metadataModel,
      modelFallback: data.modelFallback,
      routedThroughGateway: data.routedThroughGateway,
      routeProvider,
      agentId: data.agentId,
      mode: data.mode,
      thinkingLevel: data.thinkingLevel,
    });

    this.messages.set(data.messageId, streamingMessage);
    this.markMessageDirty(data.messageId);
  }

  handleStreamModelUpdate(data: StreamModelUpdateEvent): void {
    const context = this.activeStreams.get(data.messageId);
    const message = this.messages.get(data.messageId);
    if (!context || !message) return;

    // Keep parts, timestamps, and tool timing. Usage belongs to the new attempt only after its first step.
    context.model = data.model;
    context.metadataModel = data.metadataModel;
    context.effectiveContextLimit = data.effectiveContextLimit;
    context.modelFallback = data.modelFallback;
    context.routedThroughGateway = data.routedThroughGateway;
    context.routeProvider = resolveRouteProvider(data.routeProvider, data.routedThroughGateway);
    context.thinkingLevel = data.thinkingLevel;
    message.metadata = {
      ...message.metadata,
      model: data.model,
      metadataModel: data.metadataModel,
      modelFallback: data.modelFallback,
      routedThroughGateway: data.routedThroughGateway,
      routeProvider: context.routeProvider,
      thinkingLevel: data.thinkingLevel,
    };
    this.activeStreamUsage.delete(data.messageId);
    this.markMessageDirty(data.messageId);
  }

  handleStreamDelta(data: StreamDeltaEvent): void {
    const message = this.messages.get(data.messageId);
    if (!message) return;

    this.syncReplayPhase(data.messageId, data.replay);

    const context = this.activeStreams.get(data.messageId);
    if (context) {
      this.updateStreamClock(context, data.timestamp);

      // Track first token time (only for non-empty deltas)
      if (data.delta.length > 0 && context.serverFirstTokenTime === null) {
        context.serverFirstTokenTime = data.timestamp;
      }
    }

    // Compact-on-append: when the previous part is text (the common case during
    // a text run), append into it in place instead of growing parts unbounded.
    // For a 10k-char reply this drops parts.length from thousands to one and
    // shrinks per-render mergeAdjacentParts cost from O(N) to O(1). The on-disk
    // format is unaffected — partial.json/chat.jsonl persistence happens
    // backend-side; this aggregator's parts are pure in-memory display state.
    const lastPart = message.parts[message.parts.length - 1];
    if (lastPart?.type === "text") {
      lastPart.text += data.delta;
    } else {
      message.parts.push({
        type: "text",
        text: data.delta,
        timestamp: data.timestamp,
      });
    }

    // Track delta for token counting and TPS calculation
    this.trackDelta(data.messageId, data.tokens, data.timestamp, "text");

    this.markMessageDirty(data.messageId);
  }

  handleStreamEnd(data: StreamEndEvent): void {
    // A terminal event means any locally preserved "starting..." state is stale,
    // even if reconnect delivered stream-end without the earlier stream-start.
    this.clearPendingStreamLifecycleState();

    // Direct lookup by messageId - O(1) instead of O(n) find
    const activeStream = this.activeStreams.get(data.messageId);

    if (activeStream) {
      // Normal streaming case: we've been tracking this stream from the start
      const message = this.messages.get(data.messageId);
      if (message?.metadata) {
        // Transparent metadata merge - backend fields flow through automatically
        const updatedMetadata: MuxMetadata = {
          ...message.metadata,
          ...data.metadata,
        };
        updatedMetadata.routeProvider = resolveRouteProvider(
          updatedMetadata.routeProvider,
          updatedMetadata.routedThroughGateway
        );

        const durationMs = data.metadata.duration;
        if (typeof durationMs === "number" && Number.isFinite(durationMs)) {
          this.updateStreamClock(activeStream, activeStream.serverStartTime + durationMs);
        }
        message.metadata = updatedMetadata;

        // Update tool parts with their results if provided
        if (data.parts) {
          // Sync up the tool results from the backend's parts array
          for (const backendPart of data.parts) {
            if (backendPart.type === "dynamic-tool" && backendPart.state === "output-available") {
              const toolPartIndex = message.parts.findIndex(
                (part) => part.type === "dynamic-tool" && part.toolCallId === backendPart.toolCallId
              );
              const toolPart = message.parts[toolPartIndex];
              if (toolPart?.type === "dynamic-tool") {
                // Replace the discriminated-union member instead of mutating its
                // discriminator in place; this keeps TypeScript and runtime shape aligned.
                message.parts[toolPartIndex] = {
                  ...toolPart,
                  state: "output-available",
                  output: backendPart.output,
                };
              }
            }
          }
        }

        // Compact parts to merge adjacent text/reasoning deltas into single strings
        // This reduces memory from thousands of small delta objects to a few merged objects
        this.compactMessageParts(message);
      }

      // Capture completion metadata before cleanup (cleanup removes the stream context).
      // If another turn is already queued, this stream end is only an intermediate handoff.
      const completion = buildResponseCompleteMetadata(activeStream);

      // Clean up stream-scoped state for this stream.
      this.cleanupStreamState(data.messageId);

      const isFinal = this.getActiveStreamEntry() === undefined;

      // Completion timestamp for final streams — the durable "stream ended" fact.
      const completedAt = isFinal ? Date.now() : null;

      // Recency policy: only non-compaction final streams inflate lastResponseCompletedAt.
      // Compaction recency comes from the compacted summary's own timestamp.
      if (completedAt !== null && !activeStream.isCompacting) {
        this.lastResponseCompletedAt = completedAt;
      }

      // Notify on normal stream completion. isFinal = true when no stream remains.
      if (this.workspaceId && this.onResponseComplete) {
        this.onResponseComplete({
          workspaceId: this.workspaceId,
          messageId: data.messageId,
          isFinal,
          finalText: this.extractFinalResponseText(message),
          completion,
          completedAt,
        });
      }
    } else {
      // Reconnection case: user reconnected after stream completed
      // We reconstruct the entire message from the stream-end event
      // The backend now sends us the parts array with proper temporal ordering
      // Backend MUST provide historySequence in metadata

      // Create the complete message
      const routeProvider = resolveRouteProvider(
        data.metadata.routeProvider,
        data.metadata.routedThroughGateway
      );
      const message: MuxMessage = {
        id: data.messageId,
        role: "assistant",
        metadata: {
          ...data.metadata,
          routeProvider,
          timestamp: data.metadata.timestamp ?? Date.now(),
        },
        parts: data.parts,
      };

      this.messages.set(data.messageId, message);

      // Clean up stream-scoped state for this stream.
      this.cleanupStreamState(data.messageId);
    }
    // Keep incomplete plans available across stream boundaries, but clear a fully completed
    // plan once the workspace has no active streams so finished work does not linger.
    if (
      this.activeStreams.size === 0 &&
      this.currentTodos.length > 0 &&
      this.currentTodos.every((todo) => todo.status === "completed")
    ) {
      this.currentTodos = [];
    }

    // Assistant message is now stable (completed or reconnected) - invalidate all caches.
    this.markMessageDirty(data.messageId);
  }

  handleStreamAbort(data: StreamAbortEvent): void {
    // Abort can arrive before stream-start. Clear pending lifecycle UI immediately.
    this.clearPendingStreamLifecycleState();
    this.clearInFlightStreamLifecycle();
    this.lastAbortReason = {
      reason: data.abortReason ?? "system",
      at: Date.now(),
    };

    // Clear "interrupting" state - stream is now fully "interrupted"
    if (this.interruptingMessageId === data.messageId) {
      this.interruptingMessageId = null;
    }

    // Direct lookup by messageId
    const activeStream = this.activeStreams.get(data.messageId);

    if (activeStream) {
      // Mark the message as interrupted and merge metadata (consistent with handleStreamEnd)
      const message = this.messages.get(data.messageId);
      if (message?.metadata) {
        message.metadata = {
          ...message.metadata,
          partial: true,
          ...data.metadata, // Spread abort metadata (usage, duration)
        };

        // Compact parts even on abort - still reduces memory for partial messages
        this.compactMessageParts(message);
      }

      // Clean up stream-scoped state for this stream.
      this.cleanupStreamState(data.messageId);
      // Assistant message is now stable (aborted) - invalidate all caches.
      this.markMessageDirty(data.messageId);
    }
  }

  handleStreamError(data: StreamErrorMessage): void {
    // Error can arrive before/instead of stream-start. Clear pending lifecycle UI immediately.
    this.clearPendingStreamLifecycleState();
    this.clearInFlightStreamLifecycle();

    // Direct lookup by messageId
    const activeStream = this.activeStreams.get(data.messageId);

    if (activeStream) {
      // Mark the message with error metadata
      const message = this.messages.get(data.messageId);
      if (message?.metadata) {
        message.metadata.partial = true;
        message.metadata.error = data.error;
        message.metadata.errorType = data.errorType;

        // Compact parts even on error - still reduces memory for partial messages
        this.compactMessageParts(message);
      }

      // Clean up stream-scoped state for this stream.
      this.cleanupStreamState(data.messageId);
      // Assistant message is now stable (errored) - invalidate all caches.
      this.markMessageDirty(data.messageId);
    } else {
      const existingMessage = this.messages.get(data.messageId);
      if (existingMessage?.role === "assistant" && existingMessage.metadata) {
        existingMessage.metadata.partial = true;
        existingMessage.metadata.error = data.error;
        existingMessage.metadata.errorType = data.errorType;
        this.markMessageDirty(data.messageId);
        return;
      }

      // Pre-stream error (e.g., API key not configured before streaming starts)
      // Create a synthetic error message since there's no active stream to attach to.
      // If replay re-emits the same terminal error later, preserve this message's metadata
      // instead of regenerating ordering fields that can churn append-replay state.
      const maxSequence = Math.max(
        0,
        ...Array.from(this.messages.values()).map((m) => m.metadata?.historySequence ?? 0)
      );
      const errorMessage: MuxMessage = {
        id: data.messageId,
        role: "assistant",
        parts: [],
        metadata: {
          partial: true,
          error: data.error,
          errorType: data.errorType,
          timestamp: Date.now(),
          historySequence: maxSequence + 1,
        },
      };
      this.messages.set(data.messageId, errorMessage);
      this.markMessageDirty(data.messageId);
    }
  }

  handleToolCallStart(data: ToolCallStartEvent): void {
    const message = this.messages.get(data.messageId);
    if (!message) return;

    // If this is a nested call (from PTC code_execution), add to parent's nestedCalls
    if (data.parentToolCallId) {
      const parentPart = message.parts.find(
        (part): part is DynamicToolPart =>
          part.type === "dynamic-tool" && part.toolCallId === data.parentToolCallId
      );
      if (!parentPart) {
        // execute() can emit nested events before the parent part streams in.
        // Never fall through to creating a ghost top-level row: streamManager
        // buffers the nested record and re-emits its events (start, workflow
        // attachment, end) right after the parent part lands.
        return;
      }
      // Initialize nestedCalls array if needed
      parentPart.nestedCalls ??= [];
      // Buffered-merge and reconnect replays re-deliver nested starts the
      // renderer may already have; skip duplicates like the top-level path
      // below does.
      if (parentPart.nestedCalls.some((nc) => nc.toolCallId === data.toolCallId)) {
        return;
      }
      parentPart.nestedCalls.push({
        toolCallId: data.toolCallId,
        toolName: data.toolName,
        state: "input-available",
        input: data.args,
        timestamp: data.timestamp,
      });
      this.markMessageDirty(data.messageId);
      return;
    }

    // Check if this tool call already exists to prevent duplicates
    const existingToolPart = message.parts.find(
      (part): part is DynamicToolPart =>
        part.type === "dynamic-tool" && part.toolCallId === data.toolCallId
    );

    // A live tool-call-execution-start may have arrived before this (replayed) start
    // created the part; fold the stashed timestamp in as if the event carried it.
    const executionStartedAt =
      data.executionStartedAt ??
      this.takeStashedToolExecutionStart(data.messageId, data.toolCallId);

    if (existingToolPart) {
      // A `since` replay re-sends tool-call-start when a queued tool's execute() began
      // after the reconnect cursor. Merge the enriched execution start into the existing
      // row (otherwise the elapsed timer stays hidden) instead of dropping the event.
      if (executionStartedAt !== undefined && existingToolPart.executionStartedAt === undefined) {
        existingToolPart.executionStartedAt = executionStartedAt;
        // Also re-anchor the timing-stats start (seeded from the live tool-call-start's
        // emission timestamp before disconnect), mirroring handleToolCallExecutionStart —
        // otherwise tool-call-end still counts queue wait as execution time.
        this.reanchorPendingToolStart(data.messageId, data.toolCallId, executionStartedAt);
        this.markMessageDirty(data.messageId);
        return;
      }
      console.warn(`Tool call ${data.toolCallId} already exists, skipping duplicate`);
      return;
    }

    // Track tool start time for execution duration calculation.
    // Replayed starts may already carry the true execution start; prefer it so
    // toolExecutionMs never counts time spent queued behind serialized siblings.
    const context = this.activeStreams.get(data.messageId);
    if (context) {
      this.updateStreamClock(context, data.timestamp);
      context.pendingToolStarts.set(data.toolCallId, executionStartedAt ?? data.timestamp);
    }

    // Add tool part to maintain temporal order
    const toolPart: DynamicToolPartPending = {
      type: "dynamic-tool",
      toolCallId: data.toolCallId,
      toolName: data.toolName,
      state: "input-available",
      input: data.args,
      timestamp: data.timestamp,
      // Present on replay when execute() had already begun before reconnect.
      ...(executionStartedAt !== undefined ? { executionStartedAt } : {}),
    };
    message.parts.push(toolPart);

    // Track tokens for tool input
    this.trackDelta(data.messageId, data.tokens, data.timestamp, "tool-args");

    this.markMessageDirty(data.messageId);
  }

  handleToolCallDelta(data: ToolCallDeltaEvent): void {
    // Track delta for token counting and TPS calculation
    this.trackDelta(data.messageId, data.tokens, data.timestamp, "tool-args");
    // Tool deltas are for display - args are in dynamic-tool part
  }

  /**
   * Re-anchor the timing-stats start for a tool whose execute() actually began running.
   * toolExecutionMs sums per-tool durations at tool-call-end; without this, each
   * serialized sibling's duration would include the time it spent queued behind earlier
   * siblings (double-counting tool time and deflating derived streaming/tok-s stats).
   * Provider-executed tools never report an execution start and keep their
   * tool-call-start anchor.
   */
  private reanchorPendingToolStart(
    messageId: string,
    toolCallId: string,
    executionStartedAt: number
  ): void {
    const context = this.activeStreams.get(messageId);
    if (context) {
      this.updateStreamClock(context, executionStartedAt);
      if (context.pendingToolStarts.has(toolCallId)) {
        context.pendingToolStarts.set(toolCallId, executionStartedAt);
      }
    }
  }

  /**
   * Mark when a tool call's execute() actually began running. Parallel tool calls are
   * serialized in the backend, so this arrives once the call reaches the front of the
   * queue — elapsed timers start here instead of at tool-call-start.
   */
  handleToolCallExecutionStart(data: ToolCallExecutionStartEvent): void {
    this.reanchorPendingToolStart(data.messageId, data.toolCallId, data.timestamp);

    const message = this.messages.get(data.messageId);
    const toolPart = message?.parts.find(
      (part): part is DynamicToolPart =>
        part.type === "dynamic-tool" && part.toolCallId === data.toolCallId
    );
    if (!toolPart) {
      // Live event won the race against the replayed tool-call-start that creates the
      // part (execution-start events are not replay-buffered). Stash it for
      // handleToolCallStart to apply.
      const stash =
        this.stashedToolExecutionStarts.get(data.messageId) ?? new Map<string, number>();
      stash.set(data.toolCallId, data.timestamp);
      this.stashedToolExecutionStarts.set(data.messageId, stash);
      return;
    }

    toolPart.executionStartedAt = data.timestamp;
    this.markMessageDirty(data.messageId);
  }

  /** Consume a stashed execution start that arrived before its tool part existed. */
  private takeStashedToolExecutionStart(messageId: string, toolCallId: string): number | undefined {
    const stash = this.stashedToolExecutionStarts.get(messageId);
    const timestamp = stash?.get(toolCallId);
    if (stash && timestamp !== undefined) {
      stash.delete(toolCallId);
      if (stash.size === 0) {
        this.stashedToolExecutionStarts.delete(messageId);
      }
    }
    return timestamp;
  }

  private trackLoadedSkill(skill: LoadedSkill): void {
    const existing = this.loadedSkills.get(skill.name);
    if (
      existing?.name === skill.name &&
      existing.description === skill.description &&
      existing.scope === skill.scope
    ) {
      return;
    }

    this.loadedSkills.set(skill.name, skill);
    // Preserve a stable array reference for getLoadedSkills(): only replace when it changes.
    this.loadedSkillsCache = Array.from(this.loadedSkills.values());

    // A successful load supersedes any previous error for this skill
    if (this.skillLoadErrors.delete(skill.name)) {
      this.skillLoadErrorsCache = Array.from(this.skillLoadErrors.values());
    }
  }

  private trackSkillLoadError(name: string, error: string): void {
    const existing = this.skillLoadErrors.get(name);
    if (existing?.error === error) return;

    this.skillLoadErrors.set(name, { name, error });
    this.skillLoadErrorsCache = Array.from(this.skillLoadErrors.values());

    // A failed load supersedes any earlier success (skill may have been
    // edited/deleted since the previous successful read)
    if (this.loadedSkills.delete(name)) {
      this.loadedSkillsCache = Array.from(this.loadedSkills.values());
    }
  }

  private maybeTrackLoadedSkillFromAgentSkillSnapshot(snapshot: unknown): void {
    const parsed = AgentSkillSnapshotMetadataSchema.safeParse(snapshot);
    if (!parsed.success) {
      return;
    }

    const { skillName, scope } = parsed.data;

    // Don't override an existing entry (e.g. from agent_skill_read) with a placeholder description.
    if (this.loadedSkills.has(skillName)) {
      return;
    }

    this.trackLoadedSkill({
      name: skillName,
      description: `(loaded via /${skillName})`,
      scope,
    });
  }

  private handleAgentSkillReadResult(input: unknown, output: unknown): void {
    const result = parseAgentSkillReadToolResult(output);
    if (!result) {
      return;
    }

    if (result.success) {
      const skill = result.skill;
      this.trackLoadedSkill({
        name: skill.frontmatter.name,
        description: skill.frontmatter.description,
        scope: skill.scope,
      });
      return;
    }

    const parsedInput = AgentSkillReadInputSchema.safeParse(input);
    const skillName = parsedInput.success ? parsedInput.data.name : undefined;
    if (skillName) {
      this.trackSkillLoadError(skillName, result.error);
    }
  }

  /**
   * Process a completed tool call's result to update derived state.
   * Called for both live tool-call-end events and historical tool parts.
   *
   * This is the single source of truth for updating state from tool results,
   * ensuring consistency whether processing live events or historical messages.
   *
   * @param toolName - Name of the tool that was called
   * @param input - Tool input arguments
   * @param output - Tool output result
   * @param messageContext - Optional metadata about the assistant message that
   *   owns this tool call. Used by `review_pane_update` to stamp each
   *   agent-flagged hunk with the originating turn's timestamp so the UI
   *   can render a "new since last update" badge for freshly-added pins.
   */
  private processToolResult(
    toolName: string,
    input: unknown,
    output: unknown,
    // Present only for live (non-replay) tool results. History hydration and reconnect
    // replay omit it so user-visible side effects (browser notifications, assisted-review
    // "new" badges) never re-fire for events the user already saw.
    liveContext?: { timestamp: number }
  ): void {
    // Update TODO state if this was a successful todo_write.
    // We still reconstruct from history so interrupted/incomplete plans survive reloads;
    // final completed plans are cleared later when the last active stream ends.
    if (toolName === "todo_write" && hasSuccessResult(output)) {
      const args = parseTodoWriteInput(input);
      if (args && !this.todosEqual(this.currentTodos, args.todos)) {
        // Guard against malformed historical data and update only on real changes
        // to prevent flicker from equivalent-but-new todo array references.
        this.currentTodos = args.todos;
      }
    }

    // Update Assisted Review state when review_pane_update succeeds.
    // The tool returns the resulting list directly (already merged + deduped
    // by the handler), so we just re-parse the formatted strings into our
    // structured AssistedReviewHunk form. Re-running this across the entire
    // history naturally reconstructs the final state on reload.
    //
    // We additionally carry `addedAt` per pin so the UI can render a
    // transient "new" badge for freshly-added pins.
    //
    // Carryover semantics:
    //   - `operation: "add"` — the agent is appending to or refining the
    //     existing set, so a previously-seen key keeps its original
    //     `addedAt`. This prevents an `add` that just tweaks a comment
    //     from re-arming the "new" badge.
    //   - `operation: "replace"` — the agent is republishing a fresh
    //     snapshot. Treat every entry as new for metadata purposes (the
    //     same key reappearing is an explicit re-flag, not a refinement),
    //     so the UI can re-highlight the snapshot.
    if (toolName === "review_pane_update") {
      const parsed = ReviewPaneUpdateSuccessResultSchema.safeParse(output);
      if (parsed.success) {
        const previousByKey = new Map<string, AssistedReviewHunk>();
        for (const prev of this.assistedReviewHunks) {
          previousByKey.set(formatAssistedFilter(prev), prev);
        }

        const isAdd = parsed.data.operation === "add";

        const next: AssistedReviewHunk[] = [];
        for (const entry of parsed.data.hunks) {
          const filter = parseAssistedFilter(entry.path);
          if (!filter) continue;
          const candidate: AssistedReviewHunk = {
            path: filter.path,
            range: filter.range,
            comment: entry.comment ?? undefined,
          };
          const key = formatAssistedFilter(candidate);
          const previous = previousByKey.get(key);
          if (isAdd && previous) {
            // Carry forward addedAt for `add` ops only so a refined
            // comment doesn't reset the "new" badge.
            candidate.addedAt = previous.addedAt;
          } else if (liveContext !== undefined) {
            // `replace` op (or first time we've seen this key under any op):
            // stamp with the current message's timestamp. `replace` is an
            // explicit republish, so reuse of an old key should still
            // re-arm the "new" badge. Replay deliberately omits the
            // timestamp so historical pins don't all light up as "new"
            // on initial load.
            candidate.addedAt = liveContext.timestamp;
          }
          next.push(candidate);
        }
        this.assistedReviewHunks = next;
      }
    }

    if (toolName === "propose_plan" && hasSuccessResult(output) && this.currentTodos.length > 0) {
      const completedTodos = completeInProgressTodoItems(this.currentTodos);
      if (completedTodos !== this.currentTodos) {
        this.currentTodos = completedTodos;
      }
    }

    // Update agent status if this was a successful status_set
    // agentStatus persists: update both during streaming and on historical reload
    // Use output instead of input to get the truncated message
    if (toolName === "status_set") {
      const result = parseStatusSetSuccessResult(output);
      if (result) {
        // Use the provided URL, or fall back to the last URL ever set.
        const url = result.url ?? this.lastStatusUrl;
        if (url) {
          this.lastStatusUrl = url;
        }

        this.agentStatus = {
          emoji: result.emoji,
          message: result.message,
          url,
        };
        this.savePersistedAgentStatus(this.agentStatus);
      }
    }

    // Handle browser notifications when Electron wasn't available.
    // Live results only: notify outputs are persisted in history with their routing
    // metadata, so history hydration and reconnect replay would otherwise re-fire
    // OS notifications for past events on every workspace switch or reload (#2547).
    if (toolName === "notify" && liveContext !== undefined) {
      const result = parseNotifySuccessResult(output);
      if (result) {
        const uiOnlyNotify = getToolOutputUiOnly(output)?.notify;
        const legacyNotify = parseLegacyNotifyRouting(output);
        const notifiedVia = uiOnlyNotify?.notifiedVia ?? legacyNotify?.notifiedVia;
        const workspaceId = uiOnlyNotify?.workspaceId ?? legacyNotify?.workspaceId;

        if (notifiedVia === "browser") {
          this.sendBrowserNotification(result.title, result.message, workspaceId);
        }
      }
    }

    if (toolName === "agent_skill_read") {
      // Keep agent_skill_read parsing separate so this router only decides *which*
      // derived-state handler should run for a tool result.
      this.handleAgentSkillReadResult(input, output);
    }

    // Link extraction is derived from message history (see computeLinksFromMessages()).
    // When a tool output becomes available, handleToolCallEnd invalidates the link cache.
  }

  /**
   * Send a browser notification using the Web Notifications API
   * Only called when Electron notifications are unavailable.
   * Clicking the notification navigates to the workspace.
   */
  private sendBrowserNotification(title: string, body?: string, workspaceId?: string): void {
    showBrowserNotification(title, {
      body,
      onClick: workspaceId
        ? () => {
            // Focus the window and navigate to the workspace.
            window.focus();
            this.onNavigateToWorkspace?.(workspaceId);
          }
        : undefined,
    });
  }

  handleToolCallEnd(data: ToolCallEndEvent): void {
    // Track tool execution duration
    const context = this.activeStreams.get(data.messageId);
    if (context) {
      this.updateStreamClock(context, data.timestamp);

      const startTime = context.pendingToolStarts.get(data.toolCallId);
      if (startTime !== undefined) {
        // Clamp to non-negative to handle out-of-order timestamps during replay
        context.toolExecutionMs += Math.max(0, data.timestamp - startTime);
        context.pendingToolStarts.delete(data.toolCallId);
      }
    }

    const message = this.messages.get(data.messageId);
    if (message) {
      // If nested, update in parent's nestedCalls array
      if (data.parentToolCallId) {
        const parentIndex = message.parts.findIndex(
          (part): part is DynamicToolPart =>
            part.type === "dynamic-tool" && part.toolCallId === data.parentToolCallId
        );
        const parentPart = message.parts[parentIndex] as DynamicToolPart | undefined;
        if (parentPart?.nestedCalls) {
          const nestedIndex = parentPart.nestedCalls.findIndex(
            (nc) => nc.toolCallId === data.toolCallId
          );
          if (nestedIndex !== -1) {
            // Create new objects to trigger React re-render (immutable update pattern)
            const updatedNestedCalls = parentPart.nestedCalls.map((nc, i) =>
              i === nestedIndex
                ? { ...nc, state: "output-available" as const, output: data.result }
                : nc
            );
            message.parts[parentIndex] = { ...parentPart, nestedCalls: updatedNestedCalls };
            this.markMessageDirty(data.messageId);
            return;
          }
        }
      }

      // Find the specific tool part by its ID and update it with the result.
      // We don't move it - it stays in its original temporal position.
      const toolPartIndex = message.parts.findIndex(
        (part) => part.type === "dynamic-tool" && part.toolCallId === data.toolCallId
      );
      const toolPart = message.parts[toolPartIndex];
      if (toolPart?.type === "dynamic-tool") {
        message.parts[toolPartIndex] = {
          ...toolPart,
          state: "output-available",
          output: data.result,
        };

        // Process tool result to update derived state (todos, agentStatus, etc.)
        // Live updates stamp a fresh `Date.now()` so the Assisted-review "new"
        // badge can highlight just-introduced pins. Reconnect replay re-emits
        // tool-call-end for already-completed calls, so treat those like the
        // history-hydration path: no fresh timestamp and no notification re-fire.
        this.processToolResult(
          data.toolName,
          toolPart.input,
          data.result,
          data.replay === true ? undefined : { timestamp: Date.now() }
        );

        // Tool output is now stable - invalidate all caches.
        this.markMessageDirty(data.messageId);
      } else {
        // Tool part not found (shouldn't happen normally) - still invalidate display cache.
        this.markMessageDirty(data.messageId);
      }
    }
  }

  handleReasoningDelta(data: ReasoningDeltaEvent): void {
    const message = this.messages.get(data.messageId);
    if (!message) return;

    this.syncReplayPhase(data.messageId, data.replay);

    const context = this.activeStreams.get(data.messageId);
    if (context) {
      this.updateStreamClock(context, data.timestamp);

      // Track first token time (reasoning also counts as first token)
      if (data.delta.length > 0 && context.serverFirstTokenTime === null) {
        context.serverFirstTokenTime = data.timestamp;
      }
    }

    // Compact-on-append for reasoning runs (same rationale as handleStreamDelta).
    const lastPart = message.parts[message.parts.length - 1];
    if (lastPart?.type === "reasoning") {
      lastPart.text += data.delta;
    } else {
      message.parts.push({
        type: "reasoning",
        text: data.delta,
        timestamp: data.timestamp,
      });
    }

    // Track delta for token counting and TPS calculation
    this.trackDelta(data.messageId, data.tokens, data.timestamp, "reasoning");

    this.markMessageDirty(data.messageId);
  }

  handleReasoningEnd(_data: ReasoningEndEvent): void {
    // Reasoning-end is just a signal - no state to update
    // Streaming status is inferred from activeStreams in getDisplayedMessages
    this.invalidateCache();
  }

  private clearReplayInitVisiblePrefix(): void {
    this.replayInitVisiblePrefix = null;
    this.replayInitVisiblePrefixIndex = 0;
  }

  private shouldSkipVisibleReplayInitOutput(line: string, isError: boolean): boolean {
    const prefix = this.replayInitVisiblePrefix;
    if (!prefix) {
      return false;
    }

    const nextVisibleLine = prefix[this.replayInitVisiblePrefixIndex];
    if (nextVisibleLine?.line !== line || nextVisibleLine?.isError !== isError) {
      this.clearReplayInitVisiblePrefix();
      return false;
    }

    this.replayInitVisiblePrefixIndex += 1;
    if (this.replayInitVisiblePrefixIndex >= prefix.length) {
      this.clearReplayInitVisiblePrefix();
    }

    return true;
  }

  private shouldSkipReplayInitEvent(data: WorkspaceChatMessage): boolean {
    if (
      (data as { replay?: boolean }).replay !== true ||
      (!isInitStart(data) && !isInitOutput(data) && !isInitEnd(data))
    ) {
      return false;
    }

    if (this.appliedReplayInitEvents.has(data as object)) {
      return true;
    }

    this.appliedReplayInitEvents.add(data as object);
    return false;
  }

  handleMessage(data: WorkspaceChatMessage): void {
    if (this.shouldSkipReplayInitEvent(data)) {
      return;
    }

    if (this.handleInitMessage(data)) {
      return;
    }

    if (isMuxMessage(data)) {
      this.handleMuxMessage(data);
    }
  }

  private handleInitMessage(data: WorkspaceChatMessage): boolean {
    if (isInitStart(data)) {
      const isReplay = (data as { replay?: boolean }).replay === true;
      if (
        isReplay &&
        this.initState?.status === "running" &&
        this.initState.hookPath === data.hookPath &&
        this.initState.startTime === data.timestamp
      ) {
        // Reconnect replay re-emits init-start before replayed lines. Treat the same running init
        // as a no-op so switching back never clears the visible SSH/setup output mid-replay.
        this.replayInitVisiblePrefix = [...this.initState.lines];
        this.replayInitVisiblePrefixIndex = 0;
        return true;
      }

      this.clearReplayInitVisiblePrefix();
      this.initState = {
        status: "running",
        hookPath: data.hookPath,
        lines: [],
        exitCode: null,
        startTime: data.timestamp,
        endTime: null,
      };
      this.invalidateCache();
      return true;
    }

    if (isInitOutput(data)) {
      if (!this.initState) {
        console.error("Received init-output without init-start", { data });
        return true;
      }
      if (!data.line) {
        console.error("Received init-output with missing line field", { data });
        return true;
      }
      const line = data.line.trimEnd();
      const isError = data.isError === true;
      const isReplay = (data as { replay?: boolean }).replay === true;
      if (isReplay && this.shouldSkipVisibleReplayInitOutput(line, isError)) {
        return true;
      }

      // Truncation: keep only the most recent MAX_LINES (matches backend).
      if (this.initState.lines.length >= INIT_HOOK_MAX_LINES) {
        this.initState.lines.shift();
        this.initState.truncatedLines = (this.initState.truncatedLines ?? 0) + 1;
      }
      this.initState.lines.push({ line, isError });

      // Throttle cache invalidation during fast streaming to avoid re-render per line.
      this.initOutputThrottleTimer ??= setTimeout(() => {
        this.initOutputThrottleTimer = null;
        this.invalidateCache();
      }, StreamingMessageAggregator.INIT_OUTPUT_THROTTLE_MS);
      return true;
    }

    if (isInitEnd(data)) {
      this.clearReplayInitVisiblePrefix();
      if (!this.initState) {
        console.error("Received init-end without init-start", { data });
        return true;
      }
      this.initState.exitCode = data.exitCode;
      this.initState.status = data.exitCode === 0 ? "success" : "error";
      this.initState.endTime = data.timestamp;
      // Use backend truncation count if larger (covers replay of old data).
      if (data.truncatedLines && data.truncatedLines > (this.initState.truncatedLines ?? 0)) {
        this.initState.truncatedLines = data.truncatedLines;
      }
      if (this.initOutputThrottleTimer) {
        clearTimeout(this.initOutputThrottleTimer);
        this.initOutputThrottleTimer = null;
      }
      // Reset pending stream start time so the grace period starts fresh after init completes.
      // This prevents false retry barriers for slow init (e.g., Coder workspace provisioning).
      if (this.pendingStreamStartTime !== null) {
        this.setPendingStreamStartTime(Date.now());
      }
      this.invalidateCache();
      return true;
    }

    return false;
  }

  private handleMuxMessage(data: MuxMessage): void {
    const incomingMessage = normalizeMessageRouteProvider(data);

    // Smart replacement logic for edits: if history was truncated, remove the
    // existing message at the incoming sequence and all subsequent messages.
    const incomingSequence = incomingMessage.metadata?.historySequence;
    if (incomingSequence !== undefined) {
      for (const [_id, msg] of this.messages.entries()) {
        const existingSequence = msg.metadata?.historySequence;
        if (existingSequence !== undefined && existingSequence >= incomingSequence) {
          const messagesToRemove: string[] = [];
          for (const [removeId, removeMsg] of this.messages.entries()) {
            const removeSeq = removeMsg.metadata?.historySequence;
            if (removeSeq !== undefined && removeSeq >= incomingSequence) {
              messagesToRemove.push(removeId);
            }
          }
          for (const removeId of messagesToRemove) {
            this.deleteMessage(removeId);
          }
          break;
        }
      }
    }

    // When a compaction boundary arrives during a live session, prune messages
    // older than the incoming boundary sequence so the UI matches a fresh load
    // while older epochs remain available via Load More history pagination.
    if (this.isCompactionBoundaryMessage(incomingMessage)) {
      this.pruneBeforeLatestBoundary(incomingMessage);
    }

    this.addMessage(incomingMessage);
    this.maybeTrackLoadedSkillFromAgentSkillSnapshot(incomingMessage.metadata?.agentSkillSnapshot);

    if (incomingMessage.role !== "user") {
      return;
    }

    if (isDisplayOnlyCompletedSubagentReport(incomingMessage)) {
      // A terminal report card is appended for visibility after the parent already answered the
      // progress update. It intentionally starts no new parent turn, so preserve the idle lifecycle
      // instead of briefly presenting the card as an interrupted user request.
      return;
    }

    // Reset terminal lifecycle snapshots from the previous turn immediately so
    // the next accepted send never inherits a stale interrupted/failed state.
    this.streamLifecycle = null;

    const muxMeta = incomingMessage.metadata?.muxMetadata as
      | { displayStatus?: { emoji: string; message: string } }
      | undefined;
    const muxMetadata = incomingMessage.metadata?.muxMetadata;
    this.pendingCompactionRequest =
      muxMetadata?.type === "compaction-request"
        ? {
            parsed: muxMetadata.parsed,
            source: muxMetadata.source,
          }
        : null;

    this.optimisticPendingStreamStart = false;
    this.optimisticPendingStreamStartIdleCaughtUpCount = 0;
    this.pendingStreamModel = muxMetadata?.requestedModel ?? null;

    if (muxMeta?.displayStatus) {
      this.agentStatus = muxMeta.displayStatus;
    } else {
      this.agentStatus = undefined;
      this.clearPersistedAgentStatus();
    }

    this.lastAbortReason = null;
    this.setPendingStreamStartTime(Date.now());
  }

  private isContextBoundaryMessage(message: MuxMessage): boolean {
    return (
      this.isCompactionBoundaryMessage(message) ||
      getContextBoundaryKind(message) === CONTEXT_BOUNDARY_KINDS.RESET
    );
  }

  private isCompactionBoundaryMessage(message: MuxMessage): boolean {
    const muxMeta = message.metadata?.muxMetadata;
    return (
      message.role === "assistant" &&
      (getContextBoundaryKind(message) === CONTEXT_BOUNDARY_KINDS.COMPACTION ||
        muxMeta?.type === "compaction-summary")
    );
  }

  /**
   * Keep only the latest epoch visible during a live session.
   *
   * When a new boundary arrives, existing messages still represent older epochs.
   * Prune every existing message with a lower sequence than the incoming boundary
   * so once the incoming boundary is appended, the transcript matches fresh loads
   * from getHistoryFromLatestBoundary(skip=0). Older epochs remain accessible via
   * Load More.
   */
  private pruneBeforeLatestBoundary(incomingBoundary: MuxMessage): void {
    const incomingBoundarySequence = incomingBoundary.metadata?.historySequence;
    // Self-healing guard: malformed boundary metadata should not crash live sessions.
    if (incomingBoundarySequence === undefined) return;

    // Live compaction advances the replay window floor to the incoming boundary.
    // Keep reconnect cursors aligned with the server's latest-boundary replay window
    // so incremental reconnects remain eligible after compaction.
    if (
      this.establishedOldestHistorySequence === null ||
      incomingBoundarySequence > this.establishedOldestHistorySequence
    ) {
      this.establishedOldestHistorySequence = incomingBoundarySequence;
    }

    const toRemove: string[] = [];
    for (const [id, msg] of this.messages.entries()) {
      const seq = msg.metadata?.historySequence;
      if (seq !== undefined && seq < incomingBoundarySequence) {
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      this.deleteMessage(id);
    }

    if (toRemove.length > 0) {
      this.invalidateCache();
    }
  }

  private buildDisplayedMessagesForMessage(
    message: MuxMessage,
    agentSkillSnapshot?: { frontmatterYaml?: string; body?: string },
    inlineSkillSnapshots?: InlineSkillSnapshotMap
  ): DisplayedMessage[] {
    return buildDisplayedMessagesForMessage({
      message,
      agentSkillSnapshot,
      inlineSkillSnapshots,
      hasActiveStream: this.activeStreams.has(message.id),
      streamIsReplay: this.activeStreams.get(message.id)?.isReplay,
      isContextBoundaryMessage: (candidate) => this.isContextBoundaryMessage(candidate),
    });
  }

  private compareTranscriptCuts(left: MessagePartSplitCut, right: MessagePartSplitCut): number {
    const leftContentLength = left.textLength + left.reasoningLength;
    const rightContentLength = right.textLength + right.reasoningLength;
    return (
      left.partIndex - right.partIndex ||
      leftContentLength - rightContentLength ||
      left.textLength - right.textLength
    );
  }

  private getAssistantTailCut(message: MuxMessage): MessagePartSplitCut {
    const parts = mergeAdjacentParts(message.parts);
    let textLength = 0;
    let reasoningLength = 0;
    for (const part of parts) {
      if (part.type === "text") textLength += part.text.length;
      if (part.type === "reasoning") reasoningLength += part.text.length;
    }
    return { textLength, reasoningLength, partIndex: parts.length };
  }

  private isReportResponseAssistant(
    message: MuxMessage,
    shouldHideMessageFromTranscript: (message: MuxMessage) => boolean
  ): boolean {
    return (
      message.role === "assistant" &&
      message.metadata?.synthetic !== true &&
      message.metadata?.muxMetadata?.type !== "plan-display" &&
      !shouldHideMessageFromTranscript(message) &&
      !this.isContextBoundaryMessage(message)
    );
  }

  private isDisplayOnlyTailMessage(message: MuxMessage): boolean {
    return (
      isDisplayOnlyCompletedSubagentReport(message) ||
      message.metadata?.muxMetadata?.type === "plan-display"
    );
  }

  private findReportResponseTarget(
    allMessages: readonly MuxMessage[],
    reportIndex: number,
    reportMessage: MuxMessage,
    shouldHideMessageFromTranscript: (message: MuxMessage) => boolean
  ): MuxMessage | undefined {
    const report = parseSubagentReportEnvelope(getTextPartContent(reportMessage.parts));
    if (!report) {
      return undefined;
    }

    let progressIndex = -1;
    let hasPriorContextBoundary = false;
    for (let index = reportIndex - 1; index >= 0; index--) {
      const candidate = allMessages[index];
      if (this.isContextBoundaryMessage(candidate)) {
        hasPriorContextBoundary = true;
        break;
      }
      if (candidate.role !== "user") continue;
      const priorReport = parseSubagentReportEnvelope(getTextPartContent(candidate.parts));
      if (priorReport?.taskId === report.taskId && priorReport.status === "in_progress") {
        progressIndex = index;
        break;
      }
    }

    if (progressIndex >= 0) {
      // Pair historical cards with the first assistant response to their progress turn. Exact
      // within-response placement is optional anchor precision; this causal boundary is durable.
      for (let index = progressIndex + 1; index < reportIndex; index++) {
        const candidate = allMessages[index];
        if (this.isContextBoundaryMessage(candidate)) return undefined;
        if (this.isDisplayOnlyTailMessage(candidate)) continue;
        if (this.isReportResponseAssistant(candidate, shouldHideMessageFromTranscript)) {
          return candidate;
        }
        if (candidate.role === "user" && !shouldHideMessageFromTranscript(candidate)) {
          return undefined;
        }
      }
      return undefined;
    }

    if (hasPriorContextBoundary) {
      return undefined;
    }

    // Older pages or compaction may omit the progress row. Use only the immediately preceding
    // semantic row in this epoch, so later turns cannot change the repaired placement.
    for (let index = reportIndex - 1; index >= 0; index--) {
      const candidate = allMessages[index];
      if (this.isContextBoundaryMessage(candidate)) return undefined;
      if (shouldHideMessageFromTranscript(candidate)) continue;
      if (this.isDisplayOnlyTailMessage(candidate)) continue;
      return this.isReportResponseAssistant(candidate, shouldHideMessageFromTranscript)
        ? candidate
        : undefined;
    }
    return undefined;
  }

  private compareTranscriptInsertions(
    left: TranscriptInsertion,
    right: TranscriptInsertion
  ): number {
    const leftSequence = left.insertionMessage.metadata?.historySequence ?? Infinity;
    const rightSequence = right.insertionMessage.metadata?.historySequence ?? Infinity;
    return (
      this.compareTranscriptCuts(left, right) ||
      leftSequence - rightSequence ||
      left.insertionMessage.id.localeCompare(right.insertionMessage.id)
    );
  }

  private buildTranscriptInsertionPlan(
    allMessages: readonly MuxMessage[],
    shouldHideMessageFromTranscript: (message: MuxMessage) => boolean
  ): TranscriptInsertionPlan {
    const messagesById = new Map(allMessages.map((message) => [message.id, message]));
    const messageIndexById = new Map(allMessages.map((message, index) => [message.id, index]));
    const insertionsByTargetId = new Map<string, TranscriptInsertion[]>();
    const inlineMessageIds = new Set<string>();

    for (let messageIndex = 0; messageIndex < allMessages.length; messageIndex++) {
      const message = allMessages[messageIndex];
      if (!isDisplayOnlyCompletedSubagentReport(message)) {
        continue;
      }

      const responseTarget = this.findReportResponseTarget(
        allMessages,
        messageIndex,
        message,
        shouldHideMessageFromTranscript
      );
      const anchor = message.metadata?.transcriptAnchor;
      const anchoredTarget = anchor ? messagesById.get(anchor.messageId) : undefined;
      const anchoredTargetIndex = anchor ? messageIndexById.get(anchor.messageId) : undefined;
      const anchorSharesContextEpoch =
        anchoredTargetIndex !== undefined &&
        anchoredTargetIndex < messageIndex &&
        !allMessages
          .slice(anchoredTargetIndex + 1, messageIndex)
          .some((candidate) => this.isContextBoundaryMessage(candidate));
      const hasValidAnchorTarget =
        anchoredTarget !== undefined &&
        this.isReportResponseAssistant(anchoredTarget, shouldHideMessageFromTranscript) &&
        anchoredTarget.metadata?.historySequence === anchor?.historySequence &&
        anchorSharesContextEpoch;
      // A valid same-epoch anchor records the actual completion point and is more precise than
      // the earlier assistant response inferred from the task's progress turn.
      const useAnchor = hasValidAnchorTarget;
      const target = useAnchor ? anchoredTarget : responseTarget;
      if (!target) {
        continue;
      }

      let cut: MessagePartSplitCut =
        useAnchor && anchor
          ? {
              textLength: Math.max(0, anchor.textLength),
              reasoningLength: Math.max(0, anchor.reasoningLength),
              partIndex: Math.max(0, anchor.partIndex),
            }
          : { textLength: 0, reasoningLength: 0, partIndex: 0 };
      // Exact anchors are optional precision. Once a turn settles, a tail/beyond-tail anchor
      // downgrades to the stable message boundary so the completed card cannot remain a postscript.
      if (
        useAnchor &&
        !this.activeStreams.has(target.id) &&
        this.compareTranscriptCuts(cut, this.getAssistantTailCut(target)) >= 0
      ) {
        cut = { textLength: 0, reasoningLength: 0, partIndex: 0 };
      }

      const insertion: TranscriptInsertion = { ...cut, insertionMessage: message };
      const existing = insertionsByTargetId.get(target.id);
      if (existing) {
        existing.push(insertion);
      } else {
        insertionsByTargetId.set(target.id, [insertion]);
      }
      inlineMessageIds.add(message.id);
    }

    for (const insertions of insertionsByTargetId.values()) {
      insertions.sort((left, right) => this.compareTranscriptInsertions(left, right));
    }

    return { insertionsByTargetId, inlineMessageIds };
  }

  /** Split message parts at stable text/reasoning offsets and canonical part indexes. */
  private splitMessagePartsAtTranscriptAnchors(
    parts: MuxMessage["parts"],
    cutPoints: readonly MessagePartSplitCut[]
  ): Array<MuxMessage["parts"]> {
    const sortedCuts = [...cutPoints].sort((a, b) => {
      const aContentLength = a.textLength + a.reasoningLength;
      const bContentLength = b.textLength + b.reasoningLength;
      return (
        a.partIndex - b.partIndex || aContentLength - bContentLength || a.textLength - b.textLength
      );
    });
    const segments: Array<MuxMessage["parts"]> = sortedCuts.map(() => []);
    segments.push([]);

    let cumulativeText = 0;
    let cumulativeReasoning = 0;
    let currentSegment = 0;

    const advanceThroughCuts = (nextPartIndex: number): void => {
      while (currentSegment < sortedCuts.length) {
        const cut = sortedCuts[currentSegment];
        if (cumulativeText < cut.textLength || cumulativeReasoning < cut.reasoningLength) return;
        if (nextPartIndex < cut.partIndex) return;
        currentSegment++;
      }
    };

    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex];
      advanceThroughCuts(partIndex);
      if (part.type !== "text" && part.type !== "reasoning") {
        segments[currentSegment].push(part);
        advanceThroughCuts(partIndex + 1);
        continue;
      }

      let remaining = part.text;
      while (currentSegment < sortedCuts.length) {
        const cut = sortedCuts[currentSegment];
        if (partIndex + 1 < cut.partIndex) {
          break;
        }

        const currentLength = part.type === "text" ? cumulativeText : cumulativeReasoning;
        const targetLength = part.type === "text" ? cut.textLength : cut.reasoningLength;
        const charsLeftInCurrentSegment = targetLength - currentLength;
        if (charsLeftInCurrentSegment >= remaining.length) {
          break;
        }
        if (charsLeftInCurrentSegment <= 0) {
          const beforeAdvance = currentSegment;
          advanceThroughCuts(partIndex + 1);
          if (beforeAdvance === currentSegment) {
            break;
          }
          continue;
        }

        const prefix = remaining.slice(0, charsLeftInCurrentSegment);
        segments[currentSegment].push({ ...part, text: prefix });
        if (part.type === "text") {
          cumulativeText += prefix.length;
        } else {
          cumulativeReasoning += prefix.length;
        }
        remaining = remaining.slice(charsLeftInCurrentSegment);
        advanceThroughCuts(partIndex + 1);
      }

      if (remaining.length > 0) {
        segments[currentSegment].push({ ...part, text: remaining });
        if (part.type === "text") {
          cumulativeText += remaining.length;
        } else {
          cumulativeReasoning += remaining.length;
        }
        advanceThroughCuts(partIndex + 1);
      }
    }

    return segments;
  }

  /**
   * Project display-only transcript insertions into a streaming assistant row.
   * The final segment keeps the original id so active-stream state remains attached.
   */
  private buildMessageDisplayWithInsertions(
    message: MuxMessage,
    insertions: readonly TranscriptInsertion[],
    agentSkillSnapshot?: { frontmatterYaml?: string; body?: string },
    inlineSkillSnapshots?: InlineSkillSnapshotMap
  ): DisplayedMessage[] {
    const sorted = [...insertions].sort((left, right) =>
      this.compareTranscriptInsertions(left, right)
    );
    const segments = this.splitMessagePartsAtTranscriptAnchors(
      mergeAdjacentParts(message.parts),
      sorted.map((insertion) => ({
        textLength: insertion.textLength,
        reasoningLength: insertion.reasoningLength,
        partIndex: insertion.partIndex,
      }))
    );

    const result: DisplayedMessage[] = [];

    for (let i = 0; i < segments.length; i++) {
      const isLastSegment = i === segments.length - 1;
      const segParts = segments[i];

      if (segParts.length > 0 || isLastSegment) {
        const segMessageId = isLastSegment ? message.id : `${message.id}#seg${i}`;
        const segMessage: MuxMessage = {
          ...message,
          id: segMessageId,
          parts: segParts,
          // Terminal decorations belong to the original assistant tail, not every display segment.
          metadata:
            isLastSegment || !message.metadata
              ? message.metadata
              : {
                  ...message.metadata,
                  error: undefined,
                  errorType: undefined,
                  finishReason: undefined,
                },
        };

        const segRows = this.buildDisplayedMessagesForMessage(
          segMessage,
          agentSkillSnapshot,
          inlineSkillSnapshots
        );

        if (!isLastSegment) {
          for (const row of segRows) {
            if ("historyId" in row && row.historyId === segMessageId) {
              (row as { historyId: string }).historyId = message.id;
            }
            // Inserted rows split one assistant message into temporary display segments. Only the
            // real tail may render terminal response chrome (Copy / Start Here / Fork / metadata).
            if ("isLastPartOfMessage" in row) {
              row.isLastPartOfMessage = false;
            }
          }
        }

        result.push(...segRows);
      }

      if (i < sorted.length) {
        const insertion = sorted[i];
        result.push(...this.buildDisplayedMessagesForMessage(insertion.insertionMessage));
      }
    }

    // An anchor at (or beyond) the current content tail creates an empty final segment. Once the
    // stream settles, restore terminal chrome to the last emitted assistant row. While active,
    // keep that row non-final: the target can still append content after the inserted report.
    if (!this.activeStreams.has(message.id)) {
      for (let i = result.length - 1; i >= 0; i--) {
        const row = result[i];
        if ("historyId" in row && row.historyId === message.id && "isLastPartOfMessage" in row) {
          row.isLastPartOfMessage = true;
          break;
        }
      }
    }

    return result;
  }

  /**
   * After filtering older tool/reasoning parts, recompute which part is the
   * last visible block for each assistant message. This keeps meta rows and
   * interrupted barriers accurate after truncation.
   */
  private normalizeLastPartFlags(messages: DisplayedMessage[]): DisplayedMessage[] {
    const seenHistoryIds = new Set<string>();
    let didChange = false;
    const normalized = messages.slice();

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!("isLastPartOfMessage" in msg) || typeof msg.historyId !== "string") {
        continue;
      }

      const isExplicitlyNonFinalActiveSegment =
        this.activeStreams.has(msg.historyId) && msg.isLastPartOfMessage === false;
      const shouldBeLast = !seenHistoryIds.has(msg.historyId) && !isExplicitlyNonFinalActiveSegment;
      seenHistoryIds.add(msg.historyId);

      if (msg.isLastPartOfMessage !== shouldBeLast) {
        normalized[i] = { ...msg, isLastPartOfMessage: shouldBeLast };
        didChange = true;
      }
    }

    return didChange ? normalized : messages;
  }

  /**
   * Transform XumMessages into DisplayedMessages for UI consumption
   * This splits complex messages with multiple parts into separate UI blocks
   * while preserving temporal ordering through sequence numbers
   *
   * IMPORTANT: Result is cached to ensure stable references for React.
   * Cache is invalidated whenever messages change (via invalidateCache()).
   */
  getDisplayedMessages(): DisplayedMessage[] {
    if (!this.cache.displayedMessages) {
      const displayedMessages: DisplayedMessage[] = [];
      const allMessages = this.getAllMessages();
      const showSyntheticMessages =
        typeof window !== "undefined" && window.api?.debugLlmRequest === true;

      const shouldHideMessageFromTranscript = (message: MuxMessage): boolean =>
        !showSyntheticMessages &&
        ((message.metadata?.synthetic === true && message.metadata?.uiVisible !== true) ||
          isWorkflowResultMessage(message));

      // Retain hidden snapshots so referenced user messages can display their resolved content.
      const latestAgentSkillSnapshotByKey = new Map<string, AgentSkillSnapshotContent>();
      // MCP prompt snapshots are re-materialized per turn and may fail, so a user
      // row only sees the contiguous snapshot block directly before it; a
      // history-wide map would falsely attach an older turn's expansion.
      const blockMcpPromptSnapshotByKey = new Map<string, MCPPromptSnapshotContent>();
      const isSyntheticSnapshotRow = (message: MuxMessage): boolean =>
        message.metadata?.synthetic === true &&
        (message.metadata.mcpPromptSnapshot !== undefined ||
          message.metadata.agentSkillSnapshot !== undefined ||
          message.metadata.fileAtMentionSnapshot !== undefined);
      let previousWasSnapshotRow = true;

      // Pair completed subagent cards with the assistant response to their prior progress turn.
      // Persisted anchors improve within-response precision, but historical correctness must not
      // depend on metadata that older reports never had.
      const transcriptInsertionPlan = this.buildTranscriptInsertionPlan(
        allMessages,
        shouldHideMessageFromTranscript
      );

      for (const message of allMessages) {
        if (!previousWasSnapshotRow) blockMcpPromptSnapshotByKey.clear();
        previousWasSnapshotRow = isSyntheticSnapshotRow(message);
        maybeCollectAgentSkillSnapshot(message, latestAgentSkillSnapshotByKey);
        maybeCollectMcpPromptSnapshot(message, blockMcpPromptSnapshotByKey);
        // Synthetic messages are typically for model context only.
        // Show them only in debug mode, or when explicitly marked as UI-visible.
        if (shouldHideMessageFromTranscript(message)) {
          continue;
        }

        const muxMeta = message.metadata?.muxMetadata;
        const agentSkillSnapshotKey =
          message.role === "user" && muxMeta?.type === "agent-skill"
            ? getAgentSkillSnapshotKey(muxMeta.scope, muxMeta.skillName)
            : undefined;

        const agentSkillSnapshot = agentSkillSnapshotKey
          ? latestAgentSkillSnapshotByKey.get(agentSkillSnapshotKey)
          : undefined;
        const slashMcpPromptRef =
          message.role === "user"
            ? sanitizeMcpPromptRefs(muxMeta?.mcpPromptRefs).find((ref) => ref.source === "slash")
            : undefined;
        const mcpPromptSnapshotCandidate = slashMcpPromptRef
          ? blockMcpPromptSnapshotByKey.get(
              getMcpPromptReferenceKey(slashMcpPromptRef.serverName, slashMcpPromptRef.promptName)
            )
          : undefined;
        // Prompt identity alone can attach a crash-orphaned expansion to a
        // later same-prompt turn; require the exact invoking row.
        const mcpPromptSnapshot =
          mcpPromptSnapshotCandidate?.invokingMessageId === message.id
            ? mcpPromptSnapshotCandidate
            : undefined;

        const agentSkillSnapshotForDisplay = agentSkillSnapshot
          ? { frontmatterYaml: agentSkillSnapshot.frontmatterYaml, body: agentSkillSnapshot.body }
          : mcpPromptSnapshot
            ? { body: mcpPromptSnapshot.body }
            : undefined;

        const agentSkillSnapshotCacheKey = agentSkillSnapshot
          ? getAgentSkillSnapshotDisplayCacheKey(agentSkillSnapshot)
          : mcpPromptSnapshot?.body;

        const inlineSkillSnapshotState =
          message.role === "user"
            ? deriveInlineSkillSnapshotDisplayState(
                message.id,
                muxMeta?.agentSkillRefs,
                latestAgentSkillSnapshotByKey,
                muxMeta?.mcpPromptRefs,
                blockMcpPromptSnapshotByKey
              )
            : undefined;
        const inlineSkillSnapshotsCacheKey = inlineSkillSnapshotState?.cacheKey;

        // Anchored report rows are rendered inside the target assistant's
        // split display block and must not also render at their sequence position.
        if (transcriptInsertionPlan.inlineMessageIds.has(message.id)) {
          continue;
        }

        const insertions = transcriptInsertionPlan.insertionsByTargetId.get(message.id);
        if (insertions && message.role === "assistant") {
          // Build the assistant display with anchored report rows interleaved.
          // Bypass the per-message cache because the output depends on multiple
          // messages and child invalidations cannot be keyed to the target alone.
          const splitRows = this.buildMessageDisplayWithInsertions(
            message,
            insertions,
            agentSkillSnapshotForDisplay,
            inlineSkillSnapshotState?.snapshots
          );
          if (splitRows.length > 0) {
            displayedMessages.push(...splitRows);
          }
          continue;
        }

        const version = this.messageVersions.get(message.id) ?? 0;
        const cached = this.displayedMessageCache.get(message.id);
        const canReuse =
          cached?.version === version &&
          cached.agentSkillSnapshotCacheKey === agentSkillSnapshotCacheKey &&
          cached.inlineSkillSnapshotsCacheKey === inlineSkillSnapshotsCacheKey;

        const messageDisplay = canReuse
          ? cached.messages
          : this.buildDisplayedMessagesForMessage(
              message,
              agentSkillSnapshotForDisplay,
              inlineSkillSnapshotState?.snapshots
            );

        if (!canReuse) {
          this.displayedMessageCache.set(message.id, {
            version,
            agentSkillSnapshotCacheKey,
            inlineSkillSnapshotsCacheKey,
            messages: messageDisplay,
          });
        }

        if (messageDisplay.length > 0) {
          displayedMessages.push(...messageDisplay);
        }
      }

      let resultMessages = displayedMessages;

      // Limit messages for DOM performance (unless explicitly disabled).
      // Strategy: keep recent rows intact, preserve structural rows in older history,
      // and materialize omission runs as explicit history-hidden marker rows.
      // Full history is still maintained internally for token counting.
      if (!this.showAllMessages && displayedMessages.length > MAX_DISPLAYED_MESSAGES) {
        const revealTarget = this.transcriptRevealTarget;
        const truncationPlan = buildTranscriptTruncationPlan({
          displayedMessages,
          maxDisplayedMessages: MAX_DISPLAYED_MESSAGES,
          alwaysKeepMessageTypes: ALWAYS_KEEP_MESSAGE_TYPES,
          shouldAlwaysKeepMessage: revealTarget
            ? (message) =>
                (revealTarget.toolCallId != null &&
                  message.type === "tool" &&
                  message.toolCallId === revealTarget.toolCallId) ||
                (revealTarget.messageId != null &&
                  "historyId" in message &&
                  message.historyId === revealTarget.messageId)
            : undefined,
        });

        resultMessages =
          truncationPlan.hiddenCount > 0
            ? this.normalizeLastPartFlags(truncationPlan.rows)
            : truncationPlan.rows;
      }

      resultMessages = markRowsBeforeLatestContextBoundary(resultMessages);

      // Add init state if present (ephemeral, appears at top)
      if (this.initState) {
        const durationMs =
          this.initState.endTime !== null
            ? this.initState.endTime - this.initState.startTime
            : null;
        const initMessage: DisplayedMessage = {
          type: "workspace-init",
          id: "workspace-init",
          historySequence: -1, // Appears before all history
          status: this.initState.status,
          hookPath: this.initState.hookPath,
          lines: [...this.initState.lines], // Shallow copy for React.memo change detection
          exitCode: this.initState.exitCode,
          timestamp: this.initState.startTime,
          durationMs,
          truncatedLines: this.initState.truncatedLines,
        };
        resultMessages = [initMessage, ...resultMessages];
      }

      // Return the full array
      this.cache.displayedMessages = resultMessages;
    }
    return this.cache.displayedMessages;
  }

  /**
   * Track a delta for token counting and TPS calculation
   */
  private trackDelta(
    messageId: string,
    tokens: number,
    timestamp: number,
    type: "text" | "reasoning" | "tool-args"
  ): void {
    let storage = this.deltaHistory.get(messageId);
    if (!storage) {
      storage = createDeltaStorage();
      this.deltaHistory.set(messageId, storage);
    }
    storage.addDelta({ tokens, timestamp, type });
  }

  /**
   * Get streaming token count (sum of all deltas)
   */
  getStreamingTokenCount(messageId: string): number {
    const storage = this.deltaHistory.get(messageId);
    return storage ? storage.getTokenCount() : 0;
  }

  /**
   * Get tokens-per-second rate (10-second trailing window)
   */
  getStreamingTPS(messageId: string): number {
    const storage = this.deltaHistory.get(messageId);
    return storage ? storage.calculateTPS(Date.now()) : 0;
  }

  /**
   * Clear delta history for a message
   */
  clearTokenState(messageId: string): void {
    this.deltaHistory.delete(messageId);
    this.activeStreamUsage.delete(messageId);
  }

  /**
   * Handle usage-delta event: update usage tracking for active stream
   */
  handleUsageDelta(data: UsageDeltaEvent): void {
    const context = this.activeStreams.get(data.messageId);
    if (context && data.effectiveContextLimit !== undefined) {
      context.effectiveContextLimit = data.effectiveContextLimit;
    }
    this.activeStreamUsage.set(data.messageId, {
      step: { usage: data.usage, providerMetadata: data.providerMetadata },
      cumulative: {
        usage: data.cumulativeUsage,
        providerMetadata: data.cumulativeProviderMetadata,
      },
    });
  }

  getActiveStreamContextLimit(messageId: string): number | null | undefined {
    return this.activeStreams.get(messageId)?.effectiveContextLimit;
  }

  /**
   * Get active stream usage for context window display (last step's inputTokens = context size)
   */
  getActiveStreamUsage(messageId: string): LanguageModelV2Usage | undefined {
    return this.activeStreamUsage.get(messageId)?.step.usage;
  }

  /**
   * Get step provider metadata for context window cache display
   */
  getActiveStreamStepProviderMetadata(messageId: string): Record<string, unknown> | undefined {
    return this.activeStreamUsage.get(messageId)?.step.providerMetadata;
  }

  /**
   * Get active stream cumulative usage for cost display (sum of all steps)
   */
  getActiveStreamCumulativeUsage(messageId: string): LanguageModelV2Usage | undefined {
    return this.activeStreamUsage.get(messageId)?.cumulative.usage;
  }

  /**
   * Get cumulative provider metadata for cost display (with accumulated cache creation tokens)
   */
  getActiveStreamCumulativeProviderMetadata(
    messageId: string
  ): Record<string, unknown> | undefined {
    return this.activeStreamUsage.get(messageId)?.cumulative.providerMetadata;
  }
}

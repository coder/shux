import { AsyncLocalStorage } from "node:async_hooks";
import type { TurnStreamHandle } from "./streamManager";
import type { StreamManager } from "./streamManager";
import * as path from "path";
import assert from "@/common/utils/assert";
import { EventEmitter } from "events";
import { Effect, Fiber } from "effect";
import { CompactionCancellation } from "./compactionCancellation";
import { StartupRecovery, type StartupRecoveryOutcome } from "./startupRecovery";
import { mkdir, readdir, readFile, unlink, writeFile } from "fs/promises";
import type { Dirent } from "fs";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import { PlatformPaths } from "@/common/utils/paths";
import { log } from "@/node/services/log";
import { isDeepStrictEqual } from "node:util";
import { eventSpine } from "@/node/services/events/eventSpine";
import { ProvidersConfigStore, type Config } from "@/node/config";
import {
  TurnCoordinator,
  type TurnPhase,
  type TurnId,
  type QueueDrainTrigger,
  type OperationId,
  type CompactionToken,
  type StreamErrorRecoveryOutcome,
} from "./turnCoordinator";
export type { StreamErrorRecoveryOutcome } from "./turnCoordinator";
import type { StreamMessageOptions } from "@/node/services/turnRequestBuilder";
import type { HistoryService } from "@/node/services/historyService";
import type { SessionUsageService } from "@/node/services/sessionUsageService";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { MCPServerManager } from "@/node/services/mcpServerManager";

import type { FrontendWorkspaceMetadata, WorkspaceMetadata } from "@/common/types/workspace";
import type { RuntimeConfig } from "@/common/types/runtime";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { DEFAULT_MODEL } from "@/common/constants/knownModels";
import { computePriorHistoryFingerprint } from "@/common/orpc/onChatCursorFingerprint";
import type {
  WorkspaceChatMessage,
  SendMessageOptions,
  FilePart,
  OnChatMode,
  OnChatCursor,
  OnChatDowngradeReason,
  ProvidersConfigMap,
  StreamErrorMessage,
} from "@/common/orpc/types";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import {
  GOAL_BUDGET_LIMIT_KIND,
  GOAL_CONTINUATION_KIND,
  SILENT_CONTINUATION_COMPLETION_SUMMARY_FALLBACK,
  SILENT_CONTINUATION_COMPLETION_SUMMARY_MAX_LENGTH,
  type GoalSyntheticMessageKind,
} from "@/constants/goals";
import type { SendMessageError } from "@/common/types/errors";
import {
  AgentIdSchema,
  ChatMuxMessageSchema,
  SendMessageOptionsSchema,
  SkillNameSchema,
} from "@/common/orpc/schemas";
import { ToolPolicySchema } from "@/common/orpc/schemas/stream";
import { normalizeAgentId, resolvePersistedAgentIdCandidates } from "@/common/utils/agentIds";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import {
  buildStreamErrorEventData,
  createStreamErrorMessage,
  createUnknownSendMessageError,
  type StreamErrorPayload,
} from "@/node/services/utils/sendMessageError";
import {
  createUserMessageId,
  createFileSnapshotMessageId,
  createAgentSkillSnapshotMessageId,
  createMcpPromptSnapshotMessageId,
} from "@/node/services/utils/messageIds";
import {
  FileChangeTracker,
  createFileChangeNotificationMessage,
  type FileState,
} from "@/node/services/utils/fileChangeTracker";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import {
  coerceOpenAIReasoningMode,
  coerceThinkingLevel,
  type ThinkingLevel,
} from "@/common/types/thinking";
import {
  targetWorkspaceBucketToLayer,
  type AgentAiSettingsLayerValues,
} from "@/common/types/agentAiSettings";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import { resolveAgentAiSettings } from "@/common/utils/ai/resolveAgentAiSettings";
import {
  enforceThinkingPolicy,
  lookupMinThinkingLevelOverride,
  resolveMinimumThinkingLevel,
} from "@/common/utils/thinking/policy";
import type { ActiveTurnThinkingOverride } from "@/node/services/thinkingOverride";
import {
  createMuxMessage,
  dedupeAgentSkillRefs,
  dedupeMcpPromptRefs,
  filterOrphanedMcpPromptSnapshots,
  sanitizeAgentSkillRefs,
  sanitizeMcpPromptRefs,
  isCompactionSummaryMetadata,
  pickPreservedSendOptions,
  pickStartupRetrySendOptions,
  prepareUserMessageForSend,
  type AgentSkillReference,
  isSyntheticSnapshotUserMessage,
  type CompactionFollowUpRequest,
  type MuxMessageMetadata,
  type MuxFilePart,
  type MuxMessage,
  type ReviewNoteDataForDisplay,
  type StartupRetrySendOptions,
} from "@/common/types/message";
import { toValidGoalId } from "@/common/types/goal";
import { selectKeepRecentTailStartIndex } from "@/common/utils/messages/keepRecentTail";
import { extractReadFilePaths, mergeReadFilePaths } from "@/common/utils/messages/extractReadFiles";
import { isNonNegativeInteger } from "@/common/utils/numbers";
import { RLM_KEEP_RECENT_FLOOR_TOKENS } from "@/constants/rlmCompaction";
import {
  createRuntimeContextForWorkspace,
  createRuntimeForWorkspace,
} from "@/node/runtime/runtimeHelpers";
import { MessageQueue, cancelReasonBeforeAcceptance } from "./messageQueue";
import type { QueueCutCutter } from "./messageQueue";
import {
  copyStreamLifecycleSnapshot,
  type RuntimeStatusEvent,
  type StreamAbortReason,
  type StreamEndEvent,
  type StreamAbortEvent,
  type StreamLifecycleSnapshot,
} from "@/common/types/stream";
import type { GoalStreamOriginKind, WorkspaceGoalService } from "./workspaceGoalService";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";
import { getTotalCost } from "@/common/utils/tokens/usageAggregator";
import type { CompactionCompletionMetadata } from "@/common/types/compaction";
import { CompactionHandler } from "./compactionHandler";
import { RetryManager, type RetryFailureError, type RetryStatusEvent } from "./retryManager";
import { defaultEffectRunner, type EffectRunner } from "./di/effectRunner";
import type { Scope } from "effect";
import type { TelemetryService } from "./telemetryService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";

import { AttachmentService } from "./attachmentService";
import type { TodoItem } from "@/common/types/tools";
import type {
  LoadedSkillSnapshot,
  PostCompactionAttachment,
  PostCompactionExclusions,
} from "@/common/types/attachment";
import { TURNS_BETWEEN_ATTACHMENTS } from "@/common/constants/attachments";

import {
  extractEditedFileDiffs,
  type FileEditDiff,
} from "@/common/utils/messages/extractEditedFiles";
import { buildCompactionMessageText } from "@/common/utils/compaction/compactionPrompt";
import type { AutoCompactionUsageState } from "@/common/utils/compaction/autoCompactionCheck";
import { getModelCapabilitiesResolved } from "@/common/utils/ai/modelCapabilities";
import {
  getExplicitGatewayPrefix,
  normalizeToCanonical,
  normalizeSelectedModel,
  isValidModelFormat,
  supports1MContext,
} from "@/common/utils/ai/models";
import { isAnthropic1MEffectivelyEnabled } from "@/common/utils/ai/providerOptions";
import {
  isNonRetryableSendError,
  isNonRetryableStreamError,
  isProviderConfigFixableError,
} from "@/common/utils/messages/retryEligibility";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { readAgentSkill } from "@/node/services/agentSkills/agentSkillsService";
import { resolveSkillStorageContext } from "@/node/services/agentSkills/skillStorageContext";
import {
  createLoadedSkillSnapshot,
  extractLoadedSkillSnapshotsFromMessages,
  mergeLoadedSkillSnapshots,
  stringifyAgentSkillFrontmatter,
} from "@/node/services/agentSkills/loadedSkillSnapshots";
import { substituteSkillArguments } from "@/node/services/agentSkills/skillArguments";
import {
  injectSkillDynamicContext,
  SKILL_DYNAMIC_COMMAND_TIMEOUT_MS,
  SKILL_DYNAMIC_OUTPUT_CAP_BYTES,
} from "@/node/services/agentSkills/skillDynamicContext";
import {
  aliasLegacyPtcExclusive,
  EXPERIMENT_IDS,
  type ExperimentId,
} from "@/common/constants/experiments";
import {
  awaitPendingBranchSummary,
  isRlmModeEnabled,
  runInlineAbandonedBranchSummary,
  type BranchSummaryAiService,
} from "@/node/services/branchSummary";
import type { Runtime } from "@/node/runtime/Runtime";
import type { XumToolScope } from "@/common/types/toolScope";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { renderAgentSkillSnapshotText } from "@/common/utils/agentSkills/skillSnapshot";
import type { MemorySessionContext } from "@/node/services/memoryService";
import { materializeFileAtMentions } from "@/node/services/fileAtMentions";
import { parseSubagentReportEnvelope } from "@/common/utils/subagentReportEnvelope";
import { getErrorMessage } from "@/common/utils/errors";
import { CompactionMonitor, type CompactionStatusEvent } from "./compactionMonitor";
import { injectPostCompactionAttachments } from "@/browser/utils/messages/modelMessageTransform";
import { estimateMuxMessageTokens } from "@/common/utils/messages/keepRecentTail";
import { ContinuousCompactor, type ContinuousCompactionContext } from "./continuousCompactor";
import { getEffectiveContextLimit } from "@/common/utils/compaction/contextLimit";
import { summarizeContinuousCompaction } from "./continuousCompactionSummary";

type SessionCompactionContext = ContinuousCompactionContext & {
  sendOptions?: SendMessageOptions;
};

/**
 * Result shape for turn-starting session methods. failureHandled marks errors
 * whose retry/abandon bookkeeping already ran inside streamWithHistory, so
 * callers must not re-handle them (would double-increment backoff attempts).
 * superseded records ownership loss at the failure source, before cleanup awaits;
 * an accepted durable handoff remains acknowledged even though its startup retired.
 */
type AgentSessionResult<T> =
  | { success: true; data: T }
  | {
      success: false;
      error: SendMessageError;
      failureHandled?: true;
      superseded?: true;
      admissionDeferred?: true;
    };

/**
 * Tracked file state for detecting external edits.
 * Uses timestamp-based polling with diff injection.
 */
// Re-export types from FileChangeTracker for backward compatibility
export type { FileState } from "@/node/services/utils/fileChangeTracker";

// Type guard for compaction request metadata
// Supports both new `followUpContent` and legacy `continueMessage` for backwards compatibility
interface CompactionRequestMetadata {
  type: "compaction-request";
  source?: "idle-compaction" | "auto-compaction";
  parsed: {
    followUpContent?: CompactionFollowUpRequest;
    // Legacy field - older persisted requests may use this instead of followUpContent
    continueMessage?: {
      text?: string;
      imageParts?: FilePart[];
      reviews?: ReviewNoteDataForDisplay[];
      muxMetadata?: MuxMessageMetadata;
      model?: string;
      agentId?: string;
      mode?: "exec" | "plan"; // Legacy: older versions stored mode instead of agentId
    };
  };
}

type GoalInterventionPolicy = NonNullable<SendMessageOptions["goalInterventionPolicy"]>;

interface AutoRetryResumeRequest {
  // Same-session auto-retry must preserve the full normalized request because
  // ACP correlation/delegation lives in transient send options that are
  // intentionally omitted from durable startup-recovery snapshots.
  options: SendMessageOptions;
  agentInitiated?: boolean;
  goalKind?: GoalSyntheticMessageKind;
  /** Goal identity matching goalKind; keeps retried streams goal-scoped. */
  goalId?: string;
}

function stripGoalInterventionPolicy(options: SendMessageOptions): SendMessageOptions {
  const streamOptions: SendMessageOptions = { ...options };
  delete streamOptions.goalInterventionPolicy;
  return streamOptions;
}

function getGoalStreamOriginKind(input: {
  isCompaction?: boolean;
  goalKind?: GoalSyntheticMessageKind;
  agentInitiated?: boolean;
}): GoalStreamOriginKind {
  if (input.isCompaction === true) return "other";
  if (input.goalKind === GOAL_CONTINUATION_KIND) return "goal_continuation";
  if (input.goalKind === GOAL_BUDGET_LIMIT_KIND) return "goal_budget_limit";
  if (input.agentInitiated === true) return "other";
  return "user";
}

function coerceGoalSyntheticMessageKind(value: unknown): GoalSyntheticMessageKind | undefined {
  if (value === GOAL_CONTINUATION_KIND || value === GOAL_BUDGET_LIMIT_KIND) {
    return value;
  }
  return undefined;
}

// Durable goal IDs are UUIDs — see toValidGoalId for the corruption contract
// (Codex P2 PRRT_kwDOPxxmWM6cRJEC extends it to every recovery-path reader).
function coerceGoalId(value: unknown): string | undefined {
  return toValidGoalId(value) ?? undefined;
}

const PDF_MEDIA_TYPE = "application/pdf";
const ACP_PROMPT_ID_METADATA_KEY = "acpPromptId";
const ACP_DELEGATED_TOOLS_METADATA_KEY = "acpDelegatedTools";

function extractAgentSkillRefs(metadata: MuxMessageMetadata | undefined): AgentSkillReference[] {
  if (!metadata) return [];

  const refs = sanitizeAgentSkillRefs(metadata.agentSkillRefs);
  if (metadata.type === "agent-skill") {
    const hasLegacySlashRef = refs.some(
      (ref) => ref.skillName === metadata.skillName && ref.source === "slash"
    );
    if (!hasLegacySlashRef) {
      refs.push({ skillName: metadata.skillName, scope: metadata.scope, source: "slash" });
    }
  }

  return dedupeAgentSkillRefs(refs);
}

function normalizeMediaType(mediaType: string): string {
  return mediaType.toLowerCase().trim().split(";")[0];
}

function estimateBase64DataUrlBytes(dataUrl: string): number | null {
  if (!dataUrl.startsWith("data:")) return null;

  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) return null;

  const header = dataUrl.slice("data:".length, commaIndex);
  if (!header.includes(";base64")) return null;

  const base64 = dataUrl.slice(commaIndex + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function normalizeAcpPromptId(candidate: unknown): string | undefined {
  if (typeof candidate !== "string") {
    return undefined;
  }

  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeDelegatedToolNames(candidate: unknown): string[] | undefined {
  if (!Array.isArray(candidate)) {
    return undefined;
  }

  const normalizedTools = candidate
    .filter((toolName): toolName is string => typeof toolName === "string")
    .map((toolName) => toolName.trim())
    .filter((toolName) => toolName.length > 0);

  if (normalizedTools.length === 0) {
    return undefined;
  }

  return [...new Set(normalizedTools)];
}

function extractAcpPromptId(muxMetadata: unknown): string | undefined {
  if (typeof muxMetadata !== "object" || muxMetadata == null || Array.isArray(muxMetadata)) {
    return undefined;
  }

  return normalizeAcpPromptId((muxMetadata as Record<string, unknown>)[ACP_PROMPT_ID_METADATA_KEY]);
}

function extractAcpDelegatedTools(muxMetadata: unknown): string[] | undefined {
  if (typeof muxMetadata !== "object" || muxMetadata == null || Array.isArray(muxMetadata)) {
    return undefined;
  }

  return normalizeDelegatedToolNames(
    (muxMetadata as Record<string, unknown>)[ACP_DELEGATED_TOOLS_METADATA_KEY]
  );
}
type WorkspaceTurnMuxMetadata = Extract<MuxMessageMetadata, { type: "workspace-turn-task" }>;

function getWorkspaceTurnMuxMetadata(muxMetadata: unknown): WorkspaceTurnMuxMetadata | undefined {
  const metadata = muxMetadata as MuxMessageMetadata | undefined;
  return metadata?.type === "workspace-turn-task" ? metadata : undefined;
}

function hasSameWorkspaceTurnCorrelation(
  first: WorkspaceTurnMuxMetadata | undefined,
  second: WorkspaceTurnMuxMetadata | undefined
): boolean {
  return (
    first != null &&
    second != null &&
    first.taskHandleId === second.taskHandleId &&
    first.ownerWorkspaceId === second.ownerWorkspaceId &&
    first.turnId === second.turnId
  );
}

/**
 * Find the still-open workspace-turn correlation for a bash-monitor-wake
 * continuation stream.
 *
 * A queued monitor wake dispatched at a tool boundary cuts the in-flight
 * stream (finishReason "tool-calls") and immediately continues the same
 * delegated work in a new stream. That continuation must inherit the cut
 * stream's workspace-turn metadata — otherwise the delegating parent sees the
 * cut as a premature turn failure ("Workspace turn ended before completion")
 * and the turn's real outcome can never settle the task handle (see
 * TaskService.finalizeWorkspaceTurnFromStreamEnd).
 *
 * Scans newest→oldest: interleaved monitor wakes keep the chain open; any
 * other user input (manual prompt, new workspace-turn prompt) supersedes the
 * turn, and only a correlated assistant message that ended with "tool-calls"
 * (a queue-dispatch cut) leaves the turn open. The inherited metadata is
 * persisted on each continuation's assistant message, so chains survive
 * restarts.
 */
export function inheritOpenWorkspaceTurnMetadata(
  messages: readonly MuxMessage[]
): Extract<MuxMessageMetadata, { type: "workspace-turn-task" }> | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const muxMetadata = message.metadata?.muxMetadata;
    if (message.role === "assistant") {
      if (
        muxMetadata?.type === "workspace-turn-task" &&
        message.metadata?.partial !== true &&
        message.metadata?.finishReason === "tool-calls"
      ) {
        return muxMetadata;
      }
      // On-send compaction can consume a monitor-wake continuation mid-turn,
      // hiding the correlated queue-cut assistant behind the new boundary. The
      // pre-compaction correlation is stamped on the summary's pending
      // follow-up (see the on-send divert in sendMessage), so the wake
      // continuation re-inherits it from there.
      if (
        muxMetadata?.type === "compaction-summary" &&
        muxMetadata.pendingFollowUp?.workspaceTurnMetadata != null
      ) {
        return muxMetadata.pendingFollowUp.workspaceTurnMetadata;
      }
      return undefined;
    }
    if (message.role === "user") {
      if (muxMetadata?.type === "bash-monitor-wake") {
        continue;
      }
      return undefined;
    }
  }
  return undefined;
}

function isCompactionRequestMetadata(meta: unknown): meta is CompactionRequestMetadata {
  if (typeof meta !== "object" || meta === null) return false;
  const obj = meta as Record<string, unknown>;
  if (obj.type !== "compaction-request") return false;
  if (typeof obj.parsed !== "object" || obj.parsed === null) return false;
  return true;
}

const AUTO_RETRY_PREFERENCE_FILE = "auto-retry-preference.json";

/**
 * Clear provider-config-fixable startup abandon markers persisted by workspaces
 * WITHOUT a live AgentSession (closed chats). Live sessions clear their own
 * marker via handleProviderConfigChanged(); this sweep covers the rest so that
 * reopening a chat after a credential fix does not resurrect the stale
 * "auto-retry stopped" state. Like the live path, it only unlocks retry and
 * never schedules or resumes a stream (PR #2317 was rejected).
 */
export async function clearProviderConfigFixableAbandonMarkers(
  sessionsDir: string,
  skipWorkspaceIds: ReadonlySet<string>
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    const errno =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (errno === "ENOENT") {
      return;
    }
    throw error;
  }

  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory() || skipWorkspaceIds.has(entry.name)) {
        return;
      }

      const preferencePath = path.join(sessionsDir, entry.name, AUTO_RETRY_PREFERENCE_FILE);
      let parsed: { enabled?: unknown; startupAutoRetryAbandon?: unknown };
      try {
        parsed = JSON.parse(await readFile(preferencePath, "utf-8")) as typeof parsed;
      } catch {
        // Missing file is the default; corrupt files are self-healed by the
        // session load path when the workspace reopens.
        return;
      }

      const abandon = parsed.startupAutoRetryAbandon;
      const reason =
        typeof abandon === "object" && abandon !== null && "reason" in abandon
          ? (abandon as { reason?: unknown }).reason
          : undefined;
      if (typeof reason !== "string" || !isProviderConfigFixableError(reason)) {
        return;
      }

      // Mirror persistAutoRetryState(): the file only exists to carry an
      // opt-out or an abandon marker, so dropping the last field deletes it.
      if (parsed.enabled === false) {
        await writeFile(preferencePath, JSON.stringify({ enabled: false }) + "\n", "utf-8");
      } else {
        await unlink(preferencePath);
      }
    })
  );
}

/**
 * Rejection surfaced to sends refused because a context-discarding history
 * mutation (reset, full clear, destructive replace) is in flight (r40).
 * Shared with WorkspaceService's entry-point rejection so the user sees one
 * message regardless of where the send was refused.
 */
export const CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE =
  "Workspace history is being cleared or reset. Please wait and try again.";
const SESSION_SHUTDOWN_SEND_BLOCKED_MESSAGE = "Xum is shutting down; the message was not sent.";

export interface AgentSessionChatEvent {
  workspaceId: string;
  message: WorkspaceChatMessage;
}

export interface AgentSessionMetadataEvent {
  workspaceId: string;
  metadata: FrontendWorkspaceMetadata | null;
}

interface AgentSessionActiveStreamInfo {
  messageId: string;
  startTime?: number;
  parts: Array<
    MuxMessage["parts"][number] & { timestamp?: number; workflowRun?: { timestamp?: number } }
  >;
  stepStartIndices?: readonly number[];
  currentStepStartIndex?: number;
  initialMetadata?: { systemMessageTokens?: number };
  toolCompletionTimestamps: Map<string, number>;
}

export interface AgentSessionStreamManager {
  setPrefixSwap?: StreamManager["setPrefixSwap"];
  clearPrefixSwap?: StreamManager["clearPrefixSwap"];
  getPrefixSwapState?: StreamManager["getPrefixSwapState"];
  getPrefixSwapPreparation?: StreamManager["getPrefixSwapPreparation"];
  stopStream(
    workspaceId: string,
    options?: {
      soft?: boolean;
      abandonPartial?: boolean;
      abortReason?: StreamAbortReason;
      emitIfMissing?: boolean;
    }
  ): Promise<Result<void>>;
  isStreaming(workspaceId: string): boolean;
  getStreamInfo(
    workspaceId: string,
    includeFinalizing?: boolean
  ): AgentSessionActiveStreamInfo | undefined;
  replayStream(workspaceId: string, options?: { afterTimestamp?: number }): Promise<void>;
  /**
   * The runner the stream manager's clock-driven fibers use; the session's
   * `RetryManager` schedules its backoff on the same clock. Absent on test
   * doubles and the AIService fallback, which leaves RetryManager on the
   * global runtime.
   */
  readonly effectRunner?: EffectRunner;
}

/** Keeps AgentSession coupled only to the AI operations and events it consumes. */
export interface AgentSessionAIService extends BranchSummaryAiService {
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  streamMessage(options: StreamMessageOptions): Promise<Result<TurnStreamHandle, SendMessageError>>;
  stopStream?(
    workspaceId: string,
    options?: {
      soft?: boolean;
      abandonPartial?: boolean;
      abortReason?: StreamAbortReason;
      emitIfMissing?: boolean;
    }
  ): Promise<Result<void>>;
  isStreaming?(workspaceId: string): boolean;
  getStreamInfo?(workspaceId: string): AgentSessionActiveStreamInfo | undefined;
  replayStream?(workspaceId: string, options?: { afterTimestamp?: number }): Promise<void>;
  getProvidersConfig(): ProvidersConfigMap | null;
  isExperimentEnabled(experimentId: ExperimentId): boolean;
  buildMemorySessionContext?(
    workspaceId: string,
    modelString: string,
    options?: { includeHotMemories?: boolean }
  ): Promise<MemorySessionContext | null>;
  isClaudeSkillsCompatEnabled?(): boolean;
  isAgentPluginsEnabled?(): boolean;
  resolveXumToolScopeForWorkspace?(
    metadata: WorkspaceMetadata,
    runtime: Runtime,
    workspacePath: string
  ): XumToolScope;
}

interface AgentSessionOptions {
  effectRunner?: EffectRunner;
  appFiberScope?: Scope.Scope;
  workspaceId: string;
  config: Config;
  historyService: HistoryService;
  aiService: AgentSessionAIService;
  streamManager?: AgentSessionStreamManager;
  mcpServerManager?: MCPServerManager;
  initStateManager: InitStateManager;
  telemetryService?: TelemetryService;
  backgroundProcessManager: BackgroundProcessManager;
  workspaceGoalService?: WorkspaceGoalService;
  /** Cost telemetry sink for headless side-channel calls (branch summaries). */
  sessionUsageService?: Pick<SessionUsageService, "recordHeadlessUsage">;
  /** When true, skip terminating background processes on dispose/compaction (for bench/CI) */
  keepBackgroundProcesses?: boolean;
  /**
   * Registration-time Agent Plugin override sanitization for workspaces this
   * session registers itself (ensureMetadata: CLI `xum run`/`xum workflow` in
   * a directory with no existing metadata). Wired to
   * WorkspaceService.sanitizeCliRegisteredWorkspace, which rolls the config
   * write back on failure; ensureMetadata must then abort without announcing
   * the workspace. Returns an error string or undefined on success.
   */
  sanitizeCliWorkspaceRegistration?: (args: {
    workspaceId: string;
    workspacePath: string;
    runtimeConfig: RuntimeConfig | undefined;
  }) => Promise<string | undefined>;
  /** Called when compaction completes (e.g., to clear idle compaction pending state) */
  onCompactionComplete?: (metadata: CompactionCompletionMetadata) => void;
  /** Called with the terminal outcome of an idle compaction (persisted success / post-stream failure) */
  onIdleCompactionOutcome?: (success: boolean) => void;
  /** Called when post-compaction context state may have changed (plan/file edits) */
  onPostCompactionStateChange?: () => void;
  /**
   * Codex P1 (PRRT_kwDOPxxmWM6cRJD-): true while a service-level send is in
   * its preflight (counted in WorkspaceService.preflightSendCounts but not
   * yet queued or holding the turn phase). Session queue/phase state cannot
   * see that window, so redispatched idle-rule follow-ups consult this probe
   * to yield to a manual send that is still awaiting pricing/settings.
   */
  hasExternalSendPreflight?: () => boolean;
}

interface CachedMemoryContext {
  context: MemorySessionContext | null;
  includesHotMemories: boolean;
}

interface CompactionFollowUpDispatch {
  summary?: MuxMessage;
  accepted: boolean;
}

interface SendMessageInternalOptions {
  compactionHandoff?: CompactionToken;
  /** Durable-summary handoffs revalidate their source inside the history append lock. */
  compactionHandoffSource?: { summary: MuxMessage; onSkipped: () => void };
  preparation?: PreparationAttempt;
  /** A dequeued send keeps its admission owner through acceptance and startup failure. */
  turnReservation?: TurnId;
  synthetic?: boolean;
  agentInitiated?: boolean;
  goalContinuation?: boolean;
  goalKind?: GoalSyntheticMessageKind;
  /** Goal identity persisted alongside goalKind so chat-tail reconciliation can scope the row. */
  goalId?: string;
  startStreamInBackground?: boolean;
  /** Synchronous receipt at the rollback frontier, before goal sync or event observers. */
  onRowsDurable?: () => void;
  onAccepted?: () => Promise<void> | void;
  onAcceptedPreStreamFailure?: (error: SendMessageError) => Promise<void> | void;
  onCanceled?: (reason: string) => Promise<void> | void;
  cancelState?: { canceledBeforeAcceptance: boolean };
  cancelSignal?: AbortSignal;
  /**
   * For queue-dispatched sends: when the user last added to the queued
   * entry. Goal safety compares it against the goal's explicit
   * user-activation consent stamp — a message the user visibly left
   * pending while activating the goal must not auto-pause it (Codex
   * security P2 PRRT_kwDOPxxmWM6cSGrq: creation time alone is not
   * consent).
   */
  enqueuedAtMs?: number;
  /**
   * Codex P2 (PRRT_kwDOPxxmWM6cSRkH): fired synchronously the moment this
   * turn claims PREPARING (isBusy() becomes true). WorkspaceService keeps
   * its session-invisible preflight reservation armed until this fires so
   * follow-up recovery cannot observe the idle gap between the service
   * handoff and the busy claim (cancelBeforeAcceptance and the other
   * admission awaits yield) and admit a synthetic turn ahead of the
   * accepted manual send. Refusal paths never fire it — the service's
   * scoped disposal releases the reservation when the call returns.
   */
  onTurnAdmissionCommitted?: () => void;
  /**
   * Synthetic assistant rows persisted immediately before this turn's user
   * row (family-message payloads). Persisting them inside turn admission —
   * instead of a direct history append from the sender — keeps them out of
   * another turn's PREPARING window, where they could land between that
   * turn's user row and its assistant response (consecutive assistant
   * messages a tool-using response makes unmergeable) or silently enter an
   * in-flight request without their trigger (r30).
   */
  preTurnMessages?: MuxMessage[];
  /**
   * r54: fired once the pre-turn batch has crossed the rollback horizon —
   * durably committed AND past the last cancellation/rollback gate. From
   * that point every failure (goal sync, acceptance, stream start) keeps
   * the rows in the transcript, so budget-style accounting must treat the
   * delivery as persisted. Turn ACCEPTANCE is the wrong signal: it can
   * fail after the rows are already irrevocable.
   */
  onPreTurnRowsPersisted?: () => void;
  /**
   * r41: staleness probe for this send's admission epoch, captured
   * synchronously with WorkspaceService's entry checks. Returns true when
   * a context-discarding mutation COMPLETED after the send entered — the
   * level-triggered admission block check cannot catch a mutation
   * that started and finished while the send sat in pre-admission
   * awaits. Not threaded through queued entries: those dispatch into the
   * post-mutation context by design.
   */
  admissionEpochStale?: () => boolean;
  /**
   * Caller-supplied staleness probe that, unlike the epoch probe above, IS threaded
   * through queued entries (MessageQueue stores it per entry and re-emits it at
   * dispatch). Peer agent sends use it so a Stop/task_stop landing after dequeue —
   * where queue clearing can no longer see the entry — still refuses the turn at
   * these admission gates instead of starting a privileged turn on a stopped target.
   */
  admissionStale?: () => boolean;
}

// Enqueueing creates no preparation attempt. Once dispatched, Promise success alone cannot
// distinguish cancellation, a background transfer, and delivery to terminal policy.
interface PreparationAttempt {
  owner?: TurnId;
  expectedTurn: TurnId;
  editReservation?: ReturnType<TurnCoordinator["reserve"]>;
  outcome: "preparing" | "background" | "delivered" | "canceled";
  durability: "rollback-eligible" | "durable" | "accepted";
  queued: boolean;
  failureNotified: boolean;
  failureAttempts?: number;
  failure?: SendMessageError;
  onFailure?: (error: SendMessageError) => Promise<void> | void;
  resumeCancellation?: { nonce: string | null; epoch: number };
}

export class AgentSession {
  private readonly replayPublication = new AsyncLocalStorage<{
    listener: (event: AgentSessionChatEvent) => void;
    emittedStreamEvents: boolean;
  }>();
  private readonly workspaceId: string;
  private readonly config: Config;
  private readonly historyService: HistoryService;
  private readonly compactionCancellation: CompactionCancellation;
  private readonly aiService: AgentSessionAIService;
  private readonly streamManager: AgentSessionStreamManager;
  private readonly mcpServerManager?: MCPServerManager;
  private readonly initStateManager: InitStateManager;
  private readonly backgroundProcessManager: BackgroundProcessManager;
  private readonly workspaceGoalService?: WorkspaceGoalService;
  private readonly sessionUsageService?: Pick<SessionUsageService, "recordHeadlessUsage">;
  private readonly keepBackgroundProcesses: boolean;
  private readonly sanitizeCliWorkspaceRegistration?: AgentSessionOptions["sanitizeCliWorkspaceRegistration"];
  private readonly onPostCompactionStateChange?: () => void;
  private readonly hasExternalSendPreflight?: () => boolean;
  private readonly emitter = new EventEmitter();
  private readonly aiListeners: Array<{ event: string; handler: (...args: unknown[]) => void }> =
    [];
  private readonly initListeners: Array<{ event: string; handler: (...args: unknown[]) => void }> =
    [];
  private readonly coordinator = new TurnCoordinator({
    streamStarted: (payload) => {
      this.dispatchingQueuedEntry = false;
      this.dispatchingQueuedEntryMuxMetadata = undefined;
      this.preparingWorkspaceTurnMetadata = undefined;
      this.activeStreamStartedAtMs = payload.startTime;
      // Codex P1 (PRRT_kwDOPxxmWM6cClKS): a new live stream makes mid-stream
      // setGoal deferral meaningful again — clear the goal service's settled
      // fast-path synchronously so a model set_goal in THIS stream queues
      // for its stream-end drain instead of writing goal.json mid-stream.
      this.workspaceGoalService?.recordStreamStarted(this.workspaceId);
      this.queuedProviderToolEndAbortInFlight = false;
      this.activeToolCallIds.clear();
    },
    phaseChanged: (phase, isCurrent) => this.publishTurnPhase(phase, isCurrent),
    drainQueue: () => {
      if (!this.messageQueue.isEmpty()) this.sendQueuedMessages("idle");
    },
    policy: async (operation, messageId, outcome, started, notifyStartup) => {
      if (!this.coordinator.isCurrentOperation(operation)) return;
      switch (outcome.status) {
        case "completed":
          await this.handleTurnSuccess({ ...outcome.streamEnd, messageId }, operation);
          break;
        case "failed":
          await this.handleStreamError({ ...outcome.streamError, messageId }, operation);
          break;
        case "aborted":
          if (outcome.streamAbort) {
            const payload = { ...outcome.streamAbort, messageId, abortReason: outcome.abortReason };
            if (started)
              await this.handleTurnAbort(payload, outcome.systemMessageTokens, operation);
            else if (notifyStartup) await this.handleStartupAbort(payload, operation);
          }
          break;
      }
    },
    policyError: (error) =>
      log.error("Failed to consume turn completion", {
        workspaceId: this.workspaceId,
        error: getErrorMessage(error),
      }),
  });
  // When true, stream-end skips auto-flushing queued messages so an edit can truncate first.
  private deferQueuedFlushUntilAfterEdit = false;
  // Provider-executed tools (for example native web_search/web_fetch) complete inside one
  // provider response, so the SDK's between-step stopWhen hook cannot preempt after them.
  // Track known siblings and reserve soft interruption for that native-only boundary.
  private queuedProviderToolEndAbortInFlight = false;
  private readonly activeToolCallIds = new Set<string>();

  private readonly messageQueue = new MessageQueue();
  private readonly compactionHandler: CompactionHandler;
  private readonly compactionMonitor: CompactionMonitor;
  private readonly continuousCompactor: ContinuousCompactor;

  private readonly retryManager: RetryManager;
  private lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
  private readonly startupRecovery = new StartupRecovery({
    signal: this.coordinator.closingSignal,
    // Persisted compaction follow-ups precede goal continuation recovery. Each successful
    // step is checkpointed, so retrying a later read cannot replay an earlier side effect.
    steps: [
      () => this.runStartupRecoveryStep(() => this.reconcileCompactionCancellation()),
      () =>
        this.runStartupRecoveryStep(() => this.requireGoalAcknowledgmentForCrashRecoveredPartial()),
      () =>
        this.runStartupRecoveryStep(async () => {
          // An unresolved Stop also excludes a journal that has not published its summary yet.
          if ((await this.compactionCancellation.read())?.scope.kind !== "unresolved")
            await this.continuousCompactor.recover();
        }),
      () => this.dispatchPendingFollowUp(),
      () =>
        this.runStartupRecoveryStep(() =>
          this.workspaceGoalService?.recoverPendingDispatchAfterRestart(this.workspaceId)
        ),
    ],
    check: () => this.scheduleStartupAutoRetryIfNeeded(),
    wait: (delayMs) => this.waitForStartupAutoRetryRerunWindow(delayMs),
    report: (error) =>
      log.warn("Failed to run startup recovery", {
        workspaceId: this.workspaceId,
        error: getErrorMessage(error),
      }),
  });
  private autoRetryEnabledPreference: boolean | null = null;
  private legacyAutoRetryEnabledHint: boolean | null = null;
  private startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null = null;

  /** Latest context-usage snapshot used for on-send compaction checks. */
  private lastUsageState?: AutoCompactionUsageState;
  private lastSystemMessageTokens?: number;

  /** Prevent duplicate mid-stream compaction interrupts while we are already transitioning. */
  private readonly compactionObservations = new Map<symbol, Promise<void>>();
  private get midStreamCompactionPending(): boolean {
    const stage = this.coordinator.compactionIntent.observation?.stage;
    return stage === "stopping" || stage === "stopped" || stage === "dispatching";
  }
  private get continuousCompactionAbandoned(): boolean {
    return this.coordinator.compactionIntent.status === "abandoned";
  }
  private get continuousCompactionObserving(): boolean {
    return this.coordinator.compactionIntent.observation?.kind === "continuous";
  }

  /** Tracks file state for detecting external edits. */
  private readonly fileChangeTracker = new FileChangeTracker();

  /**
   * Track turns since last post-compaction attachment injection.
   * Start at max to trigger immediate injection on first turn after compaction.
   */
  private turnsSinceLastAttachment = TURNS_BETWEEN_ATTACHMENTS;

  /**
   * Flag indicating compaction has occurred in this session.
   * Used to enable the cooldown-based attachment injection.
   */
  private compactionOccurred = false;

  /**
   * Skill guardrails loaded before compaction are preserved here so later turns can
   * continue reattaching them even after the pending on-disk state is acknowledged.
   */
  private postCompactionLoadedSkills: LoadedSkillSnapshot[] = [];

  /**
   * Cumulative read-file paths from summarized epochs, mirrored like
   * postCompactionLoadedSkills so periodic re-injections keep the pre-boundary
   * reads after the pending on-disk state is acknowledged. RLM-only surface.
   */
  private postCompactionReadFilePaths: string[] = [];

  /**
   * When true, clear any persisted post-compaction state after the next successful non-compaction stream.
   *
   * This is intentionally delayed until stream-end so a crash mid-stream doesn't lose the diffs.
   */
  private ackPendingPostCompactionStateOnStreamEnd = false;

  /**
   * Cached memory session context (memory experiment): index snapshot for
   * the memory tool description plus an optional hot-memories block, keyed by
   * model because the hot set is token-budgeted with the active model's
   * tokenizer. Index-only entries can be upgraded once final tool policy keeps
   * the memory tool; compaction clears the map so repeated turns keep
   * prompt-cache-stable bytes without preserving stale files forever.
   */
  private readonly memoryContextByModelString = new Map<string, CachedMemoryContext>();
  /**
   * Cache the last-known experiment state so we don't spam metadata refresh
   * when post-compaction context is disabled.
   */
  /** Track compaction requests that already retried with truncation. */
  private readonly compactionRetryAttempts = new Set<string>();
  /**
   * Active compaction request metadata for retry decisions (cleared on stream end/abort).
   */

  /** Tracks the user message id that initiated the currently active stream (for retry guards). */
  private activeStreamUserMessageId?: string;

  /** Track user message ids that already retried without post-compaction injection. */
  private readonly postCompactionRetryAttempts = new Set<string>();

  /** Backend start time for the current stream, used to avoid charging goals created mid-stream. */
  private activeStreamStartedAtMs?: number;

  /** True once we see any model/tool output for the current stream (retry guard). */
  private activeStreamHadAnyDelta = false;

  /**
   * Backend-owned terminal lifecycle for the most recent turn.
   *
   * We retain interrupted/failed state after turnPhase returns to IDLE so reconnects and the
   * browser can distinguish a real stop/failure from a slow PREPARING turn that is still alive.
   */
  private terminalStreamLifecycle: StreamLifecycleSnapshot | null = null;

  /**
   * Most recent terminal stream-error event, retained so reconnect replay can restore specific
   * failure UI instead of degrading terminal failures to a generic interruption.
   */
  private terminalStreamError: StreamErrorMessage | null = null;

  /**
   * Latest pre-stream runtime-status breadcrumb for the in-flight PREPARING turn.
   *
   * This used to live only in the renderer, which meant switching away from and back to an
   * SSH/Coder workspace could drop the startup detail text until a brand-new event arrived.
   * Keeping the latest breadcrumb in the session lets replay restore the same status UI that
   * live subscribers saw.
   */
  private preparingRuntimeStatus: RuntimeStatusEvent | null = null;

  /** Last lifecycle snapshot emitted to live subscribers (used for change detection only). */
  private lastEmittedStreamLifecycle: StreamLifecycleSnapshot | null = null;

  /** Tracks whether the current stream included post-compaction attachments. */
  private activeStreamHadPostCompactionInjection = false;

  /**
   * muxMetadata of the queued entry currently being dispatched, held from
   * dequeue until its sendMessage settles (the stream has started or failed).
   * Lets hasPendingBashMonitorWakeContinuation see a wake continuation during
   * the dequeue→stream-start window without consulting stale stream context.
   */
  private dispatchingQueuedEntry = false;
  private dispatchingQueuedEntryMuxMetadata?: unknown;

  /** Correlation of the direct send currently in the PREPARING phase, if any. */
  private preparingWorkspaceTurnMetadata?: WorkspaceTurnMuxMetadata;

  /** Context needed to retry the current stream (cleared on stream end/abort/error). */
  private activeStreamContext?: {
    modelString: string;
    options?: SendMessageOptions;
    agentInitiated?: boolean;
    openaiTruncationModeOverride?: "auto" | "disabled";
    providersConfig: ProvidersConfigMap | null;
    goalKind?: GoalSyntheticMessageKind;
    /** Goal identity matching goalKind, so mid-stream compaction follow-ups stay goal-scoped. */
    goalId?: string;
    workspaceTurnMetadata?: Extract<MuxMessageMetadata, { type: "workspace-turn-task" }>;
  };

  private activeCompactionRequest?: {
    id: string;
    modelString: string;
    options?: SendMessageOptions;
    source?: "idle-compaction" | "auto-compaction";
  };

  /**
   * RLM keep-recent floor: summary ID of the just-completed compaction whose
   * preserved-tail copies were appended after the boundary. With copies, the
   * summary is no longer the last history row, so the stream-end follow-up
   * dispatch must target it by ID; null for default (RLM-off) compactions so
   * their "last message is the summary" staleness guard stays byte-identical.
   */
  private get pendingCompactionFollowUpSummaryId(): string | null {
    return this.coordinator.compactionIntent.summaryId;
  }

  constructor(options: AgentSessionOptions) {
    assert(options, "AgentSession requires options");
    const {
      workspaceId,
      config,
      historyService,
      aiService,
      streamManager,
      mcpServerManager,
      initStateManager,
      telemetryService,
      backgroundProcessManager,
      workspaceGoalService,
      sessionUsageService,
      keepBackgroundProcesses,
      sanitizeCliWorkspaceRegistration,
      onCompactionComplete,
      onIdleCompactionOutcome,
      onPostCompactionStateChange,
      hasExternalSendPreflight,
    } = options;

    assert(typeof workspaceId === "string", "workspaceId must be a string");
    const trimmedWorkspaceId = workspaceId.trim();
    assert(trimmedWorkspaceId.length > 0, "workspaceId must not be empty");

    this.workspaceId = trimmedWorkspaceId;
    this.config = config;
    this.historyService = historyService;
    this.compactionCancellation = new CompactionCancellation(historyService, trimmedWorkspaceId);
    this.aiService = aiService;
    const streamManagerCandidate = streamManager ?? aiService;
    assert(
      typeof streamManagerCandidate.stopStream === "function" &&
        typeof streamManagerCandidate.isStreaming === "function" &&
        typeof streamManagerCandidate.getStreamInfo === "function" &&
        typeof streamManagerCandidate.replayStream === "function",
      "AgentSession requires stream lifecycle access"
    );
    this.streamManager = streamManagerCandidate as AgentSessionStreamManager;
    this.mcpServerManager = mcpServerManager;
    this.initStateManager = initStateManager;
    this.backgroundProcessManager = backgroundProcessManager;
    this.workspaceGoalService = workspaceGoalService;
    this.sessionUsageService = sessionUsageService;
    this.keepBackgroundProcesses = keepBackgroundProcesses ?? false;
    this.sanitizeCliWorkspaceRegistration = sanitizeCliWorkspaceRegistration;
    this.onPostCompactionStateChange = onPostCompactionStateChange;
    this.hasExternalSendPreflight = hasExternalSendPreflight;

    this.compactionHandler = new CompactionHandler({
      workspaceId: this.workspaceId,
      captureCompletionGuard: () => {
        const epoch = this.coordinator.compactionIntent.epoch;
        return () => !this.coordinator.closing && this.coordinator.compactionIntent.epoch === epoch;
      },
      historyService: this.historyService,
      sessionDir: path.join(this.config.sessionsDir, this.workspaceId),
      telemetryService,
      emitter: this.emitter,
      onCompactionComplete: (metadata) => {
        // RLM keep-recent floor: tail copies after the boundary mean the
        // summary is no longer the last row; stash its ID so the stream-end
        // follow-up dispatch can target it directly.
        // Reset on every completion: a resumeless continuous fold may precede a
        // legacy compaction whose current follow-up is on its final summary row.
        this.coordinator.recordCompactionSummary(
          (metadata.preservedTailMessageCount ?? 0) > 0 ? metadata.summaryMessageId : null
        );
        onCompactionComplete?.(metadata);
      },
      onIdleCompactionOutcome,
    });

    this.compactionMonitor = new CompactionMonitor(
      this.workspaceId,
      (event: CompactionStatusEvent) => this.emitChatEvent(event)
    );

    this.continuousCompactor = new ContinuousCompactor({
      workspaceId: this.workspaceId,
      enterExecution: () => this.coordinator.enterExecution(),
      historyService: this.historyService,
      compactionHandler: this.compactionHandler,
      streamManager: {
        isStreaming: (workspaceId) => this.streamManager.isStreaming(workspaceId),
        setPrefixSwap: (workspaceId, swap) =>
          this.streamManager.setPrefixSwap?.(workspaceId, swap) ?? false,
        clearPrefixSwap: (workspaceId) => this.streamManager.clearPrefixSwap?.(workspaceId),
        getPrefixSwapState: (workspaceId) =>
          this.streamManager.getPrefixSwapState?.(workspaceId) ?? "none",
        getStreamInfo: (workspaceId) => {
          const info = this.streamManager.getStreamInfo(workspaceId);
          return (
            info && {
              ...info,
              stepStartIndices: info.stepStartIndices ?? [],
              currentStepStartIndex: info.currentStepStartIndex ?? 0,
            }
          );
        },
      },
      prepare: () =>
        eventSpine.run("compaction.prepare", {
          workspaceId: this.workspaceId,
          reason: "continuous-eager",
        }),
      estimateAttachmentTokens: async (head) => {
        const attachments = await this.buildContinuousCompactionAttachments(head);
        return injectPostCompactionAttachments([], attachments).reduce(
          (sum, row) => sum + estimateMuxMessageTokens(row),
          0
        );
      },
      prepareSwap: async (head) => {
        // A consumed swap may need the fast-stop fallback on a provider-family hop.
        if (!this.activeStreamContext?.options) return null;
        const prepared = this.streamManager.getPrefixSwapPreparation?.(this.workspaceId);
        if (!prepared) return null;
        const attachments = await this.buildContinuousCompactionAttachments(head);
        return { ...prepared, attachments };
      },
      summarize: (head, signal, context: SessionCompactionContext) => {
        const baseOptions = context.sendOptions ?? { model: context.model, agentId: "exec" };
        const request = this.buildAutoCompactionRequest({
          baseOptions,
          followUpContent: { text: "Continue", model: context.model, agentId: "exec" },
          reason: "on-send",
        });
        return summarizeContinuousCompaction({
          workspaceId: this.workspaceId,
          config: this.config,
          aiService: this.aiService,
          sessionUsageService: this.sessionUsageService,
          head,
          signal,
          context,
          baseOptions,
          compactOptions: request.sendOptions,
        });
      },
      fastApply: (apply) => this.interruptForContinuousCompaction(apply),
    });

    this.retryManager = new RetryManager(
      this.workspaceId,
      (isCurrent, signal) => this.retryActiveStream(isCurrent, signal),
      (event) => this.emitRetryEvent(event),
      this.streamManager.effectRunner,
      () => {
        const retry = this.coordinator.beginRetry();
        return { [Symbol.dispose]: () => this.coordinator.finishRetry(retry) };
      }
    );

    // App close can interrupt the guardian synchronously. Attach only after retry/compaction
    // collaborators exist, so a session created during shutdown can safely latch admission.
    this.coordinator.supervise(
      options.effectRunner ?? this.streamManager.effectRunner ?? defaultEffectRunner,
      options.appFiberScope,
      () => this.beginShutdown()
    );

    this.attachAiListeners();
    this.attachInitListeners();
    // A subscription is lazy: protect an existing engine before any caller can
    // send through this new session, even before replay is first pulled.
    const existingStream = this.streamManager.getStreamInfo(this.workspaceId);
    if (existingStream) this.coordinator.observeStreamReplay(existingStream.messageId);
    eventSpine.emit("session.start", { workspaceId: this.workspaceId });
  }

  /**
   * Process shutdown for a session that stays alive through teardown (a live stream's partial must
   * survive for the next startup's recovery, so dispose() and its abandonPartial are wrong here).
   * Stops the retry timer and makes every internal dispatch boundary below bail like `disposed`.
   */
  beginShutdown(): void {
    this.coordinator.beginShutdown();
    this.continuousCompactor.reset("shutdown");
    this.retryManager.cancel();
  }

  get closingSignal(): AbortSignal {
    return this.coordinator.closingSignal;
  }

  /** Service guardian owns the whole shutdown inside the app's existing bounded budget. */
  async finishShutdown(): Promise<void> {
    this.beginShutdown();
    // Retain/commit the captured partial before destructive disposal. The engine supervisor
    // joins this same cancellation; no session policy or scope joins itself here.
    try {
      try {
        await this.streamManager.stopStream(this.workspaceId, {
          abortReason: "system",
          emitIfMissing: false,
        });
      } catch (error) {
        log.warn("Session shutdown stop failed", { workspaceId: this.workspaceId, error });
      }
      await this.coordinator.drain();
    } finally {
      // A failed drain/adapter cannot skip background cleanup or listener teardown.
      await this.dispose();
    }
  }

  // Failed I/O keeps its exact semantic owner in the coordinator. This payload
  // schedules a later explicit recovery/teardown attempt, never a busy physical lease.
  private deferredCompactionCleanup?: {
    token: CompactionToken;
    dispatch: CompactionFollowUpDispatch;
    summaryMessageId?: string;
  };

  private compactionCleanupRetry?: Promise<void>;

  private hasDeferredCompactionCleanup(token: CompactionToken): boolean {
    return this.deferredCompactionCleanup?.token.id === token.id;
  }

  get hasPendingCompactionCleanup(): boolean {
    return (
      this.compactionCancellation.needsPersistence ||
      this.compactionCleanupRetry != null ||
      (this.deferredCompactionCleanup != null &&
        this.coordinator.canClearCompactionFollowUp(this.deferredCompactionCleanup.token))
    );
  }

  get hasBlockingCompactionCleanup(): boolean {
    return (
      this.compactionCancellation.blocksRecovery ||
      this.compactionCleanupRetry != null ||
      (this.deferredCompactionCleanup != null &&
        this.coordinator.canClearCompactionFollowUp(this.deferredCompactionCleanup.token))
    );
  }

  retryPendingCompactionCleanup(): Promise<void> {
    if (this.compactionCleanupRetry) return this.compactionCleanupRetry;
    if (this.compactionCancellation.needsPersistence)
      return this.compactionCancellation.retry().then(() => this.retryPendingCompactionCleanup());
    const deferred = this.deferredCompactionCleanup;
    if (!deferred) return Promise.resolve();
    if (!this.coordinator.canClearCompactionFollowUp(deferred.token)) {
      this.deferredCompactionCleanup = undefined;
      return Promise.resolve();
    }
    const settled = Promise.withResolvers<void>();
    this.compactionCleanupRetry = settled.promise;
    this.dispatchPendingFollowUp().then(
      () => {
        this.compactionCleanupRetry = undefined;
        settled.resolve();
      },
      (error: unknown) => {
        this.compactionCleanupRetry = undefined;
        // Dispatch preserves its original error even when bounded cleanup succeeds.
        if (
          this.hasDeferredCompactionCleanup(deferred.token) &&
          this.coordinator.canClearCompactionFollowUp(deferred.token)
        )
          settled.reject(
            new Error(`Stopped compaction cleanup remains pending: ${getErrorMessage(error)}`)
          );
        else settled.resolve();
      }
    );
    return settled.promise;
  }

  private disposePromise?: Promise<void>;
  private disposalMessageId?: string;

  /** Initiation is safe inside a leased callback; its caller must join at an outer boundary. */
  beginDispose(): void {
    this.dispose().catch((error: unknown) => log.warn("Session disposal failed", { error }));
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    const disposed = Promise.withResolvers<void>();
    this.disposePromise = disposed.promise;
    // Register before closing the guardian so app teardown also joins stop/background cleanup.
    const cleanupExecution = this.coordinator.enterExecution();
    this.disposalMessageId =
      this.streamManager.getStreamInfo(this.workspaceId, true)?.messageId ??
      this.coordinator.terminalMessageId;
    const cleanup = async (label: string, run: () => unknown): Promise<void> => {
      try {
        const result = await run();
        if (result && typeof result === "object" && "success" in result && !result.success) {
          log.debug(`dispose: ${label} failed`, { result });
        }
      } catch (error) {
        log.debug(`dispose: ${label} failed: ${getErrorMessage(error)}`);
      }
    };
    // Latch admission without publishing idle before stopStream captures the old attempt.
    this.coordinator.beginShutdown();
    const stopped = cleanup("stopStream", () =>
      this.streamManager.stopStream(this.workspaceId, {
        abandonPartial: true,
        emitIfMissing: false,
      })
    );
    const invalidated = cleanup("invalidate", () => {
      try {
        this.coordinator.dispose();
      } finally {
        // Release Node's async-context registration only after late replay events
        // are suppressed; disabling while merely closing could broadcast them live.
        if (this.coordinator.disposed) this.replayPublication.disable();
      }
    });
    const compactionStopped = cleanup("compaction", () =>
      this.continuousCompactor.reset("dispose")
    );
    const retryStopped = cleanup("retry", () => this.retryManager.dispose());
    const backgroundStopped = this.keepBackgroundProcesses
      ? undefined
      : cleanup("background processes", () =>
          this.backgroundProcessManager.cleanup(this.workspaceId)
        );
    let unresolvedCompactionCleanup: Error | undefined;
    Promise.all([stopped, invalidated, compactionStopped, retryStopped, backgroundStopped])
      .then(async () => {
        cleanupExecution[Symbol.dispose]();
        await cleanup("drain", () => this.coordinator.drain());
        // A failed producer may defer cleanup while drain is running. Retry only
        // after its lease settles; retaining its token must never self-join drain.
        try {
          await this.compactionCancellation.retry();
          await this.retryPendingCompactionCleanup();
        } catch (error) {
          unresolvedCompactionCleanup =
            error instanceof Error ? error : new Error(getErrorMessage(error));
        }
        // Raw bridges stay attached through the attempt fence. Destructive disposal suppresses
        // recovery policy, but still presents its captured terminal exactly once below.
        for (const { event, handler } of this.aiListeners) this.aiService.off(event, handler);
        this.aiListeners.length = 0;
        for (const { event, handler } of this.initListeners)
          this.initStateManager.off(event, handler as never);
        this.initListeners.length = 0;
        this.emitter.removeAllListeners();
        eventSpine.emit("session.end", { workspaceId: this.workspaceId });
      })
      .catch((error: unknown) => log.debug("dispose: final cleanup failed", { error }))
      .finally(() => {
        if (unresolvedCompactionCleanup) disposed.reject(unresolvedCompactionCleanup);
        else disposed.resolve();
      });
    return disposed.promise;
  }

  onChatEvent(listener: (event: AgentSessionChatEvent) => void): () => void {
    assert(typeof listener === "function", "listener must be a function");
    this.emitter.on("chat-event", listener);
    return () => {
      this.emitter.off("chat-event", listener);
    };
  }

  onMetadataEvent(listener: (event: AgentSessionMetadataEvent) => void): () => void {
    assert(typeof listener === "function", "listener must be a function");
    this.emitter.on("metadata-event", listener);
    return () => {
      this.emitter.off("metadata-event", listener);
    };
  }

  async subscribeChat(listener: (event: AgentSessionChatEvent) => void): Promise<() => void> {
    this.assertNotDisposed("subscribeChat");
    assert(typeof listener === "function", "listener must be a function");

    const unsubscribe = this.onChatEvent(listener);
    await this.replayHistory(listener);

    this.scheduleStartupRecovery();

    return unsubscribe;
  }

  async replayHistory(
    listener: (event: AgentSessionChatEvent) => void,
    mode?: OnChatMode,
    beforeReplayCompletion?: () => void
  ): Promise<void> {
    this.assertNotDisposed("replayHistory");
    assert(typeof listener === "function", "listener must be a function");
    await this.replayPublication.run({ listener, emittedStreamEvents: false }, () =>
      this.emitHistoricalEvents(listener, mode, beforeReplayCompletion)
    );
  }

  emitMetadata(metadata: FrontendWorkspaceMetadata | null): void {
    this.assertNotDisposed("emitMetadata");
    this.emitter.emit("metadata-event", {
      workspaceId: this.workspaceId,
      metadata,
    } satisfies AgentSessionMetadataEvent);
  }

  private getStreamLastTimestamp(streamInfo: {
    startTime?: number;
    parts: Array<{ timestamp?: number; workflowRun?: { timestamp?: number } }>;
    toolCompletionTimestamps: Map<string, number>;
  }): number {
    // Use a nonzero floor so live-mode replay never sends afterTimestamp=0 when a
    // stream has started but no parts/completions are recorded yet.
    let streamLastTimestamp = streamInfo.startTime ?? 1;
    for (let index = streamInfo.parts.length - 1; index >= 0; index -= 1) {
      const timestamp = streamInfo.parts[index]?.timestamp;
      if (timestamp === undefined) {
        continue;
      }
      streamLastTimestamp = timestamp;
      break;
    }

    for (const part of streamInfo.parts) {
      const workflowRunTimestamp = part.workflowRun?.timestamp;
      if (workflowRunTimestamp !== undefined && workflowRunTimestamp > streamLastTimestamp) {
        streamLastTimestamp = workflowRunTimestamp;
      }
    }

    for (const completionTimestamp of streamInfo.toolCompletionTimestamps.values()) {
      if (completionTimestamp > streamLastTimestamp) {
        streamLastTimestamp = completionTimestamp;
      }
    }

    return streamLastTimestamp;
  }

  private getCurrentStreamLifecycleSnapshot(): StreamLifecycleSnapshot {
    if (this.coordinator.phase === "preparing") {
      return { phase: "preparing", hadAnyOutput: false };
    }

    if (this.coordinator.phase === "streaming") {
      return {
        phase: "streaming",
        hadAnyOutput: this.activeStreamHadAnyDelta,
      };
    }

    if (this.coordinator.phase === "completing") {
      return {
        phase: "completing",
        hadAnyOutput: this.activeStreamHadAnyDelta,
      };
    }

    return this.terminalStreamLifecycle ?? { phase: "idle", hadAnyOutput: false };
  }

  private hasSameStreamLifecycle(
    left: StreamLifecycleSnapshot | null,
    right: StreamLifecycleSnapshot
  ): boolean {
    return (
      left !== null &&
      left.phase === right.phase &&
      left.hadAnyOutput === right.hadAnyOutput &&
      (left.abortReason ?? null) === (right.abortReason ?? null)
    );
  }

  private hasSameRuntimeStatus(
    left: RuntimeStatusEvent | null,
    right: RuntimeStatusEvent
  ): boolean {
    return (
      left !== null &&
      left.phase === right.phase &&
      left.runtimeType === right.runtimeType &&
      (left.source ?? null) === (right.source ?? null) &&
      (left.detail ?? null) === (right.detail ?? null)
    );
  }

  private emitStreamLifecycleIfChanged(): void {
    if (this.coordinator.disposed) {
      return;
    }

    const snapshot = this.getCurrentStreamLifecycleSnapshot();
    if (this.hasSameStreamLifecycle(this.lastEmittedStreamLifecycle, snapshot)) {
      return;
    }

    this.lastEmittedStreamLifecycle = copyStreamLifecycleSnapshot(snapshot);
    this.emitChatEvent({
      type: "stream-lifecycle",
      workspaceId: this.workspaceId,
      ...snapshot,
    });
  }

  private markActiveStreamHadAnyOutput(): void {
    if (this.activeStreamHadAnyDelta) {
      return;
    }

    this.activeStreamHadAnyDelta = true;
    this.emitStreamLifecycleIfChanged();
  }

  private setTerminalStreamLifecycle(
    phase: Extract<StreamLifecycleSnapshot["phase"], "interrupted" | "failed">,
    options?: { abortReason?: StreamAbortReason; hadAnyOutput?: boolean }
  ): void {
    this.terminalStreamLifecycle = copyStreamLifecycleSnapshot({
      phase,
      hadAnyOutput: options?.hadAnyOutput ?? this.activeStreamHadAnyDelta,
      abortReason: options?.abortReason,
    });
  }

  private updatePreparingRuntimeStatus(status: RuntimeStatusEvent): void {
    if (status.phase === "ready" || status.phase === "error") {
      this.clearPreparingRuntimeStatus();
      return;
    }

    this.preparingRuntimeStatus = status;
  }

  private clearPreparingRuntimeStatus(): void {
    this.preparingRuntimeStatus = null;
  }

  private emitRetryEvent(event: RetryStatusEvent): void {
    if (this.coordinator.disposed) {
      return;
    }
    this.emitChatEvent(event);
  }

  private async handleStreamFailureForAutoRetry(
    error: RetryFailureError,
    isCurrent = this.retryManager.captureGeneration()
  ): Promise<void> {
    assert(
      typeof error.type === "string" && error.type.length > 0,
      "handleStreamFailureForAutoRetry requires a non-empty error.type"
    );
    if (this.coordinator.closing || !isCurrent()) {
      return;
    }

    // Load persisted preference before scheduling retries so an on-disk opt-out is
    // honored even when the first failure happens before startup recovery runs.
    const turn = this.coordinator.turnId;
    await this.loadAutoRetryEnabledPreference(isCurrent);
    if (this.coordinator.closing || !isCurrent() || !this.coordinator.isCurrentTurn(turn)) return;
    this.retryManager.handleStreamFailure(error);
  }

  private setAutoRetryResumeState(
    options: SendMessageOptions | undefined,
    agentInitiated?: boolean,
    goalKind?: GoalSyntheticMessageKind,
    goalId?: string
  ): void {
    if (!options) {
      this.lastAutoRetryResumeRequest = undefined;
      return;
    }

    this.lastAutoRetryResumeRequest = {
      options,
      ...(agentInitiated === true ? { agentInitiated: true } : {}),
      ...(goalKind != null ? { goalKind } : {}),
      ...(goalId != null ? { goalId } : {}),
    };
  }

  private extractRetryFailureMessage(error: SendMessageError): string | undefined {
    if ("message" in error && typeof error.message === "string") {
      return error.message;
    }

    if ("raw" in error && typeof error.raw === "string") {
      return error.raw;
    }

    return undefined;
  }

  private async retryActiveStream(
    isCurrent = this.retryManager.captureGeneration(),
    signal?: AbortSignal
  ): Promise<void> {
    if (this.coordinator.closing || !isCurrent()) return;
    using _execution = this.coordinator.enterExecution();
    const request = this.lastAutoRetryResumeRequest;
    if (!request) {
      this.emitRetryEvent({ type: "auto-retry-abandoned", reason: "missing_retry_options" });
      return;
    }

    // Archive only interrupts a live stream; a backoff timer armed before it keeps ticking.
    if (this.isWorkspaceArchivedOnDisk()) {
      this.emitRetryEvent({ type: "auto-retry-abandoned", reason: "workspace_archived" });
      return;
    }

    const result = await this.resumeStream(request.options, {
      agentInitiated: request.agentInitiated === true ? true : undefined,
      goalKind: request.goalKind,
      goalId: request.goalId,
      retrySignal: signal,
      automatic: true,
    });
    // Interrupting the scheduling fiber cannot cancel resumeStream's original Promise.
    // Its late settlement must not mutate a replacement retry or accepted manual turn.
    if (this.coordinator.closing || !isCurrent()) return;
    if (result.success) {
      if (!result.data.started) {
        // resumeStream can defer when a turn is still PREPARING/COMPLETING.
        // Treat this as retriable so auto-retry keeps progressing instead of
        // stalling after the "auto-retry-starting" status event.
        await this.handleStreamFailureForAutoRetry(
          {
            type: "unknown",
            message: "retry_deferred_busy",
          },
          isCurrent
        );
        return;
      }

      // Retry resumed the stream successfully. Clear stale startup-abandon markers now
      // (not only on stream-end) so a crash/restart mid-stream doesn't suppress recovery.
      await this.clearStartupAutoRetryAbandon(() => !this.coordinator.closing && isCurrent());
      return;
    }

    if (result.failureHandled === true) {
      return;
    }

    // Fallback: resumeStream() can fail before stream error handlers run
    // (for example commitPartial/history read failures). Handle those here so
    // auto-retry continues instead of stalling after auto-retry-starting.
    // Persist this generation's result before publishing a successor's scheduled event.
    await this.updateStartupAutoRetryAbandonFromFailure(
      result.error.type,
      this.activeStreamUserMessageId,
      () => !this.coordinator.closing && isCurrent()
    );
    if (this.coordinator.closing || !isCurrent()) return;
    await this.handleStreamFailureForAutoRetry(
      {
        type: result.error.type,
        message: this.extractRetryFailureMessage(result.error),
      },
      isCurrent
    );
  }

  private getAutoRetryPreferencePath(): string {
    return path.join(
      path.join(this.config.sessionsDir, this.workspaceId),
      AUTO_RETRY_PREFERENCE_FILE
    );
  }

  setLegacyAutoRetryEnabledHint(enabled: boolean): void {
    this.assertNotDisposed("setLegacyAutoRetryEnabledHint");
    assert(typeof enabled === "boolean", "setLegacyAutoRetryEnabledHint requires a boolean");

    if (this.autoRetryEnabledPreference !== null) {
      return;
    }

    this.legacyAutoRetryEnabledHint = enabled;
  }

  private parseStartupAutoRetryAbandon(
    value: unknown
  ): { reason: string; userMessageId?: string } | null {
    if (typeof value !== "object" || value === null) {
      return null;
    }

    const parsed = value as { reason?: unknown; userMessageId?: unknown };
    if (typeof parsed.reason !== "string" || parsed.reason.trim().length === 0) {
      return null;
    }

    const userMessageId =
      typeof parsed.userMessageId === "string" && parsed.userMessageId.trim().length > 0
        ? parsed.userMessageId
        : undefined;

    return {
      reason: parsed.reason,
      ...(userMessageId ? { userMessageId } : {}),
    };
  }

  private async loadAutoRetryEnabledPreference(isCurrent = () => true): Promise<boolean> {
    if (this.autoRetryEnabledPreference !== null) {
      return this.autoRetryEnabledPreference;
    }

    const preferencePath = this.getAutoRetryPreferencePath();
    try {
      const raw = await readFile(preferencePath, "utf-8");
      if (this.coordinator.closing || !isCurrent()) return false;
      const parsed = JSON.parse(raw) as {
        enabled?: unknown;
        startupAutoRetryAbandon?: unknown;
      };
      const enabled = parsed.enabled !== false;
      this.autoRetryEnabledPreference = enabled;
      this.legacyAutoRetryEnabledHint = null;
      this.startupAutoRetryAbandon = this.parseStartupAutoRetryAbandon(
        parsed.startupAutoRetryAbandon
      );
      this.retryManager.setEnabled(enabled);
      return enabled;
    } catch (error) {
      if (this.coordinator.closing || !isCurrent()) return false;
      // Missing preference file is the default path. Use any legacy frontend hint
      // (captured at onChat subscribe time) before falling back to enabled.
      const errno =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      const defaultEnabled =
        errno === "ENOENT" && this.legacyAutoRetryEnabledHint === false ? false : true;

      this.autoRetryEnabledPreference = defaultEnabled;
      this.legacyAutoRetryEnabledHint = null;
      this.startupAutoRetryAbandon = null;
      this.retryManager.setEnabled(defaultEnabled);

      if (errno === "ENOENT" && defaultEnabled === false) {
        // Persist migrated legacy opt-out so restart behavior no longer depends
        // on renderer localStorage keys.
        await this.persistAutoRetryState();
      } else if (errno !== "ENOENT") {
        log.warn("Failed to load auto-retry preference; defaulting to enabled", {
          workspaceId: this.workspaceId,
          error: getErrorMessage(error),
        });
      }

      return defaultEnabled;
    }
  }

  private autoRetryPersistence: Promise<void> = Promise.resolve();

  private persistAutoRetryState(isCurrent = () => true): Promise<void> {
    if (!isCurrent()) return Promise.resolve();
    const preferencePath = this.getAutoRetryPreferencePath();
    const enabled = this.autoRetryEnabledPreference !== false;
    const abandon = this.startupAutoRetryAbandon;
    // Capture the admitted update, then serialize every writer (including success policy
    // and public opt-out). Generation checks cannot cancel an already-issued unlink: it
    // must settle before a newer preference commits, or it can erase the user's opt-out.
    // Once memory reflects this admitted snapshot it must commit even if its generation
    // retires while queued; a later clear may already see null and have nothing to enqueue.
    const payload =
      enabled && !abandon
        ? undefined
        : JSON.stringify({
            ...(!enabled ? { enabled: false } : {}),
            ...(abandon ? { startupAutoRetryAbandon: abandon } : {}),
          }) + "\n";
    const execution = this.coordinator.enterExecution();
    const persisted = this.autoRetryPersistence
      .then(async () => {
        try {
          if (payload === undefined) {
            await unlink(preferencePath);
          } else {
            await mkdir(path.dirname(preferencePath), { recursive: true });
            await writeFile(preferencePath, payload, "utf-8");
          }
        } catch (error) {
          if (
            payload === undefined &&
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return;
          log.warn("Failed to persist auto-retry preference", {
            workspaceId: this.workspaceId,
            error: getErrorMessage(error),
          });
        }
      })
      .finally(() => execution[Symbol.dispose]());
    this.autoRetryPersistence = persisted;
    return persisted;
  }

  private async persistAutoRetryEnabledPreference(enabled: boolean): Promise<void> {
    this.autoRetryEnabledPreference = enabled;
    await this.persistAutoRetryState();
  }

  private async persistStartupAutoRetryAbandon(
    reason: string,
    userMessageId?: string,
    isCurrent = () => true
  ): Promise<void> {
    if (!isCurrent()) return;
    this.startupAutoRetryAbandon = {
      reason,
      ...(userMessageId ? { userMessageId } : {}),
    };
    await this.persistAutoRetryState(isCurrent);
  }

  private async clearStartupAutoRetryAbandon(isCurrent = () => true): Promise<void> {
    if (!isCurrent()) return;
    if (this.startupAutoRetryAbandon === null) {
      return;
    }

    this.startupAutoRetryAbandon = null;
    await this.persistAutoRetryState(isCurrent);
  }

  async handleProviderConfigChanged(): Promise<void> {
    await this.loadAutoRetryEnabledPreference();
    if (!isProviderConfigFixableError(this.startupAutoRetryAbandon?.reason ?? "")) {
      return;
    }

    // Config changes only unlock retry. They must not resume the live stream (PR #2317 was
    // rejected); after a later restart, normal startup recovery may resume the interrupted tail.
    await this.clearStartupAutoRetryAbandon();
  }

  private async updateStartupAutoRetryAbandonFromFailure(
    errorType: string,
    userMessageId?: string,
    isCurrent = () => true
  ): Promise<void> {
    if (
      isNonRetryableSendError({ type: errorType }) ||
      isNonRetryableStreamError({ type: errorType })
    ) {
      await this.persistStartupAutoRetryAbandon(errorType, userMessageId, isCurrent);
      return;
    }

    await this.clearStartupAutoRetryAbandon(isCurrent);
  }

  private async updateStartupAutoRetryAbandonFromAbort(
    abortReason: StreamAbortReason | undefined,
    userMessageId?: string
  ): Promise<void> {
    // "system" and "startup" aborts come from backend-orchestrated flows
    // (for example, mid-stream auto-compaction or canceling a pending startup).
    // They are not user intent and must not poison startup recovery with a
    // persisted non-retryable "aborted" marker.
    if (abortReason === "system" || abortReason === "startup") {
      return;
    }

    await this.updateStartupAutoRetryAbandonFromFailure("aborted", userMessageId);
  }

  private isAiStreaming(): boolean {
    return this.streamManager.isStreaming(this.workspaceId);
  }

  private normalizeStartupModel(model: unknown): string | undefined {
    if (typeof model !== "string") {
      return undefined;
    }

    const trimmed = model.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    // Preserve explicit gateway identities (coder:, mux-gateway:, ...) just
    // like normal send-option normalization: normalizeToCanonical would
    // rewrite a cross-typed canonical-name instance such as
    // coder:openai/<claude> (type anthropic) to openai:<claude>, sending the
    // recovered turn through direct OpenAI instead of the selected gateway.
    const normalized = normalizeSelectedModel(trimmed);
    if (!isValidModelFormat(normalized)) {
      return undefined;
    }

    return normalized;
  }

  private normalizeAgentIdForRetry(agentId: unknown): string | undefined {
    if (typeof agentId !== "string") {
      return undefined;
    }

    const normalized = normalizeAgentId(agentId, "");
    if (normalized.length === 0) {
      return undefined;
    }

    const parsed = AgentIdSchema.safeParse(normalized);
    return parsed.success ? parsed.data : undefined;
  }

  private isPendingAskUserQuestion(message: MuxMessage | null | undefined): boolean {
    if (!message || message.role !== "assistant") {
      return false;
    }

    return message.parts.some(
      (part) =>
        part.type === "dynamic-tool" &&
        part.toolName === "ask_user_question" &&
        part.state === "input-available"
    );
  }

  private isSyntheticGoalPauseBoundaryMessage(message: MuxMessage): boolean {
    return (
      message.role === "user" &&
      message.metadata?.synthetic === true &&
      message.metadata.muxMetadata?.type === "goal-pause-boundary"
    );
  }

  private getEditTruncateTargetFromMessages(
    messages: readonly MuxMessage[],
    editMessageId: string
  ): string | undefined {
    const editIndex = messages.findIndex((message) => message.id === editMessageId);
    if (editIndex === -1) {
      return undefined;
    }

    let truncateTargetId = editMessageId;
    for (let i = editIndex - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (!isSyntheticSnapshotUserMessage(message)) {
        break;
      }
      truncateTargetId = message.id;
    }

    return truncateTargetId;
  }

  private async getEditTruncateTargetId(editMessageId: string): Promise<string> {
    const historyResult = await this.historyService.getHistoryFromLatestBoundary(this.workspaceId);
    if (historyResult.success) {
      const truncateTargetId = this.getEditTruncateTargetFromMessages(
        historyResult.data,
        editMessageId
      );
      if (truncateTargetId !== undefined) {
        return truncateTargetId;
      }
    }

    const fullHistory: MuxMessage[] = [];
    const fullHistoryResult = await this.historyService.iterateFullHistory(
      this.workspaceId,
      "forward",
      (messages) => {
        fullHistory.push(...messages);
      }
    );
    if (!fullHistoryResult.success) {
      return editMessageId;
    }

    return this.getEditTruncateTargetFromMessages(fullHistory, editMessageId) ?? editMessageId;
  }

  private getLastNonSystemHistoryMessage(historyTail: MuxMessage[]): MuxMessage | undefined {
    for (let index = historyTail.length - 1; index >= 0; index -= 1) {
      const candidate = historyTail[index];
      if (candidate.role === "system") {
        continue;
      }
      if (this.isSyntheticGoalPauseBoundaryMessage(candidate)) {
        continue;
      }
      if (isSyntheticSnapshotUserMessage(candidate)) {
        continue;
      }
      return candidate;
    }
    return undefined;
  }

  private async requireGoalAcknowledgmentForCrashRecoveredPartial(): Promise<void> {
    const goalService = this.workspaceGoalService;
    if (!goalService || this.coordinator.closing) {
      return;
    }
    if (this.isBusy() || this.isAiStreaming()) {
      return;
    }

    // Crash recovery restores abandoned assistant partials without knowing whether
    // the model's last action was safe to continue, so goal loops must wait for user acknowledgment.
    const partial = await this.historyService.readPartial(this.workspaceId);
    if (this.coordinator.closing) return;
    if (partial?.role === "assistant" && !this.isPendingAskUserQuestion(partial)) {
      await goalService.requireUserAcknowledgmentForCrashRecovery(this.workspaceId);
      return;
    }

    const historyResult = await this.historyService.getLastMessages(this.workspaceId, 20);
    if (this.coordinator.closing || !historyResult.success) {
      return;
    }

    const lastHistoryMessage = this.getLastNonSystemHistoryMessage(historyResult.data);
    if (
      lastHistoryMessage?.role === "assistant" &&
      lastHistoryMessage.metadata?.partial === true &&
      !this.isPendingAskUserQuestion(lastHistoryMessage)
    ) {
      await goalService.requireUserAcknowledgmentForCrashRecovery(this.workspaceId);
    }
  }

  private async applyManualUserMessageGoalSafety(input: {
    policy: GoalInterventionPolicy;
    enqueuedAtMs?: number;
  }): Promise<void> {
    const goalService = this.workspaceGoalService;
    if (!goalService) {
      return;
    }

    assert(
      input.policy === "steer" || input.policy === "pause",
      `invalid goal intervention policy: ${input.policy}`
    );

    // Accepted manual user turns acknowledge / clear crash-recovery gates, but
    // they are no longer goal-continuation turns. The goal mode is locked to the
    // chat tail: a real `goal_continuation` user message means running;
    // anything manually typed by the user pauses until Resume appends a fresh
    // continuation. Legacy clients may still send the old "steer" policy; treat
    // it as pause so the invariant holds at this backend boundary.
    //
    // Codex P1 (PRRT_kwDOPxxmWM6cClKd): the manual row is already durable, but
    // a direct send has not marked the session busy yet — an eligibility check
    // during the acknowledgment await below would see the workspace idle and
    // consume a still-armed kickoff candidate, dispatching a continuation
    // against the user's intervention. Take the candidate synchronously BEFORE
    // any await; the pre-goal queue-race branch restores it.
    const suspendedCandidate = goalService.takePendingContinuationCandidateForManualUserMessage(
      this.workspaceId
    );
    // Codex P2 (PRRT_kwDOPxxmWM6b-Uln): on acknowledgment failure we cannot
    // read the goal to prove the pre-goal queue race below, so leave the
    // candidate cleared conservatively (it was taken above): once the failed
    // send returns the workspace to idle, a stale candidate could otherwise
    // dispatch a continuation despite the user's persisted intervention.
    //
    // The authoring time keeps a delayed pre-stop send from clearing a NEWER
    // stop's acknowledgment gate (Codex P1 PRRT_kwDOPxxmWM6cECpj).
    const goal = await goalService.acknowledgeUser(this.workspaceId, {
      authoredAtMs: input.enqueuedAtMs,
    });

    // Queue race: a message the user typed while the goal-creating turn was
    // still streaming predates the goal itself — the model's queued set_goal
    // applies at that turn's stream end, and only then does the queued message
    // dispatch (user report: goals "paused by heartbeats" were actually killed
    // here, then heartbeat turns kept the workspace moving while the goal sat
    // paused).
    //
    // Codex security P2 (PRRT_kwDOPxxmWM6cSGrq): timestamp order alone is NOT
    // consent — a model can publish a goal AFTER the user queued a
    // stop/correction, and a "predates the goal" bypass would shield the new
    // goal's autonomy from the any-manual-turn-pauses boundary even if the
    // model ignores the corrective turn. The bypass therefore requires an
    // EXPLICIT user activation (direct create, Resume, board promote — never
    // model set_goal or auto-promotion; see stampUserActivation) that
    // postdates the message's authoring: the user acted with the message
    // already pending, a genuine opt-in. Model-created goals carry no consent
    // stamp and fail closed into the visible, resumable pause below.
    // Strict ordering (Codex P2 PRRT_kwDOPxxmWM6cS8Bu): millisecond timestamps
    // cannot order same-millisecond events, so equality cannot prove the
    // message was already pending at activation — it fails closed to pause.
    if (
      input.enqueuedAtMs != null &&
      goal?.lastUserActivationAtMs != null &&
      goal.lastUserActivationAtMs > input.enqueuedAtMs
    ) {
      if (suspendedCandidate != null) {
        // The restore re-verifies goal identity + active status under the
        // goal file lock (Codex P2 PRRT_kwDOPxxmWM6cErQ7): a pause landing
        // during classification must win over the suspended kickoff.
        await goalService.restorePendingContinuationCandidate(this.workspaceId, suspendedCandidate);
      }
      return;
    }

    // Also clears any candidate armed during the acknowledgment await — a
    // post-goal intervention must not leave a consumable continuation behind.
    goalService.clearPendingContinuationForManualUserMessage(this.workspaceId);
    // Codex P2 (PRRT_kwDOPxxmWM6cJ6NM): the candidate delete above is
    // in-memory only — persist the suppression so a restart cannot
    // re-synthesize the autonomous wrap-up over the user's intervention.
    //
    // Scoped to the acknowledged goal's identity: a replacement goal that
    // persisted during the acknowledgment await must not be suppressed by a
    // message that predates it (Codex P2 PRRT_kwDOPxxmWM6cLpID). The service
    // re-verifies goalId + budget_limited status under its lock, so callers
    // may invoke this on a stale snapshot and it no-ops unless suppression is
    // actually owed.
    const suppressWrapupForGoal = async (goalId: string): Promise<void> => {
      try {
        await goalService.suppressBudgetWrapupForManualUserMessage(this.workspaceId, goalId);
      } catch (error) {
        // A transient write failure must not break the user's manual send;
        // suppression fails closed (durable-first, so no in-memory state was
        // published) and the next manual message retries it.
        log.warn("Failed to persist budget wrap-up suppression", {
          workspaceId: this.workspaceId,
          error: getErrorMessage(error),
        });
      }
    };
    if (goal?.status === "budget_limited") {
      await suppressWrapupForGoal(goal.goalId);
    }
    if (goal?.status !== "active") {
      return;
    }

    try {
      const result = await goalService.setGoal({
        workspaceId: this.workspaceId,
        status: "paused",
        initiator: "auto",
      });
      if (!result.success) {
        log.warn("Failed to auto-pause goal for manual user message", {
          workspaceId: this.workspaceId,
          error: result.error,
        });
        // Codex P2 (PRRT_kwDOPxxmWM6cNQvL): the acknowledged snapshot said
        // "active", but a queued child-attribution or budget edit can move
        // the SAME goal to budget_limited during the awaits above — the pause
        // is then rejected (budget-limited goals cannot pause) and the
        // suppression branch above was skipped on the stale status. Suppress
        // against the same goal identity; the locked recheck no-ops unless
        // the goal really became budget-limited.
        await suppressWrapupForGoal(goal.goalId);
      }
    } catch (error) {
      log.warn("Failed to auto-pause goal for manual user message", {
        workspaceId: this.workspaceId,
        error: getErrorMessage(error),
      });
      await suppressWrapupForGoal(goal.goalId);
    }
  }

  private async getWorkspaceMetadataForRetry(): Promise<WorkspaceMetadata | undefined> {
    const aiService = this.aiService as Partial<
      Pick<AgentSessionAIService, "getWorkspaceMetadata">
    >;
    if (typeof aiService.getWorkspaceMetadata !== "function") {
      return undefined;
    }

    const metadataResult = await aiService.getWorkspaceMetadata(this.workspaceId);
    if (!metadataResult.success) {
      return undefined;
    }

    return metadataResult.data;
  }

  private isVisibleCompletedSubagentReportMessage(message: MuxMessage): boolean {
    if (
      message.role !== "user" ||
      message.metadata?.synthetic !== true ||
      message.metadata.uiVisible !== true
    ) {
      return false;
    }
    const text = message.parts
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    return parseSubagentReportEnvelope(text)?.status === "completed";
  }

  private shouldUseUserMessageForRetry(message: MuxMessage): boolean {
    if (message.role !== "user") {
      return false;
    }

    if (this.isVisibleCompletedSubagentReportMessage(message)) {
      return false;
    }
    if (this.isSyntheticGoalPauseBoundaryMessage(message)) {
      return false;
    }
    if (isSyntheticSnapshotUserMessage(message)) {
      return false;
    }

    // Include UI-visible synthetic rows (e.g., crash-recovered compaction follow-ups)
    // so retries continue the most recent pending user intent.
    if (message.metadata?.synthetic === true) {
      return (
        message.metadata?.uiVisible === true ||
        isCompactionRequestMetadata(message.metadata?.muxMetadata)
      );
    }

    return true;
  }

  /**
   * Startup crash recovery replays the ORIGINAL interrupted request from
   * persisted retry options / history metadata / workspace buckets. This is
   * request replay, not preference resolution, so it intentionally does not go
   * through resolveAgentAiSettings: its layers (and the child-task-workspace
   * inversion below) reconstruct a specific prior request rather than deriving
   * a fresh choice, and nothing here is promoted into new defaults.
   */
  private async deriveStartupAutoRetryRequest(params: {
    partial: MuxMessage | null;
    historyTail: MuxMessage[];
  }): Promise<StartupRetrySendOptions | undefined> {
    const lastUserMessage = [...params.historyTail]
      .reverse()
      .find((message): message is MuxMessage & { role: "user" } =>
        this.shouldUseUserMessageForRetry(message)
      );

    const lastAssistantMessage =
      params.partial?.role === "assistant"
        ? params.partial
        : [...params.historyTail]
            .reverse()
            .find(
              (message): message is MuxMessage & { role: "assistant" } =>
                message.role === "assistant"
            );

    const workspaceMetadata = await this.getWorkspaceMetadataForRetry();

    const persistedRetrySendOptions = lastUserMessage?.metadata?.retrySendOptions;
    // The user row's own metadata.goalId is the durable copy (stamped next to
    // `kind`); recover it so resumed streams keep goal-scoped compaction
    // follow-ups (Codex P2 PRRT_kwDOPxxmWM6cIv2E). Chat metadata is unchecked
    // JSON (Codex P2 PRRT_kwDOPxxmWM6cQt3o): a PRESENT-but-invalid goalId must
    // not resume the turn as goal-driven with untrustworthy identity — a later
    // compaction would persist a missing-ID follow-up that bypasses
    // buildGoalRedispatchAdmission. Absent IDs keep legacy unscoped semantics;
    // present-invalid values discard the row's goal attribution entirely.
    const rawPersistedGoalId: unknown = lastUserMessage?.metadata?.goalId;
    const goalAttributionCorrupt =
      rawPersistedGoalId !== undefined && coerceGoalId(rawPersistedGoalId) == null;
    const persistedGoalKind = goalAttributionCorrupt
      ? undefined
      : (coerceGoalSyntheticMessageKind(persistedRetrySendOptions?.goalKind) ??
        coerceGoalSyntheticMessageKind(lastUserMessage?.metadata?.kind));
    const persistedGoalId =
      persistedGoalKind != null ? coerceGoalId(rawPersistedGoalId) : undefined;

    const workspaceAgentIdCandidates = resolvePersistedAgentIdCandidates(workspaceMetadata);
    const workspaceAgentId = workspaceAgentIdCandidates[0] ?? WORKSPACE_DEFAULTS.agentId;
    const persistedAgentId = this.normalizeAgentIdForRetry(persistedRetrySendOptions?.agentId);
    const assistantAgentId = this.normalizeAgentIdForRetry(lastAssistantMessage?.metadata?.agentId);
    // Child task workspaces carry their creation-time identity/settings in workspace metadata.
    // Startup retry metadata can be stale after recovery sends restamp agentId to exec, so
    // child retries must prefer the persisted workspace candidate before history metadata.
    const isChildTaskWorkspace = workspaceMetadata?.parentWorkspaceId != null;
    const baseAgentId = isChildTaskWorkspace
      ? workspaceAgentId
      : (persistedAgentId ?? assistantAgentId ?? workspaceAgentId);
    const agentSettingsCandidateFields = isChildTaskWorkspace
      ? [...workspaceAgentIdCandidates, baseAgentId, persistedAgentId, assistantAgentId]
      : [baseAgentId, ...workspaceAgentIdCandidates, workspaceAgentId];
    const agentSettingsCandidates = agentSettingsCandidateFields.filter(
      (agentId, index, candidates): agentId is string =>
        typeof agentId === "string" && candidates.indexOf(agentId) === index
    );

    const agentSettings =
      agentSettingsCandidates
        .map((agentId) => workspaceMetadata?.aiSettingsByAgent?.[agentId])
        .find((settings) => settings != null) ?? workspaceMetadata?.aiSettings;
    const compactSettings = workspaceMetadata?.aiSettingsByAgent?.compact;

    const persistedModel = this.normalizeStartupModel(persistedRetrySendOptions?.model);
    const assistantModel = this.normalizeStartupModel(lastAssistantMessage?.metadata?.model);
    const agentSettingsModel = this.normalizeStartupModel(agentSettings?.model);
    const baseModel = isChildTaskWorkspace
      ? (agentSettingsModel ?? persistedModel ?? assistantModel ?? DEFAULT_MODEL)
      : (persistedModel ?? assistantModel ?? agentSettingsModel ?? DEFAULT_MODEL);

    const persistedThinkingLevel = coerceThinkingLevel(persistedRetrySendOptions?.thinkingLevel);
    const assistantThinkingLevel = coerceThinkingLevel(
      lastAssistantMessage?.metadata?.thinkingLevel
    );
    const agentSettingsThinkingLevel = coerceThinkingLevel(agentSettings?.thinkingLevel);
    const baseThinkingLevel = isChildTaskWorkspace
      ? (agentSettingsThinkingLevel ?? persistedThinkingLevel ?? assistantThinkingLevel)
      : (persistedThinkingLevel ?? assistantThinkingLevel ?? agentSettingsThinkingLevel);

    // Pro reasoning mode threads alongside thinkingLevel from the same sources
    // (assistant message metadata does not carry it), so startup retries do not
    // silently downgrade a pro-mode turn to standard.
    const persistedReasoningMode = coerceOpenAIReasoningMode(
      persistedRetrySendOptions?.reasoningMode
    );
    const agentSettingsReasoningMode = coerceOpenAIReasoningMode(agentSettings?.reasoningMode);
    const baseReasoningMode = isChildTaskWorkspace
      ? (agentSettingsReasoningMode ?? persistedReasoningMode)
      : (persistedReasoningMode ?? agentSettingsReasoningMode);

    const persistedToolPolicy =
      lastUserMessage?.metadata?.toolPolicy ?? persistedRetrySendOptions?.toolPolicy;
    const persistedDisableWorkspaceAgents =
      lastUserMessage?.metadata?.disableWorkspaceAgents ??
      persistedRetrySendOptions?.disableWorkspaceAgents;
    const persistedAdditionalSystemInstructions =
      persistedRetrySendOptions?.additionalSystemInstructions;
    const persistedMaxOutputTokens =
      typeof persistedRetrySendOptions?.maxOutputTokens === "number"
        ? persistedRetrySendOptions.maxOutputTokens
        : undefined;
    const persistedAllowAgentSetGoal = persistedRetrySendOptions?.allowAgentSetGoal;
    const persistedProviderOptions = persistedRetrySendOptions?.providerOptions;
    // History rows load as raw JSON (no schema parse), so the legacy exclusive
    // alias must be applied here: an old snapshot may carry only the exclusive
    // flag, which activates exactly the posture merged PTC now provides.
    const persistedExperiments = aliasLegacyPtcExclusive(persistedRetrySendOptions?.experiments);

    const lastUserMuxMetadata = lastUserMessage?.metadata?.muxMetadata;
    if (isCompactionRequestMetadata(lastUserMuxMetadata)) {
      const compactionModel =
        this.normalizeStartupModel(lastUserMuxMetadata.parsed.model) ?? baseModel;
      const requestedThinkingLevel =
        baseThinkingLevel ?? coerceThinkingLevel(compactSettings?.thinkingLevel) ?? "off";

      const requestedReasoningMode =
        baseReasoningMode ?? coerceOpenAIReasoningMode(compactSettings?.reasoningMode);

      const compactionRequest: StartupRetrySendOptions = {
        model: compactionModel,
        agentId: "compact",
        // No clamp here: the stream setup enforces the thinking policy (with
        // the per-model floor) at request time.
        thinkingLevel: requestedThinkingLevel,
        ...(requestedReasoningMode != null ? { reasoningMode: requestedReasoningMode } : {}),
        maxOutputTokens:
          typeof lastUserMuxMetadata.parsed.maxOutputTokens === "number"
            ? lastUserMuxMetadata.parsed.maxOutputTokens
            : persistedMaxOutputTokens,
        toolPolicy: [{ regex_match: ".*", action: "disable" }],
        allowAgentSetGoal: persistedAllowAgentSetGoal,
        disableWorkspaceAgents: persistedDisableWorkspaceAgents,
        // Carry the original compaction metadata so the resumed stream still
        // identifies as a compaction request. Without it, resolveCompactionRequest
        // aborts its backward scan at any trailing synthetic row (file-change
        // notice, [CONTINUE] sentinel), activeCompactionRequest stays undefined,
        // and the summary is recorded as a plain assistant response instead of
        // collapsing history at a compaction boundary.
        muxMetadata: lastUserMuxMetadata,
      };

      if (persistedAdditionalSystemInstructions !== undefined) {
        compactionRequest.additionalSystemInstructions = persistedAdditionalSystemInstructions;
      }
      if (persistedProviderOptions) {
        compactionRequest.providerOptions = persistedProviderOptions;
      }
      if (persistedExperiments) {
        compactionRequest.experiments = persistedExperiments;
      }
      if (persistedRetrySendOptions?.agentInitiated === true) {
        compactionRequest.agentInitiated = true;
      }
      if (persistedGoalKind != null) {
        compactionRequest.goalKind = persistedGoalKind;
      }
      if (persistedGoalId != null) {
        compactionRequest.goalId = persistedGoalId;
      }

      return compactionRequest;
    }

    const workspaceTurnMuxMetadata =
      lastUserMuxMetadata?.type === "workspace-turn-task"
        ? lastUserMuxMetadata
        : persistedRetrySendOptions?.muxMetadata;

    const retryRequest: StartupRetrySendOptions = {
      model: baseModel,
      agentId: baseAgentId,
    };
    if (workspaceTurnMuxMetadata != null) {
      retryRequest.muxMetadata = workspaceTurnMuxMetadata;
    }
    if (baseThinkingLevel) {
      retryRequest.thinkingLevel = baseThinkingLevel;
    }
    if (baseReasoningMode) {
      retryRequest.reasoningMode = baseReasoningMode;
    }
    if (persistedToolPolicy) {
      retryRequest.toolPolicy = persistedToolPolicy;
    }
    if (persistedAdditionalSystemInstructions !== undefined) {
      retryRequest.additionalSystemInstructions = persistedAdditionalSystemInstructions;
    }
    if (persistedMaxOutputTokens !== undefined) {
      retryRequest.maxOutputTokens = persistedMaxOutputTokens;
    }
    if (persistedProviderOptions) {
      retryRequest.providerOptions = persistedProviderOptions;
    }
    if (persistedExperiments) {
      retryRequest.experiments = persistedExperiments;
    }
    if (persistedGoalKind != null) {
      retryRequest.goalKind = persistedGoalKind;
    }
    if (persistedGoalId != null) {
      retryRequest.goalId = persistedGoalId;
    }
    if (typeof persistedAllowAgentSetGoal === "boolean") {
      retryRequest.allowAgentSetGoal = persistedAllowAgentSetGoal;
    }
    if (typeof persistedDisableWorkspaceAgents === "boolean") {
      retryRequest.disableWorkspaceAgents = persistedDisableWorkspaceAgents;
    }
    // Explicit-agent delegated turns must stay loud across restart recovery: without
    // this, a replay after the agent was removed/disabled would silently run exec.
    // History stores retrySendOptions as an untyped blob, so the persisted value is
    // re-validated against the canonical schema first — a malformed provenance pin
    // must be discarded (lenient replay) rather than failing every recovered attempt
    // with a false mismatch. A valid pin is copied verbatim (keeps expectedScope/
    // expectedSource).
    const persistedStrictAgentResolution =
      SendMessageOptionsSchema.shape.strictAgentResolution.safeParse(
        persistedRetrySendOptions?.strictAgentResolution
      );
    if (
      persistedStrictAgentResolution.success &&
      persistedStrictAgentResolution.data != null &&
      persistedStrictAgentResolution.data !== false
    ) {
      retryRequest.strictAgentResolution = persistedStrictAgentResolution.data;
    }

    if (persistedRetrySendOptions?.agentInitiated === true) {
      retryRequest.agentInitiated = true;
    }

    return retryRequest;
  }

  async getStartupAutoRetryModelHint(): Promise<string | null> {
    this.assertNotDisposed("getStartupAutoRetryModelHint");

    if (this.lastAutoRetryResumeRequest?.options.model) {
      return this.lastAutoRetryResumeRequest.options.model;
    }

    const [partial, historyResult] = await Promise.all([
      this.historyService.readPartial(this.workspaceId),
      this.historyService.getLastMessages(this.workspaceId, 20),
    ]);
    if (!historyResult.success) {
      return null;
    }

    if (partial && this.isPendingAskUserQuestion(partial)) {
      return null;
    }

    const lastHistoryMessage = this.getLastNonSystemHistoryMessage(historyResult.data);
    const interruptedByPartial = partial?.role === "assistant";
    const interruptedByHistory =
      lastHistoryMessage?.role === "user" ||
      (lastHistoryMessage?.role === "assistant" &&
        lastHistoryMessage.metadata?.partial === true &&
        !this.isPendingAskUserQuestion(lastHistoryMessage));

    if (!interruptedByPartial && !interruptedByHistory) {
      return null;
    }

    const retryRequest = await this.deriveStartupAutoRetryRequest({
      partial,
      historyTail: historyResult.data,
    });
    return retryRequest?.model ?? null;
  }

  private async reconcileCompactionCancellation(): Promise<void> {
    const cancellation = await this.compactionCancellation.read();
    if (!cancellation) return;
    const history = await this.historyService.getHistoryFromLatestBoundary(this.workspaceId);
    if (!history.success) throw new Error(history.error);
    // A replacement witness is part of the row's atomic commit. The sidecar can
    // safely retire even if the previous process died before its unlink completed.
    if (
      await this.historyService.hasCompactionReplacementWitness(
        this.workspaceId,
        cancellation.nonce
      )
    )
      await this.retireWitnessedCompactionCancellation(cancellation.nonce);
    else if (history.data.length === 0)
      await this.compactionCancellation.retire(cancellation.nonce);
  }

  private async retireWitnessedCompactionCancellation(nonce: string): Promise<void> {
    try {
      await this.compactionCancellation.retireReplacement(nonce);
    } catch (error) {
      log.warn("Deferred witnessed compaction cancellation cleanup", {
        workspaceId: this.workspaceId,
        error,
      });
    }
  }

  getCompactionCancellationNonce(): Promise<string | undefined> {
    return this.compactionCancellation.readForReplacement().then((record) => record?.nonce);
  }

  private async runStartupRecoveryStep(step: () => unknown): Promise<void> {
    if (this.coordinator.closing) return;
    using _execution = this.coordinator.enterExecution();
    await step();
  }

  private async scheduleStartupAutoRetryIfNeeded(): Promise<StartupRecoveryOutcome> {
    if (this.coordinator.closing) return "completed";
    using _execution = this.coordinator.enterExecution();
    const turn = this.coordinator.turnId;
    const generation = this.retryManager.captureGeneration();
    const isCurrent = () =>
      !this.coordinator.closing && generation() && this.coordinator.isCurrentTurn(turn);
    if (this.coordinator.disposed || this.isBusy() || this.isAiStreaming()) {
      return "deferred";
    }

    const autoRetryEnabled = await this.loadAutoRetryEnabledPreference(isCurrent);
    if (!isCurrent()) return "completed";
    if (!autoRetryEnabled) {
      return "completed";
    }

    const reads = await Promise.allSettled([
      this.historyService.readPartial(this.workspaceId),
      this.historyService.getLastMessages(this.workspaceId, 20),
    ]);
    if (!isCurrent()) return "completed";
    // A rejected read does not cancel its sibling's disk I/O. Join both before releasing
    // this probe's physical lease, and retry only the reads rather than the recovery prefix.
    const [partialRead, historyRead] = reads;
    if (partialRead.status === "rejected" || historyRead.status === "rejected") {
      return "retryable";
    }
    const partial = partialRead.value;
    const historyResult = historyRead.value;

    if (!historyResult.success) {
      log.warn("Failed to inspect history for startup auto-retry", {
        workspaceId: this.workspaceId,
        error: historyResult.error,
      });
      return "retryable";
    }

    if (partial && this.isPendingAskUserQuestion(partial)) {
      return "completed";
    }

    const lastHistoryMessage = this.getLastNonSystemHistoryMessage(historyResult.data);
    const interruptedByPartial = partial?.role === "assistant";
    if (
      !interruptedByPartial &&
      lastHistoryMessage &&
      this.isVisibleCompletedSubagentReportMessage(lastHistoryMessage)
    ) {
      return "completed";
    }
    const interruptedByHistory =
      lastHistoryMessage?.role === "user" ||
      (lastHistoryMessage?.role === "assistant" &&
        lastHistoryMessage.metadata?.partial === true &&
        !this.isPendingAskUserQuestion(lastHistoryMessage));

    if (!interruptedByPartial && !interruptedByHistory) {
      return "completed";
    }

    const startupRetryUserMessage = [...historyResult.data]
      .reverse()
      .find((message): message is MuxMessage & { role: "user" } =>
        this.shouldUseUserMessageForRetry(message)
      );

    if (this.startupAutoRetryAbandon) {
      const abandonReason = this.startupAutoRetryAbandon.reason;
      const abandonMatchesCurrentTail =
        this.startupAutoRetryAbandon.userMessageId === undefined ||
        this.startupAutoRetryAbandon.userMessageId === startupRetryUserMessage?.id;

      if (
        abandonMatchesCurrentTail &&
        (isNonRetryableSendError({ type: abandonReason }) ||
          isNonRetryableStreamError({ type: abandonReason }))
      ) {
        this.emitRetryEvent({ type: "auto-retry-abandoned", reason: abandonReason });
        return "completed";
      }
    }

    if (!this.lastAutoRetryResumeRequest) {
      const retryRequest = await this.deriveStartupAutoRetryRequest({
        partial,
        historyTail: historyResult.data,
      });

      // Derivation reads metadata. A manual successor may have installed its own retry
      // envelope during that await; never overwrite it with this stale disk snapshot.
      if (!isCurrent()) return "completed";
      if (!retryRequest) {
        this.emitRetryEvent({ type: "auto-retry-abandoned", reason: "missing_retry_options" });
        return "completed";
      }

      const { agentInitiated, goalKind, goalId, ...resumeOptions } = retryRequest;
      this.setAutoRetryResumeState(resumeOptions, agentInitiated, goalKind, goalId);
    }

    // Disk reads above may race with user actions; retry once the current work settles
    // instead of permanently suppressing startup auto-retry for this session.
    if (this.coordinator.disposed || this.isBusy() || this.isAiStreaming()) {
      return "deferred";
    }
    if (this.isWorkspaceArchivedOnDisk()) {
      log.debug("Startup auto-retry skipped: workspace is archived", {
        workspaceId: this.workspaceId,
      });
      return "completed";
    }
    await this.handleStreamFailureForAutoRetry(
      {
        type: "unknown",
        message: "startup_interrupted_stream",
      },
      isCurrent
    );
    return "completed";
  }

  private async waitForStartupAutoRetryRerunWindow(retryDelayMs = 0): Promise<void> {
    const delayMs = Math.max(0, Math.trunc(retryDelayMs));
    if (delayMs > 0) {
      const runner = this.streamManager.effectRunner ?? defaultEffectRunner;
      const sleeper = runner.runFork(Effect.sleep(delayMs));
      const cancel = () => sleeper.interruptUnsafe();
      this.closingSignal.addEventListener("abort", cancel, { once: true });
      if (this.closingSignal.aborted) cancel();
      try {
        await runner.runPromise(Fiber.await(sleeper));
      } finally {
        this.closingSignal.removeEventListener("abort", cancel);
      }
    }

    while (!this.coordinator.closing) {
      await this.coordinator.waitForUnbusy(this.closingSignal);
      if (this.coordinator.closing || !this.isAiStreaming()) {
        return;
      }

      await new Promise<void>((resolve) => {
        const maybeResolve = (...args: unknown[]) => {
          const [payload] = args;
          if (
            typeof payload === "object" &&
            payload !== null &&
            "workspaceId" in payload &&
            (payload as { workspaceId: unknown }).workspaceId !== this.workspaceId
          ) {
            return;
          }

          if (this.coordinator.closing || !this.isAiStreaming()) {
            cleanup();
            resolve();
          }
        };

        const close = () => {
          cleanup();
          resolve();
        };
        const cleanup = () => {
          this.closingSignal.removeEventListener("abort", close);
          this.aiService.off("stream-end", maybeResolve);
          this.aiService.off("stream-abort", maybeResolve);
          this.aiService.off("error", maybeResolve);
        };

        this.closingSignal.addEventListener("abort", close, { once: true });
        this.aiService.on("stream-end", maybeResolve);
        this.aiService.on("stream-abort", maybeResolve);
        this.aiService.on("error", maybeResolve);

        // Defensive: stream state may have changed between waitForIdle() and listener setup.
        maybeResolve({ workspaceId: this.workspaceId });
      });
    }
  }

  ensureStartupAutoRetryCheck(): Promise<void> {
    return this.runStartupRecovery();
  }

  runStartupRecovery(): Promise<void> {
    return this.startupRecovery.run();
  }

  shouldRetainAfterStartupRecovery(): boolean {
    if (this.coordinator.closing) return false;
    return (
      this.startupRecovery.pending ||
      this.isBusy() ||
      this.streamManager.isStreaming(this.workspaceId) ||
      this.hasPendingAutoRetry()
    );
  }

  scheduleStartupRecovery(): void {
    this.runStartupRecovery().catch((error: unknown) => {
      log.warn("Failed to schedule startup recovery", {
        workspaceId: this.workspaceId,
        error: getErrorMessage(error),
      });
    });
  }

  private async emitHistoricalEvents(
    listener: (event: AgentSessionChatEvent) => void,
    mode?: OnChatMode,
    beforeReplayCompletion?: () => void
  ): Promise<void> {
    let replayMode: "full" | "since" | "live" = "full";
    let hasOlderHistory: boolean | undefined;
    let serverCursor: OnChatCursor | undefined;
    // Silent since→full downgrades caused full-history re-transfers on nearly every
    // workspace switch-back for months. Keep every downgrade observable: classified
    // reason on the caught-up payload plus a log line with row counts.
    let downgradeReason: OnChatDowngradeReason | undefined;
    let epochRowCount: number | undefined;
    let sentRowCount = 0;
    let emittedReplayMessages = false;

    // Self-healing: persisted rows can fail the current wire schema (older
    // writers, schema drift, corruption). oRPC validates every event yielded to
    // onChat subscribers and a single invalid row terminates the iterator,
    // which would permanently brick workspace fetch. Skip such rows instead of
    // letting one bad line take down the whole transcript.
    const emitReplayMessage = (message: WorkspaceChatMessage): boolean => {
      const validation = ChatMuxMessageSchema.safeParse(message);
      if (!validation.success) {
        const row = message as { id?: string; metadata?: { historySequence?: number } };
        log.warn("onChat replay: skipping persisted row that fails the wire schema", {
          workspaceId: this.workspaceId,
          messageId: row.id,
          historySequence: row.metadata?.historySequence,
          issue: validation.error.issues[0],
        });
        return false;
      }
      emittedReplayMessages = true;
      listener({ workspaceId: this.workspaceId, message });
      return true;
    };

    let replayedTerminalStreamError = false;
    let replayedStreamLifecycle: StreamLifecycleSnapshot | null = null;
    let replayedRuntimeStatus: RuntimeStatusEvent | null = null;
    const emitReplayStatusMessage = (message: WorkspaceChatMessage): void => {
      listener({ workspaceId: this.workspaceId, message });
    };
    const emitCurrentReplayTerminalState = (): void => {
      if (!replayedTerminalStreamError && this.terminalStreamError) {
        replayedTerminalStreamError = true;
        emitReplayStatusMessage({
          ...this.terminalStreamError,
          replay: true,
        });
      }

      const lifecycle = this.getCurrentStreamLifecycleSnapshot();
      if (!this.hasSameStreamLifecycle(replayedStreamLifecycle, lifecycle)) {
        replayedStreamLifecycle = copyStreamLifecycleSnapshot(lifecycle);
        emitReplayStatusMessage({
          type: "stream-lifecycle",
          workspaceId: this.workspaceId,
          ...lifecycle,
        });
      }

      const runtimeStatus = this.preparingRuntimeStatus;
      if (runtimeStatus && !this.hasSameRuntimeStatus(replayedRuntimeStatus, runtimeStatus)) {
        replayedRuntimeStatus = { ...runtimeStatus };
        emitReplayStatusMessage(runtimeStatus);
      }
    };

    const shouldReplayTerminalState = mode?.type !== "live";

    // try/catch/finally guarantees caught-up is always sent, even if replay fails.
    // Without caught-up, the frontend stays in "Loading workspace..." forever.
    try {
      // Reserve the observed engine before history/tokenization awaits or the first
      // lifecycle publication can reenter a manual send. The envelope arrives later.
      const initialStreamInfo = this.streamManager.getStreamInfo(this.workspaceId);
      if (initialStreamInfo) this.coordinator.observeStreamReplay(initialStreamInfo.messageId);
      if (shouldReplayTerminalState) {
        // Rehydrate the current terminal/preparing state immediately so reconnect clients do not
        // regress to transcript heuristics while the rest of replay is still streaming in.
        emitCurrentReplayTerminalState();
      }

      if (mode?.type === "live") {
        replayMode = "live";

        // Live mode still needs stream context when a response is currently active.
        // Replay only stream-start (no historical deltas/tool updates) so clients can
        // attach future live events to the correct message.
        const liveStreamInfo = initialStreamInfo;
        if (liveStreamInfo) {
          const streamLastTimestamp = this.getStreamLastTimestamp(liveStreamInfo);
          await this.streamManager.replayStream(this.workspaceId, {
            afterTimestamp: streamLastTimestamp,
          });

          // Stream can end while replayStream runs; only expose cursor when still active.
          const liveStreamInfoAfterReplay = this.streamManager.getStreamInfo(this.workspaceId);
          if (liveStreamInfoAfterReplay) {
            serverCursor = {
              ...serverCursor,
              stream: {
                messageId: liveStreamInfoAfterReplay.messageId,
                lastTimestamp: this.getStreamLastTimestamp(liveStreamInfoAfterReplay),
              },
            };
          }
        }

        // Re-emit current init state in live mode too. If init finished while the
        // client was disconnected, replaying init-end clears stale "running" UI.
        await this.initStateManager.replayInit(this.workspaceId);

        return;
      }

      // Read partial BEFORE iterating history so we can skip the corresponding
      // placeholder message (which has empty parts). The partial has the real content.
      const streamInfo = initialStreamInfo;
      const partial = await this.historyService.readPartial(this.workspaceId);
      const partialHistorySequence = partial?.metadata?.historySequence;

      // Load chat history from the latest compaction boundary onward (skip=0).
      // Older compaction epochs are fetched on demand through workspace.history.loadMore.
      const historyResult = await this.historyService.getHistoryFromLatestBoundary(
        this.workspaceId,
        0
      );

      let sinceHistorySequence: number | undefined;
      let afterTimestamp: number | undefined;

      if (!historyResult.success && mode?.type === "since") {
        downgradeReason = "history-read-failed";
      }

      if (historyResult.success) {
        const history = historyResult.data;
        epochRowCount = history.length;

        // Cursor-based replay: only use incremental mode when all provided cursor segments are valid.
        const historyCursor = mode?.type === "since" ? mode.cursor.history : undefined;
        const streamCursor = mode?.type === "since" ? mode.cursor.stream : undefined;

        let oldestHistorySequence: number | undefined;
        for (const message of history) {
          const historySequence = message.metadata?.historySequence;
          if (historySequence === undefined) {
            continue;
          }

          if (oldestHistorySequence === undefined || historySequence < oldestHistorySequence) {
            oldestHistorySequence = historySequence;
          }
        }

        if (historyCursor) {
          const matchedHistoryCursor = history.find(
            (message) =>
              message.id === historyCursor.messageId &&
              message.metadata?.historySequence === historyCursor.historySequence
          );

          // Incremental history replay is safe only when we can prove no older
          // rows were truncated while disconnected. Require oldestHistorySequence
          // from the client cursor and match it against current server history.
          const oldestHistoryMatches =
            historyCursor.oldestHistorySequence !== undefined &&
            oldestHistorySequence !== undefined &&
            historyCursor.oldestHistorySequence === oldestHistorySequence;

          const hasRowsBeforeCursor =
            oldestHistorySequence !== undefined &&
            historyCursor.historySequence > oldestHistorySequence;

          // Defensively verify rows below the cursor are unchanged. Without this,
          // deleting or rewriting an older row while disconnected could leave stale
          // client state when since-mode append replay skips those older sequences.
          const priorHistoryFingerprint = computePriorHistoryFingerprint(
            history,
            historyCursor.historySequence
          );
          const priorHistoryMatches =
            !hasRowsBeforeCursor ||
            (historyCursor.priorHistoryFingerprint !== undefined &&
              priorHistoryFingerprint !== undefined &&
              historyCursor.priorHistoryFingerprint === priorHistoryFingerprint);

          if (matchedHistoryCursor && oldestHistoryMatches && priorHistoryMatches) {
            sinceHistorySequence = historyCursor.historySequence;
          } else {
            // Classify by the first failing predicate so downgrades are diagnosable.
            downgradeReason = !matchedHistoryCursor
              ? "cursor-row-missing"
              : !oldestHistoryMatches
                ? "oldest-mismatch"
                : "fingerprint-mismatch";
          }
        }

        if (streamCursor && streamInfo && streamCursor.messageId === streamInfo.messageId) {
          // Stream cursor is advisory: only apply it when the same stream is still active.
          // If the stream ended or rotated while offline, keep since-mode history replay
          // and skip stream filtering by leaving afterTimestamp undefined.
          const streamLastTimestamp = this.getStreamLastTimestamp(streamInfo);

          // Reconnect cursors can be ahead of server stream timestamps (e.g. replay events
          // stamped on the client clock). Clamp to server state so we never skip unseen
          // buffered deltas/tool completions on the next reconnect.
          afterTimestamp = Math.min(streamCursor.lastTimestamp, streamLastTimestamp);
        }

        // Since replay safety is anchored by a valid persisted-history cursor.
        // Stream cursor mismatches must not force a full replay when history is continuous.
        const canReplaySince = mode?.type === "since" && sinceHistorySequence !== undefined;

        if (canReplaySince) {
          replayMode = "since";
        } else {
          sinceHistorySequence = undefined;
          afterTimestamp = undefined;
        }

        if (replayMode === "full") {
          if (oldestHistorySequence === undefined) {
            // Empty full replay means there is no older page to request.
            hasOlderHistory = false;
          } else {
            hasOlderHistory = await this.historyService.hasHistoryBeforeSequence(
              this.workspaceId,
              oldestHistorySequence
            );
          }
        }

        for (const message of history) {
          // Skip the placeholder message if we have a partial with the same historySequence.
          // The placeholder has empty parts; the partial has the actual content.
          // Without this, both get loaded and the empty placeholder may be shown as "last message".
          if (
            partialHistorySequence !== undefined &&
            message.metadata?.historySequence === partialHistorySequence
          ) {
            continue;
          }

          // Incremental replay skips strictly older persisted messages.
          // We intentionally keep the cursor-boundary sequence (==) so reconnects can
          // replace an in-flight placeholder with the finalized turn when the stream
          // completed while the client was offline.
          if (sinceHistorySequence !== undefined) {
            const messageHistorySequence = message.metadata?.historySequence;
            if (
              messageHistorySequence !== undefined &&
              messageHistorySequence < sinceHistorySequence
            ) {
              continue;
            }
          }

          // Add type: "message" for discriminated union (messages from chat.jsonl don't have it)
          if (emitReplayMessage({ ...message, type: "message" })) {
            sentRowCount += 1;
          }
        }

        for (let index = history.length - 1; index >= 0; index -= 1) {
          const message = history[index];
          const historySequence = message.metadata?.historySequence;
          if (historySequence === undefined) {
            continue;
          }

          const priorHistoryFingerprint = computePriorHistoryFingerprint(history, historySequence);

          serverCursor = {
            ...serverCursor,
            history: {
              messageId: message.id,
              historySequence,
              ...(oldestHistorySequence !== undefined ? { oldestHistorySequence } : {}),
              ...(priorHistoryFingerprint !== undefined ? { priorHistoryFingerprint } : {}),
            },
          };
          break;
        }
      }

      const attemptedStreamReplay = streamInfo !== undefined;
      if (streamInfo) {
        await this.streamManager.replayStream(this.workspaceId, { afterTimestamp });
      }

      // Re-read stream state after replay. The stream can end while we are
      // replaying history, and caught-up cursor metadata must reflect that
      // latest backend state to avoid phantom active streams in the client.
      const streamInfoAfterReplay = this.streamManager.getStreamInfo(this.workspaceId);
      if (streamInfoAfterReplay) {
        serverCursor = {
          ...serverCursor,
          stream: {
            messageId: streamInfoAfterReplay.messageId,
            lastTimestamp: this.getStreamLastTimestamp(streamInfoAfterReplay),
          },
        };
      } else if (!attemptedStreamReplay && partial) {
        // Only emit disk partial when we did not replay an active stream.
        // If a stream was replayed and then ended, this stale pre-replay partial can
        // duplicate text/tool output when combined with replayed stream events.
        emitReplayMessage({ ...partial, type: "message" });
      }

      // Re-emit current init state for all replay modes. Incremental reconnects can
      // otherwise miss init-end while disconnected and remain stuck in running state.
      await this.initStateManager.replayInit(this.workspaceId);
    } catch (error) {
      log.error("Failed to replay history for workspace", {
        workspaceId: this.workspaceId,
        error,
      });

      // Keep append/live semantics when we've already emitted incremental payload.
      // Downgrading to full at that point would make the frontend apply replace-mode to
      // a partial replay buffer and temporarily hide older transcript rows.
      if (
        replayMode !== "full" &&
        !emittedReplayMessages &&
        !this.replayPublication.getStore()?.emittedStreamEvents
      ) {
        replayMode = "full";
      }
      if (mode?.type === "since" && replayMode === "full") {
        downgradeReason ??= "history-read-failed";
      }

      // Replay failed, so do not advertise a trustworthy reconnect cursor.
      serverCursor = undefined;
    } finally {
      // Flush overlapping live events before authoritative final snapshots, including on replay failure.
      beforeReplayCompletion?.();
      if (shouldReplayTerminalState) {
        // Replay the latest terminal/preparing state one last time before caught-up in case the
        // stream changed while history was replaying (for example PREPARING -> failed/idle).
        emitCurrentReplayTerminalState();
      }

      // Replay queued-message snapshot before caught-up so reconnect clients can
      // rebuild queue UI state even when history replay errored mid-flight.
      listener({
        workspaceId: this.workspaceId,
        message: {
          type: "queued-message-changed",
          workspaceId: this.workspaceId,
          hasQueuedMessages: !this.messageQueue.isEmpty(),
          queuedMessages: this.messageQueue.getVisibleMessages(),
          displayText: this.messageQueue.getVisibleDisplayText(),
          fileParts: this.messageQueue.getVisibleFileParts(),
          reviews: this.messageQueue.getVisibleReviews(),
          queueDispatchMode: this.messageQueue.getVisibleQueueDispatchMode(),
          hasCompactionRequest: this.messageQueue.hasVisibleCompactionRequest(),
        },
      });

      // Rehydrate pending auto-retry countdown state on reconnect/reload so
      // RetryBarrier keeps showing "Stop" while a backend timer is already armed.
      const pendingRetrySnapshot = this.retryManager.getScheduledStatusSnapshot();
      if (pendingRetrySnapshot) {
        listener({
          workspaceId: this.workspaceId,
          message: pendingRetrySnapshot,
        });
      }

      // Surface since→full downgrades (and replay shape in general) in logs. Row counts
      // only — no JSON.stringify byte accounting on this hot path.
      const wasDowngraded = mode?.type === "since" && replayMode === "full";
      log.debug("onChat replay", {
        workspaceId: this.workspaceId,
        requestedMode: mode?.type ?? "full",
        replayMode,
        ...(wasDowngraded && downgradeReason !== undefined ? { downgradeReason } : {}),
        epochRowCount,
        sentRowCount,
      });

      // Send caught-up after ALL historical data (including init events)
      // This signals frontend that replay is complete and future events are real-time
      listener({
        workspaceId: this.workspaceId,
        message: {
          type: "caught-up",
          replay: replayMode,
          ...(wasDowngraded && downgradeReason !== undefined ? { downgradeReason } : {}),
          ...(hasOlderHistory !== undefined ? { hasOlderHistory } : {}),
          cursor: serverCursor,
        },
      });
    }
  }

  async ensureMetadata(args: {
    workspacePath: string;
    projectName?: string;
    runtimeConfig?: RuntimeConfig;
  }): Promise<void> {
    this.assertNotDisposed("ensureMetadata");
    assert(args, "ensureMetadata requires arguments");
    const { workspacePath, projectName, runtimeConfig } = args;

    assert(typeof workspacePath === "string", "workspacePath must be a string");
    const trimmedWorkspacePath = workspacePath.trim();
    assert(trimmedWorkspacePath.length > 0, "workspacePath must not be empty");

    const normalizedWorkspacePath = path.resolve(trimmedWorkspacePath);
    const existing = await this.aiService.getWorkspaceMetadata(this.workspaceId);

    if (existing.success) {
      // Metadata already exists; use the persisted config entry as the source of truth instead of
      // reconstructing a canonical path, because upgraded SSH workspaces may still live under a
      // legacy remote layout until an operation explicitly seeds that layout back into the runtime.
      const workspace = this.config.findWorkspace(this.workspaceId);
      assert(workspace, `Workspace ${this.workspaceId} is missing its persisted config entry`);
      const expectedPath = path.resolve(workspace.workspacePath);
      assert(
        expectedPath === normalizedWorkspacePath,
        `Existing metadata workspace path mismatch for ${this.workspaceId}: expected ${expectedPath}, got ${normalizedWorkspacePath}`
      );
      return;
    }

    // Detect in-place workspace: if workspacePath is not under srcBaseDir,
    // it's a direct workspace (e.g., for CLI/benchmarks) rather than a worktree
    const srcBaseDir = this.config.srcDir;
    const normalizedSrcBaseDir = path.resolve(srcBaseDir);
    const isUnderSrcBaseDir = normalizedWorkspacePath.startsWith(normalizedSrcBaseDir + path.sep);

    let derivedProjectPath: string;
    let workspaceName: string;
    let derivedProjectName: string;

    if (isUnderSrcBaseDir) {
      // Standard worktree mode: workspace is under ~/.xum/src/project/branch
      derivedProjectPath = path.dirname(normalizedWorkspacePath);
      workspaceName = PlatformPaths.basename(normalizedWorkspacePath);
      derivedProjectName =
        projectName && projectName.trim().length > 0
          ? projectName.trim()
          : PlatformPaths.basename(derivedProjectPath) || "unknown";
    } else {
      // In-place mode: workspace is a standalone directory
      // Store the workspace path directly by setting projectPath === name
      derivedProjectPath = normalizedWorkspacePath;
      workspaceName = normalizedWorkspacePath;
      derivedProjectName =
        projectName && projectName.trim().length > 0
          ? projectName.trim()
          : PlatformPaths.basename(normalizedWorkspacePath) || "unknown";
    }

    const metadata: FrontendWorkspaceMetadata = {
      id: this.workspaceId,
      name: workspaceName,
      projectName: derivedProjectName,
      projectPath: derivedProjectPath,
      namedWorkspacePath: normalizedWorkspacePath,
      runtimeConfig: runtimeConfig ?? DEFAULT_RUNTIME_CONFIG,
    };

    // Write metadata directly to config.json (single source of truth)
    await this.config.addWorkspace(derivedProjectPath, metadata);
    // This registration path bypasses WorkspaceService.create/fork and the
    // task-materialization flows, so it must run the same pre-announcement
    // Agent Plugin override sanitization: a preserved checkout can carry a
    // stale canonical `plugin:` enable from a since-removed workspace, which
    // would start a same-name reinstall's default-disabled server on the
    // first CLI send. The callback rolls back the config write on failure.
    const sanitizeError = await this.sanitizeCliWorkspaceRegistration?.({
      workspaceId: this.workspaceId,
      workspacePath: normalizedWorkspacePath,
      runtimeConfig: metadata.runtimeConfig,
    });
    if (sanitizeError !== undefined) {
      throw new Error(`Failed to register workspace: ${sanitizeError}`);
    }
    this.emitMetadata(metadata);
  }

  async sendMessage(
    message: string,
    options?: SendMessageOptions & { fileParts?: FilePart[] },
    internal?: SendMessageInternalOptions
  ): Promise<AgentSessionResult<void>> {
    this.assertNotDisposed("sendMessage");
    if (this.coordinator.closing)
      return Err(createUnknownSendMessageError(SESSION_SHUTDOWN_SEND_BLOCKED_MESSAGE));
    if (internal?.preparation)
      return this.prepareMessage(message, options, internal, internal.preparation);
    const attempt: PreparationAttempt = {
      owner: internal?.turnReservation,
      expectedTurn: this.coordinator.turnId,
      outcome: "preparing",
      durability: "rollback-eligible",
      queued: internal?.turnReservation != null,
      failureNotified: false,
      onFailure: internal?.onAcceptedPreStreamFailure,
    };
    return this.completePreparation(attempt, () =>
      this.prepareMessage(message, options, internal, attempt)
    );
  }

  /** Correlated callbacks settle before publishing idle; teardown joins this whole physical lease. */
  private async completePreparation<T>(
    attempt: PreparationAttempt,
    run: () => Promise<AgentSessionResult<T>>
  ): Promise<AgentSessionResult<T>> {
    using _execution = this.coordinator.enterExecution();
    try {
      const result = await run();
      if (!result.success) await this.settlePreparationFailure(attempt, result.error);
      else if (attempt.outcome === "preparing" && attempt.durability === "accepted") {
        await this.settlePreparationFailure(
          attempt,
          createUnknownSendMessageError("Accepted stream startup was canceled before streaming.")
        );
      }
      return result;
    } catch (error) {
      await this.settlePreparationFailure(
        attempt,
        createUnknownSendMessageError(getErrorMessage(error))
      );
      throw error;
    } finally {
      try {
        if (attempt.outcome !== "background" && attempt.owner != null)
          this.coordinator.finishPreparation(attempt.owner);
      } finally {
        // Failed admission may be idle. The resource follows a background transfer and
        // releases only after correlated cleanup or a valid handoff to terminal policy.
        this.releasePreparationEdit(attempt);
        if (
          attempt.outcome !== "background" &&
          attempt.outcome !== "delivered" &&
          attempt.owner != null &&
          this.coordinator.isCurrentTurn(attempt.owner)
        )
          this.drainQueuedMessagesIfIdle();
      }
    }
  }

  private releasePreparationEdit(attempt: PreparationAttempt): void {
    const reservation = attempt.editReservation;
    attempt.editReservation = undefined;
    reservation?.[Symbol.dispose]();
  }

  private async settlePreparationFailure(
    attempt: PreparationAttempt,
    error: SendMessageError
  ): Promise<void> {
    if (attempt.failureNotified || (!attempt.queued && attempt.durability !== "accepted")) return;
    attempt.failure ??= error;
    while ((attempt.failureAttempts ?? 0) < 2) {
      attempt.failureAttempts = (attempt.failureAttempts ?? 0) + 1;
      try {
        await attempt.onFailure?.(attempt.failure);
        attempt.failureNotified = true;
        return;
      } catch (callbackError) {
        // Retry cleanup without rerunning persistence or terminal policy. Even persistent
        // callback failure must not replace the original error or suppress its retry decision.
        if (attempt.failureAttempts === 2)
          log.error("Preparation failure callback failed", {
            workspaceId: this.workspaceId,
            error: getErrorMessage(callbackError),
          });
      }
    }
  }

  private async prepareMessage(
    message: string,
    options: (SendMessageOptions & { fileParts?: FilePart[] }) | undefined,
    internal: SendMessageInternalOptions | undefined,
    attempt: PreparationAttempt
  ): Promise<AgentSessionResult<void>> {
    assert(typeof message === "string", "sendMessage requires a string message");

    const isManualUserMessage = internal?.synthetic !== true;

    // Single admission-staleness predicate for all three turn-admission gates below.
    const isAdmissionStale = () =>
      compactionAppendSkipped ||
      internal?.admissionEpochStale?.() === true ||
      internal?.admissionStale?.() === true ||
      !this.coordinator.isCurrentTurn(attempt.owner ?? attempt.expectedTurn) ||
      this.coordinator.editBlocked(attempt.editReservation?.id);

    const cancelSignal = internal?.cancelSignal;
    const persistedCancelableMessageIds: string[] = [];
    let compactionAppendSkipped = false;
    const compactionAppendCondition = internal?.compactionHandoff
      ? {
          summary: internal.compactionHandoffSource?.summary,
          allowedTailMessageIds: persistedCancelableMessageIds,
          isCurrent: () =>
            !isAdmissionStale() && !this.coordinator.closing && cancelSignal?.aborted !== true,
          onSkipped: () => {
            compactionAppendSkipped = true;
            internal.compactionHandoffSource?.onSkipped();
          },
        }
      : undefined;
    // Roll back synthetic snapshots if the invoking user row fails to persist, or
    // later provider requests could consume orphaned context.
    /**
     * Returns whether the rows are verifiably gone. deleteMessages can fail AFTER its atomic
     * rewrite committed, so a reported failure re-reads the durable history before concluding —
     * callers that couple side effects to the rollback (peer budget refunds) must only act when
     * deletion actually committed, or a "canceled" payload would stay durable while no longer
     * counting against the sender's budget.
     */
    const rollbackPersistedTurnRows = async (): Promise<boolean> => {
      if (persistedCancelableMessageIds.length === 0) return true;
      const handoff = internal?.compactionHandoff;
      const ownsCleanup = handoff != null && this.coordinator.canClearCompactionFollowUp(handoff);
      // Stop retains this handoff's summary cleanup even while its user-row append
      // unwinds. A replaced handoff may delete its own rows, but cannot retire its successor.
      if (handoff == null || ownsCleanup || this.coordinator.isCurrentCompaction(handoff)) {
        this.coordinator.invalidateCompaction(
          this.coordinator.compactionIntent.status === "abandoned"
        );
        this.continuousCompactor.reset("delete-messages");
      }
      const rollbackResult = await this.historyService.deleteMessages(
        this.workspaceId,
        persistedCancelableMessageIds
      );
      if (rollbackResult.success) return true;
      log.error("Failed to roll back partially persisted turn rows", {
        workspaceId: this.workspaceId,
        error: rollbackResult.error,
      });
      const historyResult = await this.historyService.getHistoryFromLatestBoundary(
        this.workspaceId
      );
      return (
        historyResult.success &&
        persistedCancelableMessageIds.every(
          (messageId) => !historyResult.data.some((message) => message.id === messageId)
        )
      );
    };
    const refuseSkippedCompactionAppend = async (): Promise<AgentSessionResult<void>> => {
      // Snapshot leftovers are not acceptance of a user/request row that never
      // committed. Preserve the cleanup failure without publishing a durable receipt.
      if (!(await rollbackPersistedTurnRows()))
        throw new Error(
          "Failed to roll back preparation rows after compaction follow-up became stale"
        );
      return Err(
        createUnknownSendMessageError("Compaction follow-up source became stale before append")
      );
    };
    const markRowsDurable = (): void => {
      if (attempt.durability !== "rollback-eligible") return;
      attempt.durability = "durable";
      internal?.onRowsDurable?.();
      if ((internal?.preTurnMessages?.length ?? 0) > 0) internal?.onPreTurnRowsPersisted?.();
    };
    const accept = async (): Promise<void> => {
      await internal?.onAccepted?.();
      attempt.durability = "accepted";
    };
    // Capture known admission refusal where it occurs; later token changes cannot
    // turn a genuine goal/provider failure into a successful historical handoff.
    const refuseAdmission = (error: SendMessageError): AgentSessionResult<void> => ({
      success: false,
      error,
      ...(attempt.durability !== "rollback-eligible" ? { superseded: true as const } : {}),
    });
    const refuseBeforeAcceptance = async (
      error: SendMessageError
    ): Promise<AgentSessionResult<void>> => {
      if (attempt.durability === "rollback-eligible" && !(await rollbackPersistedTurnRows()))
        markRowsDurable();
      return refuseAdmission(error);
    };
    const refuseContextMutation = (): Promise<AgentSessionResult<void>> => {
      // Only an intact, pre-persistence handoff can wait and retry. Capture the
      // refusal here; later state or error text cannot reclassify real failures.
      if (
        this.coordinator.admissionBlocked &&
        !isAdmissionStale() &&
        internal?.compactionHandoff != null &&
        this.coordinator.isCurrentCompaction(internal.compactionHandoff) &&
        attempt.durability === "rollback-eligible" &&
        persistedCancelableMessageIds.length === 0
      )
        return Promise.resolve({
          success: false,
          error: createUnknownSendMessageError(CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE),
          admissionDeferred: true,
        });
      return refuseBeforeAcceptance(
        createUnknownSendMessageError(CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE)
      );
    };
    let cancellationHandled = false;
    let cancellationDisabled = false;
    const cancelBeforeAcceptance = async (): Promise<boolean> => {
      if (cancelSignal?.aborted !== true || cancellationDisabled) return false;
      if (cancellationHandled) return true;

      // Delete only this attempt's rows; concurrent non-session history writers survive.
      if (!(await rollbackPersistedTurnRows())) {
        // The wake remains provider-visible, so cancellation must not refund or supersede it.
        cancellationDisabled = true;
        return false;
      }

      cancellationHandled = true;
      attempt.outcome = "canceled";
      await internal?.onCanceled?.(cancelReasonBeforeAcceptance(cancelSignal));
      if (internal?.cancelState != null) {
        internal.cancelState.canceledBeforeAcceptance = true;
      }
      return true;
    };

    if (await cancelBeforeAcceptance()) {
      return Ok(undefined);
    }

    // Last-line-of-defence pricing gate: every dispatch path (initial sends,
    // sendQueuedMessages, dispatchPendingFollowUp,
    // post-compaction follow-ups) lands here, so a budgeted goal that became
    // resumable while a queued unpriced-model message waited cannot bypass
    // enforcement. The WorkspaceService-level gate already runs first for
    // initial calls (and prevents persisting bad AI settings), but it cannot
    // catch goal-state changes that happen between queueing and dispatch.
    //
    // When rejecting a manual (user-typed) send, we MUST persist the user's
    // message and surface a stream-error chat event before returning. The
    // queue-dispatch flow in `sendQueuedMessages()` removes the message from
    // the queue before calling us, so a silent `Err` here would drop the
    // user's input without any visible feedback (Codex P1
    // PRRT_kwDOPxxmWM5_s-jo). For synthetic sends (compaction, goal
    // continuation, etc.) the user did not type the message, so we just
    // return Err and let the synthetic caller log/handle it.
    if (this.workspaceGoalService) {
      const pricingGate = await this.workspaceGoalService.assertPricedModelForBudgetedGoal(
        this.workspaceId,
        options?.model
      );
      if (await cancelBeforeAcceptance()) {
        return Ok(undefined);
      }
      if (isAdmissionStale())
        return refuseBeforeAcceptance(
          createUnknownSendMessageError(CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE)
        );
      if (!pricingGate.success) {
        if (isManualUserMessage) {
          const persisted = await this.preserveRejectedManualSend(
            message,
            options,
            pricingGate.error,
            internal?.enqueuedAtMs
          );
          // The user has explicitly intervened, so the goal-safety contract
          // for manual sends must still apply on the rejection path: clear any
          // pending acknowledgment gate AND auto-pause an active goal so a
          // pending post-stream-end continuation does not fire as if the user
          // had not interrupted (Codex P1 PRRT_kwDOPxxmWM5_tOFt). Only run the
          // hook when an actionable manual turn was actually present — empty
          // payloads (Codex P2 PRRT_kwDOPxxmWM5_tUsx) would otherwise silently
          // disable goal continuation after a blank submit / invalid payload.
          if (persisted) {
            await this.applyManualUserMessageGoalSafety({
              policy: "pause",
              enqueuedAtMs: internal?.enqueuedAtMs,
            });
          }
        }
        return Err(pricingGate.error);
      }
    }

    const goalKind =
      internal?.goalKind ??
      (internal?.goalContinuation === true ? GOAL_CONTINUATION_KIND : undefined);

    const trimmedMessage = message.trim();
    const fileParts = options?.fileParts;
    const editMessageId = options?.editMessageId;

    const manualGoalInterventionPolicy: GoalInterventionPolicy | undefined = isManualUserMessage
      ? (options?.goalInterventionPolicy ?? "pause")
      : undefined;

    // Edits are implemented as truncate+replace. If the frontend omits fileParts,
    // preserve the original message's attachments.
    // Only search the current compaction epoch — edits of pre-boundary messages are
    // blocked (the frontend only shows post-boundary messages).
    let preservedEditFileParts: MuxFilePart[] | undefined;
    if (editMessageId && fileParts === undefined) {
      const historyResult = await this.historyService.getHistoryFromLatestBoundary(
        this.workspaceId
      );
      if (historyResult.success) {
        const targetMessage: MuxMessage | undefined = historyResult.data.find(
          (msg) => msg.id === editMessageId
        );
        const fileParts = targetMessage?.parts.filter(
          (part): part is MuxFilePart => part.type === "file"
        );
        if (fileParts && fileParts.length > 0) {
          preservedEditFileParts = fileParts;
        }
      }
    }

    const hasFiles = (fileParts?.length ?? 0) > 0 || (preservedEditFileParts?.length ?? 0) > 0;

    if (trimmedMessage.length === 0 && !hasFiles) {
      return Err(
        createUnknownSendMessageError(
          "Empty message not allowed. Use interruptStream() to interrupt active streams."
        )
      );
    }

    // Validate model and attachment compatibility before any edit path mutates history.
    // User rationale: an edit send used to truncate first, then fail validation and leave
    // the existing chat visibly cut off at the edit target.
    if (!options?.model || options.model.trim().length === 0) {
      return Err(
        createUnknownSendMessageError("No model specified. Please select a model using /model.")
      );
    }

    options = this.normalizeGatewaySendOptions(options);

    // Validate model string format (must be "provider:model-id")
    if (!isValidModelFormat(options.model)) {
      return Err({
        type: "invalid_model_string",
        message: `Invalid model string format: "${options.model}". Expected "provider:model-id"`,
      });
    }

    const effectiveFileParts =
      preservedEditFileParts && preservedEditFileParts.length > 0
        ? preservedEditFileParts.map((part) => ({
            url: part.url,
            mediaType: part.mediaType,
            filename: part.filename,
          }))
        : fileParts;

    // Defense-in-depth: reject PDFs for models we know don't support them.
    // (Frontend should also block this, but it's easy to bypass via IPC / older clients.)
    if (effectiveFileParts && effectiveFileParts.length > 0) {
      const pdfParts = effectiveFileParts.filter(
        (part) => normalizeMediaType(part.mediaType) === PDF_MEDIA_TYPE
      );

      if (pdfParts.length > 0) {
        const caps = getModelCapabilitiesResolved(
          options.model,
          this.aiService.getProvidersConfig()
        );

        if (caps && !caps.supportsPdfInput) {
          return Err(
            createUnknownSendMessageError(`Model ${options.model} does not support PDF input.`)
          );
        }

        if (caps?.maxPdfSizeMb !== undefined) {
          const maxBytes = caps.maxPdfSizeMb * 1024 * 1024;
          for (const part of pdfParts) {
            const bytes = estimateBase64DataUrlBytes(part.url);
            if (bytes !== null && bytes > maxBytes) {
              const actualMb = (bytes / (1024 * 1024)).toFixed(1);
              const label = part.filename ?? "PDF";
              return Err(
                createUnknownSendMessageError(
                  `${label} is ${actualMb}MB, but ${options.model} allows up to ${caps.maxPdfSizeMb}MB per PDF.`
                )
              );
            }
          }
        }
      }
    }

    // Validate the actual payload before truncate+replace, including non-PDF attachment shape.
    const additionalParts =
      preservedEditFileParts && preservedEditFileParts.length > 0
        ? preservedEditFileParts
        : fileParts && fileParts.length > 0
          ? fileParts.map((part, index) => {
              assert(
                typeof part.url === "string",
                `file part [${index}] must include url string content (got ${typeof part.url}): ${JSON.stringify(part).slice(0, 200)}`
              );
              assert(
                part.url.startsWith("data:"),
                `file part [${index}] url must be a data URL (got: ${part.url.slice(0, 50)}...)`
              );
              assert(
                typeof part.mediaType === "string" && part.mediaType.trim().length > 0,
                `file part [${index}] must include a mediaType (got ${typeof part.mediaType}): ${JSON.stringify(part).slice(0, 200)}`
              );
              if (part.filename !== undefined) {
                assert(
                  typeof part.filename === "string",
                  `file part [${index}] filename must be a string if present (got ${typeof part.filename}): ${JSON.stringify(part).slice(0, 200)}`
                );
              }
              return {
                type: "file" as const,
                url: part.url,
                mediaType: part.mediaType,
                filename: part.filename,
              };
            })
          : undefined;

    // A fork starts its abandoned-branch summary in the background so the fork
    // itself returns fast; the first send must then await that pending row so
    // it keeps its position BEFORE this turn's user message and request build
    // (the "summary lands before the next request" contract). Bounded by the
    // generation deadline; resolves immediately when nothing is pending.
    const pendingBranchSummary = await awaitPendingBranchSummary(
      this.workspaceId,
      // Session dir enables the cross-process pending-marker wait (r48): a
      // fork registered in another backend has no entry in this process.
      path.join(this.config.sessionsDir, this.workspaceId)
    );
    // Workspace removal disposes the session and cancels the summary writer
    // while this send is parked on the await above; every append between here
    // and the late pre-stream disposed check would recreate the session
    // directory removal is about to delete. Bail exactly like that check
    // (nothing durable has been persisted for this turn yet, so a plain Ok is
    // safe — no monitor wake can be past its point of no return here).
    if (this.coordinator.disposed) {
      return Ok(undefined);
    }
    if (pendingBranchSummary) {
      // The renderer loaded history before the background row landed; surface
      // it without requiring a reload.
      this.emitChatEvent({ ...pendingBranchSummary, type: "message" });
    }

    // The shared completion owns the edit reservation: a reentrant PREPARING observer
    // may retire admission back to idle, but queued work must still wait for failure cleanup.
    if (editMessageId) {
      if (this.coordinator.editBlocked())
        return refuseBeforeAcceptance(
          createUnknownSendMessageError(CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE)
        );
      this.coordinator.invalidateCompaction();
      this.continuousCompactor.reset("edit");
      // Ensure no in-flight completion code can append after we truncate.
      if (this.isBusy()) {
        let preemptedPreparing = false;

        // If a turn is still PREPARING/STREAMING, interrupt aggressively — history is about to be
        // truncated.
        //
        // If we're already COMPLETING, do NOT call stopStream(): StreamManager will emit a
        // synthetic stream-abort when no stream is active, which can incorrectly transition us to
        // IDLE while completion cleanup is still in-flight.
        if (this.coordinator.phase !== "completing") {
          // MUST use abandonPartial=true to prevent handleAbort from performing partial compaction
          // with mismatched history (since we're about to truncate it).
          const stopResult = await this.interruptStream({ abandonPartial: true });
          if (!stopResult.success) {
            log.warn("Failed to interrupt stream before edit", {
              workspaceId: this.workspaceId,
              editMessageId,
              error: stopResult.error,
            });
            return Err(createUnknownSendMessageError(stopResult.error));
          }
        }

        // Editing owns history before its replacement reaches PREPARING. The coordinator
        // invalidates startup synchronously so late completion cannot write across truncation.
        preemptedPreparing = this.coordinator.preemptPreparation();

        // Tell stream-end to skip sendQueuedMessages() so the edit truncates first.
        this.deferQueuedFlushUntilAfterEdit = true;
        try {
          if (!preemptedPreparing) {
            await this.waitForIdle();
          }

          // Workspace teardown does not await in-flight async work; bail out if the session was
          // disposed while waiting for completion cleanup.
          if (this.coordinator.disposed) {
            return Ok(undefined);
          }
        } finally {
          this.deferQueuedFlushUntilAfterEdit = false;
        }
      }

      // r40: same admission gate as the acceptance path below — the edit is
      // about to truncate and rewrite history while a context-discarding
      // mutation may sit between its busy check and its mutation. Checked in
      // the same synchronous block that arms the edit reservation (which
      // claims busy-ness), so whichever side runs first is observed by the
      // other. The epoch probe (r41) also refuses edits whose target rows a
      // completed mutation already discarded.
      if (this.coordinator.admissionBlocked || isAdmissionStale()) {
        return refuseContextMutation();
      }
      if (this.coordinator.closing) {
        return refuseBeforeAcceptance(
          createUnknownSendMessageError(SESSION_SHUTDOWN_SEND_BLOCKED_MESSAGE)
        );
      }

      // Idle (or preempted to idle) now: hold busy-ness from here until the
      // turn phase takes over, so concurrent sends queue instead of racing the
      // truncate + summary + append sequence below.
      attempt.expectedTurn = this.coordinator.turnId;
      attempt.editReservation ??= this.coordinator.reserve("edit");

      // The edit is about to truncate and rewrite history. Any queued content from
      // the previous turn was written in the old context — return it to the input
      // so the user can re-evaluate, and start the edit stream with an empty queue.
      this.restoreQueueToInput();

      // Find the truncation target: the edited message or any immediately-preceding snapshots.
      // (snapshots are persisted immediately before their corresponding user message)
      // Pre-boundary edits are user-confirmed by the composer, so fall back to full-history lookup
      // when the edit target is outside the active context window.
      const truncateTargetId = await this.getEditTruncateTargetId(editMessageId);

      this.clearUsageState();
      const truncateResult = await this.historyService.truncateAfterMessage(
        this.workspaceId,
        truncateTargetId
      );
      if (!truncateResult.success) {
        const isMissingEditTarget =
          truncateResult.error.includes("Message with ID") &&
          truncateResult.error.includes("not found in history");
        if (isMissingEditTarget) {
          // This can happen if the frontend is briefly out-of-sync with persisted history
          // (e.g., compaction/truncation completed and removed the message while the UI still
          // shows it as editable). Treat as a no-op truncation so the user can recover.
          log.warn("editMessageId not found in history; proceeding without truncation", {
            workspaceId: this.workspaceId,
            editMessageId,
            error: truncateResult.error,
          });
        } else {
          return Err(createUnknownSendMessageError(truncateResult.error));
        }
      } else {
        // RLM mode: summarize the truncated tail into a durable labeled row
        // BEFORE the edited user message is appended and this turn's request is
        // built (log purity by construction). Best-effort with a hard deadline —
        // never blocks or fails the edit beyond that bound. Registered (r57
        // P1): workspace removal racing this await must find a cancellation
        // handle in clearPendingBranchSummary, or the writer's late append
        // could recreate the just-deleted session directory.
        const branchSummaryMessage = await runInlineAbandonedBranchSummary({
          historyService: this.historyService,
          aiService: this.aiService,
          workspaceId: this.workspaceId,
          abandonedMessages: truncateResult.data.removedMessages,
          experiments: options?.experiments,
          isExperimentEnabled:
            typeof this.aiService.isExperimentEnabled === "function"
              ? (experimentId) => this.aiService.isExperimentEnabled(experimentId)
              : undefined,
          // Side-channel spend must reach session usage / the cost UI.
          ...(this.sessionUsageService ? { sessionUsageService: this.sessionUsageService } : {}),
        });
        if (branchSummaryMessage) {
          // The renderer just truncated its visible chat; surface the durable
          // summary row without requiring a history reload.
          this.emitChatEvent({ ...branchSummaryMessage, type: "message" });
        }
      }
    }

    const messageId = createUserMessageId();

    // toolPolicy is properly typed via Zod schema inference
    const typedToolPolicy = options?.toolPolicy;
    // muxMetadata is z.any() in schema - cast to proper type
    const typedMuxMetadata = options?.muxMetadata as MuxMessageMetadata | undefined;
    const acpPromptId =
      normalizeAcpPromptId(options?.acpPromptId) ?? extractAcpPromptId(typedMuxMetadata);
    const delegatedToolNames =
      normalizeDelegatedToolNames(options?.delegatedToolNames) ??
      extractAcpDelegatedTools(typedMuxMetadata);
    const isCompactionRequest = isCompactionRequestMetadata(typedMuxMetadata);
    if (isCompactionRequest) {
      this.continuousCompactor.reset("compaction-request");
    }

    // Internal callers can force Copilot billing attribution for non-user turns
    // (task orchestration, compaction, auto-resume, etc.).
    let agentInitiated = internal?.agentInitiated === true;

    let modelForStream = options.model;
    let optionsForStream: SendMessageOptions = stripGoalInterventionPolicy({
      ...options,
      ...(acpPromptId != null ? { acpPromptId } : {}),
      ...(delegatedToolNames != null ? { delegatedToolNames } : {}),
    });

    // RLM keep-recent floor: stamp compaction requests (manual /compact,
    // mid-stream forced, idle) with the durable tail-start sequence before the
    // row is persisted. No-op when RLM is off.
    const stampedMuxMetadata =
      isCompactionRequest && typedMuxMetadata?.type === "compaction-request"
        ? await this.withKeepRecentTailStamp(typedMuxMetadata, optionsForStream)
        : typedMuxMetadata;

    const compactionCancellationNonce = isManualUserMessage
      ? await this.getCompactionCancellationNonce()
      : undefined;
    const userMessage = createMuxMessage(
      messageId,
      "user",
      message,
      {
        timestamp: Date.now(),
        toolPolicy: typedToolPolicy,
        disableWorkspaceAgents: options?.disableWorkspaceAgents,
        retrySendOptions: pickStartupRetrySendOptions(optionsForStream, agentInitiated, goalKind),
        muxMetadata: stampedMuxMetadata, // Pass through frontend metadata as black-box
        ...(compactionCancellationNonce ? { compactionCancellationNonce } : {}),
        ...(acpPromptId != null ? { acpPromptId } : {}),
        ...(goalKind != null ? { kind: goalKind } : {}),
        // Scope goal-loop rows to their goal so a replaced goal's continuation
        // cannot reactivate its successor during chat-tail reconciliation.
        ...(goalKind != null && internal?.goalId != null ? { goalId: internal.goalId } : {}),
        // Persist the queue-entry authoring time so goal-safety reconciliation
        // can re-derive the pre-goal/post-goal distinction after a restart.
        ...(internal?.enqueuedAtMs != null ? { enqueuedAtMs: internal.enqueuedAtMs } : {}),
        // Auto-resume and other system-generated messages are synthetic + UI-visible
        ...(internal?.synthetic && { synthetic: true, uiVisible: true }),
      },
      additionalParts
    );

    // Materialize @file mentions from the user message into a snapshot.
    // This ensures prompt-cache stability: we read files once and persist the content,
    // so subsequent turns don't re-read (which would change the prompt prefix if files changed).
    // File changes after this point are surfaced via <system-file-update> diffs instead.
    const snapshotResult = await this.materializeFileAtMentionsSnapshot(trimmedMessage);

    if (await cancelBeforeAcceptance()) {
      return Ok(undefined);
    }

    // Check compaction threshold BEFORE persisting the user message.
    // Skill snapshots are materialized AFTER this decision (below): when on-send
    // compaction defers the turn, the follow-up re-enters sendMessage with the same
    // skill metadata and materializes then. Materializing before the decision would
    // run twice — executing dynamic context directives (side effects!) once for a
    // snapshot that is immediately discarded.
    // Persisting snapshots too early can also bloat the compaction request context
    // and make compaction itself fail near the context limit.
    // If on-send compaction is needed, we skip persisting the user's message now — it becomes
    // the follow-up content sent after compaction completes. This avoids duplicating the user
    // turn in model context (the compaction would otherwise summarize a transcript that already
    // contains the new prompt, then replay it again post-compaction).
    let autoCompactionMessage: MuxMessage | null = null;
    // Pre-turn rows cannot ride the on-send compaction follow-up (its durable
    // metadata carries only text + send options), and compacting a payload row
    // away would dangle the trigger's message-ID reference. Family sends are
    // small and bounded, so skip on-send compaction for them; mid-stream
    // forcing still protects the context limit.
    const hasPreTurnMessages = (internal?.preTurnMessages?.length ?? 0) > 0;
    if (!isCompactionRequest && !editMessageId && !hasPreTurnMessages) {
      // Seed usage state from persisted history on the first send after restart
      // so the compaction monitor can detect context limits even before any live
      // stream events have populated lastUsageState.
      await this.seedUsageStateFromHistory();
      if (await cancelBeforeAcceptance()) {
        return Ok(undefined);
      }

      const providersConfigForCompaction = this.getProvidersConfigSafe();
      // Recover before measuring pressure so the old pre-swap usage cannot force another fold.
      if (await this.continuousCompactor.recover()) {
        if (isAdmissionStale() || this.coordinator.closing)
          return refuseBeforeAcceptance(
            createUnknownSendMessageError(CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE)
          );
        this.clearUsageState();
      }
      const compactionResult = this.compactionMonitor.checkBeforeSend({
        model: modelForStream,
        usage: this.getUsageState(),
        use1MContext: this.is1MContextEnabledForModel(
          modelForStream,
          optionsForStream,
          providersConfigForCompaction
        ),
        providersConfig: providersConfigForCompaction,
        openaiWireFormat: optionsForStream.providerOptions?.openai?.wireFormat,
      });

      const continuousContext = this.getContinuousCompactionContext(
        modelForStream,
        optionsForStream
      );
      if (!continuousContext.enabled) this.continuousCompactor.reset("disabled");
      const continuousResult = continuousContext.enabled
        ? await this.continuousCompactor.observe(compactionResult.usagePercentage, {
            ...continuousContext,
            phase: "on-send",
          })
        : "none";
      if (isAdmissionStale() || this.coordinator.closing)
        return refuseBeforeAcceptance(
          createUnknownSendMessageError(CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE)
        );
      if (continuousResult === "applied") this.clearUsageState();
      if (await cancelBeforeAcceptance()) return Ok(undefined);

      // A staged fold needs no compact turn. Without one, the experiment waits
      // until the force threshold; the legacy path retains its on-send threshold.
      const shouldCompactBeforeSend =
        this.compactionMonitor.getThreshold() < 1 &&
        (continuousContext.enabled
          ? continuousResult === "fallback" && compactionResult.shouldForceCompact
          : compactionResult.usagePercentage >= compactionResult.thresholdPercentage);
      if (shouldCompactBeforeSend) {
        this.continuousCompactor.reset("legacy-fallback");
        const followUpFileParts = effectiveFileParts?.map((part) => ({
          url: part.url,
          mediaType: part.mediaType,
          filename: part.filename,
        }));

        // A monitor-wake continuation of an open delegated turn is about to be
        // consumed by compaction; capture the correlation from pre-compaction
        // history now, because the correlated queue-cut assistant will be
        // hidden behind the new boundary when the follow-up dispatches.
        let inheritedWorkspaceTurnMetadata:
          | Extract<MuxMessageMetadata, { type: "workspace-turn-task" }>
          | undefined;
        if (typedMuxMetadata?.type === "bash-monitor-wake") {
          const preCompactionHistory = await this.historyService.getHistoryFromLatestBoundary(
            this.workspaceId
          );
          if (preCompactionHistory.success) {
            inheritedWorkspaceTurnMetadata = inheritOpenWorkspaceTurnMetadata(
              preCompactionHistory.data
            );
          }
        }

        const followUpContent = this.buildAutoCompactionFollowUp({
          messageText: message,
          options: optionsForStream,
          modelForStream,
          fileParts: followUpFileParts,
          agentInitiated,
          goalKind,
          goalId: internal?.goalId,
          muxMetadata: typedMuxMetadata,
          workspaceTurnMetadata: inheritedWorkspaceTurnMetadata,
        });

        // Waterfall hook point: lets registered middleware (e.g. refinement
        // journaling) run before context is compacted away. No-op when empty.
        await eventSpine.run("compaction.prepare", {
          workspaceId: this.workspaceId,
          reason: "on-send",
        });

        const autoCompactionRequest = this.buildAutoCompactionRequest({
          followUpContent,
          baseOptions: optionsForStream,
          reason: "on-send",
        });

        // RLM keep-recent floor: stamp on-send auto-compaction requests with
        // the durable tail-start sequence. No-op when RLM is off.
        if (autoCompactionRequest.metadata.type === "compaction-request") {
          autoCompactionRequest.metadata = await this.withKeepRecentTailStamp(
            autoCompactionRequest.metadata,
            optionsForStream
          );
        }

        autoCompactionMessage = createMuxMessage(
          createUserMessageId(),
          "user",
          autoCompactionRequest.messageText,
          {
            timestamp: Date.now(),
            toolPolicy: autoCompactionRequest.sendOptions.toolPolicy,
            disableWorkspaceAgents: optionsForStream.disableWorkspaceAgents,
            retrySendOptions: pickStartupRetrySendOptions(
              autoCompactionRequest.sendOptions,
              autoCompactionRequest.agentInitiated
            ),
            muxMetadata: autoCompactionRequest.metadata,
            ...(compactionCancellationNonce ? { compactionCancellationNonce } : {}),
            synthetic: true,
            uiVisible: true,
          }
        );

        if (this.coordinator.admissionBlocked || isAdmissionStale()) return refuseContextMutation();
        if (this.coordinator.closing)
          return refuseBeforeAcceptance(
            createUnknownSendMessageError(SESSION_SHUTDOWN_SEND_BLOCKED_MESSAGE)
          );

        // Persist compaction request (NOT the user message — it's the follow-up)
        const appendCompactionResult = await this.historyService.appendToHistory(
          this.workspaceId,
          autoCompactionMessage,
          compactionAppendCondition
        );
        if (!appendCompactionResult.success) {
          if (compactionAppendCondition) throw new Error(appendCompactionResult.error);
          return Err(createUnknownSendMessageError(appendCompactionResult.error));
        }
        if (compactionAppendSkipped) return refuseSkippedCompactionAppend();
        persistedCancelableMessageIds.push(autoCompactionMessage.id);
        if (await cancelBeforeAcceptance()) {
          return Ok(undefined);
        }

        this.emitChatEvent({
          type: "auto-compaction-triggered",
          reason: "on-send",
          usagePercent: Math.round(compactionResult.usagePercentage),
        });

        modelForStream = autoCompactionRequest.sendOptions.model;
        optionsForStream = stripGoalInterventionPolicy({
          ...autoCompactionRequest.sendOptions,
          muxMetadata: autoCompactionRequest.metadata,
        });
        agentInitiated = autoCompactionRequest.agentInitiated;
      }
    }

    // r41: reject before persisting the turn's rows when a context-discarding
    // mutation is in flight or completed after this send entered — otherwise
    // rows composed against the discarded context (snapshots, family
    // payloads, the user row) land in the fresh transcript even though the
    // PREPARING gate below refuses the turn. Still pre-acceptance here, so a
    // plain Err keeps cancellation/rollback contracts clean. Mutations also
    // refuse while sends are in preflight (r42), so rows can no longer land
    // after a mutation commits; this check and the PREPARING gate remain
    // backstops for entry-accounting bypasses.
    if (this.coordinator.admissionBlocked || isAdmissionStale()) {
      return refuseContextMutation();
    }
    // Still pre-persist: a row appended now would read as a dispatched turn on the next startup
    // while streamWithHistory's own latch check keeps its stream from ever running.
    if (this.coordinator.closing) {
      return refuseBeforeAcceptance(
        createUnknownSendMessageError(SESSION_SHUTDOWN_SEND_BLOCKED_MESSAGE)
      );
    }

    // Persist snapshots only when this turn will be sent immediately.
    // On on-send compaction paths, snapshots are deferred with the follow-up turn.
    const shouldPersistTurnSnapshots = autoCompactionMessage === null;

    let skillSnapshotMessages: MuxMessage[] = [];
    let mcpPromptSnapshotMessages: MuxMessage[] = [];
    if (shouldPersistTurnSnapshots) {
      try {
        skillSnapshotMessages = await this.materializeAgentSkillSnapshots(
          typedMuxMetadata,
          options?.disableWorkspaceAgents
        );
        mcpPromptSnapshotMessages = await this.materializeMcpPromptSnapshots(
          typedMuxMetadata,
          userMessage.id,
          cancelSignal
        );
      } catch (error) {
        return Err(createUnknownSendMessageError(getErrorMessage(error)));
      }
      if (await cancelBeforeAcceptance()) {
        return Ok(undefined);
      }
    }

    if (shouldPersistTurnSnapshots && snapshotResult?.snapshotMessage) {
      const snapshotAppendResult = await this.historyService.appendToHistory(
        this.workspaceId,
        snapshotResult.snapshotMessage
      );
      if (!snapshotAppendResult.success) {
        return Err(createUnknownSendMessageError(snapshotAppendResult.error));
      }
      persistedCancelableMessageIds.push(snapshotResult.snapshotMessage.id);
      if (await cancelBeforeAcceptance()) {
        return Ok(undefined);
      }
    }

    if (shouldPersistTurnSnapshots && skillSnapshotMessages.length > 0) {
      for (const snapshotMessage of skillSnapshotMessages) {
        const skillSnapshotAppendResult = await this.historyService.appendToHistory(
          this.workspaceId,
          snapshotMessage
        );
        if (!skillSnapshotAppendResult.success) {
          await rollbackPersistedTurnRows();
          return Err(createUnknownSendMessageError(skillSnapshotAppendResult.error));
        }
        persistedCancelableMessageIds.push(snapshotMessage.id);
        if (await cancelBeforeAcceptance()) {
          return Ok(undefined);
        }
      }
    }

    if (shouldPersistTurnSnapshots && mcpPromptSnapshotMessages.length > 0) {
      for (const snapshotMessage of mcpPromptSnapshotMessages) {
        const appendResult = await this.historyService.appendToHistory(
          this.workspaceId,
          snapshotMessage
        );
        if (!appendResult.success) {
          await rollbackPersistedTurnRows();
          return Err(createUnknownSendMessageError(appendResult.error));
        }
        persistedCancelableMessageIds.push(snapshotMessage.id);
        if (await cancelBeforeAcceptance()) {
          return Ok(undefined);
        }
      }
    }

    // Pre-turn rows persist immediately before the user row so the payload and
    // its trigger land as one uninterrupted transcript unit (see the internal
    // option's doc comment). ONE durable write for payload(s) + user row (r32):
    // separate appends left a crash window where the payload persisted without
    // the turn that delivers it — in-process rollback cannot repair a process
    // exit. They still join the rollback set for in-process failures.
    // hasPreTurnMessages implies autoCompactionMessage === null (exempted above).
    if (internal?.preTurnMessages != null && internal.preTurnMessages.length > 0) {
      for (const preTurnMessage of internal.preTurnMessages) {
        // Family payloads are the only producer today: synthetic assistant rows
        // only, so a future caller cannot smuggle user-role content past the
        // provenance rules or non-synthetic rows past queue/restore projections.
        assert(
          preTurnMessage.role === "assistant" && preTurnMessage.metadata?.synthetic === true,
          "sendMessage: preTurnMessages must be synthetic assistant rows"
        );
      }
      const batchAppendResult = await this.historyService.appendManyToHistory(this.workspaceId, [
        ...internal.preTurnMessages,
        userMessage,
      ]);
      if (!batchAppendResult.success) {
        await rollbackPersistedTurnRows();
        return Err(createUnknownSendMessageError(batchAppendResult.error));
      }
      persistedCancelableMessageIds.push(
        ...internal.preTurnMessages.map((message) => message.id),
        userMessage.id
      );
      if (await cancelBeforeAcceptance()) {
        return Ok(undefined);
      }
    } else if (!autoCompactionMessage) {
      // When on-send compaction triggers, the user message is NOT persisted to
      // history (it's sent as follow-up after compaction). Otherwise, persist
      // normally.
      const appendResult = await this.historyService.appendToHistory(
        this.workspaceId,
        userMessage,
        compactionAppendCondition
      );
      if (!appendResult.success) {
        await rollbackPersistedTurnRows();
        // Rollback can retire the local token; that must not disguise a real
        // locked-read/write failure as an ordinary stale-source skip.
        if (compactionAppendCondition) throw new Error(appendResult.error);
        return Err(createUnknownSendMessageError(appendResult.error));
      }
      if (compactionAppendSkipped) return refuseSkippedCompactionAppend();
      persistedCancelableMessageIds.push(userMessage.id);
      if (await cancelBeforeAcceptance()) {
        return Ok(undefined);
      }
    }

    // Caller-probe staleness (peer sends racing a Stop) must resolve BEFORE the pre-turn batch
    // becomes irrevocable below: the rows persisted by the appends above are still inside the
    // rollback horizon here, so a Stop that landed during that history IO refuses the send and
    // leaves no trace for a later human resume to replay into provider context. Past this point
    // rollback is forbidden by design (goal sync observes the durable row), so a Stop landing in
    // the remaining pre-stream awaits refuses the turn at the PREPARING gate with rows retained.
    if (
      internal?.admissionStale?.() === true ||
      !this.coordinator.isCurrentTurn(attempt.owner ?? attempt.expectedTurn)
    ) {
      const rolledBack = await rollbackPersistedTurnRows();
      // Probe-carrying sends are peer messages whose caller already returned success when the
      // entry was queued — the cancellation hook is their only way to observe this refusal and
      // release the budget reservation (the refund closure is idempotent). Fire it ONLY when the
      // rollback verifiably committed: rows that remain durable can enter provider context after
      // a resume, so their charge must stand (budget charged ⇔ rows durable).
      if (rolledBack) {
        await internal?.onCanceled?.(
          "Send refused: the caller's admission became stale before the turn was accepted."
        );
      } else {
        // Failed rollback leaves the rows durable, and the Err below still reaches the caller's
        // OUTER refund paths (the direct-call failure branch and sendQueuedMessages'
        // onAcceptedPreStreamFailure). Mark the rows persisted first so those payload-guarded
        // refunds keep the charge — refunding here would leave provider-visible rows uncharged.
        markRowsDurable();
      }
      return refuseAdmission(
        createUnknownSendMessageError(
          "Send refused: the caller's admission became stale before the turn was accepted."
        )
      );
    }

    // Goal synchronization can mutate goal.json based on this durable user row. Once it begins, the
    // turn has crossed the cancellation point-of-no-return: a concurrent monitor stop must let this
    // wake finish acceptance rather than delete the row after goal state has already observed it.
    if (cancelSignal != null) {
      cancellationDisabled = true;
    }
    // r54: the pre-turn batch is now irrevocable — rollbackPersistedTurnRows
    // is never invoked past this point, so even a failure in goal sync or
    // acceptance leaves the payload + trigger rows durable in the transcript.
    markRowsDurable();
    // The committed row witnesses replacement even if ancillary unlink fails.
    // Continue acceptance so a visible, durable user send is never reported lost.
    if (compactionCancellationNonce)
      await this.retireWitnessedCompactionCancellation(compactionCancellationNonce);
    try {
      await this.workspaceGoalService?.syncGoalModeWithChatTail(this.workspaceId);
    } catch (error) {
      if (cancelSignal != null) {
        // The durable row crossed the point of no return, so every later goal-sync failure must still
        // finalize this monitor wake. Startup recovery can resume the row without redelivering it.
        await accept();
      }
      throw error;
    }

    if (manualGoalInterventionPolicy != null) {
      await this.applyManualUserMessageGoalSafety({
        policy: manualGoalInterventionPolicy,
        enqueuedAtMs: internal?.enqueuedAtMs,
      });
    }

    // Workspace may be tearing down while we await filesystem IO.
    // If so, skip event emission + streaming to avoid races with dispose(). A cancelable monitor
    // wake past the point of no return is already durable, so finalize it before leaving.
    if (this.coordinator.disposed) {
      if (cancelSignal != null && cancellationDisabled) {
        await accept();
      }
      return Ok(undefined);
    }

    // Turn durably accepted + options finalized: open the mid-turn thinking
    // override window BEFORE the user-message emit / onAccepted / any further
    // await, so a slider change during PREPARING (runtime warmup, model
    // creation) lands in the holder the stream's prepareStep will read.
    const turnThinkingOverride: ActiveTurnThinkingOverride = {};
    if (isAdmissionStale())
      return refuseAdmission(createUnknownSendMessageError(CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE));
    this.coordinator.acceptThinkingOverride(
      turnThinkingOverride,
      attempt.owner ?? attempt.expectedTurn
    );

    // Emit snapshots only for immediately-sent turns. On on-send compaction paths,
    // snapshots are deferred with the follow-up message to avoid duplicate ephemeral
    // snapshot rows that were never persisted.
    if (shouldPersistTurnSnapshots && snapshotResult?.snapshotMessage) {
      this.emitChatEvent({ ...snapshotResult.snapshotMessage, type: "message" });
    }

    if (shouldPersistTurnSnapshots && skillSnapshotMessages.length > 0) {
      for (const snapshotMessage of skillSnapshotMessages) {
        this.emitChatEvent({ ...snapshotMessage, type: "message" });
      }
    }

    if (shouldPersistTurnSnapshots && mcpPromptSnapshotMessages.length > 0) {
      for (const snapshotMessage of mcpPromptSnapshotMessages) {
        this.emitChatEvent({ ...snapshotMessage, type: "message" });
      }
    }

    // Pre-turn rows emit ahead of the user row, matching their persisted order.
    if (internal?.preTurnMessages != null) {
      for (const preTurnMessage of internal.preTurnMessages) {
        this.emitChatEvent({ ...preTurnMessage, type: "message" });
      }
    }

    // When on-send compaction triggers, the original user message is NOT emitted now —
    // it was not persisted and will be dispatched (persisted + emitted) as a follow-up
    // after compaction completes. Emitting it here would cause a duplicate in the
    // live transcript once the follow-up path re-sends the same text.
    if (autoCompactionMessage) {
      this.emitChatEvent({ ...autoCompactionMessage, type: "message" });
    } else {
      this.emitChatEvent({ ...userMessage, type: "message" });
    }

    // Only explicit user sends should reset auto-retry intent, and only after the
    // send has passed validation + been accepted into history.
    // Synthetic/system sends (mid-stream compaction, task recovery prompts, etc.)
    // must not silently opt users back into auto-retry after they've disabled it.
    if (isManualUserMessage) {
      // A fresh accepted user send supersedes any persisted startup-abandon
      // classification from previous turns.
      if (isAdmissionStale())
        return refuseAdmission(
          createUnknownSendMessageError(CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE)
        );
      await this.clearStartupAutoRetryAbandon();
      if (isAdmissionStale())
        return refuseAdmission(
          createUnknownSendMessageError(CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE)
        );
      this.retryManager.cancel();
      this.retryManager.setEnabled(true);
      await this.persistAutoRetryEnabledPreference(true);
    }

    // Same-session retry should resume the exact accepted request we just finalized
    // in history, even if runtime warmup fails before streamWithHistory() starts.
    if (isAdmissionStale())
      return refuseAdmission(createUnknownSendMessageError(CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE));
    this.setAutoRetryResumeState(optionsForStream, agentInitiated, goalKind, internal?.goalId);
    try {
      await accept();
    } catch (error) {
      // Pre-stream failure: identity-guarded so a replacement turn's holder
      // (created while this one unwound) is never cleared by mistake.
      if (this.coordinator.thinkingOverride === turnThinkingOverride) {
        this.coordinator.releaseThinkingOverride(turnThinkingOverride);
      }
      return Err(createUnknownSendMessageError(getErrorMessage(error)));
    }

    // r40: a context-discarding mutation (reset, full clear, destructive
    // replace) may have started while this send was validating and persisting
    // rows — its busy checks saw an idle session. Refuse admission in the
    // same synchronous block that would set PREPARING: streaming would
    // snapshot the transcript the mutation is about to discard and repopulate
    // the cleared context. The turn rows persisted above land pre-mutation,
    // so the mutation itself discards them. The epoch probe (r41) is a
    // backstop for a mutation that COMPLETED during the awaits above —
    // normally impossible since mutations refuse while sends are in
    // preflight (r42), but kept for paths that bypass WorkspaceService
    // entry accounting.
    if (this.coordinator.admissionBlocked || isAdmissionStale()) {
      const error = createUnknownSendMessageError(CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE);
      // The turn was already accepted (rows durable, onAccepted ran):
      // internal callers like the terminal-attention outbox mark state
      // delivered in onAccepted and rely on the accepted pre-stream failure
      // callback to revert it — returning without notifying would strand
      // that bookkeeping (r41).
      await this.settlePreparationFailure(attempt, error);
      return { success: false, error, superseded: true };
    }

    const preparedTurnAbortController = new AbortController();
    const admission = this.coordinator.prepare(
      attempt.owner != null
        ? { kind: "adopt", turnId: attempt.owner }
        : {
            kind: "fresh",
            intent: "direct",
            expectedTurnId: attempt.expectedTurn,
            editReservation: attempt.editReservation?.id,
            compactionHandoff: internal?.compactionHandoff,
          },
      preparedTurnAbortController,
      (turnId) => {
        attempt.owner = turnId;
        this.preparingWorkspaceTurnMetadata = getWorkspaceTurnMuxMetadata(
          optionsForStream.muxMetadata
        );
      }
    );
    if (admission.status !== "admitted") {
      return {
        success: false,
        error: createUnknownSendMessageError(
          admission.status === "rejected" && admission.reason === "closing"
            ? SESSION_SHUTDOWN_SEND_BLOCKED_MESSAGE
            : CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE
        ),
        superseded: true,
      };
    }
    const preparedTurn = admission.turnId;

    internal?.onTurnAdmissionCommitted?.();

    const startPreparedStream = async (
      startup: PreparationAttempt
    ): Promise<AgentSessionResult<void>> => {
      if (
        !this.coordinator.isCurrentTurn(preparedTurn) ||
        preparedTurnAbortController.signal.aborted
      ) {
        await this.settlePreparationFailure(
          startup,
          createUnknownSendMessageError("Accepted stream startup was canceled before it began.")
        );
        return Ok(undefined);
      }
      // Background processes are workspace-scoped, not context-scoped. Compaction must preserve
      // processes, monitors, and queued wakes so a waiting agent is not stranded.
      // Note: Follow-up content for compaction is now stored on the summary message
      // and dispatched via dispatchPendingFollowUp() after compaction completes.
      // This provides crash safety - the follow-up survives app restarts.

      if (this.coordinator.disposed || preparedTurnAbortController.signal.aborted) {
        await this.settlePreparationFailure(
          startup,
          createUnknownSendMessageError("Accepted stream startup was canceled before streaming.")
        );
        return Ok(undefined);
      }

      // Raw terminals reserve COMPLETING; delivered completion runs terminal policy.
      const streamResult = await this.streamWithHistory(
        preparedTurn,
        modelForStream,
        optionsForStream,
        undefined,
        undefined,
        agentInitiated,
        preparedTurnAbortController.signal,
        goalKind,
        internal?.goalId,
        turnThinkingOverride,
        startup
      );
      if (streamResult.success && preparedTurnAbortController.signal.aborted) {
        await this.settlePreparationFailure(
          startup,
          createUnknownSendMessageError("Accepted stream startup was canceled during preparation.")
        );
      }
      return streamResult;
    };

    if (editMessageId || internal?.startStreamInBackground === true) {
      // Transfer physical work before the foreground lease releases. The child has its own
      // completion outcome so a resolved foreground Ok cannot finish a still-starting turn.
      attempt.outcome = "background";
      const backgroundAttempt: PreparationAttempt = { ...attempt, outcome: "preparing" };
      // Handoff callbacks may already have preempted back to idle. Transfer the edit
      // exclusion too, so only the child's settled startup can release queued work.
      attempt.editReservation = undefined;
      this.completePreparation(backgroundAttempt, () =>
        startPreparedStream(backgroundAttempt)
      ).catch((error: unknown) => {
        log.error("Accepted background stream failed before startup completed", {
          workspaceId: this.workspaceId,
          error: getErrorMessage(error),
        });
      });
      return Ok(undefined);
    }

    return await startPreparedStream(attempt);
  }

  async resumeStream(
    options: SendMessageOptions,
    internal?: {
      agentInitiated?: boolean;
      goalKind?: GoalSyntheticMessageKind;
      goalId?: string;
      retrySignal?: AbortSignal;
      automatic?: boolean;
    }
  ): Promise<AgentSessionResult<{ started: boolean }>> {
    this.assertNotDisposed("resumeStream");
    if (this.coordinator.closing || internal?.retrySignal?.aborted) return Ok({ started: false });
    using _execution = this.coordinator.enterExecution();
    const expectedTurnId = this.coordinator.turnId;
    // Cancel retry startup through pricing/history/provider preparation, then detach the link.
    // Disabling backoff after delivery must not abort the already-running stream.
    const startupController = internal?.retrySignal ? new AbortController() : undefined;
    const cancelStartup = () => startupController?.abort();
    internal?.retrySignal?.addEventListener("abort", cancelStartup, { once: true });
    using _retryCancellation = {
      [Symbol.dispose]: () => internal?.retrySignal?.removeEventListener("abort", cancelStartup),
    };

    assert(options, "resumeStream requires options");
    const { model } = options;
    assert(typeof model === "string" && model.trim().length > 0, "resumeStream requires a model");

    const normalizedOptions = this.normalizeGatewaySendOptions(options);
    const modelForStream = normalizedOptions.model;
    const optionsForStream = normalizedOptions;

    // Guard against auto-retry starting a second stream while the initial send is
    // still waiting for init hooks to complete (or while completion cleanup is running).
    if (this.isBusy()) {
      return Ok({ started: false });
    }

    if (this.workspaceGoalService) {
      const pricingGate = await this.workspaceGoalService.assertPricedModelForBudgetedGoal(
        this.workspaceId,
        modelForStream
      );
      if (!pricingGate.success) {
        return Err(pricingGate.error);
      }
    }

    // r40: refuse resume admission while a context-discarding mutation is
    // mid-flight (see holdTurnAdmission) — checked in the same synchronous
    // block that sets PREPARING. A non-started resume reads as retriable to
    // retryActiveStream, but the mutation itself cancels pending retries and
    // clears the resume request (discardAutoRetryForContextMutation, r41),
    // so a straggler reschedule self-abandons instead of replaying the
    // discarded context.
    if (
      this.coordinator.admissionBlocked ||
      this.coordinator.closing ||
      startupController?.signal.aborted
    ) {
      return Ok({ started: false });
    }

    const attempt: PreparationAttempt = {
      expectedTurn: expectedTurnId,
      outcome: "preparing",
      durability: "accepted",
      queued: false,
      failureNotified: false,
    };
    return await this.completePreparation(attempt, async () => {
      const admission = this.coordinator.prepare(
        { kind: "fresh", intent: "resume", expectedTurnId },
        startupController,
        (turnId) => {
          attempt.owner = turnId;
          this.preparingWorkspaceTurnMetadata = getWorkspaceTurnMuxMetadata(
            optionsForStream.muxMetadata
          );
        }
      );
      if (admission.status !== "admitted") return Ok({ started: false });
      const preparedTurn = admission.turnId;
      if (!internal?.automatic && internal?.agentInitiated !== true) {
        const epoch = this.coordinator.compactionIntent.epoch;
        const nonce = await this.getCompactionCancellationNonce();
        if (
          !this.coordinator.isCurrentTurn(preparedTurn) ||
          this.coordinator.compactionIntent.epoch !== epoch ||
          this.coordinator.closing
        )
          return Ok({ started: false });
        attempt.resumeCancellation = { nonce: nonce ?? null, epoch };
      }
      this.setAutoRetryResumeState(
        optionsForStream,
        internal?.agentInitiated,
        internal?.goalKind,
        internal?.goalId
      );
      // Open the mid-turn thinking override window for the resumed turn (after
      // preparation publication; the coordinator expires the holder when the turn becomes idle).
      const turnThinkingOverride: ActiveTurnThinkingOverride = {};
      this.coordinator.acceptThinkingOverride(turnThinkingOverride, preparedTurn);
      // Must await here so the finally block runs after streaming completes,
      // not immediately when the Promise is returned.
      const result = await this.streamWithHistory(
        preparedTurn,
        modelForStream,
        optionsForStream,
        undefined,
        undefined,
        internal?.agentInitiated,
        startupController?.signal,
        internal?.goalKind,
        internal?.goalId,
        turnThinkingOverride,
        attempt
      );
      if (!result.success) {
        return result;
      }

      return Ok({ started: attempt.outcome === "delivered" });
    });
  }

  async setAutoRetryEnabled(
    enabled: boolean,
    options?: { persist?: boolean }
  ): Promise<{ previousEnabled: boolean; enabled: boolean }> {
    this.assertNotDisposed("setAutoRetryEnabled");
    assert(typeof enabled === "boolean", "setAutoRetryEnabled requires a boolean");

    const previousEnabled = await this.loadAutoRetryEnabledPreference();

    this.retryManager.setEnabled(enabled);
    if (!enabled) {
      this.retryManager.cancel();
    }

    if (options?.persist ?? true) {
      await this.persistAutoRetryEnabledPreference(enabled);
    }

    return { previousEnabled, enabled };
  }

  setAutoCompactionThreshold(threshold: number): void {
    this.assertNotDisposed("setAutoCompactionThreshold");
    const previous = this.compactionMonitor.getThreshold();
    this.compactionMonitor.setThreshold(threshold);
    if (previous !== threshold) this.continuousCompactor.reset("threshold-changed");
  }

  private getUsageState(): AutoCompactionUsageState | undefined {
    return this.lastUsageState;
  }

  private getProvidersConfigSafe(): ProvidersConfigMap | null {
    try {
      // Prefer ProviderService's safe config view: it includes env/file API-key source
      // metadata plus the Codex OAuth presence bit, which context-limit resolution needs
      // to distinguish GPT-5.5 API-key requests from lower-cap OAuth-routed requests.
      const maybeAIService = this.aiService as AgentSessionAIService & {
        getProvidersConfig?: () => ProvidersConfigMap | null;
      };
      if (typeof maybeAIService.getProvidersConfig === "function") {
        return maybeAIService.getProvidersConfig();
      }

      const providersConfig = new ProvidersConfigStore(this.config.rootDir).loadProvidersConfig();
      return providersConfig as ProvidersConfigMap | null;
    } catch {
      // Best-effort read: if config cannot be loaded, keep null and rely on
      // built-in model limits. This matches prior behavior without crashing.
      return null;
    }
  }

  private is1MContextEnabledForModel(
    modelString: string,
    options?: SendMessageOptions,
    providersConfig?: ProvidersConfigMap | null
  ): boolean {
    return isAnthropic1MEffectivelyEnabled(modelString, options?.providerOptions, providersConfig);
  }

  private updateUsageStateFromModelUsage(params: {
    model: string;
    usage: LanguageModelV2Usage | undefined;
    providerMetadata?: Record<string, unknown>;
    live: boolean;
  }): void {
    if (!params.usage) {
      return;
    }

    const usageForDisplay = createDisplayUsage(params.usage, params.model, params.providerMetadata);
    if (!usageForDisplay) {
      return;
    }

    const totalTokens = params.usage.totalTokens ?? this.lastUsageState?.totalTokens;
    if (params.live) {
      this.lastUsageState = {
        ...this.lastUsageState,
        liveUsage: usageForDisplay,
        totalTokens,
      };
      return;
    }

    this.lastUsageState = {
      ...this.lastUsageState,
      lastContextUsage: usageForDisplay,
      liveUsage: undefined,
      totalTokens,
    };
  }

  private clearLiveUsageState(): void {
    if (!this.lastUsageState?.liveUsage) {
      return;
    }

    this.lastUsageState = {
      ...this.lastUsageState,
      liveUsage: undefined,
    };
  }

  /** Prevent cached usage from auto-compacting a rewritten context. */
  clearUsageState(): void {
    this.continuousCompactor.reset("context-changed");
    this.lastUsageState = undefined;
  }

  /**
   * Persist a manual user message + emit a stream-error chat event when a
   * pre-stream gate (e.g. the unpriced-model budget gate) rejects a send.
   *
   * Without this, queue-dispatched manual sends silently disappear: the
   * caller (`sendQueuedMessages`) has already removed the message from the
   * queue before invoking `sendMessage`, so a bare `Err` return drops the
   * user's typed input with no visible feedback. Persisting + emitting both
   * the user message and the stream error gives the user a chat-history
   * record of what they sent and a clear explanation of why it was blocked.
   *
   * Best-effort: failures to persist/emit are logged and swallowed so the
   * caller still gets the original gate error back, which preserves the
   * existing turn-phase / IDLE bookkeeping in `sendQueuedMessages`.
   *
   * Returns `true` if an actionable user message was actually present (text
   * and/or attachments) — the caller uses this to decide whether to run the
   * goal-safety hook. An empty payload (blank submit / invalid options) is
   * not a real intervention and must not pause an active goal (Codex P2
   * PRRT_kwDOPxxmWM5_tUsx).
   */
  private async preserveRejectedManualSend(
    message: string,
    options: (SendMessageOptions & { fileParts?: FilePart[] }) | undefined,
    rejection: SendMessageError,
    enqueuedAtMs?: number
  ): Promise<boolean> {
    if (this.coordinator.disposed) {
      return false;
    }
    const trimmed = message.trim();
    const fileParts = options?.fileParts ?? [];
    const additionalParts = fileParts.map((part) => ({
      type: "file" as const,
      url: part.url,
      mediaType: part.mediaType,
      filename: part.filename,
    }));
    if (trimmed.length === 0 && additionalParts.length === 0) {
      // Empty payload — nothing to preserve and no actionable intervention to
      // attribute to the user. The empty-message rejection further down in
      // sendMessage would normally catch this, but if the gate fires first we
      // still need to stay defensive.
      return false;
    }
    try {
      const userMessage = createMuxMessage(
        createUserMessageId(),
        "user",
        trimmed,
        {
          // Stamp authoring metadata like accepted turns do: goal-safety
          // reconciliation reads it after a restart to classify this row as
          // pre-goal (queued before the goal existed) vs a real intervention.
          // Without it a rejected queued send would pause a never-driven goal
          // on the next getGoal.
          timestamp: Date.now(),
          ...(enqueuedAtMs != null ? { enqueuedAtMs } : {}),
        },
        additionalParts.length > 0 ? additionalParts : undefined
      );
      const appendResult = await this.historyService.appendToHistory(this.workspaceId, userMessage);
      if (!appendResult.success) {
        log.warn("Failed to persist user message after pre-stream gate rejection", {
          workspaceId: this.workspaceId,
          error: appendResult.error,
        });
      } else if (!this.coordinator.disposed) {
        this.emitChatEvent({ ...userMessage, type: "message" });
      }
    } catch (error) {
      log.warn("Unexpected error persisting user message after pre-stream gate rejection", {
        workspaceId: this.workspaceId,
        error: getErrorMessage(error),
      });
    }
    if (!this.coordinator.disposed) {
      const streamError = buildStreamErrorEventData(rejection);
      this.emitChatEvent(createStreamErrorMessage(streamError));
    }
    return true;
  }

  /**
   * Seed `lastUsageState` from persisted history so the compaction monitor
   * can trigger on-send compaction even when no live stream has occurred yet
   * (e.g., after an app restart). Walks the last N messages backwards to find
   * the most recent assistant message carrying `contextUsage` metadata.
   *
   * This is a lazy one-shot: called from `sendMessage` only when
   * `lastUsageState` is still undefined.
   */
  private async seedUsageStateFromHistory(): Promise<void> {
    if (this.lastUsageState !== undefined) {
      return;
    }

    try {
      // Seed from the active compaction epoch only. Using a generic tail read can
      // accidentally pull context usage from pre-boundary assistant rows after
      // compaction, which makes post-compaction turns immediately re-compact.
      const historyResult = await this.historyService.getHistoryFromLatestBoundary(
        this.workspaceId
      );
      if (!historyResult.success) {
        return;
      }

      // Walk backwards to find the most recent message with contextUsage.
      for (let i = historyResult.data.length - 1; i >= 0; i--) {
        const msg = historyResult.data[i];
        const meta = msg.metadata;
        if (!meta?.contextUsage || !meta.model) {
          continue;
        }

        this.lastSystemMessageTokens = meta.systemMessageTokens;
        this.updateUsageStateFromModelUsage({
          model: meta.model,
          usage: meta.contextUsage,
          providerMetadata: meta.contextProviderMetadata ?? meta.providerMetadata,
          live: false,
        });
        return;
      }
    } catch {
      // Best-effort: seeding is an optimization so the compaction monitor
      // works after restart. If it fails, the first live stream-end will
      // populate lastUsageState and compaction kicks in from then on.
    }
  }

  private buildAutoCompactionFollowUp(params: {
    messageText: string;
    options: SendMessageOptions;
    modelForStream: string;
    fileParts?: FilePart[];
    agentInitiated?: boolean;
    goalKind?: GoalSyntheticMessageKind;
    goalId?: string;
    muxMetadata?: MuxMessageMetadata;
    workspaceTurnMetadata?: Extract<MuxMessageMetadata, { type: "workspace-turn-task" }>;
  }): CompactionFollowUpRequest {
    const followUp: CompactionFollowUpRequest = {
      text: params.messageText,
      model: params.modelForStream,
      agentId: params.options.agentId,
      ...pickPreservedSendOptions(params.options),
    };

    if (params.agentInitiated === true) {
      followUp.agentInitiated = true;
    }

    if (params.goalKind != null) {
      followUp.goalKind = params.goalKind;
    }

    if (params.goalId != null) {
      followUp.goalId = params.goalId;
    }

    if (params.fileParts && params.fileParts.length > 0) {
      followUp.fileParts = params.fileParts;
    }

    if (params.muxMetadata) {
      followUp.muxMetadata = params.muxMetadata;
    }

    if (params.workspaceTurnMetadata) {
      followUp.workspaceTurnMetadata = params.workspaceTurnMetadata;
    }

    return followUp;
  }

  /**
   * Startup recovery dispatches through this session's internal send path, which bypasses
   * WorkspaceService.sendMessage's archived guard, so an archive that lands while a recovery
   * step awaits disk I/O would otherwise start a hidden stream. Re-read the durable state right
   * before dispatching: dispose() reaches only transient recovery sessions, not a session a
   * client had already created when housekeeping scheduled the recovery on it.
   */
  private isWorkspaceArchivedOnDisk(): boolean {
    try {
      const entry = findWorkspaceEntry(this.config.loadConfigOrDefault(), this.workspaceId);
      return (
        entry != null &&
        isWorkspaceArchived(entry.workspace.archivedAt, entry.workspace.unarchivedAt)
      );
    } catch {
      // Partial Config mocks (see getCompactionResolverInputs); a real config never throws here.
      return false;
    }
  }

  /**
   * Layers for auto-compaction resolution. Defensive reads: tests construct
   * sessions with partial Config mocks, so missing methods degrade to empty
   * layers instead of throwing.
   */
  private getCompactionResolverInputs(): {
    agentAiDefaults?: AgentAiDefaults;
    minThinkingLevelByModel?: Record<string, ThinkingLevel>;
    compactBucket?: AgentAiSettingsLayerValues;
  } {
    try {
      const maybeConfig = this.config as Config & {
        loadConfigOrDefault?: () => ReturnType<Config["loadConfigOrDefault"]> | null;
        findWorkspace?: Config["findWorkspace"];
      };
      if (typeof maybeConfig.loadConfigOrDefault !== "function") {
        return {};
      }
      const cfg = maybeConfig.loadConfigOrDefault();
      const workspaceMatch =
        typeof maybeConfig.findWorkspace === "function"
          ? maybeConfig.findWorkspace(this.workspaceId)
          : null;
      const project = workspaceMatch ? cfg?.projects.get(workspaceMatch.projectPath) : undefined;
      const workspaceEntry = project?.workspaces.find(
        (workspace) => workspace.id === this.workspaceId
      );
      const compactBucket = workspaceEntry?.aiSettingsByAgent?.compact;
      return {
        agentAiDefaults: cfg?.agentAiDefaults,
        minThinkingLevelByModel: cfg?.minThinkingLevelByModel,
        compactBucket: compactBucket ? targetWorkspaceBucketToLayer(compactBucket) : undefined,
      };
    } catch {
      return {};
    }
  }

  /**
   * True when RLM-mode history behaviors (keep-recent compaction floor,
   * abandoned-branch summaries) apply. Frontend sends carry experiments in
   * send options; backend-initiated compaction sends (idle loop) do not, so
   * the shared gate falls back to the persisted machine overrides the
   * renderer syncs into Settings.
   */
  private isRlmCompactionEnabled(options: SendMessageOptions | undefined): boolean {
    // Guard for test mocks that may not implement isExperimentEnabled.
    const isExperimentEnabled =
      typeof this.aiService.isExperimentEnabled === "function"
        ? (experimentId: ExperimentId) => this.aiService.isExperimentEnabled(experimentId)
        : undefined;
    return isRlmModeEnabled(options?.experiments, isExperimentEnabled);
  }

  /**
   * Compute the durable keep-recent stamp for a compaction request (RLM mode).
   *
   * The stamp records the historySequence where the preserved tail starts so
   * live request assembly, compaction completion, and replay all derive the
   * exact same tail from durable rows. Returns undefined when RLM is off,
   * when history cannot be read (self-healing: compaction proceeds without a
   * tail), or when the tail clamps away entirely.
   */
  private async computeKeepRecentTailStamp(
    options: SendMessageOptions | undefined
  ): Promise<{ startHistorySequence: number } | undefined> {
    if (!this.isRlmCompactionEnabled(options)) {
      return undefined;
    }

    const historyResult = await this.historyService.getHistoryFromLatestBoundary(this.workspaceId);
    if (!historyResult.success) {
      return undefined;
    }

    const messages = historyResult.data;
    const startIndex = selectKeepRecentTailStartIndex(messages, RLM_KEEP_RECENT_FLOOR_TOKENS);
    if (startIndex === -1) {
      return undefined;
    }

    const startHistorySequence = messages[startIndex].metadata?.historySequence;
    assert(
      isNonNegativeInteger(startHistorySequence),
      "keep-recent tail selector must only pick rows with a valid historySequence"
    );
    return { startHistorySequence };
  }

  /** Stamp a compaction-request metadata payload with the keep-recent tail (no-op when RLM is off). */
  private async withKeepRecentTailStamp(
    metadata: Extract<MuxMessageMetadata, { type: "compaction-request" }>,
    options: SendMessageOptions | undefined
  ): Promise<MuxMessageMetadata> {
    const stamp = await this.computeKeepRecentTailStamp(options);
    return stamp === undefined ? metadata : { ...metadata, keepRecentTail: stamp };
  }

  private buildAutoCompactionRequest(params: {
    followUpContent: CompactionFollowUpRequest;
    baseOptions: SendMessageOptions;
    reason: "on-send" | "mid-stream";
  }): {
    messageText: string;
    metadata: MuxMessageMetadata;
    sendOptions: SendMessageOptions;
    agentInitiated: boolean;
  } {
    // Unified resolution for agent "compact": the workspace's compact bucket
    // and configured compact defaults win over the active stream's settings
    // (parent runtime) — the stream's level was chosen for its model, not the
    // compaction model. Callers pass the stream settings in baseOptions; avoid
    // ambient session state here because the current stream is cleared before
    // compaction and could go stale.
    const inputs = this.getCompactionResolverInputs();
    const resolved = resolveAgentAiSettings({
      targetAgentId: "compact",
      profile: "interactive",
      agentAiDefaults: inputs.agentAiDefaults,
      targetWorkspaceSettings: inputs.compactBucket,
      parentRuntime: {
        model: params.baseOptions.model,
        thinkingLevel: coerceThinkingLevel(params.baseOptions.thinkingLevel),
        reasoningMode: coerceOpenAIReasoningMode(params.baseOptions.reasoningMode),
      },
      providersConfig: this.getProvidersConfigSafe(),
      minThinkingLevelByModel: inputs.minThinkingLevelByModel,
    });

    const sendOptions: SendMessageOptions = {
      ...params.baseOptions,
      agentId: "compact",
      // This internal request intentionally runs the hidden compact agent, so the
      // caller's strict explicit-agent gate must not apply to it. The post-compaction
      // follow-up re-arms strictness via pickPreservedSendOptions.
      strictAgentResolution: undefined,
      skipAiSettingsPersistence: true,
      model: resolved.selected.model,
      // Effective (clamped) thinking: this internal request skips persistence,
      // so there is no user preference to preserve.
      thinkingLevel: resolved.effective.thinkingLevel,
      // Selected reasoning; the send path re-gates per model/route.
      ...(resolved.selected.reasoningMode != null
        ? { reasoningMode: resolved.selected.reasoningMode }
        : {}),
      maxOutputTokens: undefined,
      toolPolicy: [{ regex_match: ".*", action: "disable" }],
    };

    const followUpContent: CompactionFollowUpRequest =
      params.reason === "mid-stream"
        ? {
            ...params.followUpContent,
            dispatchOptions: {
              ...params.followUpContent.dispatchOptions,
              // Mid-stream compaction resumes with a generated "Continue" sentinel; unlike
              // on-send compaction, it is not the user's original prompt completing.
              source: "internal-resume",
            },
          }
        : params.followUpContent;

    const messageText = buildCompactionMessageText({ followUpContent });

    const metadata: MuxMessageMetadata = {
      type: "compaction-request",
      rawCommand: "/compact",
      commandPrefix: "/compact",
      parsed: {
        model: sendOptions.model,
        followUpContent,
      },
      requestedModel: sendOptions.model,
      source: "auto-compaction",
      displayStatus: {
        emoji: "🔄",
        message:
          params.reason === "on-send"
            ? "Auto-compacting before sending..."
            : "Auto-compacting to continue...",
      },
    };

    return {
      messageText,
      metadata,
      sendOptions,
      agentInitiated: true,
    };
  }

  private async buildContinuousCompactionAttachments(head: MuxMessage[]) {
    const pending = await this.compactionHandler.peekPendingState();
    return this.buildAttachmentsFromContext({
      diffs: [...(pending?.diffs ?? []), ...extractEditedFileDiffs(head)],
      loadedSkills: mergeLoadedSkillSnapshots([
        ...this.postCompactionLoadedSkills,
        ...(pending?.loadedSkills ?? []),
        ...extractLoadedSkillSnapshotsFromMessages(head),
      ]),
      readFilePaths: mergeReadFilePaths(this.postCompactionReadFilePaths, [
        ...(pending?.readFiles ?? []),
        ...extractReadFilePaths(head),
      ]),
      reportsCompletedBeforeMs: Date.now(),
    });
  }

  private getContinuousCompactionContext(
    model: string,
    options?: SendMessageOptions
  ): SessionCompactionContext {
    const providersConfig = this.getProvidersConfigSafe();
    const enabled =
      options?.experiments?.continuousCompaction ??
      (typeof this.aiService.isExperimentEnabled === "function" &&
        this.aiService.isExperimentEnabled(EXPERIMENT_IDS.CONTINUOUS_COMPACTION));
    return {
      enabled:
        enabled &&
        this.compactionMonitor.getThreshold() < 1 &&
        !this.coordinator.disposed &&
        !this.coordinator.closing &&
        !this.continuousCompactionAbandoned &&
        !this.coordinator.admissionBlocked &&
        !this.coordinator.editReserved &&
        !this.isWorkspaceArchivedOnDisk(),
      model,
      contextWindowTokens:
        getEffectiveContextLimit(
          model,
          this.is1MContextEnabledForModel(model, options, providersConfig),
          providersConfig
        ) ?? 0,
      thresholdPercent: this.compactionMonitor.getThreshold() * 100,
      systemMessageTokens:
        this.streamManager.getStreamInfo(this.workspaceId)?.initialMetadata?.systemMessageTokens ??
        this.lastSystemMessageTokens,
      sendOptions: options,
    };
  }

  private async observeContinuousCompactionAtStreamEnd(
    model: string,
    options?: SendMessageOptions
  ): Promise<void> {
    // fastApply waits for this handler to reach IDLE; waiting on its latch here
    // (or re-entering it from the generated Continue send) would deadlock.
    if (
      this.midStreamCompactionPending ||
      this.continuousCompactor.isApplying() ||
      this.deferQueuedFlushUntilAfterEdit
    )
      return;
    const epoch = this.coordinator.compactionIntent.epoch;
    try {
      const context = this.getContinuousCompactionContext(model, options);
      if (!context.enabled && !this.continuousCompactor.hasConsumedSwap()) {
        this.continuousCompactor.reset("disabled");
        return;
      }
      const usage = this.compactionMonitor.checkBeforeSend({
        model,
        usage: this.getUsageState(),
        use1MContext: this.is1MContextEnabledForModel(
          model,
          options,
          this.getProvidersConfigSafe()
        ),
        providersConfig: this.getProvidersConfigSafe(),
      });
      const result = await this.continuousCompactor.observe(usage.usagePercentage, {
        ...context,
        phase: "stream-end",
      });
      if (
        result === "applied" &&
        epoch === this.coordinator.compactionIntent.epoch &&
        !this.coordinator.closing
      )
        this.clearUsageState();
    } catch (error) {
      await this.recoverContinuousCompactionFailure(error);
    }
  }

  private async recoverContinuousCompactionFailure(
    error: unknown,
    ownsObservation = false
  ): Promise<void> {
    log.warn(
      "[continuous-compaction] observation failed; preserving durable recovery state",
      error
    );
    try {
      // An invalidated prepareStep waits for abort. If failure preceded the stop,
      // release that wait without resetting the consumed journal or saved follow-up.
      if (
        (!ownsObservation && this.midStreamCompactionPending) ||
        !this.streamManager.isStreaming(this.workspaceId) ||
        this.streamManager.getPrefixSwapState?.(this.workspaceId) !== "invalidated"
      )
        return;
      const result = await this.streamManager.stopStream(this.workspaceId, {
        abortReason: "system",
      });
      if (!result.success) log.warn("[continuous-compaction] recovery stop failed", result.error);
    } catch (stopError) {
      log.warn("[continuous-compaction] recovery stop failed", stopError);
    }
  }

  private async waitForContinuousCompactionObservation(): Promise<void> {
    const observation = this.coordinator.compactionIntent.observation;
    if (observation) await this.compactionObservations.get(observation.id);
  }

  private async runContinuousCompactionObservation<T>(
    observe: (token: CompactionToken) => Promise<T>
  ): Promise<T | undefined> {
    if (this.coordinator.closing) return undefined;
    using _execution = this.coordinator.enterExecution();
    const token = this.coordinator.beginCompactionObservation("continuous");
    if (!token) {
      await this.waitForContinuousCompactionObservation();
      return undefined;
    }
    const observation = Promise.withResolvers<void>();
    this.compactionObservations.set(token.id, observation.promise);
    try {
      return await observe(token);
    } catch (error) {
      if (this.coordinator.isCurrentCompaction(token))
        await this.recoverContinuousCompactionFailure(error, true);
      return undefined;
    } finally {
      // Semantic ownership can move to B while A's Promise is still finishing.
      // Always release A's waiter; only its current owner may unblock queue dispatch.
      this.compactionObservations.delete(token.id);
      if (this.coordinator.finishCompactionObservation(token)) {
        try {
          this.drainQueuedMessagesIfIdle();
        } catch (error) {
          log.warn("[continuous-compaction] queued drain failed", error);
        }
      }
      observation.resolve();
    }
  }

  private async interruptForContinuousCompaction(
    apply: (pendingFollowUp?: CompactionFollowUpRequest) => Promise<boolean>
  ): Promise<boolean> {
    const context = this.activeStreamContext;
    const token = this.coordinator.compactionIntent.observation;
    if (
      !token ||
      !this.coordinator.isCurrentCompaction(token) ||
      this.midStreamCompactionPending ||
      !context?.options ||
      this.coordinator.disposed ||
      this.coordinator.closing
    ) {
      return false;
    }
    this.coordinator.setCompactionStage(token, "stopping");
    const stopped = await this.streamManager.stopStream(this.workspaceId, {
      abortReason: "system",
    });
    if (!stopped.success || !this.coordinator.isCurrentCompaction(token)) return false;
    this.coordinator.setCompactionStage(token, "stopped");
    await this.waitForIdle();
    if (
      this.coordinator.disposed ||
      this.coordinator.closing ||
      !this.coordinator.isCurrentCompaction(token) ||
      this.isWorkspaceArchivedOnDisk()
    )
      return false;
    const followUp = this.buildContinuousCompactionFollowUp(context);
    // observe owns the apply latch. Its caller dispatches this continuation only
    // after observe returns, so the resumed send can observe normally.
    return apply(followUp);
  }

  private buildContinuousCompactionFollowUp(
    context: NonNullable<AgentSession["activeStreamContext"]>
  ): CompactionFollowUpRequest {
    assert(context.options, "Continuous compaction requires the interrupted send options");
    const followUp = this.buildAutoCompactionFollowUp({
      messageText: "Continue",
      modelForStream: context.modelString,
      options: context.options,
      agentInitiated: context.agentInitiated,
      goalKind: context.goalKind,
      goalId: context.goalId,
      muxMetadata: context.workspaceTurnMetadata,
    });
    followUp.dispatchOptions = { ...followUp.dispatchOptions, source: "internal-resume" };
    return followUp;
  }

  private async finishContinuousCompaction(
    applied: boolean,
    context: NonNullable<AgentSession["activeStreamContext"]>,
    token: CompactionToken
  ): Promise<void> {
    assert(
      !this.continuousCompactor.isApplying(),
      "Continue must dispatch after the apply latch clears"
    );
    if (
      this.coordinator.compactionIntent.observation?.id !== token.id ||
      this.coordinator.compactionIntent.observation.stage !== "stopped" ||
      !context.options
    )
      return;
    // A consumed journal is an outstanding durable obligation, not a failed
    // speculative summary. Leave it retryable instead of resetting into legacy compaction.
    if (!applied && this.continuousCompactor.hasConsumedSwap()) return;
    if (!applied) {
      const followUp = this.buildContinuousCompactionFollowUp(context);
      // The completed step can outgrow the staged tail budget during stop.
      // We already interrupted the turn, so recover using its captured context
      // rather than relying on activeStreamContext (cleared by stream-abort).
      if (
        !this.coordinator.isCurrentCompaction(token) ||
        this.coordinator.disposed ||
        this.coordinator.closing ||
        this.isWorkspaceArchivedOnDisk() ||
        this.coordinator.admissionBlocked
      )
        return;
      const pressure = this.compactionMonitor.checkBeforeSend({
        model: context.modelString,
        usage: this.getUsageState(),
        use1MContext: this.is1MContextEnabledForModel(
          context.modelString,
          context.options,
          context.providersConfig
        ),
        providersConfig: context.providersConfig,
      });
      if (pressure.shouldForceCompact) {
        await eventSpine.run("compaction.prepare", {
          workspaceId: this.workspaceId,
          reason: "mid-stream",
        });
      }
      if (!this.coordinator.isCurrentCompaction(token)) return;
      const fallback = pressure.shouldForceCompact
        ? this.buildAutoCompactionRequest({
            baseOptions: context.options,
            followUpContent: followUp,
            reason: "mid-stream",
          })
        : undefined;
      this.continuousCompactor.reset("failed-fast-apply");
      this.coordinator.setCompactionStage(token, "dispatching");
      const sent = await this.sendMessage(
        fallback?.messageText ?? followUp.text,
        fallback ? { ...fallback.sendOptions, muxMetadata: fallback.metadata } : context.options,
        {
          synthetic: true,
          compactionHandoff: token,
          agentInitiated: fallback?.agentInitiated ?? context.agentInitiated,
          goalKind: fallback ? undefined : context.goalKind,
          goalId: fallback ? undefined : context.goalId,
          admissionStale: () => !this.coordinator.isCurrentCompaction(token),
        }
      );
      if (!sent.success && !sent.failureHandled && this.coordinator.isCurrentCompaction(token)) {
        this.emitChatEvent(createStreamErrorMessage(buildStreamErrorEventData(sent.error)));
      }
      return;
    }
    if (this.coordinator.isCurrentCompaction(token)) this.lastUsageState = undefined;
    const summaryId = this.pendingCompactionFollowUpSummaryId;
    await this.dispatchPendingFollowUp(
      summaryId ?? undefined,
      () => !this.coordinator.isCurrentCompaction(token)
    );
    if (
      this.coordinator.isCurrentCompaction(token) &&
      this.pendingCompactionFollowUpSummaryId === summaryId
    )
      this.coordinator.recordCompactionSummary(null);
  }

  private async interruptForCompaction(): Promise<void> {
    if (this.midStreamCompactionPending || this.coordinator.closing) {
      return;
    }
    using _execution = this.coordinator.enterExecution();

    const streamContext = this.activeStreamContext;
    if (!streamContext?.modelString || !streamContext.options) {
      return;
    }

    const token = this.coordinator.beginCompactionObservation("legacy");
    if (!token) return;
    const interruptedUserMessageId = this.activeStreamUserMessageId;
    this.continuousCompactor.reset("legacy-fallback");

    this.coordinator.setCompactionStage(token, "stopping");
    try {
      const stopResult = await this.streamManager.stopStream(this.workspaceId, {
        abortReason: "system",
      });
      if (!stopResult.success) {
        log.warn("Failed to stop stream for mid-stream compaction", {
          workspaceId: this.workspaceId,
          error: stopResult.error,
        });
        return;
      }

      await this.waitForIdle();
      if (!this.coordinator.isCurrentCompaction(token)) {
        return;
      }

      const followUpContent = this.buildAutoCompactionFollowUp({
        // Keep mid-stream auto-compaction on the shared default sentinel so
        // buildCompactionMessageText can hide the internal resume marker.
        messageText: "Continue",
        options: streamContext.options,
        agentInitiated: streamContext.agentInitiated,
        goalKind: streamContext.goalKind,
        goalId: streamContext.goalId,
        modelForStream: streamContext.modelString,
        muxMetadata: streamContext.workspaceTurnMetadata,
      });
      // Waterfall hook point: see the on-send compaction.prepare run above.
      await eventSpine.run("compaction.prepare", {
        workspaceId: this.workspaceId,
        reason: "mid-stream",
      });

      if (!this.coordinator.isCurrentCompaction(token)) return;
      this.coordinator.setCompactionStage(token, "dispatching");
      const autoCompactionRequest = this.buildAutoCompactionRequest({
        followUpContent,
        baseOptions: streamContext.options,
        reason: "mid-stream",
      });

      const sendResult = await this.sendMessage(
        autoCompactionRequest.messageText,
        {
          ...autoCompactionRequest.sendOptions,
          muxMetadata: autoCompactionRequest.metadata,
        },
        {
          synthetic: true,
          agentInitiated: autoCompactionRequest.agentInitiated,
          compactionHandoff: token,
          admissionStale: () => !this.coordinator.isCurrentCompaction(token),
        }
      );
      if (!sendResult.success && this.coordinator.isCurrentCompaction(token)) {
        log.warn("Failed to dispatch mid-stream compaction request", {
          workspaceId: this.workspaceId,
          error: sendResult.error,
        });

        const failureType = sendResult.error.type;
        const handledByNestedSend = sendResult.failureHandled === true;

        if (!handledByNestedSend) {
          await this.handleStreamFailureForAutoRetry({
            type: failureType,
            message: this.extractRetryFailureMessage(sendResult.error),
          });
          await this.updateStartupAutoRetryAbandonFromFailure(
            failureType,
            interruptedUserMessageId
          );
        }

        if (
          !handledByNestedSend ||
          failureType === "runtime_not_ready" ||
          failureType === "runtime_start_failed"
        ) {
          // Mid-stream compaction already interrupted the original turn. Surface the
          // nested dispatch failure so the user gets an explicit retry/error affordance.
          const streamError = buildStreamErrorEventData(sendResult.error);
          this.emitChatEvent(createStreamErrorMessage(streamError));
        }
      }
    } finally {
      // Preflight drains deferred to this pending compaction have no other retry: if the
      // compaction request never became a turn, release the queue now (no-op when it did).
      if (this.coordinator.finishCompactionObservation(token)) this.drainQueuedMessagesIfIdle();
    }
  }

  private normalizeGatewaySendOptions(options: SendMessageOptions): SendMessageOptions {
    const normalizeModelSelection = (modelString: string): string => {
      const trimmedModelString = modelString.trim();
      // Preserve explicit gateway prefixes as user intent; otherwise keep persisted IDs canonical.
      return getExplicitGatewayPrefix(trimmedModelString)
        ? trimmedModelString
        : normalizeToCanonical(trimmedModelString);
    };

    return {
      ...options,
      model: normalizeModelSelection(options.model),
    };
  }

  async interruptStream(options?: {
    soft?: boolean;
    abandonPartial?: boolean;
  }): Promise<Result<void>> {
    this.assertNotDisposed("interruptStream");
    // Send-now callers may replace the turn immediately after this returns. Capture
    // its settlement before any await so the old abort reaches accounting and the
    // renderer before replacement PREPARING invalidates its operation identity.
    // Startup edits must still preempt a blocked envelope; soft stop only requests
    // a future boundary, so neither joins policy here.
    const interruptedPolicy = this.coordinator.captureInterruptSettlement(options?.soft);
    const publishesCancellation =
      options?.abandonPartial === true || this.midStreamCompactionPending;
    if (publishesCancellation) {
      this.coordinator.invalidateCompaction(true);
      // Register durable cancellation before any Stop await. Its independent nonce
      // survives a later manual preparation that fails before committing its row.
      const execution = this.coordinator.enterExecution();
      this.compactionCancellation
        .cancel()
        .finally(() => execution[Symbol.dispose]())
        .catch((error: unknown) =>
          log.warn("Failed to persist compaction cancellation", {
            workspaceId: this.workspaceId,
            error,
          })
        );
      this.continuousCompactor.reset("user-interrupt");
    }

    // Explicit user interruption should immediately stop any pending auto-retry loop.
    this.retryManager.cancel();

    if (options?.soft !== true) {
      this.queuedProviderToolEndAbortInFlight = false;
      this.activeToolCallIds.clear();
    }

    const stopResult = await this.streamManager.stopStream(this.workspaceId, {
      ...options,
      abortReason: "user",
    });
    if (!stopResult.success) {
      return Err(stopResult.error);
    }

    await interruptedPolicy;
    if (publishesCancellation) {
      try {
        await this.compactionCancellation.flush();
      } catch (error) {
        return Err(getErrorMessage(error));
      }
    }
    return Ok(undefined);
  }

  private async handleStreamWithHistoryFailure(
    turn: TurnId,
    operation: OperationId,
    error: SendMessageError,
    acpPromptId?: string,
    preStartErrors?: StreamErrorPayload[] | null,
    preparation?: PreparationAttempt
  ): Promise<AgentSessionResult<void>> {
    const superseded =
      !this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation);
    if (preparation) {
      await this.settlePreparationFailure(preparation, error);
      // Recovery may synchronously claim a follow-up. Its predecessor's callback has
      // settled, and PREPARING still owns the queue until policy decides the outcome.
      this.releasePreparationEdit(preparation);
    }
    // A disposed session must not persist retry/goal state or error rows
    // post-teardown (mirrors delivered completion). Settle collected recovery
    // decisions in memory so waiters cannot hang, then skip all recovery
    // bookkeeping; failureHandled keeps callers from running theirs.
    if (!this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation)) {
      for (const payload of preStartErrors ?? []) {
        this.coordinator.resolveErrorDecision(payload.messageId, "terminal");
      }
      return {
        success: false,
        error,
        failureHandled: true,
        superseded: superseded ? true : undefined,
      };
    }

    // Collected pre-start error events own this failure; the branches below
    // only cover failures that produced no error event.
    if (preStartErrors != null && preStartErrors.length > 0) {
      for (const payload of preStartErrors) {
        try {
          await this.handleStreamError(
            {
              ...payload,
              acpPromptId: payload.acpPromptId ?? acpPromptId,
            },
            operation
          );
        } finally {
          this.coordinator.resolveErrorDecision(payload.messageId, "terminal");
        }
      }
      return { success: false, error, failureHandled: true };
    }

    const failureType = error.type;

    if (failureType === "runtime_not_ready" || failureType === "runtime_start_failed") {
      const failedUserMessageId = this.activeStreamUserMessageId;
      this.activeCompactionRequest = undefined;
      this.resetActiveStreamState();
      await this.handleStreamFailureForAutoRetry({
        type: failureType,
        message: this.extractRetryFailureMessage(error),
      });
      if (!this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation))
        return { success: false, error, failureHandled: true };
      await this.updateStartupAutoRetryAbandonFromFailure(failureType, failedUserMessageId);
    } else {
      await this.handleStreamError(buildStreamErrorEventData(error, { acpPromptId }), operation);
    }

    return { success: false, error, failureHandled: true };
  }

  private async streamWithHistory(
    turn: TurnId,
    modelString: string,
    options?: SendMessageOptions,
    openaiTruncationModeOverride?: "auto" | "disabled",
    disablePostCompactionAttachments?: boolean,
    agentInitiated?: boolean,
    abortSignal?: AbortSignal,
    goalKind?: GoalSyntheticMessageKind,
    goalId?: string,
    // Session-owned per-turn holder for mid-turn thinking changes. Passed
    // explicitly (not read from the field) so a preempted turn can never pick
    // up its replacement's holder. Absent for internal retry paths.
    activeTurnThinkingOverride?: ActiveTurnThinkingOverride,
    preparation?: PreparationAttempt
  ): Promise<AgentSessionResult<void>> {
    const fail = (
      error: SendMessageError,
      acpPromptId?: string,
      preStartErrors?: StreamErrorPayload[]
    ) =>
      this.handleStreamWithHistoryFailure(
        turn,
        operation,
        error,
        acpPromptId,
        preStartErrors,
        preparation
      );
    // Re-read at every pre-stream checkpoint below: dispose or shutdown can land while a
    // recovery-initiated stream (which carries no abortSignal) awaits commitPartial, file-change
    // detection, or history reads, and must not reach the provider afterwards.
    const isStreamStartAborted = (): boolean =>
      !this.coordinator.isCurrentTurn(turn) ||
      this.coordinator.closing ||
      abortSignal?.aborted === true;

    if (isStreamStartAborted()) {
      return Ok(undefined);
    }

    const operation = this.coordinator.registerOperation(turn);
    let completionTransferred = false;
    try {
      // Reset per-stream flags (used for retries / crash-safe bookkeeping).
      this.compactionMonitor.resetForNewStream();
      this.clearLiveUsageState();
      this.ackPendingPostCompactionStateOnStreamEnd = false;
      this.activeStreamHadAnyDelta = false;
      this.activeStreamHadPostCompactionInjection = false;
      const providersConfig = this.getProvidersConfigSafe();
      this.activeStreamContext = {
        modelString,
        options,
        agentInitiated,
        openaiTruncationModeOverride,
        ...(goalKind != null ? { goalKind } : {}),
        ...(goalId != null ? { goalId } : {}),
        providersConfig,
      };
      this.activeStreamUserMessageId = undefined;

      const commitResult = await this.historyService.commitPartial(this.workspaceId);
      if (!commitResult.success) {
        return await fail(createUnknownSendMessageError(commitResult.error));
      }

      if (isStreamStartAborted()) {
        return Ok(undefined);
      }

      // Detect external file edits (timestamp-based polling) BEFORE reading history
      // and append the <system-file-update> notification as a durable row. The
      // provider request is built purely from chat.jsonl, so anything the model
      // sees must be logged first — there is no request-time injection path.
      // Detection is side-effect-free; tracker state advances via commit() only
      // AFTER the notification row is durably appended. A retry after a startup
      // abort or append failure therefore re-detects the same change (nothing is
      // dropped), while a successful append cannot produce a duplicate row.
      const fileChangeDetection = await this.fileChangeTracker.getChangedAttachments();
      if (isStreamStartAborted()) {
        return Ok(undefined);
      }
      if (fileChangeDetection.attachments.length > 0) {
        const notificationAppendResult = await this.historyService.appendToHistory(
          this.workspaceId,
          createFileChangeNotificationMessage(fileChangeDetection.attachments)
        );
        if (!notificationAppendResult.success) {
          return await fail(createUnknownSendMessageError(notificationAppendResult.error));
        }
        fileChangeDetection.commit();
      }

      const historyResult = await this.historyService.getHistoryFromLatestBoundary(
        this.workspaceId
      );
      if (isStreamStartAborted()) {
        return Ok(undefined);
      }

      if (!historyResult.success) {
        return await fail(createUnknownSendMessageError(historyResult.error));
      }

      // A crash between snapshot and user-row appends can leave orphaned prompt
      // expansions on disk; exclude them from every provider request.
      let requestMessages = filterOrphanedMcpPromptSnapshots(historyResult.data);

      if (requestMessages.length === 0) {
        return await fail(
          createUnknownSendMessageError(
            "Cannot resume stream: workspace history is empty. Send a new message instead."
          )
        );
      }

      // Structural invariant: API requests must not end with a non-partial assistant message.
      // Partial assistants are handled by addInterruptedSentinel at transform time.
      // Non-partial trailing assistants indicate a missing user message upstream — inject a
      // [CONTINUE] sentinel so the model has a valid conversation to respond to. This is
      // defense-in-depth; callers should prefer sendMessage() which persists a real user message.
      const lastMsg = requestMessages[requestMessages.length - 1];
      if (lastMsg?.role === "assistant" && !lastMsg.metadata?.partial) {
        log.warn(
          "streamWithHistory: trailing non-partial assistant detected, injecting [CONTINUE]",
          {
            workspaceId: this.workspaceId,
            messageId: lastMsg.id,
          }
        );
        const sentinelMessage = createMuxMessage(createUserMessageId(), "user", "[CONTINUE]", {
          timestamp: Date.now(),
          synthetic: true,
        });
        await this.historyService.appendToHistory(this.workspaceId, sentinelMessage);
        const refreshed = await this.historyService.getHistoryFromLatestBoundary(this.workspaceId);
        if (refreshed.success) {
          requestMessages = filterOrphanedMcpPromptSnapshots(refreshed.data);
        }
      }

      // Capture the current user message id so retries are stable across assistant message ids.
      // Retry-eligible rows only: startup recovery matches this persisted ID
      // against shouldUseUserMessageForRetry candidates, so selecting an
      // invisible synthetic row (file-update notification, [CONTINUE] sentinel,
      // snapshot) would persist non-retryable failures against a row recovery
      // never selects and break the tail match after restart.
      const lastUserMessage = [...requestMessages]
        .reverse()
        .find((m) => this.shouldUseUserMessageForRetry(m));
      this.activeStreamUserMessageId = lastUserMessage?.id;

      this.activeCompactionRequest = this.resolveCompactionRequest(
        requestMessages,
        modelString,
        options
      );

      if (isStreamStartAborted()) {
        return Ok(undefined);
      }

      // Check if post-compaction attachments should be injected.
      const postCompactionAttachments =
        disablePostCompactionAttachments === true
          ? null
          : await this.getPostCompactionAttachmentsIfNeeded(this.isRlmCompactionEnabled(options));
      if (isStreamStartAborted()) {
        return Ok(undefined);
      }

      this.activeStreamHadPostCompactionInjection =
        postCompactionAttachments !== null && postCompactionAttachments.length > 0;

      // Apply per-model thinking floors once so desktop, mobile, and ACP requests match.
      // Tests may provide partial config mocks, so read overrides only when available.
      const maybeConfig = this.config as Config & {
        loadConfigOrDefault?: () => {
          minThinkingLevelByModel?: Record<string, ThinkingLevel>;
        } | null;
      };
      // Gateway-preserving key first (an explicit coder:<instance>/<model>
      // floor stays distinct from a direct model with the same ID), with a
      // legacy name-canonical fallback for floors persisted by older versions.
      const minThinkingOverride =
        typeof maybeConfig.loadConfigOrDefault === "function"
          ? lookupMinThinkingLevelOverride(
              maybeConfig.loadConfigOrDefault()?.minThinkingLevelByModel,
              modelString
            )
          : undefined;
      // Pass providersConfig so mapped aliases (mappedToModel -> e.g. GPT-5.6)
      // clamp against the target model's policy — otherwise a capability level
      // like native max would be stripped here before buildProviderOptions can
      // resolve the alias.
      const minThinkingLevel = resolveMinimumThinkingLevel(
        modelString,
        minThinkingOverride,
        providersConfig
      );
      const effectiveThinkingLevel = options?.thinkingLevel
        ? enforceThinkingPolicy(
            modelString,
            options.thinkingLevel,
            minThinkingLevel,
            providersConfig
          )
        : undefined;

      // Bind recordFileState to this session for the propose_plan tool
      const recordFileState = this.fileChangeTracker.record.bind(this.fileChangeTracker);

      const optionsMuxMetadata = options?.muxMetadata as MuxMessageMetadata | undefined;
      const retryMuxMetadata = lastUserMessage?.metadata?.muxMetadata;
      // Bash-monitor-wake continuations inherit the correlation of a delegated
      // workspace turn that was cut mid-work by the wake's queued dispatch, so
      // the turn's eventual terminal stream-end can settle the parent's handle.
      const streamMuxMetadata =
        optionsMuxMetadata?.type === "workspace-turn-task"
          ? optionsMuxMetadata
          : retryMuxMetadata?.type === "workspace-turn-task"
            ? retryMuxMetadata
            : retryMuxMetadata?.type === "bash-monitor-wake"
              ? inheritOpenWorkspaceTurnMetadata(requestMessages)
              : undefined;
      // Mid-stream compaction runs after the original send options have already been resolved against
      // history (notably bash-monitor wakes). Persist the actual correlation used by this stream so the
      // post-compaction continuation remains the same delegated workspace turn.
      if (this.activeStreamContext != null) {
        this.activeStreamContext.workspaceTurnMetadata = streamMuxMetadata;
      }
      const acpPromptId =
        normalizeAcpPromptId(options?.acpPromptId) ?? extractAcpPromptId(optionsMuxMetadata);
      const delegatedToolNames =
        normalizeDelegatedToolNames(options?.delegatedToolNames) ??
        extractAcpDelegatedTools(optionsMuxMetadata);

      // Fatal pre-start failures (runtime readiness, strict agent resolution)
      // emit an error event for fire-and-forget senders and then return Err;
      // collect them so the Err path resolves each exactly once.
      const preStartErrors: StreamErrorPayload[] = [];
      this.coordinator.configureOperation(operation, this.activeCompactionRequest != null);
      const resumedCancellation = preparation?.resumeCancellation;
      if (resumedCancellation) {
        const resumedUser =
          lastUserMessage ?? requestMessages.findLast((row) => row.role === "user");
        if (!resumedUser)
          return await fail(
            createUnknownSendMessageError("Cannot accept resume without a user row")
          );
        let committed = false;
        // Retry is explicit user intent but reuses its existing row. Persist that
        // acceptance before engine entry; failed preflight or a guarded no-op keeps Stop.
        const witnessed = await this.historyService.acceptResumeCancellation(
          this.workspaceId,
          resumedUser,
          resumedCancellation.nonce,
          (current) =>
            !isStreamStartAborted() &&
            this.coordinator.compactionIntent.epoch === resumedCancellation.epoch &&
            current.id === resumedUser.id &&
            current.role === "user" &&
            current.metadata?.historySequence === resumedUser.metadata?.historySequence,
          () => {
            committed = true;
          }
        );
        if (committed && resumedCancellation.nonce !== null)
          await this.retireWitnessedCompactionCancellation(resumedCancellation.nonce);
        if (!witnessed.success) return await fail(createUnknownSendMessageError(witnessed.error));
        if (
          !committed ||
          isStreamStartAborted() ||
          this.coordinator.compactionIntent.epoch !== resumedCancellation.epoch
        )
          return Ok(undefined);
      }

      const streamResult = await this.aiService.streamMessage({
        messages: requestMessages,
        workspaceId: this.workspaceId,
        modelString,
        abortSignal,
        thinkingLevel: effectiveThinkingLevel,
        // Orthogonal to thinking level; buildRequestHeaders gates it per model.
        reasoningMode: options?.reasoningMode,
        toolPolicy: options?.toolPolicy,
        additionalSystemContext: options?.additionalSystemContext,
        additionalSystemInstructions: options?.additionalSystemInstructions,
        maxOutputTokens: options?.maxOutputTokens,
        muxProviderOptions: options?.providerOptions,
        agentInitiated,
        agentId: options?.agentId,
        acpPromptId,
        delegatedToolNames,
        muxMetadata: streamMuxMetadata,
        recordFileState,
        postCompactionAttachments,
        // Invoked by AIService after runtime.ensureReady() (project-scope
        // listing needs a running runtime). Still ordered after the
        // post-compaction check above: a just-consumed compaction boundary has
        // already reset the segment cache, so this stream recomputes the context.
        resolveMemoryContext: (forModelString, memoryOptions) =>
          this.resolveMemoryContext(forModelString, memoryOptions),
        allowAgentSetGoal: options?.allowAgentSetGoal === true,
        workspaceGoalService: this.workspaceGoalService,
        experiments: options?.experiments,
        disableWorkspaceAgents: options?.disableWorkspaceAgents,
        strictAgentResolution: options?.strictAgentResolution,
        hasQueuedMessages: this.hasQueuedMessages.bind(this),
        openaiTruncationModeOverride,
        // Mid-turn thinking overrides clamp against the same floor as the
        // send-time level above (single source of truth for the floor).
        minThinkingLevel,
        activeTurnThinkingOverride,
        onPreStartError: ({ workspaceId: _workspaceId, ...payload }) =>
          preStartErrors.push(payload),
        onStreamStarting: (messageId) => {
          this.coordinator.streamStarting(operation, messageId);
        },
      });

      if (!streamResult.success) {
        if (!this.coordinator.isCurrentOperation(operation)) {
          for (const payload of preStartErrors) {
            this.coordinator.resolveErrorDecision(payload.messageId, "terminal");
          }
          return {
            success: false,
            error: streamResult.error,
            failureHandled: true,
            superseded: true,
          };
        }
        return await fail(streamResult.error, acpPromptId, preStartErrors);
      }

      if (preparation) {
        preparation.outcome = "delivered";
        // An already-resolved handle can launch recovery synchronously. Release the
        // valid edit's history exclusion first; canceled startup keeps it through its callback.
        if (
          this.coordinator.isCurrentTurn(turn) &&
          !this.coordinator.closing &&
          !abortSignal?.aborted
        )
          this.releasePreparationEdit(preparation);
      }
      this.coordinator.consumeCompletion(operation, streamResult.data).catch((error: unknown) => {
        log.error("Failed to consume turn completion", { error: getErrorMessage(error) });
      });
      completionTransferred = true;
      return Ok(undefined);
    } finally {
      // Every pre-handle return/throw retires physical startup, including history and attachment
      // failures. A delivered handle keeps ownership through independent engine + policy completion.
      if (!completionTransferred) this.coordinator.finishStartup(operation);
    }
  }

  private resolveCompactionRequest(
    history: MuxMessage[],
    modelString: string,
    options?: SendMessageOptions
  ):
    | {
        id: string;
        modelString: string;
        options?: SendMessageOptions;
        source?: "idle-compaction" | "auto-compaction";
      }
    | undefined {
    const streamIsCompaction = isCompactionRequestMetadata(options?.muxMetadata);

    for (let index = history.length - 1; index >= 0; index -= 1) {
      const message = history[index];
      if (message.role !== "user") {
        continue;
      }
      const muxMetadata = message.metadata?.muxMetadata;
      if (isCompactionRequestMetadata(muxMetadata)) {
        return {
          id: message.id,
          modelString,
          options,
          source: muxMetadata.source,
        };
      }

      // Snapshot rows can follow a synthetic compaction request before stream startup.
      // Skip only those rows when the current send options identify this stream as compaction.
      if (!streamIsCompaction || message.metadata?.synthetic !== true) {
        return undefined;
      }
    }
    return undefined;
  }

  private async clearFailedAssistantMessage(messageId: string, reason: string): Promise<void> {
    this.coordinator.invalidateCompaction();
    this.continuousCompactor.reset("delete-message");
    const [partialResult, deleteMessageResult] = await Promise.all([
      this.historyService.deletePartial(this.workspaceId),
      this.historyService.deleteMessage(this.workspaceId, messageId),
    ]);

    if (!partialResult.success) {
      log.warn("Failed to clear partial before retry", {
        workspaceId: this.workspaceId,
        reason,
        error: partialResult.error,
      });
    }

    if (
      !deleteMessageResult.success &&
      !(
        typeof deleteMessageResult.error === "string" &&
        deleteMessageResult.error.includes("not found in history")
      )
    ) {
      log.warn("Failed to delete failed assistant placeholder", {
        workspaceId: this.workspaceId,
        reason,
        error: deleteMessageResult.error,
      });
    }
  }

  private async finalizeCompactionRetry(messageId: string): Promise<void> {
    this.activeCompactionRequest = undefined;
    this.resetActiveStreamState();
    this.emitChatEvent({
      type: "stream-abort",
      workspaceId: this.workspaceId,
      messageId,
    });
    await this.clearFailedAssistantMessage(messageId, "compaction-retry");
  }

  private supports1MContextRetry(modelString: string): boolean {
    return supports1MContext(modelString, this.getProvidersConfigSafe());
  }

  private withAnthropic1MContext(
    modelString: string,
    options: SendMessageOptions | undefined
  ): SendMessageOptions | null {
    if (options) {
      const existingModels = options.providerOptions?.anthropic?.use1MContextModels ?? [];
      const nextProviderOptions = {
        ...options.providerOptions,
        anthropic: {
          ...options.providerOptions?.anthropic,
          use1MContext: true,
          use1MContextModels: existingModels.includes(modelString)
            ? existingModels
            : [...existingModels, modelString],
        },
      };

      // Providers config resolves Coder gateway instances (the raw
      // coder:<instance>/<model> prefix is opaque without instance metadata).
      if (
        !isAnthropic1MEffectivelyEnabled(
          modelString,
          nextProviderOptions,
          this.getProvidersConfigSafe()
        )
      ) {
        return null;
      }

      return {
        ...options,
        providerOptions: nextProviderOptions,
      };
    }

    const nextProviderOptions = {
      anthropic: {
        use1MContext: true,
        use1MContextModels: [modelString],
      },
    };

    if (
      !isAnthropic1MEffectivelyEnabled(
        modelString,
        nextProviderOptions,
        this.getProvidersConfigSafe()
      )
    ) {
      return null;
    }

    return {
      model: modelString,
      agentId: WORKSPACE_DEFAULTS.agentId,
      providerOptions: nextProviderOptions,
    };
  }

  private isGptClassModel(modelString: string): boolean {
    const normalized = normalizeToCanonical(modelString);
    const [provider, modelName] = normalized.split(":", 2);
    return provider === "openai" && modelName?.toLowerCase().startsWith("gpt-");
  }

  private async maybeRetryCompactionOnContextExceeded(data: {
    messageId: string;
    errorType?: string;
  }): Promise<boolean> {
    const expectedTurnId = this.coordinator.turnId;
    const expectedOperationId = this.coordinator.operationId;
    if (data.errorType !== "context_exceeded") {
      return false;
    }

    const context = this.activeCompactionRequest;
    if (!context) {
      return false;
    }

    const isGptClass = this.isGptClassModel(context.modelString);
    const is1MCapable = this.supports1MContextRetry(context.modelString);

    if (!isGptClass && !is1MCapable) {
      return false;
    }

    let retryOptions = context.options;
    if (is1MCapable) {
      if (
        this.is1MContextEnabledForModel(
          context.modelString,
          context.options,
          this.activeStreamContext?.providersConfig ?? null
        )
      ) {
        return false;
      }

      const retryOptionsWith1M = this.withAnthropic1MContext(context.modelString, context.options);
      if (!retryOptionsWith1M) {
        return false;
      }
      retryOptions = retryOptionsWith1M;
    }

    if (this.compactionRetryAttempts.has(context.id)) {
      return false;
    }

    this.compactionRetryAttempts.add(context.id);

    const retryLabel = is1MCapable ? "Anthropic 1M context" : "OpenAI truncation";
    log.info(`Compaction hit context limit; retrying once with ${retryLabel}`, {
      workspaceId: this.workspaceId,
      model: context.modelString,
      compactionRequestId: context.id,
    });

    // Capture attribution before finalizeCompactionRetry() clears active stream state.
    const retryAgentInitiated = this.activeStreamContext?.agentInitiated;
    const retryGoalKind = this.activeStreamContext?.goalKind;
    const retryGoalId = this.activeStreamContext?.goalId;
    const retryOptionsForResume = retryOptions ?? {
      model: context.modelString,
      agentId: WORKSPACE_DEFAULTS.agentId,
    };

    await this.finalizeCompactionRetry(data.messageId);

    // r40: the completion path passes through a transient idle gap here — a
    // context-discarding mutation admitted during that gap must not race the
    // retry stream (it would snapshot the transcript the mutation discards).
    // Skipping leaves the recovery decision to the terminal path, exactly
    // like a retry that failed to start.
    if (this.coordinator.admissionBlocked) {
      log.info("Skipping compaction retry: a context-discarding history mutation is in progress", {
        workspaceId: this.workspaceId,
      });
      return false;
    }

    if (!this.coordinator.isCurrentOperation(expectedOperationId)) return false;
    let claimedTurn: TurnId | undefined;
    using _preparation = {
      [Symbol.dispose]: () => {
        if (claimedTurn != null) this.coordinator.finishPreparation(claimedTurn);
      },
    };
    const admission = this.coordinator.prepare(
      {
        kind: "fresh",
        intent: "handoff",
        expectedTurnId,
      },
      undefined,
      (turnId) => {
        claimedTurn = turnId;
        this.preparingWorkspaceTurnMetadata = getWorkspaceTurnMuxMetadata(
          retryOptionsForResume.muxMetadata
        );
      }
    );
    if (admission.status !== "admitted") return false;
    const preparedTurn = admission.turnId;
    this.setAutoRetryResumeState(
      retryOptionsForResume,
      retryAgentInitiated,
      retryGoalKind,
      retryGoalId
    );

    let retryResult: Result<void, SendMessageError>;
    try {
      retryResult = await this.streamWithHistory(
        preparedTurn,
        context.modelString,
        retryOptions,
        isGptClass ? "auto" : undefined,
        undefined,
        retryAgentInitiated,
        undefined,
        retryGoalKind,
        retryGoalId
      );
    } finally {
      if (this.coordinator.isCurrentTurn(preparedTurn)) {
        this.coordinator.finishPreparation(preparedTurn);
      }
    }
    if (!retryResult.success) {
      // Leave the recovery decision pending: the terminal path in
      // handleStreamError resolves it once settlement state is final, so
      // waiters (task/workspace-turn settlement) never observe a transient
      // "retry preparing" that already failed before stream startup.
      log.error("Compaction retry failed to start", {
        workspaceId: this.workspaceId,
        error: retryResult.error,
      });
      return false;
    }

    // streamWithHistory resolves once stream startup completed (the stream is
    // registered, so isStreaming is true); resolve the recovery decision only
    // now so waiters observe the actual retry outcome, not a pre-stream state.
    this.coordinator.resolveErrorDecision(data.messageId, "retry-started");
    return true;
  }

  private async maybeRetryWithoutPostCompactionOnContextExceeded(data: {
    messageId: string;
    errorType?: string;
  }): Promise<boolean> {
    const expectedTurnId = this.coordinator.turnId;
    const expectedOperationId = this.coordinator.operationId;
    if (data.errorType !== "context_exceeded") {
      return false;
    }

    // Only retry if we actually injected post-compaction context.
    if (!this.activeStreamHadPostCompactionInjection) {
      return false;
    }

    // Guardrail: don't retry if we've already emitted any meaningful output.
    if (this.activeStreamHadAnyDelta) {
      return false;
    }

    const requestId = this.activeStreamUserMessageId;
    const context = this.activeStreamContext;
    if (!requestId || !context) {
      return false;
    }

    if (this.postCompactionRetryAttempts.has(requestId)) {
      return false;
    }

    this.postCompactionRetryAttempts.add(requestId);

    log.info("Post-compaction context hit context limit; retrying once without it", {
      workspaceId: this.workspaceId,
      requestId,
      model: context.modelString,
    });

    // The post-compaction context is likely the culprit; discard it so we don't loop.
    this.postCompactionLoadedSkills = [];
    this.postCompactionReadFilePaths = [];
    try {
      await this.compactionHandler.discardPendingState("context_exceeded");
      this.onPostCompactionStateChange?.();
    } catch (error) {
      log.warn("Failed to discard pending post-compaction state", {
        workspaceId: this.workspaceId,
        error: getErrorMessage(error),
      });
    }

    // Abort the failed assistant placeholder and clean up persisted partial/history state.
    this.resetActiveStreamState();
    this.emitChatEvent({
      type: "stream-abort",
      workspaceId: this.workspaceId,
      messageId: data.messageId,
    });
    await this.clearFailedAssistantMessage(data.messageId, "post-compaction-retry");

    // r40: same admission gate as the compaction retry above — this path also
    // crosses a transient idle gap before re-entering PREPARING.
    if (this.coordinator.admissionBlocked) {
      log.info(
        "Skipping post-compaction retry: a context-discarding history mutation is in progress",
        { workspaceId: this.workspaceId }
      );
      return false;
    }

    // Retry the same request, but without post-compaction injection.
    if (!this.coordinator.isCurrentOperation(expectedOperationId)) return false;
    let claimedTurn: TurnId | undefined;
    using _preparation = {
      [Symbol.dispose]: () => {
        if (claimedTurn != null) this.coordinator.finishPreparation(claimedTurn);
      },
    };
    const admission = this.coordinator.prepare(
      {
        kind: "fresh",
        intent: "handoff",
        expectedTurnId,
      },
      undefined,
      (turnId) => {
        claimedTurn = turnId;
        this.preparingWorkspaceTurnMetadata = getWorkspaceTurnMuxMetadata(
          context.options?.muxMetadata
        );
      }
    );
    if (admission.status !== "admitted") return false;
    const preparedTurn = admission.turnId;

    let retryResult: Result<void, SendMessageError>;
    try {
      retryResult = await this.streamWithHistory(
        preparedTurn,
        context.modelString,
        context.options,
        context.openaiTruncationModeOverride,
        true,
        context.agentInitiated,
        undefined,
        context.goalKind,
        context.goalId
      );
    } finally {
      if (this.coordinator.isCurrentTurn(preparedTurn)) {
        this.coordinator.finishPreparation(preparedTurn);
      }
    }

    if (!retryResult.success) {
      // Leave the recovery decision pending: the terminal path in
      // handleStreamError resolves it once settlement state is final (see
      // maybeRetryCompactionOnContextExceeded).
      log.error("Post-compaction retry failed to start", {
        workspaceId: this.workspaceId,
        error: retryResult.error,
      });
      return false;
    }

    // Resolve only after startup completed so waiters observe the actual
    // retry outcome (see maybeRetryCompactionOnContextExceeded).
    this.coordinator.resolveErrorDecision(data.messageId, "retry-started");
    return true;
  }

  private async previewGoalAccountingFromUsage(input: {
    model: string;
    usage: LanguageModelV2Usage | undefined;
    providerMetadata?: Record<string, unknown>;
    metadataModel?: string;
    isCompaction?: boolean;
    goalKind?: GoalSyntheticMessageKind;
    agentInitiated?: boolean;
  }): Promise<void> {
    if (!this.workspaceGoalService) {
      return;
    }
    const displayUsage = createDisplayUsage(
      input.usage,
      input.model,
      input.providerMetadata,
      input.metadataModel
    );
    // Classify like final accounting so previews and stream-end agree on
    // whether this stream may charge a non-active goal — otherwise the Goal UI
    // shows growing maintenance cost mid-stream that snaps back at stream end.
    const streamOriginKind = getGoalStreamOriginKind(input);
    const costUsd = getTotalCost(displayUsage) ?? 0;
    try {
      await this.workspaceGoalService.previewStreamAccounting({
        workspaceId: this.workspaceId,
        costUsd,
        isCompaction: input.isCompaction === true,
        streamOriginKind,
        streamStartedAtMs: this.activeStreamStartedAtMs ?? null,
      });
    } catch (error) {
      log.warn("Failed to preview goal stream accounting", {
        workspaceId: this.workspaceId,
        error: getErrorMessage(error),
      });
    }
  }

  private async restoreGoalAccountingSnapshot(): Promise<void> {
    if (!this.workspaceGoalService) {
      return;
    }

    try {
      // Terminal stream errors do not run final goal accounting, so any
      // live cost preview from the failed stream must be discarded before
      // re-emitting the durable goal snapshot. Pass the stream start time so
      // any queued usage-delta preview from the same failed stream is ignored
      // under the goal service's workspace lock instead of repopulating stale
      // "budget used" after this restore.
      await this.workspaceGoalService.restoreGoalAccountingSnapshot(
        this.workspaceId,
        this.activeStreamStartedAtMs ?? null
      );
    } catch (error) {
      log.warn("Failed to restore goal accounting snapshot", {
        workspaceId: this.workspaceId,
        error: getErrorMessage(error),
      });
    }
  }

  private async recordGoalAccountingFromUsage(input: {
    model: string;
    usage: StreamEndEvent["metadata"]["usage"];
    providerMetadata?: Record<string, unknown>;
    metadataModel?: string;
    isCompaction?: boolean;
    goalKind?: GoalSyntheticMessageKind;
    agentInitiated?: boolean;
  }): Promise<void> {
    if (!this.workspaceGoalService) {
      return;
    }

    const displayUsage = createDisplayUsage(
      input.usage,
      input.model,
      input.providerMetadata,
      input.metadataModel
    );
    const streamOriginKind = getGoalStreamOriginKind(input);
    const costUsd = getTotalCost(displayUsage) ?? 0;
    try {
      await this.workspaceGoalService.recordStreamAccounting({
        workspaceId: this.workspaceId,
        costUsd,
        isCompaction: input.isCompaction === true,
        streamOriginKind,
        streamStartedAtMs: this.activeStreamStartedAtMs ?? null,
      });
    } catch (error) {
      log.warn("Failed to record goal stream accounting", {
        workspaceId: this.workspaceId,
        error: getErrorMessage(error),
      });
    }
  }

  private resetActiveStreamState(): void {
    this.activeToolCallIds.clear();
    this.activeStreamContext = undefined;
    this.activeStreamUserMessageId = undefined;
    this.activeStreamStartedAtMs = undefined;
    this.activeStreamHadPostCompactionInjection = false;
    this.activeStreamHadAnyDelta = false;
    this.ackPendingPostCompactionStateOnStreamEnd = false;
  }

  private async handleStreamError(
    data: StreamErrorPayload,
    operation = this.coordinator.operationId
  ): Promise<void> {
    const turn = this.coordinator.turnId;
    this.coordinator.beginPolicy(turn);
    if (!this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation))
      return;

    this.queuedProviderToolEndAbortInFlight = false;
    this.clearLiveUsageState();
    const hadCompactionRequest = this.activeCompactionRequest !== undefined;
    if (
      await this.maybeRetryCompactionOnContextExceeded({
        messageId: data.messageId,
        errorType: data.errorType,
      })
    ) {
      return; // retry set PREPARING
    }

    if (
      await this.maybeRetryWithoutPostCompactionOnContextExceeded({
        messageId: data.messageId,
        errorType: data.errorType,
      })
    ) {
      return; // retry set PREPARING
    }

    if (!this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation))
      return;
    // Terminal error — no retry succeeded
    const failedUserMessageId = this.activeStreamUserMessageId;
    const failureType = data.errorType ?? "unknown";
    const streamErrorMessage = createStreamErrorMessage(data);
    this.setTerminalStreamLifecycle("failed");
    this.terminalStreamError = streamErrorMessage;
    await this.restoreGoalAccountingSnapshot();
    if (!this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation))
      return;
    this.activeCompactionRequest = undefined;
    this.resetActiveStreamState();

    if (hadCompactionRequest && !this.coordinator.disposed) {
      this.clearQueue();
    }

    await this.handleStreamFailureForAutoRetry({
      type: failureType,
      message: data.error,
    });
    if (!this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation))
      return;
    await this.updateStartupAutoRetryAbandonFromFailure(failureType, failedUserMessageId);
    if (!this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation))
      return;
    this.coordinator.resolveErrorDecision(data.messageId, "terminal");

    this.emitChatEvent(streamErrorMessage);
    this.coordinator.finishTurn(turn);
  }

  private async handleStartupAbort(
    payload: StreamAbortEvent,
    operation = this.coordinator.operationId
  ): Promise<void> {
    const turn = this.coordinator.turnId;
    log.debug("Forwarding stream-abort without phase transition (not in STREAMING)", {
      workspaceId: this.workspaceId,
      turnPhase: this.coordinator.phase,
    });

    const preStreamAbortReason = "abortReason" in payload ? payload.abortReason : undefined;
    if (this.coordinator.phase === "preparing") {
      this.clearPreparingRuntimeStatus();
      this.setTerminalStreamLifecycle("interrupted", {
        abortReason: preStreamAbortReason,
        hadAnyOutput: false,
      });
    }
    if (preStreamAbortReason === "user") {
      await this.workspaceGoalService?.recordUserStoppedStream(this.workspaceId);
      if (!this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation))
        return;
    }
    await this.updateStartupAutoRetryAbandonFromAbort(
      preStreamAbortReason,
      this.activeStreamUserMessageId
    );
    if (!this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation))
      return;

    this.queuedProviderToolEndAbortInFlight = false;
    this.activeToolCallIds.clear();
    this.emitChatEvent(payload);
  }

  private async handleTurnAbort(
    payload: StreamAbortEvent,
    systemMessageTokens?: number,
    operation = this.coordinator.operationId
  ): Promise<void> {
    const turn = this.coordinator.turnId;
    this.coordinator.beginPolicy(turn);
    if (!this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation))
      return;
    const hadAnyOutput = this.activeStreamHadAnyDelta;
    let emittedAbort = false;
    try {
      const activeModelForAbort = this.activeStreamContext?.modelString;
      const activeOptionsForAbort = this.activeStreamContext?.options;
      this.lastSystemMessageTokens = systemMessageTokens ?? this.lastSystemMessageTokens;
      if (activeModelForAbort) {
        this.updateUsageStateFromModelUsage({
          model: activeModelForAbort,
          usage: payload.metadata?.contextUsage,
          providerMetadata:
            payload.metadata?.contextProviderMetadata ?? payload.metadata?.providerMetadata,
          live: false,
        });
      }
      this.clearLiveUsageState();

      const failedUserMessageId = this.activeStreamUserMessageId;
      const hadCompactionRequest = this.activeCompactionRequest !== undefined;
      const abortReason = "abortReason" in payload ? payload.abortReason : undefined;
      const isQueuedProviderToolEndAbort =
        this.queuedProviderToolEndAbortInFlight && abortReason !== "user";
      if (abortReason === "user") {
        await this.workspaceGoalService?.recordUserStoppedStream(this.workspaceId);
        if (
          !this.coordinator.isCurrentTurn(turn) ||
          !this.coordinator.isCurrentOperation(operation)
        )
          return;
      }
      if (activeModelForAbort) {
        // Forward goalKind / agentInitiated from the active stream context so
        // an interrupted continuation/wrap stream is correctly classified
        // as `goal_continuation` / `goal_budget_limit` and counts toward
        // the turn cap. Without this, getGoalStreamOriginKind falls back to
        // `"user"` and the interrupted synthetic turn would not consume a
        // turn, under-enforcing limits (Codex P2 PRRT_kwDOPxxmWM5_t9Bu).
        await this.recordGoalAccountingFromUsage({
          model: activeModelForAbort,
          usage: payload.metadata?.usage,
          providerMetadata: payload.metadata?.providerMetadata,
          goalKind: this.activeStreamContext?.goalKind,
          agentInitiated: this.activeStreamContext?.agentInitiated,
          isCompaction: hadCompactionRequest,
        });
        if (
          !this.coordinator.isCurrentTurn(turn) ||
          !this.coordinator.isCurrentOperation(operation)
        )
          return;
      }
      if (abortReason !== "user") {
        await this.workspaceGoalService?.applyPendingAfterStreamEnd(this.workspaceId);
        if (
          !this.coordinator.isCurrentTurn(turn) ||
          !this.coordinator.isCurrentOperation(operation)
        )
          return;
      }
      this.setTerminalStreamLifecycle("interrupted", { abortReason });
      this.activeCompactionRequest = undefined;
      this.resetActiveStreamState();
      if (!hadCompactionRequest && activeModelForAbort && !this.continuousCompactionAbandoned) {
        await this.observeContinuousCompactionAtStreamEnd(
          activeModelForAbort,
          activeOptionsForAbort
        );
        if (
          !this.coordinator.isCurrentTurn(turn) ||
          !this.coordinator.isCurrentOperation(operation)
        )
          return;
      }
      if (hadCompactionRequest && !this.coordinator.disposed) {
        this.clearQueue();
      }
      if (!isQueuedProviderToolEndAbort) {
        await this.handleStreamFailureForAutoRetry({
          type: "aborted",
          message: abortReason,
        });
        if (
          !this.coordinator.isCurrentTurn(turn) ||
          !this.coordinator.isCurrentOperation(operation)
        )
          return;
      }
      await this.updateStartupAutoRetryAbandonFromAbort(abortReason, failedUserMessageId);
      if (!this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation))
        return;
      emittedAbort = true;
      this.emitChatEvent(payload);
      const dispatchedQueuedMessage =
        !this.midStreamCompactionPending &&
        !this.continuousCompactor.isApplying() &&
        this.dispatchQueuedProviderToolEndMessageAfterAbort(abortReason);
      if (!dispatchedQueuedMessage) {
        this.coordinator.finishTurn(turn);
      }
    } finally {
      // Accounting failure must not strand COMPLETING: an edit may be waiting for idle while
      // app shutdown joins its physical lease. Keep the failure visible to the policy reporter,
      // deliver the terminal once, and never finalize a replacement admitted by a callback.
      if (
        this.coordinator.isCurrentOperation(operation) &&
        this.coordinator.isCurrentTurn(turn) &&
        this.coordinator.phase === "completing"
      ) {
        this.setTerminalStreamLifecycle("interrupted", {
          abortReason: payload.abortReason,
          hadAnyOutput,
        });
        this.activeCompactionRequest = undefined;
        this.resetActiveStreamState();
        try {
          if (!emittedAbort) this.emitChatEvent(payload);
        } finally {
          if (this.coordinator.isCurrentOperation(operation)) this.coordinator.finishTurn(turn);
        }
      }
    }
  }

  private async handleTurnSuccess(
    payload: StreamEndEvent,
    operation = this.coordinator.operationId
  ): Promise<void> {
    const turn = this.coordinator.turnId;
    this.coordinator.beginPolicy(turn);
    if (!this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation))
      return;
    this.retryManager.handleStreamSuccess();
    await this.clearStartupAutoRetryAbandon();
    if (!this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation))
      return;

    const streamEndPayload = payload;
    const activeStreamGoalKind = this.activeStreamContext?.goalKind;
    const activeStreamOptions = this.activeStreamContext?.options;

    let goalContinuationRequest: {
      sendOptions: SendMessageOptions;
      streamEndedAtMs: number;
    } | null = null;
    let emittedStreamEnd = false;
    const completedCompactionRequest = this.activeCompactionRequest;
    let continuedAfterCompaction = false;
    let handledCompaction = false;
    let followUpDispatchStarted = false;

    try {
      this.activeCompactionRequest = undefined;
      this.lastSystemMessageTokens =
        streamEndPayload.metadata.systemMessageTokens ?? this.lastSystemMessageTokens;
      this.updateUsageStateFromModelUsage({
        model: streamEndPayload.metadata.model,
        usage: streamEndPayload.metadata.contextUsage,
        providerMetadata:
          streamEndPayload.metadata.contextProviderMetadata ??
          streamEndPayload.metadata.providerMetadata,
        live: false,
      });
      this.clearLiveUsageState();

      const handled = await this.compactionHandler.handleCompletion(
        streamEndPayload,
        completedCompactionRequest?.id
      );
      handledCompaction = handled;
      if (!this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation))
        return;

      await this.recordGoalAccountingFromUsage({
        model: streamEndPayload.metadata.model,
        usage: streamEndPayload.metadata.usage,
        providerMetadata: streamEndPayload.metadata.providerMetadata,
        metadataModel: streamEndPayload.metadata.metadataModel,
        goalKind: this.activeStreamContext?.goalKind,
        agentInitiated: this.activeStreamContext?.agentInitiated,
        isCompaction: handled,
      });
      if (!this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation))
        return;
      await this.workspaceGoalService?.applyPendingAfterStreamEnd(this.workspaceId);
      if (!this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation))
        return;

      if (!handled) {
        this.emitChatEvent(payload);
        emittedStreamEnd = true;

        if (this.ackPendingPostCompactionStateOnStreamEnd) {
          this.ackPendingPostCompactionStateOnStreamEnd = false;
          try {
            await this.compactionHandler.ackPendingStateConsumed();
            if (
              !this.coordinator.isCurrentTurn(turn) ||
              !this.coordinator.isCurrentOperation(operation)
            )
              return;
          } catch (error) {
            log.warn("Failed to ack pending post-compaction state", {
              workspaceId: this.workspaceId,
              error: getErrorMessage(error),
            });
          }
          this.onPostCompactionStateChange?.();
        }
      } else {
        // CompactionHandler emits its own sanitized stream-end; mark as handled
        // so the catch block doesn't re-emit the unsanitized original payload.
        emittedStreamEnd = true;

        // Compaction collapses history to a boundary summary, so prior context-usage snapshots
        // are stale. Clear them to prevent immediate re-trigger loops on the follow-up turn.
        this.clearUsageState();

        if (completedCompactionRequest?.source === "auto-compaction") {
          this.emitChatEvent({
            type: "auto-compaction-completed",
            newUsagePercent: 0,
          });
        }
      }

      // IMPORTANT: reset BEFORE anything that can start a new stream,
      // so the next turn doesn't get its state clobbered by our cleanup.
      this.resetActiveStreamState();
      if (!handled && !completedCompactionRequest) {
        await this.observeContinuousCompactionAtStreamEnd(
          streamEndPayload.metadata.model,
          activeStreamOptions
        );
        if (
          !this.coordinator.isCurrentTurn(turn) ||
          !this.coordinator.isCurrentOperation(operation)
        )
          return;
      }

      if (handled) {
        // Dispatch follow-up AFTER reset so it can set its own stream state. Child lifecycle
        // settlement defers only when this durable continuation was actually accepted.
        // RLM keep-recent floor: when tail copies were appended the summary is
        // not the last row, so target it by ID (stashed in onCompactionComplete).
        const rlmSummaryId = this.pendingCompactionFollowUpSummaryId;
        this.coordinator.recordCompactionSummary(null);
        followUpDispatchStarted = true;
        continuedAfterCompaction = await this.dispatchPendingFollowUp(rlmSummaryId ?? undefined);
        if (
          !this.coordinator.isCurrentTurn(turn) ||
          !this.coordinator.isCurrentOperation(operation)
        )
          return;
      }

      // Stream end: auto-send queued messages (for user messages typed during streaming)
      // and suppress goal continuations for external slash workflow follow-ups waiting on idle.
      // P2: if an edit is waiting, skip the queue flush so the edit truncates first.
      const hadQueuedMessages = this.hasPendingManualFollowUp();
      const continuousApplyPending =
        this.midStreamCompactionPending || this.continuousCompactor.isApplying();
      if (this.deferQueuedFlushUntilAfterEdit || continuousApplyPending) {
        this.queuedProviderToolEndAbortInFlight = false;
        // Clear the queued-message signal while the edit flow owns the next dispatch.
        this.backgroundProcessManager.setMessageQueued(this.workspaceId, false);
        // Do not dispatch stream-end follow-ups while the edit flow is waiting
        // for IDLE; truncation must run before any synthetic turn resumes.
      } else {
        this.sendQueuedMessages("terminal");
      }

      if (
        !handled &&
        !this.deferQueuedFlushUntilAfterEdit &&
        !continuousApplyPending &&
        !hadQueuedMessages
      ) {
        const sendOptions = activeStreamOptions ?? {
          model: streamEndPayload.metadata.model,
          agentId: WORKSPACE_DEFAULTS.agentId,
        };
        if (sendOptions.agentId !== "plan" && sendOptions.agentId !== "compact") {
          // If a `goal_continuation` turn ended without any tool calls,
          // interpret the text-only finish as an implicit `complete_goal`.
          // The continuation prompt asks the agent to call `complete_goal`
          // explicitly, but real models sometimes finish with a plain
          // "looks done" reply instead — without this fallback the
          // continuation loop would re-fire on the same idle output until
          // budget/cooldown gates intervene. We restrict to continuation
          // turns (not user messages, not budget-limit wrap-ups) so a
          // user's first manual turn answered with text is never
          // mistaken for completion. `requestContinuationAfterStreamEnd`
          // below safely no-ops once the goal flips to `complete`.
          if (activeStreamGoalKind === GOAL_CONTINUATION_KIND) {
            await this.maybeAutoCompleteGoalFromSilentContinuation(streamEndPayload);
            if (
              !this.coordinator.isCurrentTurn(turn) ||
              !this.coordinator.isCurrentOperation(operation)
            )
              return;
          }

          goalContinuationRequest = {
            sendOptions,
            streamEndedAtMs: Date.now(),
          };
        }
      }
    } catch (error) {
      const streamEndCleanupError = getErrorMessage(error);
      log.error("stream-end cleanup failed", {
        workspaceId: this.workspaceId,
        error: streamEndCleanupError,
      });

      // Defense-in-depth: unblock renderer if compaction handler threw before we emitted.
      if (this.coordinator.isCurrentOperation(operation) && !emittedStreamEnd) {
        try {
          this.emitChatEvent(payload);
        } catch {
          // Best-effort; don't mask the original error.
        }
      }

      // Goal/accounting or boundary-publication failures can bypass dispatch
      // after the boundary commits. History revalidation also makes an uncommitted
      // compaction request a no-op here.
      // Stop still owns that cleanup; the terminal lease joins it before shutdown ends.
      // Once dispatch began, its own receipt protects any irrevocable continuation row.
      if (
        (handledCompaction || completedCompactionRequest != null) &&
        !followUpDispatchStarted &&
        this.coordinator.isCurrentOperation(operation) &&
        this.coordinator.compactionIntent.status === "abandoned"
      ) {
        try {
          await this.dispatchPendingFollowUp(this.pendingCompactionFollowUpSummaryId ?? undefined);
        } catch (cleanupError) {
          log.warn("Abandoned compaction follow-up cleanup failed", {
            workspaceId: this.workspaceId,
            error: getErrorMessage(cleanupError),
          });
        }
      }
    } finally {
      if (completedCompactionRequest != null) {
        this.coordinator.resolveCompactionDecision(
          streamEndPayload.messageId,
          continuedAfterCompaction
        );
      }

      // Only clean up if we're still in COMPLETING — a new turn started by
      // dispatchPendingFollowUp() or sendQueuedMessages()
      // owns the stream state now.
      if (
        this.coordinator.isCurrentOperation(operation) &&
        this.coordinator.phase === "completing"
      ) {
        this.resetActiveStreamState();
        this.coordinator.finishTurn(turn);
        if (goalContinuationRequest != null) {
          await this.workspaceGoalService?.requestContinuationAfterStreamEnd({
            workspaceId: this.workspaceId,
            sendOptions: goalContinuationRequest.sendOptions,
            streamEndedAtMs: goalContinuationRequest.streamEndedAtMs,
          });
        }
      }
    }
  }

  private attachAiListeners(): void {
    const forward = (
      event: string,
      handler: (payload: WorkspaceChatMessage) => Promise<void> | void
    ) => {
      const wrapped = (...args: unknown[]) => {
        const [payload] = args;
        if (
          typeof payload === "object" &&
          payload !== null &&
          "workspaceId" in payload &&
          (payload as { workspaceId: unknown }).workspaceId !== this.workspaceId
        ) {
          return;
        }
        void handler(payload as WorkspaceChatMessage);
      };
      this.aiListeners.push({ event, handler: wrapped });
      this.aiService.on(event, wrapped);
    };

    forward("stream-start", (payload) => {
      if (payload.type === "stream-start" && payload.replay === true) {
        // Reconnect needs the stream envelope even when its live start was already
        // admitted. Replay must not rerun start policy or revive a retired attempt.
        if (
          this.streamManager.getStreamInfo(this.workspaceId)?.messageId === payload.messageId &&
          this.coordinator.observeStreamReplay(payload.messageId)
        )
          this.emitChatEvent(payload);
        return;
      }
      if (payload.type === "stream-start" && this.coordinator.streamStarted(payload)) {
        this.emitChatEvent(payload);
      }
    });
    forward("stream-delta", (payload) => {
      this.markActiveStreamHadAnyOutput();
      this.emitChatEvent(payload);
    });
    forward("tool-call-start", (payload) => {
      this.markActiveStreamHadAnyOutput();
      this.emitChatEvent(payload);
      if (payload.type === "tool-call-start" && payload.replay !== true) {
        this.activeToolCallIds.add(payload.toolCallId);
      }
    });
    forward("tool-call-execution-start", (payload) => {
      this.emitChatEvent(payload);
    });
    forward("bash-output", (payload) => {
      this.markActiveStreamHadAnyOutput();
      this.emitChatEvent(payload);
    });
    forward("advisor-output", (payload) => {
      this.markActiveStreamHadAnyOutput();
      this.emitChatEvent(payload);
    });
    forward("advisor-reasoning-output", (payload) => {
      this.markActiveStreamHadAnyOutput();
      this.emitChatEvent(payload);
    });
    forward("task-created", (payload) => {
      this.emitChatEvent(payload);
    });
    forward("workflow-run-attached", (payload) => {
      this.emitChatEvent(payload);
    });
    forward("advisor-phase", (payload) => {
      this.emitChatEvent(payload);
    });
    forward("session-usage-delta", (payload) => {
      this.emitChatEvent(payload);
    });
    forward("tool-call-delta", (payload) => {
      this.markActiveStreamHadAnyOutput();
      this.emitChatEvent(payload);
    });
    forward("tool-call-end", async (payload) => {
      this.markActiveStreamHadAnyOutput();
      this.emitChatEvent(payload);

      // Post-compaction context state depends on plan writes + tracked file diffs.
      // Trigger a metadata refresh so the right sidebar updates immediately.
      if (
        payload.type === "tool-call-end" &&
        (payload.toolName === "propose_plan" || payload.toolName.startsWith("file_edit_"))
      ) {
        this.onPostCompactionStateChange?.();
      }

      if (payload.type === "tool-call-end" && payload.replay !== true) {
        this.activeToolCallIds.delete(payload.toolCallId);
        if (payload.providerExecuted === true && this.activeToolCallIds.size === 0) {
          await this.requestQueuedProviderToolEndDispatch();
        }
      }
    });
    forward("reasoning-delta", (payload) => {
      this.markActiveStreamHadAnyOutput();
      this.emitChatEvent(payload);
    });
    forward("reasoning-end", (payload) => this.emitChatEvent(payload));
    forward("prefix-swap-invalidated", async (payload) => {
      try {
        if (
          payload.type !== "prefix-swap-invalidated" ||
          payload.messageId !== this.streamManager.getStreamInfo(this.workspaceId)?.messageId
        )
          return;
        // Wait for the entire owning observer, including its follow-up dispatch.
        await this.waitForContinuousCompactionObservation();
        await this.continuousCompactor.waitForIdle();
        await this.waitForContinuousCompactionObservation();
        const context = this.activeStreamContext;
        if (
          !context ||
          this.continuousCompactionObserving ||
          this.midStreamCompactionPending ||
          payload.messageId !== this.streamManager.getStreamInfo(this.workspaceId)?.messageId ||
          !this.streamManager.isStreaming(this.workspaceId)
        )
          return;
        await this.runContinuousCompactionObservation(async (token) => {
          const result = await this.continuousCompactor.observe(0, {
            ...this.getContinuousCompactionContext(context.modelString, context.options),
            phase: "mid-stream",
          });
          await this.finishContinuousCompaction(result === "applied", context, token);
        });
      } catch (error) {
        await this.recoverContinuousCompactionFailure(error);
      }
    });

    forward("usage-delta", async (payload) => {
      this.emitChatEvent(payload);

      if (payload.type !== "usage-delta") {
        return;
      }

      const modelForUsage = this.activeStreamContext?.modelString;
      if (!modelForUsage) {
        return;
      }

      this.updateUsageStateFromModelUsage({
        model: modelForUsage,
        usage: payload.usage,
        providerMetadata: payload.providerMetadata,
        live: true,
      });

      await this.previewGoalAccountingFromUsage({
        model: modelForUsage,
        usage: payload.cumulativeUsage ?? payload.usage,
        providerMetadata: payload.cumulativeProviderMetadata ?? payload.providerMetadata,
        metadataModel: resolveModelForMetadata(
          modelForUsage,
          this.activeStreamContext?.providersConfig ?? null
        ),
        isCompaction: this.activeCompactionRequest !== undefined,
        goalKind: this.activeStreamContext?.goalKind,
        agentInitiated: this.activeStreamContext?.agentInitiated,
      });

      // Never recurse compaction while we're already running a compaction request.
      if (
        this.activeCompactionRequest ||
        this.midStreamCompactionPending ||
        this.continuousCompactionObserving
      ) {
        return;
      }

      const streamContext = this.activeStreamContext;
      const streamOptions = streamContext?.options;
      if (streamContext?.modelString !== modelForUsage) return;
      const continuousContext = this.getContinuousCompactionContext(modelForUsage, streamOptions);
      const usagePercent =
        continuousContext.contextWindowTokens > 0
          ? ((payload.usage.inputTokens ?? payload.usage.cachedInputTokens ?? 0) /
              continuousContext.contextWindowTokens) *
            100
          : 0;
      if (!continuousContext.enabled) this.continuousCompactor.reset("disabled");
      const consumedSwapPending = this.continuousCompactor.hasConsumedSwap();
      let continuousResult: "none" | "applied" | "fallback" = "none";
      if (continuousContext.enabled || consumedSwapPending) {
        // One usage handler owns the eventual resume; observe itself shares its
        // latch result, which must not dispatch the continuation twice.
        const observed = await this.runContinuousCompactionObservation(async (token) => {
          const result = await this.continuousCompactor.observe(usagePercent, {
            ...continuousContext,
            phase: "mid-stream",
          });
          if (this.midStreamCompactionPending) {
            await this.finishContinuousCompaction(result === "applied", streamContext, token);
            return undefined;
          }
          if (result === "applied" && this.coordinator.isCurrentCompaction(token))
            this.clearUsageState();
          return result;
        });
        if (observed === undefined) return;
        continuousResult = observed;
      }
      if (
        continuousResult === "applied" ||
        ((continuousContext.enabled || consumedSwapPending) && continuousResult !== "fallback")
      )
        return;
      if (this.activeStreamContext !== streamContext) return;
      const shouldInterruptForCompaction = this.compactionMonitor.checkMidStream({
        model: modelForUsage,
        usage: payload.usage,
        use1MContext: this.is1MContextEnabledForModel(
          modelForUsage,
          streamOptions,
          streamContext?.providersConfig ?? null
        ),
        providersConfig: streamContext?.providersConfig ?? null,
        openaiWireFormat: streamOptions?.providerOptions?.openai?.wireFormat,
      });

      if (shouldInterruptForCompaction) {
        await this.interruptForCompaction();
      }
    });
    forward("stream-abort", (payload) => {
      if (payload.type !== "stream-abort") return;
      if (this.forwardDisposalTerminal(payload)) return;
      if (this.finishObservedStream(payload.messageId, payload)) return;
      if (this.coordinator.observeStartupAbort(payload)) return this.handleStartupAbort(payload);
      this.coordinator.rawTerminal("aborted", payload.messageId);
    });
    forward("runtime-status", (payload) => {
      if (payload.type === "runtime-status") {
        this.updatePreparingRuntimeStatus(payload);
      }
      this.emitChatEvent(payload);
    });

    forward("stream-end", (payload) => {
      if (payload.type !== "stream-end") return;
      if (this.forwardDisposalTerminal(payload)) return;
      if (this.finishObservedStream(payload.messageId, payload)) return;
      this.coordinator.rawTerminal("completed", payload.messageId);
    });

    const errorHandler = (...args: unknown[]) => {
      const [raw] = args;
      if (
        typeof raw !== "object" ||
        raw === null ||
        !("workspaceId" in raw) ||
        (raw as { workspaceId: unknown }).workspaceId !== this.workspaceId
      ) {
        return;
      }
      const data = raw as StreamErrorPayload & { workspaceId: string };
      if (
        this.finishObservedStream(data.messageId, {
          ...data,
          type: "stream-error",
          errorType: data.errorType ?? "unknown",
        })
      )
        return;
      // Begin synchronously at event emission so completion waiters always find
      // this attempt's decision before they run.
      this.coordinator.beginErrorDecision(data.messageId);
    };

    this.aiListeners.push({ event: "error", handler: errorHandler });
    this.aiService.on("error", errorHandler);
  }

  private attachInitListeners(): void {
    const forward = (event: string, handler: (payload: WorkspaceChatMessage) => void) => {
      const wrapped = (...args: unknown[]) => {
        const [payload] = args;
        if (
          typeof payload === "object" &&
          payload !== null &&
          "workspaceId" in payload &&
          (payload as { workspaceId: unknown }).workspaceId !== this.workspaceId
        ) {
          return;
        }
        // Strip workspaceId from payload before forwarding (WorkspaceInitEvent doesn't include it)
        const { workspaceId: _, ...message } = payload as WorkspaceChatMessage & {
          workspaceId: string;
        };
        handler(message as WorkspaceChatMessage);
      };
      this.initListeners.push({ event, handler: wrapped });
      this.initStateManager.on(event, wrapped as never);
    };

    forward("init-start", (payload) => this.emitChatEvent(payload));
    forward("init-output", (payload) => this.emitChatEvent(payload));
    forward("init-end", (payload) => this.emitChatEvent(payload));
  }

  private forwardDisposalTerminal(payload: StreamAbortEvent | StreamEndEvent): boolean {
    if (!this.disposePromise) return false;
    if (payload.messageId && payload.messageId === this.disposalMessageId) {
      this.disposalMessageId = undefined;
      this.emitter.emit("chat-event", {
        workspaceId: this.workspaceId,
        message: payload,
      } satisfies AgentSessionChatEvent);
    }
    return true;
  }

  private finishObservedStream(messageId: string, payload: WorkspaceChatMessage): boolean {
    return this.coordinator.finishObservedStream(messageId, () => this.emitChatEvent(payload));
  }

  // Public method to emit chat events (used by init hooks and other workspace events)
  emitChatEvent(message: WorkspaceChatMessage): void {
    // Destructive disposal keeps raw terminal presentation separate from late policy work.
    if (this.coordinator.disposed) {
      return;
    }

    const event = { workspaceId: this.workspaceId, message } satisfies AgentSessionChatEvent;
    const replay = this.replayPublication.getStore();
    if (replay && "replay" in message && message.replay === true) {
      // Async-local routing isolates concurrent reconnects without redirecting live
      // provider events or resetting another subscriber's active-stream queue state.
      replay.emittedStreamEvents = true;
      replay.listener(event);
      return;
    }
    this.emitter.emit("chat-event", event);
  }

  private publishTurnPhase(next: TurnPhase, isCurrent: () => boolean): void {
    this.clearPreparingRuntimeStatus();
    if (next !== "idle") {
      this.terminalStreamLifecycle = null;
      this.terminalStreamError = null;
    }
    this.emitStreamLifecycleIfChanged();
    // A lifecycle observer may already have admitted a replacement. Its queue attribution
    // belongs to that turn; the coordinator has separately detached the old resources/waiters.
    if (next === "idle" && isCurrent()) {
      this.dispatchingQueuedEntry = false;
      this.dispatchingQueuedEntryMuxMetadata = undefined;
      this.preparingWorkspaceTurnMetadata = undefined;
    }
  }

  isBusy(): boolean {
    // An edit reservation covers the edit flow's pre-PREPARING window (r32):
    // truncation + abandoned-branch summary can take seconds before the edit
    // turn reaches PREPARING, and a concurrent ordinary send observing an
    // idle session would interleave its rows with the edit's against moved
    // history.
    return this.coordinator.isBusy();
  }

  /**
   * r43: true while any turn is active OR mid-stream compaction is between
   * stopping the original stream and dispatching its compaction request.
   * During that window the session looks idle (turnPhase IDLE, no stream,
   * the original send's preflight already settled), but interruptForCompaction
   * will imminently call sendMessage directly — bypassing WorkspaceService
   * entry accounting — so context-discarding mutations and refine publication
   * must treat it as turn work and refuse.
   */
  hasActiveOrPendingTurnWork(): boolean {
    return this.isBusy() || this.midStreamCompactionPending;
  }

  /**
   * Number of queued message entries (including synthetic/internal ones). The
   * interrupt_active archive path compares this against the delegated queued turns it is
   * about to interrupt: any entry beyond those is user work that the sink would refuse on
   * only after the turns were already destroyed.
   */
  queuedMessageEntryCount(): number {
    return this.messageQueue.entryCount();
  }

  /**
   * r41: discard pending auto-retry state and the persisted partial as part
   * of a context-discarding history mutation. A retry scheduled before the
   * mutation (session idle during backoff) would otherwise fire after the
   * admission guard releases, commit the pre-mutation partial, and stream a
   * request derived from the discarded context. Clearing the resume request
   * makes any straggler reschedule self-abandon (missing_retry_options), and
   * deleting the partial removes the discarded transcript's tail durably.
   */
  async discardAutoRetryForContextMutation(): Promise<Result<void>> {
    this.continuousCompactor.reset("context-mutation");
    this.retryManager.cancel();
    this.setAutoRetryResumeState(undefined);
    const deleteResult = await this.historyService.deletePartial(this.workspaceId);
    if (!deleteResult.success) {
      return Err(deleteResult.error);
    }
    return Ok(undefined);
  }

  /**
   * Block new turn admission while a context-discarding history mutation
   * (reset, full clear, destructive replace) runs (r40). Unlike
   * edit reservations this does NOT claim busy-ness — the holder requires an
   * idle session — it refuses turn starts during the mutation's awaits
   * (refine drain + cross-process lock, up to seconds) that would otherwise
   * snapshot the about-to-be-discarded transcript and stream across the
   * mutation, repopulating the cleared context with derived output.
   *
   * Every idle→PREPARING entry point checks the counter in the same
   * synchronous block that sets PREPARING (or arms busy-ness); the mutation
   * arms this block and only then (re)checks busy-ness. On a single thread
   * one side always observes the other: a turn admitted first fails the
   * mutation's busy check, a mutation armed first fails the turn's admission
   * check.
   */
  holdTurnAdmission(): Disposable {
    // Refine/archive and failed mutation acquisition share this temporary gate.
    // Only committed replacement history may retire Stop's exact cleanup owner.
    return this.coordinator.reserve("admission");
  }

  async contextMutationCommitted(cancellationNonce?: string | null): Promise<void> {
    this.coordinator.invalidateCompaction(false);
    this.continuousCompactor.reset("context-mutation");
    await this.retireCompactionCancellation(cancellationNonce);
  }

  async retireCompactionCancellation(cancellationNonce?: string | null): Promise<void> {
    // null captures absence before a mutation; undefined preserves explicit repair callers.
    const nonce =
      cancellationNonce === undefined
        ? (await this.compactionCancellation.readForReplacement())?.nonce
        : cancellationNonce;
    if (nonce) await this.compactionCancellation.retire(nonce);
  }

  /**
   * Mid-turn thinking change: request that the active turn's next model step
   * uses `level`. Returns accepted:false when no turn is active — the caller
   * already persisted the setting, which covers the next turn. Last write wins
   * across consecutive calls; the pending value expires silently if the turn
   * ends before another model step occurs.
   */
  setActiveTurnThinkingLevel(level: ThinkingLevel): { accepted: boolean } {
    this.assertNotDisposed("setActiveTurnThinkingLevel");
    const holder = this.coordinator.thinkingOverride;
    if (!holder) {
      return { accepted: false };
    }
    holder.pending = level;
    return { accepted: true };
  }

  isPreparingTurn(): boolean {
    return this.coordinator.phase === "preparing";
  }

  // Back-compat alias; prefer isPreparingTurn() + isBusy().
  isStreamStarting(): boolean {
    return this.isPreparingTurn();
  }

  async waitForIdle(signal?: AbortSignal): Promise<void> {
    await this.coordinator.waitForIdle(signal);
  }

  /**
   * Slash workflow commands are user follow-ups even though they do not live in MessageQueue.
   * Reserve a manual slot while they wait so goal continuations do not outrun them at stream end.
   */
  registerExternalManualFollowUp(signal?: AbortSignal): () => void {
    return this.coordinator.registerManualFollowUp(signal);
  }

  queueMessage(
    message: string,
    options?: SendMessageOptions & { fileParts?: FilePart[] },
    internal?: {
      synthetic?: boolean;
      agentInitiated?: boolean;
      /** Request-entry authoring time captured before send preflight awaits (see MessageQueue). */
      authoredAtMs?: number;
      /** True only for a report that continues an existing workspace turn. */
      workspaceTurnContinuation?: boolean;
      /** Coalescing: drop the message when an entry with the same key is already queued. */
      dedupeKey?: string;
      /** Isolate this keyed message so it can be selectively superseded later. */
      removableDedupeKey?: boolean;
      /** Queue ahead of hidden turn-end predecessors (see MessageQueue). */
      promoteAheadOfHiddenTurnEnd?: boolean;
      onAccepted?: () => Promise<void> | void;
      onAcceptedPreStreamFailure?: (error: SendMessageError) => Promise<void> | void;
      onCanceled?: (reason: string) => Promise<void> | void;
      cancelState?: { canceledBeforeAcceptance: boolean };
      cancelSignal?: AbortSignal;
      /** Synthetic assistant rows persisted just before the dispatched turn's user row. */
      preTurnMessages?: MuxMessage[];
      /** r54: fired once pre-turn rows cross the rollback horizon at dispatch. */
      onPreTurnRowsPersisted?: () => void;
      /** Caller staleness probe re-checked at this entry's dispatch admission. */
      admissionStale?: () => boolean;
    }
  ): "tool-end" | "turn-end" | null {
    this.assertNotDisposed("queueMessage");
    const didEnqueue =
      internal?.dedupeKey != null
        ? this.messageQueue.addOnce(message, options, internal.dedupeKey, internal)
        : this.messageQueue.add(message, options, internal);
    if (!didEnqueue) {
      return null;
    }
    this.emitQueuedMessageChanged();
    // Signal to bash_output that it should return early to process queued messages
    // only for tool-end dispatches. Return the same mode so the caller's foreground
    // task waits follow the entry that will actually run, not a withdrawn FIFO head.
    const nextDispatchableMode = this.messageQueue.getNextDispatchableMode();
    this.backgroundProcessManager.setMessageQueued(
      this.workspaceId,
      nextDispatchableMode === "tool-end"
    );
    // Undefined only if the entry just added is itself withdrawn; WorkspaceService.sendMessage
    // refuses those before enqueue, so null keeps its "nothing pending was queued" meaning.
    return nextDispatchableMode ?? null;
  }

  clearQueue(cancelReason = "Queued message cleared before dispatch."): void {
    this.assertNotDisposed("clearQueue");
    using _execution = this.coordinator.enterExecution();
    const callbackSets = this.messageQueue.getClearCallbacks();
    this.messageQueue.clear();
    this.emitQueuedMessageChanged();
    this.backgroundProcessManager.setMessageQueued(this.workspaceId, false);
    for (const callbacks of callbackSets) {
      this.notifyQueuedMessageCleared(callbacks, cancelReason);
    }
  }

  setQueuedMessageDispatchMode(mode: "tool-end" | "turn-end"): boolean {
    this.assertNotDisposed("setQueuedMessageDispatchMode");
    const didUpdate = this.messageQueue.setVisibleQueueDispatchMode(mode);
    if (!didUpdate) {
      return false;
    }

    this.emitQueuedMessageChanged();
    // Only the FIFO head can dispatch next; later hidden entries must not pull an earlier
    // user-authored turn-end entry forward to a step boundary.
    this.backgroundProcessManager.setMessageQueued(
      this.workspaceId,
      this.messageQueue.getNextDispatchableMode() === "tool-end"
    );
    return true;
  }

  private notifyQueuedMessageCleared(
    callbacks: {
      onCanceled?: (reason: string) => Promise<void> | void;
      onAcceptedPreStreamFailure?: (error: SendMessageError) => Promise<void> | void;
    },
    cancelReason: string
  ): void {
    const notify = async () => {
      using _execution = this.coordinator.enterExecution();
      if (callbacks.onCanceled != null) {
        await callbacks.onCanceled(cancelReason);
        return;
      }
      await callbacks.onAcceptedPreStreamFailure?.(createUnknownSendMessageError(cancelReason));
    };
    notify().catch((error: unknown) => {
      log.error("Queued message clear callback failed", {
        workspaceId: this.workspaceId,
        error: getErrorMessage(error),
      });
    });
  }

  removeQueuedMessagesByDedupeKeyPrefix(
    prefix: string,
    cancelReason: string,
    options?: { skipCancelCallbacks?: boolean }
  ): number {
    this.assertNotDisposed("removeQueuedMessagesByDedupeKeyPrefix");
    using _execution = this.coordinator.enterExecution();
    assert(prefix.length > 0, "removeQueuedMessagesByDedupeKeyPrefix requires prefix");
    const removal = this.messageQueue.removeByDedupeKeyPrefix(prefix);
    if (removal.removedCount === 0) {
      return 0;
    }
    this.emitQueuedMessageChanged();
    this.backgroundProcessManager.setMessageQueued(
      this.workspaceId,
      this.messageQueue.getNextDispatchableMode() === "tool-end"
    );
    // Supersession is not withdrawal: a sub-agent progress report dropped because its child's
    // terminal outcome arrived carries workspace-turn continuation callbacks that would settle
    // this session's still-active delegated turn as interrupted (see
    // TaskService.wakeParentWorkspaceWithSyntheticMessage). The terminal delivery is that
    // turn's next wake, so the caller opts out of the failure notification.
    if (options?.skipCancelCallbacks !== true) {
      for (const callbacks of removal.callbacks) {
        this.notifyQueuedMessageCleared(callbacks, cancelReason);
      }
    }
    return removal.removedCount;
  }

  hasQueuedWorkspaceTurn(handleId: string): boolean {
    assert(handleId.length > 0, "hasQueuedWorkspaceTurn requires handleId");
    return this.messageQueue.hasWorkspaceTurn(handleId);
  }

  /**
   * Remove only the queued workspace-turn entry for this handle, keeping any
   * unrelated queued messages (interrupting a queued turn must not drop user
   * input queued before/behind it). Returns true when an entry was removed.
   */
  removeQueuedWorkspaceTurn(handleId: string, cancelReason: string): boolean {
    this.assertNotDisposed("removeQueuedWorkspaceTurn");
    using _execution = this.coordinator.enterExecution();
    assert(handleId.length > 0, "removeQueuedWorkspaceTurn requires handleId");
    const callbacks = this.messageQueue.removeWorkspaceTurn(handleId);
    if (callbacks == null) {
      return false;
    }
    this.emitQueuedMessageChanged();
    this.backgroundProcessManager.setMessageQueued(
      this.workspaceId,
      this.messageQueue.getNextDispatchableMode() === "tool-end"
    );
    this.notifyQueuedMessageCleared(callbacks, cancelReason);
    return true;
  }

  /** Pending work only: withdrawn (aborted) entries still occupy the queue but never start a turn. */
  hasQueuedMessages(dispatchMode?: "tool-end" | "turn-end"): boolean {
    const nextMode = this.messageQueue.getNextDispatchableMode();
    return nextMode != null && (dispatchMode == null || nextMode === dispatchMode);
  }

  /** Queued intra-tree agent peer messages awaiting dispatch (peer-message queue cap input). */
  countQueuedAgentPeerMessages(): number {
    return this.messageQueue.countAgentPeerMessageEntries();
  }

  /**
   * Whether an earlier queued, dequeued, or direct send supersedes a continuation.
   *
   * A predecessor with the same workspace-turn correlation remains part of the
   * continuation chain and does not supersede the proposed report. A send that will be
   * enqueued with promoteAheadOfHiddenTurnEnd (see MessageQueue) never dispatches behind
   * the trailing hidden turn-end entries, so those are not counted as predecessors.
   */
  hasQueuedOrDispatchingEntry(
    continuationMetadata?: WorkspaceTurnMuxMetadata,
    options?: { promoteAheadOfHiddenTurnEnd?: boolean }
  ): boolean {
    const hasDifferentPreparingSend =
      this.coordinator.phase === "preparing" &&
      !hasSameWorkspaceTurnCorrelation(this.preparingWorkspaceTurnMetadata, continuationMetadata);
    if (hasDifferentPreparingSend) {
      return true;
    }

    if (this.dispatchingQueuedEntry) {
      const dispatchingMetadata = getWorkspaceTurnMuxMetadata(
        this.dispatchingQueuedEntryMuxMetadata
      );
      if (!hasSameWorkspaceTurnCorrelation(dispatchingMetadata, continuationMetadata)) {
        return true;
      }
    }

    if (!this.messageQueue.isEmpty()) {
      if (continuationMetadata == null) {
        return true;
      }
      return options?.promoteAheadOfHiddenTurnEnd === true
        ? !this.messageQueue.hasAllWorkspaceTurnContinuationsAheadOfPromotedToolEnd(
            continuationMetadata.taskHandleId,
            continuationMetadata.ownerWorkspaceId,
            continuationMetadata.turnId
          )
        : !this.messageQueue.hasAllWorkspaceTurnContinuations(
            continuationMetadata.taskHandleId,
            continuationMetadata.ownerWorkspaceId,
            continuationMetadata.turnId
          );
    }

    return false;
  }

  /**
   * Whether a bash-monitor-wake continuation is pending dispatch: the next
   * queued entry is a wake, or a dequeued wake is mid-dispatch (dequeue →
   * stream start). Wake sends are the only input that inherits an open
   * delegated workspace turn's correlation, so TaskService uses this — not
   * generic queued/preparing state — to decide whether a correlated
   * "tool-calls" queue cut will be continued rather than superseded. Once the
   * wake's stream starts, TaskService matches the active stream's inherited
   * correlation instead (see hasSameTurnWakeContinuation).
   */
  hasPendingBashMonitorWakeContinuation(): boolean {
    if (this.messageQueue.isNextEntryBashMonitorWake()) {
      return true;
    }
    const dispatching = this.dispatchingQueuedEntryMuxMetadata as MuxMessageMetadata | undefined;
    return dispatching?.type === "bash-monitor-wake";
  }

  /**
   * Whether a queued or dispatching entry continues the exact workspace-turn correlation.
   */
  hasPendingWorkspaceTurnContinuation(
    metadata: Extract<MuxMessageMetadata, { type: "workspace-turn-task" }>
  ): boolean {
    if (hasSameWorkspaceTurnCorrelation(this.preparingWorkspaceTurnMetadata, metadata)) {
      return true;
    }

    if (
      this.messageQueue.hasNextWorkspaceTurnContinuation(
        metadata.taskHandleId,
        metadata.ownerWorkspaceId,
        metadata.turnId
      )
    ) {
      return true;
    }

    const dispatching = this.dispatchingQueuedEntryMuxMetadata as MuxMessageMetadata | undefined;
    return (
      dispatching?.type === "workspace-turn-task" &&
      dispatching.taskHandleId === metadata.taskHandleId &&
      dispatching.ownerWorkspaceId === metadata.ownerWorkspaceId &&
      dispatching.turnId === metadata.turnId
    );
  }

  /**
   * Input poised to take over this session at a queue cut. Engaged stages win
   * over the queue head; an engaged stage is reported even when its metadata is
   * undefined (manual message) so callers cannot misattribute the cut to an
   * entry queued behind it. Pure read.
   */
  getQueueCutCutter(): QueueCutCutter | undefined {
    // PREPARING covers both direct sends (preparingWorkspaceTurnMetadata set
    // alongside preparation publication) and dequeued entries (set at dequeue in
    // sendQueuedMessages). The metadata is already parsed workspace-turn
    // correlation or undefined for any other input.
    if (this.coordinator.phase === "preparing") {
      return { stage: "preparing", muxMetadata: this.preparingWorkspaceTurnMetadata };
    }
    // Dequeue-to-stream-start window after PREPARING released (e.g. a
    // background send resolved before stream-start): the dispatched entry is
    // still the engaged cutter.
    if (this.dispatchingQueuedEntry) {
      return { stage: "dispatching", muxMetadata: this.dispatchingQueuedEntryMuxMetadata };
    }
    const candidate = this.messageQueue.getNextQueueCutCandidate();
    return candidate != null ? { stage: "queued", ...candidate } : undefined;
  }

  /** Whether a message queued with this dedupe key is still pending (see MessageQueue.addOnce). */
  hasQueuedDedupeKey(dedupeKey: string): boolean {
    assert(dedupeKey.length > 0, "hasQueuedDedupeKey requires a dedupeKey");
    return this.messageQueue.hasDedupeKey(dedupeKey);
  }

  /**
   * Drop the queue when its only content is the entry queued under this dedupe key.
   * Returns true when a drop happened. Supersede semantics for scheduled maintenance
   * messages: new input must own its turn, not batch behind a pending heartbeat whose
   * muxMetadata would mislabel it.
   */
  dropQueuedMessageWithOnlyDedupeKey(dedupeKey: string): boolean {
    this.assertNotDisposed("dropQueuedMessageWithOnlyDedupeKey");
    assert(dedupeKey.length > 0, "dropQueuedMessageWithOnlyDedupeKey requires a dedupeKey");
    if (!this.messageQueue.holdsOnlyDedupeKey(dedupeKey)) {
      return false;
    }
    this.clearQueue("Scheduled message superseded by new input.");
    return true;
  }

  private async requestQueuedProviderToolEndDispatch(): Promise<void> {
    if (
      this.coordinator.phase !== "streaming" ||
      this.queuedProviderToolEndAbortInFlight ||
      this.activeToolCallIds.size > 0 ||
      !this.hasQueuedMessages("tool-end")
    ) {
      return;
    }

    this.queuedProviderToolEndAbortInFlight = true;
    const result = await this.streamManager.stopStream(this.workspaceId, {
      soft: true,
      abortReason: "system",
    });
    if (!result.success) {
      this.queuedProviderToolEndAbortInFlight = false;
      log.warn("Failed to stop stream after provider-executed tool result", {
        workspaceId: this.workspaceId,
        error: result.error,
      });
    }
  }

  private dispatchQueuedProviderToolEndMessageAfterAbort(
    abortReason: StreamAbortReason | undefined
  ): boolean {
    if (!this.queuedProviderToolEndAbortInFlight) {
      return false;
    }

    // Physical check: withdrawn entries must still drain so their onCanceled fires.
    const shouldDispatch =
      abortReason !== "user" &&
      !this.deferQueuedFlushUntilAfterEdit &&
      !this.messageQueue.isEmpty();
    this.queuedProviderToolEndAbortInFlight = false;

    if (!shouldDispatch) {
      return false;
    }

    this.sendQueuedMessages("provider-tool");
    return true;
  }

  async waitForPendingCompactionCompletionDecision(messageId: string): Promise<boolean> {
    return this.coordinator.waitForCompactionDecision(
      messageId,
      this.activeCompactionRequest != null
    );
  }

  /** Late callers receive the retained decision for their attempt, never a sampled phase. */
  async waitForPendingStreamErrorRecoveryDecision(
    messageId: string
  ): Promise<StreamErrorRecoveryOutcome | undefined> {
    return this.coordinator.waitForErrorDecision(messageId);
  }

  hasPendingAutoRetry(): boolean {
    return this.retryManager.isRetryPending || this.coordinator.retryStarting;
  }

  hasPendingManualFollowUp(): boolean {
    return !this.messageQueue.isEmpty() || this.coordinator.manualFollowUpPending;
  }

  /**
   * Restore queued user input to the composer after a user-initiated interrupt.
   * Fully synthetic background work is canceled with the queue but never surfaced
   * as editable text, so monitor wakes cannot replace or pollute the user's draft.
   */
  restoreQueueToInput(): void {
    this.assertNotDisposed("restoreQueueToInput");
    if (this.messageQueue.isEmpty()) {
      return;
    }

    const queuedMessages = this.messageQueue.getVisibleMessages();
    const displayText = this.messageQueue.getVisibleDisplayText();
    const fileParts = this.messageQueue.getVisibleFileParts();
    const reviews = this.messageQueue.getVisibleReviews();
    const hasVisibleContent =
      queuedMessages.length > 0 || fileParts.length > 0 || (reviews?.length ?? 0) > 0;

    // Clear everything: synthetic wake callbacks need cancellation so their durable
    // records do not retry after the user explicitly interrupted the workspace.
    this.clearQueue();

    if (hasVisibleContent) {
      this.emitChatEvent({
        type: "restore-to-input",
        workspaceId: this.workspaceId,
        text: displayText,
        fileParts,
        reviews,
      });
    }
  }

  private emitQueuedMessageChanged(): void {
    this.emitChatEvent({
      type: "queued-message-changed",
      workspaceId: this.workspaceId,
      hasQueuedMessages: !this.messageQueue.isEmpty(),
      queuedMessages: this.messageQueue.getVisibleMessages(),
      displayText: this.messageQueue.getVisibleDisplayText(),
      fileParts: this.messageQueue.getVisibleFileParts(),
      reviews: this.messageQueue.getVisibleReviews(),
      queueDispatchMode: this.messageQueue.getVisibleQueueDispatchMode(),
      hasCompactionRequest: this.messageQueue.hasVisibleCompactionRequest(),
    });
  }

  /**
   * Dispatch the next user-authored queued entry immediately. Hidden synthetic
   * entries remain queued behind it and resume through the normal drain lifecycle.
   */
  sendNextUserQueuedMessage(): boolean {
    this.assertNotDisposed("sendNextUserQueuedMessage");
    if (!this.messageQueue.prioritizeNextUserEntry()) {
      return false;
    }
    this.sendQueuedMessages("send-immediately");
    return true;
  }

  /**
   * Drain the queue when no turn owns the next dispatch. For callers whose
   * reservation kept a send invisible to isBusy() (WorkspaceService preflight)
   * and that settled without a turn, so no stream end will drain what queued
   * behind them. A turn in flight, a mid-stream compaction about to dispatch its
   * request, or the edit flow still owns the next dispatch, so the queue keeps
   * waiting for them. A scheduled auto-retry does not: this is the only drain
   * the queued input gets, and the retry defers to the busy session
   * (retry_deferred_busy) until stream success cancels it, matching the
   * failed-startup drains elsewhere in this file.
   */
  drainQueuedMessagesIfIdle(): void {
    if (
      this.hasActiveOrPendingTurnWork() ||
      this.deferQueuedFlushUntilAfterEdit ||
      this.messageQueue.isEmpty()
    ) {
      return;
    }
    this.sendQueuedMessages("idle");
  }

  /**
   * Send queued messages if any exist.
   * Called when the current turn ends or the user chooses to send immediately.
   */
  sendQueuedMessages(trigger: QueueDrainTrigger = "terminal"): void {
    if (
      this.coordinator.closing ||
      this.deferQueuedFlushUntilAfterEdit ||
      this.midStreamCompactionPending
    )
      return;
    using _dispatch = this.coordinator.enterExecution();
    const candidate = this.messageQueue.peekNext();
    if (candidate == null) {
      this.backgroundProcessManager.setMessageQueued(this.workspaceId, false);
      return;
    }
    const expectedTurnId = this.coordinator.turnId;
    const attempt: PreparationAttempt = {
      expectedTurn: expectedTurnId,
      outcome: "preparing",
      durability: "rollback-eligible",
      queued: false,
      failureNotified: false,
    };
    this.completePreparation(attempt, async () => {
      const admission = this.coordinator.prepare(
        { kind: "fresh", intent: trigger, expectedTurnId },
        undefined,
        (turnId) => {
          attempt.owner = turnId;
          this.dispatchingQueuedEntry = true;
          this.dispatchingQueuedEntryMuxMetadata = candidate.muxMetadata;
          this.preparingWorkspaceTurnMetadata = getWorkspaceTurnMuxMetadata(candidate.muxMetadata);
        }
      );
      if (admission.status !== "admitted") return Ok(undefined);
      const preparedTurn = admission.turnId;
      // PREPARING observers can clear/reorder the head without retiring its owner. Never
      // consume a replacement entry or notify callbacks already handled by queue removal.
      if (this.messageQueue.peekNext()?.identity !== candidate.identity) return Ok(undefined);
      attempt.queued = true;
      const { message, options, internal, enqueuedAtMs } = this.messageQueue.dequeueNext();
      attempt.onFailure = internal?.onAcceptedPreStreamFailure;
      this.dispatchingQueuedEntry = true;
      this.dispatchingQueuedEntryMuxMetadata = options?.muxMetadata;
      this.preparingWorkspaceTurnMetadata = getWorkspaceTurnMuxMetadata(options?.muxMetadata);
      this.queuedProviderToolEndAbortInFlight = false;
      this.emitQueuedMessageChanged();
      if (!this.coordinator.isCurrentTurn(preparedTurn) || this.coordinator.closing) {
        return Err(
          createUnknownSendMessageError("Queued preparation was retired before dispatch.")
        );
      }
      this.backgroundProcessManager.setMessageQueued(
        this.workspaceId,
        this.messageQueue.getNextDispatchableMode() === "tool-end"
      );
      return this.sendMessage(message, options, {
        ...internal,
        enqueuedAtMs,
        turnReservation: preparedTurn,
        preparation: attempt,
      });
    }).catch((error: unknown) => {
      log.error("Queued preparation failed", {
        workspaceId: this.workspaceId,
        error: getErrorMessage(error),
      });
    });
  }

  /**
   * If a `goal_continuation` turn finished with no `dynamic-tool` parts,
   * treat it as an implicit `complete_goal` call. The caller is expected
   * to have already gated on `activeStreamGoalKind === GOAL_CONTINUATION_KIND`
   * and on the standard plan/compact/queued-input exclusions; this helper
   * owns the parts inspection + summary synthesis.
   *
   * Requires `finishReason === "stop"` so truncated turns
   * (`"length"` / `"content-filter"` / unknown) keep the goal active and
   * can resume on the next continuation. Matches the same conservatism
   * `TaskService` uses for implicit task-report finalization (see
   * `taskService.ts` comment at the `finishReason === "stop"` gate):
   * partial assistant text must not prematurely finalize the goal.
   */
  private async maybeAutoCompleteGoalFromSilentContinuation(
    payload: StreamEndEvent
  ): Promise<void> {
    if (!this.workspaceGoalService) {
      return;
    }
    if (payload.metadata.finishReason !== "stop") {
      return;
    }
    if (payload.parts.some((part) => part.type === "dynamic-tool")) {
      return;
    }
    const summary = this.synthesizeSilentContinuationSummary(payload.parts);
    try {
      await this.workspaceGoalService.completeGoalFromSilentContinuation({
        workspaceId: this.workspaceId,
        completionSummary: summary,
      });
    } catch (error) {
      // Best-effort: never let goal-completion bookkeeping break the
      // stream-end cleanup path. The service already swallows typed
      // `Result` errors; this catch is defense-in-depth for unexpected
      // throws.
      log.warn("Failed to auto-complete goal from silent continuation", {
        workspaceId: this.workspaceId,
        error: getErrorMessage(error),
      });
    }
  }

  /** Last non-empty text part, trimmed and length-capped; falls back to a constant. */
  private synthesizeSilentContinuationSummary(parts: StreamEndEvent["parts"]): string {
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const part = parts[index];
      if (part.type !== "text") {
        continue;
      }
      const trimmed = part.text.trim();
      if (trimmed.length === 0) {
        continue;
      }
      if (trimmed.length <= SILENT_CONTINUATION_COMPLETION_SUMMARY_MAX_LENGTH) {
        return trimmed;
      }
      // Reserve one character for the ellipsis so the persisted summary
      // stays under the configured cap.
      return `${trimmed.slice(0, SILENT_CONTINUATION_COMPLETION_SUMMARY_MAX_LENGTH - 1)}…`;
    }
    return SILENT_CONTINUATION_COMPLETION_SUMMARY_FALLBACK;
  }

  /**
   * Dispatch the pending follow-up from a compaction summary message.
   * Called after compaction completes - the follow-up is stored on the summary
   * for crash safety. The user message persisted by sendMessage() serves as
   * proof of dispatch (no history rewrite needed).
   */
  private async dispatchPendingFollowUp(
    summaryMessageId?: string,
    cancelResume?: () => boolean
  ): Promise<boolean> {
    const epoch = this.coordinator.compactionIntent.epoch;
    for (;;) {
      // Keep the recovery checkpoint pending while a temporary hold excludes sends.
      // Wait outside the I/O lease so shutdown can cancel it without joining itself.
      while (this.coordinator.admissionBlocked && !this.coordinator.closing) {
        await this.coordinator.waitForAdmissionRelease();
        if (this.coordinator.compactionIntent.epoch !== epoch) return false;
      }
      const result = await this.tryDispatchPendingFollowUp(summaryMessageId, cancelResume);
      if (result !== "deferred") return result;
    }
  }

  private async tryDispatchPendingFollowUp(
    summaryMessageId?: string,
    cancelResume?: () => boolean
  ): Promise<boolean | "deferred"> {
    if (
      this.deferredCompactionCleanup &&
      !this.coordinator.canClearCompactionFollowUp(this.deferredCompactionCleanup.token)
    ) {
      this.deferredCompactionCleanup = undefined;
    }
    const deferred = this.deferredCompactionCleanup;
    if (
      (this.coordinator.disposed && !deferred) ||
      (this.coordinator.closing && this.coordinator.compactionIntent.status !== "abandoned")
    ) {
      return false;
    }
    this.deferredCompactionCleanup = undefined;
    const targetSummaryId = deferred ? deferred.summaryMessageId : summaryMessageId;
    // A leased terminal producer can reach its abandoned boundary only after
    // shutdown begins. Join its cleanup while continuing to forbid new sends.
    using _execution = this.coordinator.enterExecution();
    // Claim before history I/O: a send admitted and completed during that read
    // must not make an obsolete summary look like a fresh idle continuation.
    const token =
      deferred?.token ??
      this.coordinator.claimCompactionFollowUp() ??
      this.coordinator.claimCompactionFollowUpCleanup();
    if (!token) return false;
    const dispatch: CompactionFollowUpDispatch = deferred?.dispatch ?? { accepted: false };
    try {
      await this.compactionCancellation.flush();
      if (deferred && dispatch.summary) {
        await this.clearPendingFollowUpFromSummary(dispatch.summary, token);
        return false;
      }
      return await this.dispatchOwnedCompactionFollowUp(
        token,
        dispatch,
        targetSummaryId,
        cancelResume
      );
    } catch (error) {
      // Rejections must settle the same abandoned obligation as normal refusals.
      // Keep the captured payload guard and durable receipt: a replacement summary
      // or already-persisted Continue must never lose its recovery marker here.
      if (
        !dispatch.accepted &&
        this.coordinator.compactionIntent.status === "abandoned" &&
        this.coordinator.canClearCompactionFollowUp(token)
      ) {
        try {
          if (dispatch.summary) await this.clearPendingFollowUpFromSummary(dispatch.summary, token);
          else {
            // The initial read can fail before capturing a summary. Retry once under
            // the same abandoned owner; this path cannot admit a send or reclaim B.
            await this.dispatchOwnedCompactionFollowUp(token, dispatch, targetSummaryId);
          }
        } catch (cleanupError) {
          if (this.coordinator.canClearCompactionFollowUp(token)) {
            this.deferredCompactionCleanup = { token, dispatch, summaryMessageId: targetSummaryId };
          }
          log.warn("Abandoned compaction follow-up cleanup failed", {
            workspaceId: this.workspaceId,
            error: getErrorMessage(cleanupError),
          });
        }
      }
      throw error;
    } finally {
      if (!this.hasDeferredCompactionCleanup(token))
        this.coordinator.finishCompactionFollowUp(token);
    }
  }

  private async dispatchOwnedCompactionFollowUp(
    token: CompactionToken,
    dispatch: CompactionFollowUpDispatch,
    summaryMessageId?: string,
    cancelResume?: () => boolean
  ): Promise<boolean | "deferred"> {
    const repairRevision = this.compactionCancellation.repairRevision;
    let summaryMessage: MuxMessage | undefined;
    if (summaryMessageId) {
      const historyResult = await this.historyService.getHistoryFromLatestBoundary(
        this.workspaceId
      );
      if (!historyResult.success) {
        throw new Error(
          `Failed to read history for targeted follow-up recovery: ${historyResult.error}`
        );
      }
      const summaryIndex = historyResult.data.findIndex(
        (message) => message.id === summaryMessageId
      );
      if (summaryIndex === -1) {
        return false;
      }
      // Same staleness rule as the startup-recovery branch below: background
      // writers (family-message and refine-summary rows) can append between
      // the compaction boundary committing and this stream-end dispatch. Any
      // non-copy row after the targeted summary means the follow-up would
      // continue after unrelated content — do not fire.
      const onlyTailCopiesAfterSummary = historyResult.data
        .slice(summaryIndex + 1)
        .every((message) => message.metadata?.rlmPreservedTailCopy === true);
      if (!onlyTailCopiesAfterSummary) {
        return false;
      }
      summaryMessage = historyResult.data[summaryIndex];
    } else {
      // Read the last message from history — only need 1 message, avoid full-file read.
      // Startup recovery must retry on transient read failures, so bubble errors.
      const historyResult = await this.historyService.getLastMessages(this.workspaceId, 1);
      if (!historyResult.success) {
        const historyError =
          typeof historyResult.error === "string"
            ? historyResult.error
            : getErrorMessage(historyResult.error);
        throw new Error(`Failed to read history for startup follow-up recovery: ${historyError}`);
      }

      if (historyResult.data.length === 0) {
        return false;
      }
      summaryMessage = historyResult.data[0];

      // RLM keep-recent floor: preserved-tail copies sit after the boundary,
      // so "compaction just completed" means the epoch is exactly
      // [summary, ...tail copies]. Any non-copy row after the summary means
      // something else happened and the follow-up must not fire (same
      // staleness guard as the plain "last message is the summary" check).
      if (summaryMessage.metadata?.rlmPreservedTailCopy === true) {
        const epochResult = await this.historyService.getHistoryFromLatestBoundary(
          this.workspaceId
        );
        if (!epochResult.success) {
          throw new Error(
            `Failed to read epoch for preserved-tail follow-up recovery: ${epochResult.error}`
          );
        }
        const epoch = epochResult.data;
        const boundary = epoch[0];
        const onlyTailCopiesAfterBoundary = epoch
          .slice(1)
          .every((message) => message.metadata?.rlmPreservedTailCopy === true);
        if (boundary === undefined || !onlyTailCopiesAfterBoundary) {
          return false;
        }
        summaryMessage = boundary;
      }
    }

    const lastMessage = summaryMessage;
    const muxMeta = lastMessage.metadata?.muxMetadata;

    if (!isCompactionSummaryMetadata(muxMeta) || !muxMeta.pendingFollowUp) {
      return false;
    }
    dispatch.summary = lastMessage;

    if (!this.coordinator.isCurrentCompaction(token)) {
      // Stop cancels dispatch while retaining ownership of its durable cleanup.
      // A replacement/edit drops that ownership, so it cannot erase the new intent.
      if (this.coordinator.canClearCompactionFollowUp(token))
        await this.clearPendingFollowUpFromSummary(lastMessage, token);
      return false;
    }

    const cancellation = await this.compactionCancellation.read();
    if (!this.coordinator.isCurrentCompaction(token)) {
      if (this.coordinator.canClearCompactionFollowUp(token))
        await this.clearPendingFollowUpFromSummary(lastMessage, token);
      return false;
    }
    // A repairing read may have removed this captured follow-up from history.
    // Its now-absent fence cannot authorize the stale request we read before repair.
    if (repairRevision !== this.compactionCancellation.repairRevision) return false;
    if (cancellation && this.compactionCancellation.matches(cancellation, lastMessage)) {
      await this.clearPendingFollowUpFromSummary(lastMessage, token);
      return false;
    }

    // A user can abandon after the boundary commits but before its continuation
    // dispatches. Keep the fold, but remove the crash-recoverable resume intent.
    if (cancelResume?.()) {
      await this.clearPendingFollowUpFromSummary(lastMessage, token);
      return false;
    }

    // Handle legacy formats: older persisted requests may have `mode` instead of `agentId`,
    // and `imageParts` instead of `fileParts`.
    const followUp = muxMeta.pendingFollowUp as typeof muxMeta.pendingFollowUp & {
      mode?: "exec" | "plan";
      imageParts?: FilePart[];
    };

    // Compaction summaries are unchecked chat.jsonl. Reject malformed persisted
    // goal attribution instead of forwarding it into goal-service assertions or
    // repeatedly crashing startup recovery on the same row.
    const persistedGoalKind = coerceGoalSyntheticMessageKind(followUp.goalKind);
    const persistedGoalId = coerceGoalId(followUp.goalId);
    if (
      (followUp.goalKind !== undefined && persistedGoalKind == null) ||
      (followUp.goalId !== undefined && persistedGoalId == null)
    ) {
      log.warn("Discarding pending follow-up with malformed goal attribution", {
        workspaceId: this.workspaceId,
        summaryMessageId: lastMessage.id,
      });
      await this.clearPendingFollowUpFromSummary(lastMessage, token);
      return false;
    }

    // Codex P1 (PRRT_kwDOPxxmWM6cS8Bq): pre-upgrade summaries persisted
    // goalKind without any goalId field, so the durable admission
    // revalidation below cannot scope them — goal A could be replaced while
    // the summary sat at the tail, and redispatching its captured objective
    // as an unscoped synthetic turn would do autonomous work charged to the
    // current goal. Fail closed and discard; an active goal re-arms fresh,
    // properly scoped continuations through the normal idle/stream-end paths.
    if (persistedGoalKind != null && persistedGoalId == null) {
      log.info("Discarding legacy goal follow-up without goal identity", {
        workspaceId: this.workspaceId,
        summaryMessageId: lastMessage.id,
        goalKind: persistedGoalKind,
      });
      await this.clearPendingFollowUpFromSummary(lastMessage, token);
      return false;
    }

    // Codex P1 (PRRT_kwDOPxxmWM6cPuMw): goal-loop follow-ups were originally
    // requireIdle sends — enforce the idle rule for them unconditionally so a
    // user message queued during the compaction stream wins the race instead
    // of the synthetic continuation starting first.
    const enforceIdleRule =
      followUp.dispatchOptions?.requireIdle === true || persistedGoalKind != null;
    const hasQueuedMessages = this.hasPendingManualFollowUp();
    const hasActiveNonCompletingTurn = this.isBusy() && this.coordinator.phase !== "completing";
    // Codex P1 (PRRT_kwDOPxxmWM6cRJD-): a manual service-level send can sit
    // in its preflight (awaiting pricing/settings) without queueing or
    // holding the turn phase — it must win over the synthetic follow-up too.
    const hasExternalPreflightSend = this.hasExternalSendPreflight?.() === true;
    if (
      enforceIdleRule &&
      (hasQueuedMessages || hasActiveNonCompletingTurn || hasExternalPreflightSend)
    ) {
      log.info("Skipping pending follow-up because the workspace is no longer idle", {
        workspaceId: this.workspaceId,
        summaryMessageId: lastMessage.id,
        hasQueuedMessages,
        turnPhase: this.coordinator.phase,
      });
      await this.skipIdleRuleFollowUp(
        lastMessage,
        hasQueuedMessages || hasExternalPreflightSend,
        hasActiveNonCompletingTurn,
        token
      );
      return false;
    }

    // Derive agentId: new field has it directly, legacy may use `mode` field.
    // Legacy `mode` was "exec" | "plan" and maps directly to agentId.
    const effectiveAgentId = followUp.agentId ?? followUp.mode ?? "exec";

    // Normalize attachments: newer metadata uses `fileParts`, older persisted entries used `imageParts`.
    const effectiveFileParts = followUp.fileParts ?? followUp.imageParts;

    // Model fallback for legacy follow-ups that may lack the model field.
    // DEFAULT_MODEL is a safe fallback that's always available.
    const effectiveModel = followUp.model ?? DEFAULT_MODEL;

    // Codex P1 (PRRT_kwDOPxxmWM6cPuMw): the durable handoff preserves the
    // goal identity but not the original send's admission guards. An explicit
    // Pause (or a replacement/completion/suppression) persisted while the
    // compaction stream ran must veto the redispatch — otherwise the
    // synthetic row lands after the pause boundary and reads as fresh active
    // evidence. Revalidate against durable goal state and carry a fresh
    // staleness probe through the redispatched send's admission gates.
    let goalAdmissionStale: (() => boolean) | undefined;
    if (persistedGoalKind != null && persistedGoalId != null && this.workspaceGoalService) {
      const admission = await this.workspaceGoalService.buildGoalRedispatchAdmission(
        this.workspaceId,
        persistedGoalId,
        persistedGoalKind
      );
      if (!admission.admissible) {
        log.info("Skipping goal-scoped pending follow-up: goal no longer admits it", {
          workspaceId: this.workspaceId,
          goalKind: persistedGoalKind,
        });
        await this.clearPendingFollowUpFromSummary(lastMessage, token);
        return false;
      }
      goalAdmissionStale = admission.admissionStale;
    }

    if (!this.coordinator.isCurrentCompaction(token)) {
      if (this.coordinator.canClearCompactionFollowUp(token))
        await this.clearPendingFollowUpFromSummary(lastMessage, token);
      return false;
    }

    // Codex P1 (PRRT_kwDOPxxmWM6cQt3j): the queue/busy sample above ages
    // across the awaited goal read and the send's own preflight. Re-evaluate
    // the idle rule through the send-admission gates — all of them run before
    // this send claims the turn phase, so the probe cannot self-trip — and a
    // manual message queued during those awaits wins instead of waiting
    // behind the synthetic follow-up's stream.
    const idleRuleStale = enforceIdleRule
      ? () =>
          this.hasPendingManualFollowUp() ||
          this.hasExternalSendPreflight?.() === true ||
          (this.isBusy() && this.coordinator.phase !== "completing")
      : undefined;
    // Ordinary durable follow-ups reconstruct the interrupted request and precede
    // queued input. Optional/goal/requireIdle continuations yield to manual work.
    let sourceAppendSkipped = false;
    const followUpAdmissionStale = () =>
      sourceAppendSkipped ||
      repairRevision !== this.compactionCancellation.repairRevision ||
      !this.coordinator.isCurrentCompaction(token) ||
      idleRuleStale?.() === true ||
      goalAdmissionStale?.() === true ||
      cancelResume?.() === true;

    log.debug("Dispatching pending follow-up from compaction summary", {
      workspaceId: this.workspaceId,
      hasText: Boolean(followUp.text),
      hasFileParts: Boolean(effectiveFileParts?.length),
      hasReviews: Boolean(followUp.reviews?.length),
      model: effectiveModel,
      agentId: effectiveAgentId,
      requireIdle: followUp.dispatchOptions?.requireIdle === true,
    });

    // Process the follow-up content (handles reviews -> text formatting + metadata)
    const { finalText, metadata } = prepareUserMessageForSend(
      {
        text: followUp.text,
        fileParts: effectiveFileParts,
        reviews: followUp.reviews,
      },
      followUp.muxMetadata
    );

    // Same raw JSON boundary as below: a persisted follow-up may carry a malformed toolPolicy,
    // and restoring it unvalidated would throw during resolution. Invalid values are dropped
    // like any corrupt persisted policy (self-healing doctrine); a restricted turn's
    // follow-up must otherwise keep its policy instead of redispatching allow-all.
    const persistedToolPolicy =
      followUp.toolPolicy != null ? ToolPolicySchema.safeParse(followUp.toolPolicy) : undefined;
    if (persistedToolPolicy != null && !persistedToolPolicy.success) {
      log.warn("Ignoring malformed persisted toolPolicy on compaction follow-up", {
        workspaceId: this.workspaceId,
      });
    }

    // Build options for the follow-up message from the preserved send settings captured
    // when the compaction handoff was staged. Avoid forwarding internal-only recovery flags.
    const options: SendMessageOptions & {
      fileParts?: FilePart[];
      muxMetadata?: MuxMessageMetadata;
    } = {
      model: effectiveModel,
      agentId: effectiveAgentId,
      thinkingLevel: followUp.thinkingLevel,
      reasoningMode: followUp.reasoningMode,
      additionalSystemInstructions: followUp.additionalSystemInstructions,
      providerOptions: followUp.providerOptions,
      // Raw JSON boundary (same as the startup-retry snapshot read above): an
      // older build may have persisted {programmaticToolCalling: false,
      // programmaticToolCallingExclusive: true}, and the explicit false would
      // otherwise win over backend overrides while the removed legacy field
      // is ignored — silently downgrading the crash-safe follow-up to
      // PTC-off (and making its rlm flag inert).
      experiments: aliasLegacyPtcExclusive(followUp.experiments),
      allowAgentSetGoal: followUp.allowAgentSetGoal,
      disableWorkspaceAgents: followUp.disableWorkspaceAgents,
      ...(persistedToolPolicy?.success ? { toolPolicy: persistedToolPolicy.data } : {}),
      // Explicit-agent turns stay loud on the resumed turn too: the requested agent
      // may have been removed/hidden/disabled while compaction ran.
      strictAgentResolution: followUp.strictAgentResolution,
      skipAiSettingsPersistence: followUp.skipAiSettingsPersistence,
    };

    if (effectiveFileParts && effectiveFileParts.length > 0) {
      options.fileParts = effectiveFileParts;
    }

    if (metadata) {
      options.muxMetadata = metadata;
    }

    // Leave the follow-up pending on the summary: it dispatches on the next startup after an
    // unarchive instead of running hidden now.
    if (this.isWorkspaceArchivedOnDisk()) {
      log.debug("Pending follow-up skipped: workspace is archived", {
        workspaceId: this.workspaceId,
        summaryMessageId: lastMessage.id,
      });
      return false;
    }

    if (cancelResume?.()) {
      await this.clearPendingFollowUpFromSummary(lastMessage, token);
      return false;
    }

    // The compaction summary is now the source of truth for the next live resume
    // request. Pre-arm retry state from the reconstructed follow-up so failures
    // before stream startup do not fall back to the already-completed compact turn.
    if (!this.coordinator.isCurrentCompaction(token)) return false;
    this.setAutoRetryResumeState(
      options,
      followUp.agentInitiated,
      persistedGoalKind,
      persistedGoalId
    );

    // A hold may arrive during history/goal reads. Release this claim and wait
    // at the outer checkpoint rather than turning temporary exclusion into failure.
    if (this.coordinator.admissionBlocked) return "deferred";

    // Await sendMessage to ensure the follow-up is persisted before returning.
    // This guarantees ordering: the follow-up message is written to history
    // before sendQueuedMessages() runs, preventing race conditions.
    // Mark as synthetic so recovery/background dispatches do not implicitly
    // re-enable auto-retry after a user explicitly opted out.
    const sendResult = await this.sendMessage(finalText, options, {
      synthetic: true,
      compactionHandoff: token,
      compactionHandoffSource: {
        summary: lastMessage,
        onSkipped: () => {
          sourceAppendSkipped = true;
        },
      },
      // Goal sync and synchronous message observers run after rollback becomes
      // forbidden but before onAccepted. Stop cannot erase that durable handoff.
      onRowsDurable: () => {
        dispatch.accepted = true;
      },
      onAccepted: () => {
        dispatch.accepted = true;
      },
      agentInitiated: followUp.agentInitiated,
      goalKind: persistedGoalKind,
      // Keep the re-dispatched continuation row goal-scoped so a replaced
      // goal's follow-up cannot reactivate its successor during chat-tail
      // reconciliation (Codex P2 PRRT_kwDOPxxmWM6cIv2E).
      goalId: persistedGoalId,
      goalContinuation: persistedGoalKind === GOAL_CONTINUATION_KIND,
      // Codex P1 (PRRT_kwDOPxxmWM6cPuMw): re-derived admission guard for the
      // redispatched goal turn (see buildGoalRedispatchAdmission above).
      admissionStale: followUpAdmissionStale,
    });
    if (!sendResult.success && sendResult.admissionDeferred) return "deferred";
    if (!sendResult.success && !(dispatch.accepted && sendResult.superseded)) {
      if (!dispatch.accepted && cancelResume?.()) {
        await this.clearPendingFollowUpFromSummary(lastMessage, token);
        return false;
      }
      // A stale-admission refusal is the idle rule (or a goal transition)
      // working as intended, not a recovery failure: route it through the
      // same skip path as the pre-send check instead of throwing.
      if (!dispatch.accepted && followUpAdmissionStale?.() === true) {
        log.info("Pending follow-up refused at send admission; skipping it", {
          workspaceId: this.workspaceId,
          summaryMessageId: lastMessage.id,
        });
        await this.skipIdleRuleFollowUp(
          lastMessage,
          this.hasPendingManualFollowUp() || this.hasExternalSendPreflight?.() === true,
          this.isBusy() && this.coordinator.phase !== "completing",
          token
        );
        return false;
      }
      const message = this.extractRetryFailureMessage(sendResult.error) ?? sendResult.error.type;
      throw new Error(`Failed to dispatch pending follow-up: ${message}`);
    }

    // Success can be a pre-acceptance no-op. Conversely, an accepted send may
    // return a captured supersession error before startup; that cannot undo its
    // durable handoff. Genuine startup errors still follow the failure path above.
    if (!dispatch.accepted) return false;

    // Codex P2 (PRRT_kwDOPxxmWM6cRJEE): if the original wrap-up dispatcher
    // crashed between send acceptance and its tryMarkBudgetLimitInjected
    // commit, this redispatched follow-up owns the wrap-up now — install the
    // missing reservation so the recovered stream's end cannot arm a second
    // one. Best-effort: a failed marker write must not fail the already
    // dispatched wrap-up turn.
    if (persistedGoalKind === GOAL_BUDGET_LIMIT_KIND && persistedGoalId != null) {
      try {
        await this.workspaceGoalService?.reserveBudgetWrapupForRedispatch(
          this.workspaceId,
          persistedGoalId
        );
      } catch (error) {
        log.warn("Failed to reserve budget wrap-up after redispatch", {
          workspaceId: this.workspaceId,
          error,
        });
      }
    }

    return true;
  }

  /**
   * Shared skip path for a pending follow-up vetoed by the idle rule (or a
   * stale goal admission): heartbeat reset boundaries are rolled back so the
   * user turn sees pre-reset context; every other summary just drops its
   * pending follow-up so it cannot re-fire on a later recovery pass.
   *
   * `hasUserContention` covers queued manual input AND a service-level send
   * still in preflight (Codex P2 PRRT_kwDOPxxmWM6cRi_N): when user input is
   * the reason the heartbeat continuation was vetoed, the reset boundary must
   * be rolled back even though the message has not reached the queue yet.
   */
  private async skipIdleRuleFollowUp(
    summaryMessage: MuxMessage,
    hasUserContention: boolean,
    hasActiveNonCompletingTurn: boolean,
    token: CompactionToken
  ): Promise<void> {
    if (
      summaryMessage.metadata?.compacted === "heartbeat" &&
      hasUserContention &&
      !hasActiveNonCompletingTurn
    ) {
      const rollbackResult = await this.compactionHandler.rollbackHeartbeatContextResetBoundary(
        summaryMessage,
        () => this.coordinator.canClearCompactionFollowUp(token),
        this.onPostCompactionStateChange
      );
      if (!rollbackResult.success) {
        throw new Error(`Failed to rollback heartbeat reset boundary: ${rollbackResult.error}`);
      }
    } else {
      await this.clearPendingFollowUpFromSummary(summaryMessage, token);
    }
  }

  private async clearPendingFollowUpFromSummary(
    summaryMessage: MuxMessage,
    token: CompactionToken
  ): Promise<void> {
    assert(
      summaryMessage.role === "assistant",
      "clearPendingFollowUpFromSummary requires an assistant summary message"
    );

    const muxMeta = summaryMessage.metadata?.muxMetadata;
    assert(
      isCompactionSummaryMetadata(muxMeta),
      "clearPendingFollowUpFromSummary requires compaction-summary metadata"
    );

    if (!muxMeta.pendingFollowUp) {
      return;
    }

    if (!this.coordinator.canClearCompactionFollowUp(token)) return;
    const cancellation = await this.compactionCancellation.read();
    if (!this.coordinator.canClearCompactionFollowUp(token)) return;
    const canceled =
      cancellation != null && this.compactionCancellation.matches(cancellation, summaryMessage);
    let matched = false;
    let committed = false;
    const updateResult = await this.historyService.updateHistory(
      this.workspaceId,
      summaryMessage,
      (current) => {
        const currentMeta = current.metadata?.muxMetadata;
        // Summary finalization may change content/usage without replacing the
        // handoff. Only its durable identity and pending request authorize cleanup.
        return (
          this.coordinator.canClearCompactionFollowUp(token) &&
          current.id === summaryMessage.id &&
          current.metadata?.historySequence === summaryMessage.metadata?.historySequence &&
          current.role === "assistant" &&
          isCompactionSummaryMetadata(currentMeta) &&
          isDeepStrictEqual(currentMeta.pendingFollowUp, muxMeta.pendingFollowUp)
        );
      },
      (current) => {
        matched = true;
        const currentMeta = current.metadata?.muxMetadata;
        assert(isCompactionSummaryMetadata(currentMeta), "Cleanup requires the guarded summary");
        const { pendingFollowUp: _pendingFollowUp, ...muxMetadataWithoutFollowUp } = currentMeta;
        return {
          ...current,
          metadata: { ...current.metadata, muxMetadata: muxMetadataWithoutFollowUp },
        };
      },
      () => {
        committed = true;
      }
    );
    if (!updateResult.success) {
      // Only a target verified under the write lock may narrow an unresolved Stop.
      // A conditional no-op for obsolete A must leave a foreign successor C intact.
      if (canceled && matched && this.coordinator.canClearCompactionFollowUp(token)) {
        try {
          await this.compactionCancellation.narrow(cancellation.nonce, summaryMessage);
        } catch (error) {
          log.warn("Failed to narrow canceled compaction cleanup", {
            workspaceId: this.workspaceId,
            error,
          });
        }
      }
      throw new Error(`Failed to clear skipped pending follow-up: ${updateResult.error}`);
    }
    if (committed && canceled && this.coordinator.canClearCompactionFollowUp(token))
      await this.compactionCancellation.retire(cancellation.nonce);
  }

  /**
   * Record file state for change detection.
   * Called by tools (e.g., propose_plan) after reading/writing files.
   */
  async recordFileState(filePath: string, state: FileState): Promise<void> {
    await this.fileChangeTracker.record(filePath, state);
  }

  /** Clear all tracked file state (e.g., on /clear). */
  clearFileState(): void {
    this.fileChangeTracker.clear();
  }

  /**
   * Discard cumulative post-compaction carryover when a NEW context segment
   * starts (context reset, full history clear, destructive replace). The
   * cached read-file paths, loaded skills, and pending diff snapshot
   * summarize PRE-boundary epochs; injecting them into a later turn would
   * resurrect context the user explicitly discarded and tell the model files
   * were "previously read" when their contents are gone from active context.
   * Covers both injection routes: the immediate pending-state path (on-disk
   * post-compaction.json + handler caches) and the periodic re-merge path
   * (compactionOccurred + the in-session mirrors).
   */
  async clearPostCompactionState(): Promise<void> {
    // In-memory clears stay unconditional: they stop THIS session from
    // injecting carryover even when the durable discard below fails.
    this.compactionOccurred = false;
    this.turnsSinceLastAttachment = TURNS_BETWEEN_ATTACHMENTS;
    this.postCompactionLoadedSkills = [];
    this.postCompactionReadFilePaths = [];
    this.ackPendingPostCompactionStateOnStreamEnd = false;
    // Durable-or-throw: a swallowed unlink failure would leave the stale
    // post-compaction.json to re-inject pre-boundary carryover after a
    // restart while the boundary caller reports success — the same
    // invalidation-must-be-durable invariant as the sandbox reset tombstone.
    // Boundary callers surface the throw as a partial failure.
    await this.compactionHandler.discardPendingStateDurably("context-boundary");
    this.onPostCompactionStateChange?.();
  }

  /**
   * Resolve the memory session context (index snapshot + optional hot block)
   * for the current session segment.
   *
   * Computed lazily on the first stream for each model. The first pass is
   * index-only so final tool policy can strip memory without paying hot-set
   * tokenization cost; if memory survives policy, the cache is upgraded with
   * the token-budgeted hot block. Compaction clears the cache. Invoked by
   * AIService.streamMessage after runtime.ensureReady(): caching before the
   * runtime is started (stopped Docker/remote workspace) would pin an
   * empty/partial context for the whole segment.
   */
  private async resolveMemoryContext(
    modelString: string,
    options?: { includeHotMemories?: boolean }
  ): Promise<MemorySessionContext | undefined> {
    assert(modelString.length > 0, "resolveMemoryContext requires a model string");
    const includeHotMemories = options?.includeHotMemories !== false;
    const cached = this.memoryContextByModelString.get(modelString);
    if (cached && (cached.includesHotMemories || !includeHotMemories)) {
      return cached.context ?? undefined;
    }

    // Guard for test mocks that may not implement buildMemorySessionContext.
    const context =
      typeof this.aiService.buildMemorySessionContext === "function"
        ? await this.aiService.buildMemorySessionContext(this.workspaceId, modelString, {
            includeHotMemories,
          })
        : null;
    this.memoryContextByModelString.set(modelString, {
      context,
      includesHotMemories: includeHotMemories,
    });
    return context ?? undefined;
  }

  /**
   * Get post-compaction attachments if they should be injected this turn.
   *
   * Logic:
   * - On first turn after compaction: inject immediately, clear file state cache
   * - Subsequent turns: inject every TURNS_BETWEEN_ATTACHMENTS turns
   *
   * @returns Attachments to inject, or null if none needed
   */
  private async getPostCompactionAttachmentsIfNeeded(
    includeReadFiles: boolean
  ): Promise<PostCompactionAttachment[] | null> {
    // Check if compaction just occurred (immediate injection with cached post-compaction state)
    const pendingState = await this.compactionHandler.peekPendingState();
    if (pendingState !== null) {
      this.ackPendingPostCompactionStateOnStreamEnd = true;
      this.compactionOccurred = true;
      this.turnsSinceLastAttachment = 0;
      this.postCompactionLoadedSkills = pendingState.loadedSkills;
      this.postCompactionReadFilePaths = pendingState.readFiles;
      // Compaction boundary: invalidate the session-cached memory context so
      // the next stream recomputes the index and hot set from current
      // files/pins/usage stats.
      this.memoryContextByModelString.clear();
      // Clear file state cache since history context is gone
      this.fileChangeTracker.clear();

      return this.buildAttachmentsFromContext({
        diffs: pendingState.diffs,
        loadedSkills: pendingState.loadedSkills,
        // Read tracking is internal bookkeeping in both modes but only ever
        // model-visible in RLM mode, keeping RLM-off prompts byte-identical.
        readFilePaths: includeReadFiles ? pendingState.readFiles : [],
        // Compaction just completed, so every already-completed report predates the boundary.
        reportsCompletedBeforeMs: Date.now(),
      });
    }

    // Increment turn counter
    this.turnsSinceLastAttachment++;

    // Check cooldown for subsequent injections (re-read from current history)
    if (this.compactionOccurred && this.turnsSinceLastAttachment >= TURNS_BETWEEN_ATTACHMENTS) {
      this.turnsSinceLastAttachment = 0;
      return this.generatePostCompactionAttachments(includeReadFiles);
    }

    return null;
  }

  /**
   * Generate post-compaction attachments by extracting diffs and loaded skills from message history.
   */
  private async generatePostCompactionAttachments(
    includeReadFiles: boolean
  ): Promise<PostCompactionAttachment[]> {
    // getHistoryFromLatestBoundary already returns only the active compaction epoch,
    // so no further boundary slicing is needed.
    const historyResult = await this.historyService.getHistoryFromLatestBoundary(this.workspaceId);
    if (!historyResult.success) {
      return [];
    }

    const fileDiffs = extractEditedFileDiffs(historyResult.data);
    const loadedSkills = mergeLoadedSkillSnapshots([
      ...this.postCompactionLoadedSkills,
      ...extractLoadedSkillSnapshotsFromMessages(historyResult.data),
    ]);
    // Mirror loadedSkills: cumulative pre-boundary reads carried in memory,
    // merged with reads from the current epoch (newest-first, capped).
    const readFilePaths = includeReadFiles
      ? mergeReadFilePaths(
          this.postCompactionReadFilePaths,
          extractReadFilePaths(historyResult.data)
        )
      : [];

    // Reports completed before the latest boundary had their tool results summarized away;
    // anything newer is still visible in the active epoch and would be redundant.
    const boundaryTimestampMs = historyResult.data.find(
      (message) => message.metadata?.compactionBoundary === true
    )?.metadata?.timestamp;

    return this.buildAttachmentsFromContext({
      diffs: fileDiffs,
      loadedSkills,
      readFilePaths,
      reportsCompletedBeforeMs: boundaryTimestampMs ?? Date.now(),
    });
  }

  /**
   * Shared logic for assembling post-compaction attachments from cached context.
   * Loads exclusions, TODO state, workspace metadata, and plan references,
   * then combines them into the final attachment list.
   */
  private async buildAttachmentsFromContext(context: {
    diffs: FileEditDiff[];
    loadedSkills: LoadedSkillSnapshot[];
    /** RLM read tracking (already gated by the caller); empty means "do not surface". */
    readFilePaths: string[];
    /** Cutoff for the completed-reports index: reports completed before this were summarized away. */
    reportsCompletedBeforeMs: number;
  }): Promise<PostCompactionAttachment[]> {
    const excludedItems = await this.loadExcludedItems();
    const todoAttachment = await this.loadTodoListAttachment(excludedItems);

    // Host-side disk read (session dir), independent of workspace metadata/runtime.
    const completedReportsAttachment = await AttachmentService.generateCompletedReportsAttachment({
      workspaceId: this.workspaceId,
      sessionDir: path.join(this.config.sessionsDir, this.workspaceId),
      completedBeforeMs: context.reportsCompletedBeforeMs,
    });

    const readFilesAttachment = AttachmentService.generateReadFilesAttachment(
      context.readFilePaths
    );

    const metadataResult = await this.aiService.getWorkspaceMetadata(this.workspaceId);
    if (!metadataResult.success) {
      // Can't get metadata — skip plan reference but still include other attachments.
      const attachments: PostCompactionAttachment[] = [];

      if (todoAttachment) {
        attachments.push(todoAttachment);
      }

      if (completedReportsAttachment) {
        attachments.push(completedReportsAttachment);
      }

      if (readFilesAttachment) {
        attachments.push(readFilesAttachment);
      }

      const loadedSkillsAttachment = AttachmentService.generateLoadedSkillsAttachment(
        context.loadedSkills,
        excludedItems
      );
      if (loadedSkillsAttachment) {
        attachments.push(loadedSkillsAttachment);
      }

      const editedFilesRef = AttachmentService.generateEditedFilesAttachment(context.diffs);
      if (editedFilesRef) {
        attachments.push(editedFilesRef);
      }

      return attachments;
    }
    const runtime = createRuntimeForWorkspace(metadataResult.data);

    const attachments = await AttachmentService.generatePostCompactionAttachments(
      metadataResult.data.name,
      metadataResult.data.projectName,
      this.workspaceId,
      context.diffs,
      context.loadedSkills,
      runtime,
      excludedItems
    );

    if (todoAttachment) {
      // Insert TODO after plan (if present), otherwise first.
      const planIndex = attachments.findIndex((att) => att.type === "plan_file_reference");
      const insertIndex = planIndex === -1 ? 0 : planIndex + 1;
      attachments.splice(insertIndex, 0, todoAttachment);
    }

    if (completedReportsAttachment) {
      // Final injection order is decided by the renderer's priority sort.
      attachments.push(completedReportsAttachment);
    }

    if (readFilesAttachment) {
      attachments.push(readFilesAttachment);
    }

    return attachments;
  }

  /**
   * Materialize @file mentions from a user message into a persisted snapshot message.
   *
   * This reads the referenced files once and creates a synthetic message containing
   * their content. The snapshot is persisted to history so subsequent sends don't
   * re-read the files (which would bust prompt cache if files changed).
   *
   * Also registers file state for change detection via <system-file-update> diffs.
   *
   * @returns The snapshot message and list of materialized mentions, or null if no mentions found
   */
  private async materializeFileAtMentionsSnapshot(
    messageText: string
  ): Promise<{ snapshotMessage: MuxMessage; materializedTokens: string[] } | null> {
    // Guard for test mocks that may not implement getWorkspaceMetadata
    if (typeof this.aiService.getWorkspaceMetadata !== "function") {
      return null;
    }

    const metadataResult = await this.aiService.getWorkspaceMetadata(this.workspaceId);
    if (!metadataResult.success) {
      log.debug("Cannot materialize @file mentions: workspace metadata not found", {
        workspaceId: this.workspaceId,
      });
      return null;
    }

    const metadata = metadataResult.data;
    const { runtime, workspacePath } = createRuntimeContextForWorkspace(metadata);

    const materialized = await materializeFileAtMentions(messageText, {
      runtime,
      workspacePath,
    });

    if (materialized.length === 0) {
      return null;
    }

    // Register file state for each successfully read file (for change detection)
    for (const mention of materialized) {
      if (
        mention.content !== undefined &&
        mention.modifiedTimeMs !== undefined &&
        mention.resolvedPath
      ) {
        await this.recordFileState(mention.resolvedPath, {
          content: mention.content,
          timestamp: mention.modifiedTimeMs,
        });
      }
    }

    // Create a synthetic snapshot message (not persisted here - caller handles persistence)
    const tokens = materialized.map((m) => m.token);
    const blocks = materialized.map((m) => m.block).join("\n\n");

    const snapshotId = createFileSnapshotMessageId();
    const snapshotMessage = createMuxMessage(snapshotId, "user", blocks, {
      timestamp: Date.now(),
      synthetic: true,
      fileAtMentionSnapshot: tokens,
    });

    return { snapshotMessage, materializedTokens: tokens };
  }

  private async materializeMcpPromptSnapshots(
    muxMetadata: MuxMessageMetadata | undefined,
    invokingMessageId: string,
    cancelSignal: AbortSignal | undefined
  ): Promise<MuxMessage[]> {
    const mcpServerManager = this.mcpServerManager;
    if (!mcpServerManager) return [];

    const refs = dedupeMcpPromptRefs(sanitizeMcpPromptRefs(muxMetadata?.mcpPromptRefs));
    const snapshots = await Promise.all(
      refs.map(async (ref): Promise<MuxMessage | null> => {
        try {
          const prompt = await mcpServerManager.getPrompt(
            this.workspaceId,
            ref.serverName,
            ref.promptName,
            ref.arguments ?? {},
            cancelSignal !== undefined ? { signal: cancelSignal } : undefined
          );
          return createMuxMessage(createMcpPromptSnapshotMessageId(), "user", prompt.text, {
            timestamp: Date.now(),
            synthetic: true,
            mcpPromptSnapshot: {
              serverName: ref.serverName,
              promptName: ref.promptName,
              commandKey: ref.commandKey,
              invokingMessageId,
              ...(prompt.description !== undefined ? { description: prompt.description } : {}),
            },
          });
        } catch (error) {
          // Cancellation is handled by cancelBeforeAcceptance after this returns.
          if (cancelSignal?.aborted) return null;
          // A slash-invoked prompt was explicitly selected; sending the turn
          // without its expansion would silently change what the user asked
          // for. Inline references degrade to the authored text instead.
          if (ref.source === "slash") {
            throw new Error(
              `Cannot expand MCP prompt '${ref.serverName}/${ref.promptName}': ${getErrorMessage(error)}`
            );
          }
          log.debug("Failed to materialize MCP prompt reference", {
            workspaceId: this.workspaceId,
            serverName: ref.serverName,
            promptName: ref.promptName,
            error: getErrorMessage(error),
          });
          return null;
        }
      })
    );
    return snapshots.filter((snapshot): snapshot is MuxMessage => snapshot !== null);
  }

  private async materializeAgentSkillSnapshots(
    muxMetadata: MuxMessageMetadata | undefined,
    disableWorkspaceAgents: boolean | undefined
  ): Promise<MuxMessage[]> {
    const refs = extractAgentSkillRefs(muxMetadata);
    if (refs.length === 0) {
      return [];
    }

    // Guard for test mocks that may not implement getWorkspaceMetadata.
    if (typeof this.aiService.getWorkspaceMetadata !== "function") {
      return [];
    }

    const metadataResult = await this.aiService.getWorkspaceMetadata(this.workspaceId);
    if (!metadataResult.success) {
      const hasSlash = refs.some((ref) => ref.source === "slash");
      if (hasSlash) {
        throw new Error("Cannot materialize agent skill: workspace metadata not found");
      }
      return [];
    }

    const metadata = metadataResult.data;
    const { runtime, workspacePath } = createRuntimeContextForWorkspace(metadata);

    // When workspace agents are disabled, resolve skills from the project path instead of
    // the worktree so skill invocation uses the same precedence/discovery root as the UI.
    const skillDiscoveryPath = disableWorkspaceAgents ? metadata.projectPath : workspacePath;

    // Dedupe per skill against recent persisted snapshots. A wider window keeps multi-skill
    // turns from reloading snapshots that were persisted together on the previous turn.
    const recentSnapshots: Array<{ skillName: string; sha256: string }> = [];
    const historyResult = await this.historyService.getLastMessages(this.workspaceId, 10);
    if (historyResult.success) {
      for (const msg of historyResult.data) {
        const metadata = msg.metadata;
        if (metadata?.synthetic && metadata.agentSkillSnapshot) {
          recentSnapshots.push({
            skillName: metadata.agentSkillSnapshot.skillName,
            sha256: metadata.agentSkillSnapshot.sha256,
          });
        }
      }
    }

    const snapshotMessages: MuxMessage[] = [];
    for (const ref of refs) {
      const parsedName = SkillNameSchema.safeParse(ref.skillName);
      if (!parsedName.success) {
        if (ref.source === "slash") {
          throw new Error(`Invalid agent skill name: ${ref.skillName}`);
        }
        continue;
      }

      let resolved: Awaited<ReturnType<typeof readAgentSkill>>;
      try {
        // claude-skills-compat experiment: resolve slash-invoked skills with the same
        // roots as discovery. Guard for test mocks that may not implement the gate.
        const includeClaudeSkills =
          typeof this.aiService.isClaudeSkillsCompatEnabled === "function" &&
          this.aiService.isClaudeSkillsCompatEnabled();
        // agent-plugins experiment: same treatment for plugin-provided skills.
        const includeAgentPlugins =
          typeof this.aiService.isAgentPluginsEnabled === "function" &&
          this.aiService.isAgentPluginsEnabled();
        // Resolve project workspaces through the same storage context as the
        // skill tools so subprojects inherit checkout-level skills and plugins
        // across host-local and runtime-backed workspaces. disableWorkspaceAgents
        // keeps default projectPath discovery.
        const xumScope =
          !disableWorkspaceAgents &&
          typeof this.aiService.resolveXumToolScopeForWorkspace === "function"
            ? this.aiService.resolveXumToolScopeForWorkspace(metadata, runtime, workspacePath)
            : null;
        const skillCtx =
          xumScope?.type === "project"
            ? resolveSkillStorageContext({
                runtime,
                workspacePath: skillDiscoveryPath,
                xumScope,
                includeClaudeSkills,
                includeAgentPlugins,
              })
            : null;
        resolved = await readAgentSkill(
          skillCtx?.runtime ?? runtime,
          skillCtx?.workspacePath ?? skillDiscoveryPath,
          parsedName.data,
          {
            ...(skillCtx != null
              ? { roots: skillCtx.roots, containment: skillCtx.containment }
              : {}),
            includeClaudeSkills,
            includeAgentPlugins,
          }
        );
      } catch (error) {
        if (ref.source === "slash") {
          throw error;
        }
        continue;
      }

      const skill = resolved.package;

      // Slash invocations can carry trailing argument text (e.g. "/fix-issue 123 high").
      // Substitute $ARGUMENTS/$1..$9 placeholders in the snapshot body so the model sees
      // the resolved instructions; bodies without placeholders stay byte-identical and the
      // user message keeps showing what was typed. Inline `$skill` refs have no argument
      // concept, so their bodies are never touched. Missing metadata arguments (legacy
      // messages) substitute as "".
      const slashArgumentText =
        ref.source === "slash" &&
        muxMetadata?.type === "agent-skill" &&
        muxMetadata.skillName === ref.skillName
          ? (muxMetadata.arguments ?? "")
          : null;
      const substitutedBody =
        slashArgumentText != null
          ? substituteSkillArguments(skill.body, slashArgumentText).body
          : skill.body;

      // Dynamic context injection (default-off experiment): replace whole-line
      // !`command` directives with their output. Ordering matters: it runs after
      // argument substitution so directives like !`git log $1` see resolved
      // arguments, and before snapshot creation so the hash covers the final body
      // (different command outputs naturally produce distinct snapshots). Every
      // ref in this materialization path is user-initiated (slash "/skill" or
      // inline "$skill"); the model-side agent_skill_read tool takes a separate
      // path and always sees the raw body.
      const body = await this.maybeInjectSkillDynamicContext({
        skillName: skill.frontmatter.name,
        body: substitutedBody,
        runtime,
        workspacePath,
      });

      // Include the parsed YAML frontmatter in the hash so frontmatter-only edits (e.g. description)
      // generate a new snapshot and keep the UI hover preview in sync. The hash also covers
      // the substituted body, so the same skill invoked with different arguments produces
      // distinct snapshots (dedupe must not collapse them).
      const frontmatterYaml = stringifyAgentSkillFrontmatter(skill.frontmatter);
      const snapshot = createLoadedSkillSnapshot({
        name: skill.frontmatter.name,
        scope: skill.scope,
        body,
        frontmatterYaml,
      });
      const sha256 = snapshot.sha256;

      if (
        recentSnapshots.some(
          (recent) => recent.skillName === skill.frontmatter.name && recent.sha256 === sha256
        )
      ) {
        continue;
      }

      const snapshotText = renderAgentSkillSnapshotText(snapshot);
      const snapshotId = createAgentSkillSnapshotMessageId();
      snapshotMessages.push(
        createMuxMessage(snapshotId, "user", snapshotText, {
          timestamp: Date.now(),
          synthetic: true,
          agentSkillSnapshot: {
            skillName: skill.frontmatter.name,
            scope: skill.scope,
            sha256,
            frontmatterYaml,
          },
        })
      );

      // Defense-in-depth: avoid double-loading this skill within the same turn even if
      // future metadata shapes bypass extractAgentSkillRefs dedupe.
      recentSnapshots.push({ skillName: skill.frontmatter.name, sha256 });
    }

    return snapshotMessages;
  }

  /**
   * Experiment-gated dynamic context injection for user-invoked skills (see
   * skillDynamicContext.ts for directive syntax and limits). Returns the body
   * unchanged when the experiment is off or when anything unexpected fails: a
   * broken directive must never break the send path (self-healing doctrine).
   */
  private async maybeInjectSkillDynamicContext(args: {
    skillName: string;
    body: string;
    runtime: Runtime;
    workspacePath: string;
  }): Promise<string> {
    // The typeof guard mirrors the getWorkspaceMetadata guard in
    // materializeAgentSkillSnapshots: test mocks may provide a partial AIService.
    if (
      typeof this.aiService.isExperimentEnabled !== "function" ||
      !this.aiService.isExperimentEnabled(EXPERIMENT_IDS.SKILL_DYNAMIC_CONTEXT)
    ) {
      return args.body;
    }

    try {
      const result = await injectSkillDynamicContext({
        body: args.body,
        // SECURITY AUDIT: this sink executes shell commands sourced from SKILL.md
        // bodies, which are repo-controlled and therefore attacker-controlled input
        // (any cloned repo can ship arbitrary skills). It is acceptable only because:
        // (1) it is gated on the default-off "skill-dynamic-context" experiment,
        // which only an explicit local Settings toggle can enable, so the user has
        // deliberately opted into skills running commands; and
        // (2) it runs solely on user-initiated skill invocations (slash "/skill" or
        // inline "$skill" refs) — the model-side agent_skill_read tool never reaches
        // this path — so each execution traces to a deliberate user action on a skill
        // they chose, the same trust level as the user running the command themselves.
        // Commands run non-interactively (no stdin) in the workspace directory with
        // the runtime's default environment; the bash tool's `.xum/tool_env` sourcing
        // lives behind hook/trust plumbing that is not reachable here, and directive
        // commands should not depend on tool-specific env anyway.
        execute: async (command) => {
          const execResult = await execBuffered(args.runtime, command, {
            cwd: args.workspacePath,
            // Runtime-level timeout (seconds) actually kills the process; the
            // module-level race in injectSkillDynamicContext bounds our wait.
            timeout: Math.ceil(SKILL_DYNAMIC_COMMAND_TIMEOUT_MS / 1000),
            // Bound memory while reading, not just after: without this, a
            // directive like !`cat big.log` would buffer the entire output
            // before the module's truncateOutput cap applies. +1 so the
            // module still sees an over-cap payload and appends its
            // "[output truncated ...]" marker.
            maxOutputBytes: SKILL_DYNAMIC_OUTPUT_CAP_BYTES + 1,
          });
          return {
            stdout: execResult.stdout,
            stderr: execResult.stderr,
            exitCode: execResult.exitCode,
          };
        },
      });
      return result.body;
    } catch (error) {
      log.warn(
        `Skill dynamic context injection failed for ${args.skillName}: ${getErrorMessage(error)}`
      );
      return args.body;
    }
  }

  /**
   * Load excluded items from the exclusions file.
   * Returns empty set if file doesn't exist or can't be read.
   */
  private async loadExcludedItems(): Promise<Set<string>> {
    const exclusionsPath = path.join(
      path.join(this.config.sessionsDir, this.workspaceId),
      "exclusions.json"
    );
    try {
      const data = await readFile(exclusionsPath, "utf-8");
      const exclusions = JSON.parse(data) as PostCompactionExclusions;
      return new Set(exclusions.excludedItems);
    } catch {
      return new Set();
    }
  }

  private coerceTodoItems(value: unknown): TodoItem[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const result: TodoItem[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object") continue;

      const content = (item as { content?: unknown }).content;
      const status = (item as { status?: unknown }).status;

      if (typeof content !== "string") continue;
      if (status !== "pending" && status !== "in_progress" && status !== "completed") continue;

      result.push({ content, status });
    }

    return result;
  }

  private async loadTodoListAttachment(
    excludedItems: Set<string>
  ): Promise<PostCompactionAttachment | null> {
    if (excludedItems.has("todo")) {
      return null;
    }

    const todoPath = path.join(this.config.sessionsDir, this.workspaceId, "todos.json");

    try {
      const data = await readFile(todoPath, "utf-8");
      const parsed: unknown = JSON.parse(data);
      const todos = this.coerceTodoItems(parsed);
      if (todos.length === 0) {
        return null;
      }

      return {
        type: "todo_list",
        todos,
      };
    } catch {
      // File missing or unreadable
      return null;
    }
  }

  async appendHeartbeatContextResetBoundary(params: {
    boundaryText: string;
    pendingFollowUp: CompactionFollowUpRequest;
  }): Promise<Result<{ summaryMessageId: string }, string>> {
    this.assertNotDisposed("appendHeartbeatContextResetBoundary");

    if (this.isBusy()) {
      return Err("Cannot reset heartbeat context while a turn is active.");
    }
    if (this.hasQueuedMessages()) {
      return Err("Cannot reset heartbeat context while queued user input is pending.");
    }

    const result = await this.compactionHandler.appendHeartbeatContextResetBoundary({
      boundaryText: params.boundaryText,
      pendingFollowUp: params.pendingFollowUp,
    });
    if (result.success) {
      this.clearUsageState();
      this.onPostCompactionStateChange?.();
    }
    return result;
  }

  async dispatchPendingCompactionFollowUpIfNeeded(summaryMessageId?: string): Promise<boolean> {
    this.assertNotDisposed("dispatchPendingCompactionFollowUpIfNeeded");
    return this.dispatchPendingFollowUp(summaryMessageId);
  }

  /**
   * Peek at cached file paths from pending compaction.
   * Returns paths that will be reinjected, or null if no pending compaction.
   */
  getPendingTrackedFilePaths(): string[] | null {
    return this.compactionHandler.peekCachedFilePaths();
  }

  private assertNotDisposed(operation: string): void {
    assert(!this.coordinator.disposed, `AgentSession.${operation} called after dispose`);
  }
}

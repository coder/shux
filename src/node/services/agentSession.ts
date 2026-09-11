import type { QueuedInputStopCause } from "@/common/types/streamStopCause";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import { STARTUP_RECOVERY_PROBE_TIMEOUT_MS } from "@/constants/startupRecovery";
import type { AIService } from "./aiService";
import { AsyncLocalStorage } from "node:async_hooks";
import type { GoalRecordV1 } from "@/common/types/goal";
import type { PreparedStreamMessage } from "./turnRequestBuilder";
import { estimateFreshRequestTokensForModel } from "./contextBudgetCounting";
import type { RequestAssemblySnapshot } from "./events/eventSpine";
import { getRequestPreludeMessageIds } from "@/common/utils/messages/requestPrelude";
import { createContextBudgetRejectedMessage } from "@/common/utils/messages/contextBudgetRejection";
import { sliceMessagesForProviderFromLatestContextBoundary } from "@/common/utils/messages/compactionBoundary";
import { randomUUID } from "crypto";
import { sandboxHostService } from "./sandbox/sandboxHostService";
import { applyToolPolicyToNames, isSessionHistoryDisabled } from "@/common/utils/tools/toolPolicy";
import { isExecLikeEditingCapableInResolvedChain } from "@/common/utils/agentTools";
import { resolveMemoryAccessPolicy } from "./tools/memory";
import {
  CONTEXT_CONTINUE_DEDUPE_KEY,
  CONTEXT_WARNING_DEDUPE_KEY,
  FLUSH_RESERVE_TOKENS,
  OUTPUT_RESERVE_TOKENS,
  IMAGE_TOKEN_ESTIMATE,
  PDF_TOKENS_PER_PAGE_ESTIMATE,
} from "@/common/constants/contextBudget";
import {
  evaluateStepBudget,
  type StepBudgetEvaluation,
  getContextBudgetHardCeiling,
  getContextBudgetRolloverPoint,
  resolveContextBudgetFlushThinking,
  estimateFreshRequestTokens,
} from "@/common/utils/compaction/contextBudget";
import {
  createRolloverPrefix,
  createContextBudgetWarning,
  currentContextWindowId,
  hasRolloverEligibleMessages,
  hasUnconsumedNewContextRequest,
  estimateLastStepToolResults,
  type ContextWindowRollover,
} from "./contextWindowRollover";
import { resolveAgentForStream, type AgentResolutionResult } from "./agentResolution";
import type { SettledStepBudget } from "./streamManager";
import type { TurnStreamHandle } from "./streamManager";
import type { StreamManager } from "./streamManager";
import type { PreDispatchConsentGateContext } from "./streamManager";
import * as path from "path";
import assert from "@/common/utils/assert";
import { EventEmitter } from "events";
import { Effect, Fiber } from "effect";
import {
  StartupRecovery,
  retryStartupRead,
  type StartupRecoveryOutcome,
  type StartupRecoveryState,
} from "./startupRecovery";
import { hasErrorCode } from "./tools/skillFileUtils";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "fs/promises";
import type { Dirent } from "fs";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import { PlatformPaths } from "@/common/utils/paths";
import { log } from "@/node/services/log";
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
import type { SendMessageAccepted, SendMessageError } from "@/common/types/errors";
import {
  ChatMuxMessageSchema,
  SendMessageOptionsSchema,
  SkillNameSchema,
} from "@/common/orpc/schemas";
import { ToolPolicySchema } from "@/common/orpc/schemas/stream";
import { isWorkspaceProjectTrusted } from "@/node/utils/projectTrust";
import { roundToBase2 } from "@/common/telemetry/utils";
import {
  normalizePersistedAgentCandidate,
  resolvePersistedAgentIdCandidates,
} from "@/common/utils/agentIds";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { findWorkspaceEntry, resolveWorkspaceModelFallbackChain } from "@/node/services/taskUtils";
import {
  buildStreamErrorEventData,
  createStreamErrorMessage,
  createUnknownSendMessageError,
  REJECTED_TURN_RECORD_UNRECORDED_MESSAGE,
  REJECTED_TURN_REPAIR_PENDING_MESSAGE,
  rejectedTurnRecordCorruptMessage,
  ROUTED_SKILL_TRUST_REVOKED_MESSAGE,
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
  resolveThinkingInput,
} from "@/common/utils/thinking/policy";
import type { ActiveTurnThinkingOverride } from "@/node/services/thinkingOverride";
import {
  collectRejectedTurnRowIds,
  filterPreStreamRejectedRows,
  isCommittedAssistantReply,
  createMuxMessage,
  STARTUP_RETRY_DURABLE_SEND_OPTION_KEYS,
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
  isTurnStartingUserRow,
  type CompactionFollowUpRequest,
  type MuxMessageMetadata,
  type MuxFilePart,
  type MuxMessage,
  type ReviewNoteDataForDisplay,
  type StartupRetrySendOptions,
  type WorkspaceTurnTaskCorrelation,
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
import { ROUTED_SEND_COMPACTION_HEADROOM_PERCENT } from "@/common/constants/ui";
import { MAX_AGENT_SKILL_SNAPSHOT_CHARS } from "@/common/constants/attachments";
import { MCP_PROMPT_MAX_TEXT_BYTES } from "@/common/constants/toolLimits";
import type { AgentSkillScope } from "@/common/types/agentSkill";
import { APPROX_CHARS_PER_TOKEN } from "@/constants/streaming";
import type { OpenAIWireFormat } from "@/common/types/providerOptions";
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
import type { AiSdkUsageLike } from "@/common/utils/tokens/usageHelpers";
import {
  type ResolvedAgentSkill,
  readAgentSkill,
} from "@/node/services/agentSkills/agentSkillsService";
import { resolveSkillStorageContext } from "@/node/services/agentSkills/skillStorageContext";
import {
  describeSkillModelClassRoutingProblem,
  resolveSkillModelClassBinding,
} from "@/common/utils/ai/skillModelClasses";
import { isModelServableWithProvidersConfig } from "@/common/utils/ai/modelAvailability";
import {
  createLoadedSkillSnapshot,
  extractLoadedSkillSnapshotsFromMessages,
  mergeLoadedSkillSnapshots,
  messagesCarryProjectSkillContent,
  withholdProjectSkillContentFromRequest,
  stepMessagesCarryProjectSkillContent,
  stringifyAgentSkillFrontmatter,
} from "@/node/services/agentSkills/loadedSkillSnapshots";
import {
  skillBodyHasArgumentPlaceholders,
  substituteSkillArguments,
} from "@/node/services/agentSkills/skillArguments";
import {
  injectSkillDynamicContext,
  SKILL_DYNAMIC_COMMAND_TIMEOUT_MS,
  SKILL_DYNAMIC_OUTPUT_CAP_BYTES,
  extractSkillDynamicCommands,
} from "@/node/services/agentSkills/skillDynamicContext";
import {
  aliasLegacyPtcExclusive,
  EXPERIMENT_IDS,
  type ExperimentId,
} from "@/common/constants/experiments";
import {
  awaitPendingBranchSummary,
  clearPendingBranchSummary,
  isRlmModeEnabled,
  runInlineAbandonedBranchSummary,
  type BranchSummaryAiService,
} from "@/node/services/branchSummary";
import type { Runtime } from "@/node/runtime/Runtime";
import type { XumToolScope } from "@/common/types/toolScope";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { isErrnoWithCode } from "@/node/utils/fs";
import { renderAgentSkillSnapshotText } from "@/common/utils/agentSkills/skillSnapshot";
import type { MemorySessionContext } from "@/node/services/memoryService";
import { materializeFileAtMentions } from "@/node/services/fileAtMentions";
import { parseSubagentReportEnvelope } from "@/common/utils/subagentReportEnvelope";
import { getErrorMessage } from "@/common/utils/errors";
import {
  AUTO_RETRY_PREFERENCE_FILE,
  parseStrictPendingRejectedTurnRepairKeys,
} from "@/node/services/rejectedTurnRepairRecord";
import { CompactionMonitor, type CompactionStatusEvent } from "./compactionMonitor";
import { injectPostCompactionAttachments } from "@/browser/utils/messages/modelMessageTransform";
import { estimateMuxMessageTokens } from "@/common/utils/messages/keepRecentTail";
import { ContinuousCompactor, type ContinuousCompactionContext } from "./continuousCompactor";
import { getEffectiveContextLimit } from "@/common/utils/compaction/contextLimit";
import { summarizeContinuousCompaction } from "./continuousCompactionSummary";

/** See AgentSession.createRoutedMemoryConsent. Mutable: the resolver records what it included. */
interface RoutedMemoryConsent {
  excludeProjectSkillContent: boolean;
  carriesProjectSkillContent: boolean;
}

type SessionCompactionContext = ContinuousCompactionContext & {
  sendOptions?: SendMessageOptions;
  /**
   * The observed turn is skill-routed (resumeStream's routed predicate:
   * compactionBaseOptions set): its summaries and swapped prefixes leave for
   * the routed/compact provider under the routed request's consent rules.
   */
  routedTurn?: boolean;
};

/**
 * Result shape for turn-starting session methods. failureHandled marks errors
 * whose retry/abandon bookkeeping already ran inside streamWithHistory, so
 * callers must not re-handle them (would double-increment backoff attempts).
 */
type AgentSessionResult<T> =
  | { success: true; data: T }
  | { success: false; error: SendMessageError; failureHandled?: true };

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

// Wake continuations must retain their delegated turn correlation through candidate preparation.
function resolveStreamMuxMetadata(
  options: MuxMessageMetadata | undefined,
  retry: MuxMessageMetadata | undefined,
  messages: MuxMessage[]
): ReturnType<typeof inheritOpenWorkspaceTurnMetadata> {
  return options?.type === "workspace-turn-task"
    ? options
    : retry?.type === "workspace-turn-task"
      ? retry
      : retry?.type === "bash-monitor-wake"
        ? inheritOpenWorkspaceTurnMetadata(messages)
        : undefined;
}

function manualSendPreservesGoalActivation(
  goal: Pick<GoalRecordV1, "lastUserActivationAtMs"> | null,
  enqueuedAtMs?: number
): boolean {
  return (
    enqueuedAtMs != null &&
    goal?.lastUserActivationAtMs != null &&
    goal.lastUserActivationAtMs > enqueuedAtMs
  );
}

interface AutoRetryResumeRequest {
  // Same-session auto-retry must preserve the full normalized request because
  // ACP correlation/delegation lives in transient send options that are
  // intentionally omitted from durable startup-recovery snapshots.
  options: SendMessageOptions;
  requestAssemblySnapshot?: RequestAssemblySnapshot;
  /**
   * The request already is an admitted context reset, so a budget failure on retry must not
   * reset again. Distinct from the snapshot: an admitted final flush pins its chain too, yet
   * its emergency reset stays available.
   */
  contextBudgetRetried?: boolean;
  agentInitiated?: boolean;
  goalKind?: GoalSyntheticMessageKind;
  /** Goal identity matching goalKind; keeps retried streams goal-scoped. */
  goalId?: string;
  /** Routed project-skill turn: retries re-verify Project Trust (see resumeStream). */
  routedProjectConsent?: boolean;
  /**
   * Pre-skill-routing options for a routed turn (see
   * activeStreamContext.compactionBaseOptions). A same-session retry must keep
   * the routed compaction policy — without this, the retried stream would
   * force-compact at the workspace threshold against the routed window and
   * summarize on the wrong model.
   */
  compactionBaseOptions?: SendMessageOptions;
  /**
   * Retry-eligible row of the turn this request replays (the user row, or the
   * on-send compaction request that stands in for it). A consent refusal on
   * resume stamps THIS row and its snapshot prefix (rejectResumedRoutedTurn):
   * the resume path holds no other key to the rows it replays, and the
   * refusal must not depend on re-reading history to find one.
   */
  userMessageId?: string;
}

function stripGoalInterventionPolicy(options: SendMessageOptions): SendMessageOptions {
  const streamOptions: SendMessageOptions = { ...options };
  delete streamOptions.goalInterventionPolicy;
  return streamOptions;
}

/**
 * retrySendOptions comes from unchecked chat.jsonl JSON: a malformed
 * compactionBaseOptions (boolean, string, partial object) must neither mark a
 * row as routed — which would flip child-workspace model precedence toward the
 * persisted outer model — nor be forwarded as a compaction base. A usable
 * durable context needs at least the model that owns the larger window; every
 * other field is re-coerced downstream like the outer persisted options. The
 * nested field is stripped to uphold pickStartupRetrySendOptions' one-level
 * invariant.
 */
function sanitizePersistedCompactionBaseOptions(
  value: unknown
): Omit<StartupRetrySendOptions, "compactionBaseOptions"> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.model !== "string" || record.model.trim().length === 0) {
    return undefined;
  }
  // Same bar as the startup model path (normalizeStartupModel): a durable
  // model must normalize to a valid provider:model id, or the row must not
  // count as routed at all.
  const normalizedModel = normalizeSelectedModel(record.model.trim());
  if (!isValidModelFormat(normalizedModel)) {
    return undefined;
  }
  // Whitelist-then-schema-parse the durable subset: these values are spread
  // into an internal send (buildAutoCompactionRequest), so a malformed
  // sibling (providerOptions: false) must not ride into provider request
  // construction, and a schema-VALID but non-durable field must not flip
  // behavioral switches there — a smuggled editMessageId would send the
  // restored compaction request down the edit/truncation path and delete
  // history. The whitelist is the same key set pickStartupRetrySendOptions
  // persists; retry-state extras (goalKind, agentInitiated) are dropped since
  // the base feeds a fresh internal send, and muxMetadata mirrors the durable
  // pick's narrowing (workspace-turn correlation only).
  const candidate: Record<string, unknown> = {};
  for (const key of STARTUP_RETRY_DURABLE_SEND_OPTION_KEYS) {
    if (key in record) {
      candidate[key] = record[key];
    }
  }
  const parsed = SendMessageOptionsSchema.safeParse(candidate);
  if (!parsed.success) {
    return undefined;
  }
  const typedMuxMetadata = parsed.data.muxMetadata as MuxMessageMetadata | undefined;
  const durable = {
    ...parsed.data,
    ...(typedMuxMetadata?.type === "workspace-turn-task"
      ? { muxMetadata: typedMuxMetadata }
      : { muxMetadata: undefined }),
    model: normalizedModel,
  };
  return durable as Omit<StartupRetrySendOptions, "compactionBaseOptions">;
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

/**
 * Character count of an attachment's content as the provider will see it: a
 * data URL's decoded payload (base64 inflates by 4/3), otherwise the URL text.
 */
function decodedAttachmentChars(url: string): number {
  return estimateBase64DataUrlBytes(url) ?? url.length;
}

/**
 * Conservative token cost of a PDF attachment. Providers bill a PDF per page
 * (extracted text plus a page image), not as one media unit: count the page
 * objects of the decoded document and price each at the per-page upper bound;
 * a document whose page objects live in compressed object streams (none
 * visible) falls back to its decoded size as text — over-estimating is the
 * safe direction here (it only compacts earlier).
 */
function estimatePdfAttachmentTokens(url: string): number {
  if (!url.startsWith("data:")) return IMAGE_TOKEN_ESTIMATE;
  const commaIndex = url.indexOf(",");
  if (commaIndex === -1 || !url.slice(0, commaIndex).includes(";base64")) {
    return IMAGE_TOKEN_ESTIMATE;
  }
  const bytes = Buffer.from(url.slice(commaIndex + 1), "base64");
  const pages = bytes.toString("latin1").match(/\/Type\s*\/Page(?![s])/g)?.length ?? 0;
  return pages > 0
    ? pages * PDF_TOKENS_PER_PAGE_ESTIMATE
    : Math.max(IMAGE_TOKEN_ESTIMATE, Math.ceil(bytes.length / APPROX_CHARS_PER_TOKEN));
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

/**
 * Replace the auto-retry preference file atomically (temp file + rename): a
 * crash mid-write must not leave a torn document, which reads as an UNKNOWN
 * rejected-turn quarantine and refuses sends until removed by hand. Built on
 * the fs/promises primitives (not write-file-atomic) so the temp write stays
 * orderable and failable through the same seams as the plain write it replaces.
 */
async function replacePreferenceFile(preferencePath: string, payload: string): Promise<void> {
  const tempPath = `${preferencePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, payload, "utf-8");
    await rename(tempPath, preferencePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Per-file serialization of auto-retry preference updates within this
 * process. A live session's persistAutoRetryState and the closed-workspace
 * marker sweep (clearProviderConfigFixableAbandonMarkers) target the same
 * file when a workspace opens after the sweep began; each update's read,
 * decision and write run as one unit, in order, so a sweep that scanned a
 * stale marker cannot erase the repair key or rejection marker the session
 * persisted meanwhile.
 */
const preferenceFileUpdates = new Map<string, Promise<void>>();
async function serializePreferenceFileUpdate<T>(
  preferencePath: string,
  update: () => Promise<T>
): Promise<T> {
  const previous = preferenceFileUpdates.get(preferencePath) ?? Promise.resolve();
  const run = previous.then(update, update);
  const settled = run.then(
    () => undefined,
    () => undefined
  );
  preferenceFileUpdates.set(preferencePath, settled);
  try {
    return await run;
  } finally {
    if (preferenceFileUpdates.get(preferencePath) === settled) {
      preferenceFileUpdates.delete(preferencePath);
    }
  }
}

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
    if (hasErrorCode(error, "ENOENT")) {
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
      // Read, decide and write as ONE serialized unit: the workspace may have
      // opened since this sweep began (the skip set is a snapshot), and its
      // session's writes queue behind — or ahead of — this one, never
      // interleave with it. A marker the session already replaced (a
      // rejection marker with its repair key) is therefore seen, not erased.
      await serializePreferenceFileUpdate(preferencePath, async () => {
        let parsed: {
          enabled?: unknown;
          startupAutoRetryAbandon?: unknown;
          pendingRejectedTurnRepair?: unknown;
        };
        try {
          parsed = JSON.parse(await readFile(preferencePath, "utf-8")) as typeof parsed;
        } catch {
          // Missing file is the default; a malformed file is the session's
          // unknown-quarantine state (readAutoRetryState) and not this sweep's
          // to touch.
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

        // Mirror persistAutoRetryState(): the file carries an opt-out, an abandon
        // marker or the rejected-turn repair record, so dropping the last field
        // deletes it. This sweep retires only the marker; the record (keys of
        // refused turns whose stamp is outstanding) is carried over verbatim.
        const repairRecord = parsed.pendingRejectedTurnRepair;
        if (parsed.enabled === false || repairRecord != null) {
          await replacePreferenceFile(
            preferencePath,
            JSON.stringify({
              ...(parsed.enabled === false ? { enabled: false } : {}),
              ...(repairRecord != null ? { pendingRejectedTurnRepair: repairRecord } : {}),
            }) + "\n"
          );
        } else {
          await unlink(preferencePath);
        }
      });
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

/**
 * Accepted-send payload for a turn whose rows are durable but that never
 * reached a provider (a late consent refusal, a canceled startup): the visible
 * stream error is the record, and the renderer must not attribute send
 * telemetry to it — no request occurred.
 */
const ACCEPTED_WITHOUT_STREAM: SendMessageAccepted = { acceptedWithoutStream: true };

/**
 * Late consent gate of a routed project-skill turn. `requestCarriesProjectContent`
 * is set by the provider-boundary caller when the assembled request carries
 * project-scope content from EARLIER turns; `midStream` marks a per-step
 * (prepareStep) invocation, whose refusal surfaces through the stream's own
 * error path — the gate then leaves the visible error emission to it.
 */
type RoutedConsentRejection = (
  requestCarriesProjectContent?: boolean,
  midStream?: boolean
) => Promise<SendMessageError | null>;

/** Result of a rejected-turn repair pass (see repairUnstampedRejectedTurn). */
interface RejectedTurnRepairOutcome {
  /** Every key verified stamped and no surviving partial: the record is retired. */
  durable: boolean;
  /**
   * The rejected turn's surviving in-flight assistant is gone (or there was
   * none) and history could be read to vouch for it. False means a
   * commitPartial would promote that output into an unmarked history row.
   */
  partialSecured: boolean;
}

// ROUTED_SKILL_TRUST_REVOKED_MESSAGE moved to utils/sendMessageError.ts so
// StreamManager's per-step consent gate can share it without an import cycle.

/**
 * Loaded-skills attachments re-inject the scope AND body of every skill read
 * before the compaction boundary — a second channel for repository-controlled
 * content, independent of the snapshot rows the request scan sees.
 */
function carriesProjectLoadedSkills(attachments: PostCompactionAttachment[] | null): boolean {
  return (
    attachments?.some(
      (attachment) =>
        attachment.type === "loaded_skills_snapshot" &&
        attachment.skills.some((skill) => skill.scope === "project")
    ) === true
  );
}

/** Least-privilege counterpart: drop project-scope skills (and an emptied attachment). */
function excludeProjectLoadedSkills(
  attachments: PostCompactionAttachment[] | null
): PostCompactionAttachment[] | null {
  if (attachments === null) {
    return null;
  }
  return attachments.flatMap((attachment): PostCompactionAttachment[] => {
    if (attachment.type !== "loaded_skills_snapshot") {
      return [attachment];
    }
    const skills = attachment.skills.filter((skill) => skill.scope !== "project");
    return skills.length > 0 ? [{ ...attachment, skills }] : [];
  });
}

/**
 * Project skill content a per-step consent gate context carries BEYOND the
 * assembly-time request scan: tool results appended by earlier steps of the
 * same stream, and a continuous-compaction prefix swapped in under trust —
 * its rows are ModelMessages by then, so the step scan cannot classify them
 * and the swap carries its own verdict.
 */
function gateContextCarriesProjectSkillContent(
  context: PreDispatchConsentGateContext | undefined
): boolean {
  if (context == null) return false;
  return (
    (context.stepMessages != null && stepMessagesCarryProjectSkillContent(context.stepMessages)) ||
    context.swappedPrefixCarriesProjectSkillContent === true
  );
}

/**
 * Client-stamped skill scopes replaced by the AUTHORITATIVE scopes of the
 * packages the backend resolved (slash invocation and inline refs alike).
 * rowInvokesProjectSkill reads these durably for request withholding, so a
 * stale or forged non-project scope on a project skill must not survive
 * persistence. Returns the input when nothing changes.
 */
function withAuthoritativeSkillScopes(
  muxMetadata: MuxMessageMetadata | undefined,
  scopes: ReadonlyMap<string, AgentSkillScope>
): MuxMessageMetadata | undefined {
  if (muxMetadata == null || scopes.size === 0) return muxMetadata;
  let next = muxMetadata;
  if (next.type === "agent-skill") {
    const scope = scopes.get(next.skillName);
    if (scope != null && scope !== next.scope) next = { ...next, scope };
  }
  const refs = next.agentSkillRefs;
  if (Array.isArray(refs)) {
    let changed = false;
    const rewritten = refs.map((ref) => {
      const scope = scopes.get(ref.skillName);
      if (scope == null || scope === ref.scope) return ref;
      changed = true;
      return { ...ref, scope };
    });
    if (changed) next = { ...next, agentSkillRefs: rewritten };
  }
  return next;
}

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
  createModelWithPinnedOptions: AIService["createModelWithPinnedOptions"];
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  streamMessage(options: StreamMessageOptions): Promise<Result<TurnStreamHandle, SendMessageError>>;
  prepareStreamMessage?(
    options: StreamMessageOptions
  ): Promise<Result<PreparedStreamMessage, SendMessageError>>;
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
    options?: {
      includeHotMemories?: boolean;
      tokenBudgetActive?: boolean;
      onlyContextNotes?: boolean;
      excludeProjectSkillContent?: boolean;
    }
  ): Promise<MemorySessionContext | null>;
  isClaudeSkillsCompatEnabled?(): boolean;
  isAgentPluginsEnabled?(): boolean;
  captureRequestAssemblySnapshot?(
    workspaceId: string
  ): Promise<Result<RequestAssemblySnapshot, SendMessageError>>;
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
   * Called when a send whose delivery was deferred (an on-send compaction
   * answered `{ queued: true }`) actually streams, with the delivered text.
   * The service defers the fork auto-title to this moment: the deferred text
   * may still be refused by the follow-up's consent gate, and it must not
   * reach the title model before the primary request was allowed to leave.
   */
  onDeferredSendDelivered?: (text: string) => void;
  /**
   * Codex P1 (PRRT_kwDOPxxmWM6cRJD-): true while a service-level send is in
   * its preflight (counted in WorkspaceService.preflightSendCounts but not
   * yet queued or holding the turn phase). Session queue/phase state cannot
   * see that window, so redispatched idle-rule follow-ups consult this probe
   * to yield to a manual send that is still awaiting pricing/settings.
   */
  hasExternalSendPreflight?: () => boolean;
  onContextWindowRollover?: () => void;
}

interface CachedMemoryContext {
  context: MemorySessionContext | null;
  includesHotMemories: boolean;
  tokenBudgetActive: boolean;
  memoryEnabled: boolean;
  hotSetEnabled: boolean;
  excludesProjectSkillContent: boolean;
}

interface SendMessageInternalOptions {
  preparation?: PreparationAttempt;
  /**
   * Queue-dispatched entry (see the seam's SendMessageInternalOptions.dequeued):
   * pre-stream gate rejections preserve the user row only then. sendQueuedMessages
   * marks its dispatches through the preparation attempt; this flag lets other
   * callers (and tests) assert the same provenance.
   */
  dequeued?: boolean;
  /** A dequeued send keeps its admission owner through acceptance and startup failure. */
  turnReservation?: TurnId;
  synthetic?: boolean;
  agentInitiated?: boolean;
  goalContinuation?: boolean;
  goalKind?: GoalSyntheticMessageKind;
  /** Goal identity persisted alongside goalKind so chat-tail reconciliation can scope the row. */
  goalId?: string;
  startStreamInBackground?: boolean;
  onAccepted?: () => Promise<void> | void;
  onAcceptedPreStreamFailure?: (error: SendMessageError) => Promise<void> | void;
  onCanceled?: (reason: string) => Promise<void> | void;
  cancelState?: { canceledBeforeAcceptance: boolean };
  cancelSignal?: AbortSignal;
  /**
   * Withdraw the send when `cancelSignal` aborts after its rows are durable but before PREPARING:
   * resolve Ok without a stream and record the startup abandon marker for the row. By default a
   * late abort cannot revoke an accepted send (r54). Bash-monitor wakes set this so a Stop that
   * lands during acceptance or goal sync is not followed by the wake's stream.
   */
  withdrawAcceptedOnCancel?: boolean;
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
   * Consent gate of the routed stream this send replaces (mid-stream
   * compaction, see interruptForCompaction). The replacement reads that
   * stream's project snapshot — possibly on the class model — so it must
   * keep verifying Project Trust at startup, at dispatch and per step,
   * and its retries must inherit the obligation.
   */
  inheritedConsentRejection?: RoutedConsentRejection;
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
  /** Advance other sends' epochs while keeping this rollover send admitted. */
  onContextWindowRollover?: () => void;
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
  preparedRequest?: PreparedStreamMessage;
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
}

export class AgentSession {
  private readonly replayPublication = new AsyncLocalStorage<{
    listener: (event: AgentSessionChatEvent) => void;
    emittedStreamEvents: boolean;
  }>();
  private readonly workspaceId: string;
  private readonly config: Config;
  private readonly historyService: HistoryService;
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
  private readonly onDeferredSendDelivered?: (text: string) => void;
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
      () =>
        this.runStartupRecoveryStep(() => this.requireGoalAcknowledgmentForCrashRecoveredPartial()),
      () => this.runStartupRecoveryStep(() => this.continuousCompactor.recover()),
      () => this.runStartupRecoveryStep(() => this.dispatchPendingFollowUp()),
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
  // The preference file may not reflect memory after a failed write (see persistAutoRetryState).
  private autoRetryStateUnrecorded = false;
  private autoRetryStateVersion = 0;
  private autoRetryStateLoad: Promise<void> | null = null;
  private readonly telemetryService?: TelemetryService;
  /**
   * Rows whose durable preStreamRejected stamp FAILED (transient history
   * rewrite error): request assembly filters these for the rest of the
   * session so the rejected turn cannot reach a provider unstamped. Startup
   * recovery re-attempts the durable stamp via the abandon marker.
   */
  private readonly unstampedRejectedRowIds = new Set<string>();
  /**
   * Durable keys of rejected turns whose provider-ineligibility stamp is still
   * outstanding (the stamp and/or the turn's partial delete failed, so the
   * rows are only quarantined in memory). Kept apart from the abandon marker —
   * which every accepted send and stream-end legitimately clears — so a crash
   * between the failure and the next successful repair still leaves startup
   * recovery keys to restamp with. A set, not a slot: a second refusal before
   * the first repair completes must not evict the older key, and each key
   * retires only once ITS rows verified.
   */
  private pendingRejectedTurnRepair: { userMessageIds: string[] } | null = null;

  /** Latest context-usage snapshot used for on-send compaction checks. */
  private lastUsageState?: AutoCompactionUsageState;
  // Slider edits cannot expand the budget of a reset that has already been queued.
  private pendingRollover?: ContextWindowRollover & { budgetTokens: number };
  /** Request-assembly snapshot admitted when a final flush was promised; pins the sealing reset. */
  private pendingRolloverSnapshot?: RequestAssemblySnapshot;
  private contextBudgetWarningClaimed = false;
  /** One final pre-rollover notes flush per window; derived from history on restart. */
  private contextBudgetFlushClaimed = false;
  private pendingBudgetWarning?: true;
  private contextBudgetGeneration = 0;
  // Unknown after restart: do not spend the window's warning on guessed permissions.
  private contextBudgetMemoryWritable: boolean | undefined;
  private contextBudgetHistoryAvailable = false;
  private readonly onContextWindowRollover?: () => void;
  private lastSystemMessageTokens?: number;

  /** Prevent duplicate mid-stream compaction interrupts while we are already transitioning. */
  private get midStreamCompactionPending(): boolean {
    return this.coordinator.midStreamCompactionPending;
  }
  private get continuousCompactionAbandoned(): boolean {
    return this.coordinator.compactionIntent.abandoned;
  }
  private get continuousCompactionObserving(): boolean {
    return this.coordinator.compactionIntent.observation?.kind === "continuous";
  }
  private continuousCompactionObservation: Promise<void> | null = null;

  /** Tracks file state for detecting external edits. */
  private readonly fileChangeTracker = new FileChangeTracker();
  private acceptedFileSnapshotBaseline?: {
    messageId: string;
    tracking: ReturnType<FileChangeTracker["captureSnapshotBaseline"]>;
  };

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
   * Retain the exact injected snapshot so a late completion cannot consume a replacement.
   *
   * This is intentionally delayed until stream-end so a crash mid-stream doesn't lose the diffs.
   */
  private pendingPostCompactionStateToAcknowledge: Awaited<
    ReturnType<CompactionHandler["peekPendingState"]>
  > = null;
  /** Periodic reinjection retains the consumed owner of the cached skill/read carryover. */
  private postCompactionState: typeof this.pendingPostCompactionStateToAcknowledge = null;

  /**
   * Cached memory session context (memory experiment): index snapshot for
   * the memory tool description plus an optional hot-memories block, keyed by
   * model because the hot set is token-budgeted with the active model's
   * tokenizer. Index-only entries can be upgraded once final tool policy keeps
   * the memory tool; compaction clears the map so repeated turns keep
   * prompt-cache-stable bytes without preserving stale files forever.
   */
  private memoryContextByModelString = new Map<string, CachedMemoryContext>();
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
    contextBudgetRetried?: boolean;
    requestAssemblySnapshot?: RequestAssemblySnapshot;
    options?: SendMessageOptions;
    agentInitiated?: boolean;
    openaiTruncationModeOverride?: "auto" | "disabled";
    providersConfig: ProvidersConfigMap | null;
    goalKind?: GoalSyntheticMessageKind;
    /** Goal identity matching goalKind, so mid-stream compaction follow-ups stay goal-scoped. */
    goalId?: string;
    workspaceTurnMetadata?: Extract<MuxMessageMetadata, { type: "workspace-turn-task" }>;
    /** The active stream is a context-budget final-flush turn (bounded to one provider step). */
    contextBudgetFlushTurn?: boolean;
    /**
     * Pre-skill-routing options for compaction requests spawned off this
     * stream. A turn routed to a small class model must never compact on that
     * model — the compaction model has to fit the full uncompacted history —
     * so both the on-send and mid-stream compaction sites build their request
     * from these options when present.
     */
    compactionBaseOptions?: SendMessageOptions;
    /**
     * The turn's late consent gate, so AgentSession-internal recreations of
     * this stream (the post-compaction context_exceeded retry) keep verifying
     * trust the way StreamManager's own fallback/retry recreations do.
     */
    routedConsentRejection?: RoutedConsentRejection;
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
    this.onContextWindowRollover = options.onContextWindowRollover;
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
      onDeferredSendDelivered,
      hasExternalSendPreflight,
    } = options;

    assert(typeof workspaceId === "string", "workspaceId must be a string");
    const trimmedWorkspaceId = workspaceId.trim();
    assert(trimmedWorkspaceId.length > 0, "workspaceId must not be empty");

    this.workspaceId = trimmedWorkspaceId;
    this.config = config;
    this.historyService = historyService;
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
    this.telemetryService = telemetryService;
    this.sessionUsageService = sessionUsageService;
    this.keepBackgroundProcesses = keepBackgroundProcesses ?? false;
    this.sanitizeCliWorkspaceRegistration = sanitizeCliWorkspaceRegistration;
    this.onPostCompactionStateChange = onPostCompactionStateChange;
    this.onDeferredSendDelivered = onDeferredSendDelivered;
    this.hasExternalSendPreflight = hasExternalSendPreflight;

    this.compactionHandler = new CompactionHandler({
      workspaceId: this.workspaceId,
      historyService: this.historyService,
      sessionDir: path.join(this.config.sessionsDir, this.workspaceId),
      telemetryService,
      emitter: this.emitter,
      // The in-memory quarantine plus every outstanding repair key: a heartbeat
      // reset or compaction that runs before startup recovery stamped the keyed
      // rows must still keep them out of the carried-over pending state.
      getQuarantinedRowIds: () =>
        new Set([...this.unstampedRejectedRowIds, ...this.outstandingRejectedTurnKeys()]),
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
        // The swapped prefix is rebuilt from history copies and ships to the
        // live (possibly routed) provider mid-stream: the same provider-copy
        // rules as the summarizer head, applied at rebuild time so the durable
        // journal keeps the unfiltered sources. Post-compaction loaded-skill
        // attachments are a second channel for the same content.
        const eligible = await this.prepareContinuousCompactionRows(
          head,
          this.activeStreamContext.compactionBaseOptions != null
        );
        if (eligible === null) return null;
        const attachments = await this.buildContinuousCompactionAttachments(eligible.rows);
        const swapAttachments = eligible.projectContentWithheld
          ? (excludeProjectLoadedSkills(attachments) ?? [])
          : attachments;
        return {
          ...prepared,
          attachments: swapAttachments,
          prefixRows: (rows: MuxMessage[]) => {
            const filtered = this.excludeRejectedRows(rows);
            return eligible.projectContentWithheld
              ? withholdProjectSkillContentFromRequest(filtered)
              : filtered;
          },
          // The swap's own consent verdict for the per-step gate: content kept
          // under trust arms it (a revocation before the swapped prefix ships
          // then refuses the step); withheld content never does — withheld
          // copies keep their provenance stamps, so they must not be rescanned.
          prefixCarriesProjectSkillContent: eligible.projectContentWithheld
            ? () => false
            : (rows: MuxMessage[]) =>
                messagesCarryProjectSkillContent(rows) ||
                carriesProjectLoadedSkills(swapAttachments),
        };
      },
      summarize: async (head, signal, context: SessionCompactionContext) => {
        const baseOptions = context.sendOptions ?? { model: context.model, agentId: "exec" };
        const request = this.buildAutoCompactionRequest({
          baseOptions,
          followUpContent: { text: "Continue", model: context.model, agentId: "exec" },
          reason: "on-send",
        });
        // The compactor reads RAW history; what its summarizer sends is a
        // provider request like any other (see prepareContinuousCompactionRows).
        const eligible = await this.prepareContinuousCompactionRows(
          head,
          context.routedTurn === true
        );
        if (eligible === null || eligible.rows.length === 0) return null;
        return summarizeContinuousCompaction({
          workspaceId: this.workspaceId,
          config: this.config,
          aiService: this.aiService,
          sessionUsageService: this.sessionUsageService,
          head: eligible.rows,
          signal,
          context,
          baseOptions,
          compactOptions: request.sendOptions,
          beforeDispatch: () => this.continuousCompactionRowsStillEligible(eligible),
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
    Promise.all([stopped, invalidated, compactionStopped, retryStopped, backgroundStopped])
      .then(async () => {
        cleanupExecution[Symbol.dispose]();
        await cleanup("drain", () => this.coordinator.drain());
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
      .finally(() => disposed.resolve());
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

    // Consent refusals are non-retryable regardless of their generic
    // "unknown" classification (see retryActiveStream): the verdict cannot
    // change without user action, so never arm the retry manager for them.
    if (error.message?.includes(ROUTED_SKILL_TRUST_REVOKED_MESSAGE)) {
      this.emitRetryEvent({ type: "auto-retry-abandoned", reason: "pre_stream_rejected" });
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
    goalId?: string,
    requestAssemblySnapshot?: RequestAssemblySnapshot,
    contextBudgetRetried?: boolean,
    compactionBaseOptions?: SendMessageOptions,
    routedProjectConsent?: boolean,
    userMessageId?: string
  ): void {
    if (!options) {
      this.lastAutoRetryResumeRequest = undefined;
      return;
    }

    this.lastAutoRetryResumeRequest = {
      options,
      ...(requestAssemblySnapshot ? { requestAssemblySnapshot } : {}),
      ...(contextBudgetRetried === true ? { contextBudgetRetried: true } : {}),
      ...(agentInitiated === true ? { agentInitiated: true } : {}),
      ...(goalKind != null ? { goalKind } : {}),
      ...(goalId != null ? { goalId } : {}),
      ...(compactionBaseOptions != null ? { compactionBaseOptions } : {}),
      ...(routedProjectConsent === true ? { routedProjectConsent: true } : {}),
      ...(userMessageId != null ? { userMessageId } : {}),
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
      requestAssemblySnapshot: request.requestAssemblySnapshot,
      contextBudgetRetried: request.contextBudgetRetried,
      compactionBaseOptions: request.compactionBaseOptions,
      routedProjectConsent: request.routedProjectConsent,
      userMessageId: request.userMessageId,
    });
    // Interrupting the scheduling fiber cannot cancel resumeStream's original Promise.
    // Its late settlement must not mutate a replacement retry or accepted manual turn.
    if (this.coordinator.closing || !isCurrent()) return;
    if (
      !result.success &&
      result.error.type === "unknown" &&
      "raw" in result.error &&
      result.error.raw === ROUTED_SKILL_TRUST_REVOKED_MESSAGE
    ) {
      // Consent refusals are non-retryable: the verdict cannot change
      // without user action (re-granting trust or sending a new turn), and
      // RetryManager treats "unknown" as retryable with no attempt limit —
      // it would recheck the same revoked trust forever. resumeStream's
      // refusal already persisted the abandon marker WITH the refused
      // turn's row key and stamped its rows (rejectResumedRoutedTurn);
      // re-persisting here without the key would erase what the repair
      // needs to finish a failed stamp after a restart.
      this.emitRetryEvent({ type: "auto-retry-abandoned", reason: "pre_stream_rejected" });
      return;
    }
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
      this.extractRetryFailureMessage(result.error),
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
    return path.join(this.config.sessionsDir, this.workspaceId, AUTO_RETRY_PREFERENCE_FILE);
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

    return { reason: parsed.reason, userMessageId };
  }

  /**
   * Successful preference reads are cached per session, and every reader and writer of in-memory
   * auto-retry state waits for that read: a load that lands late cannot overwrite a newer change,
   * and a write never rebuilds the file from unloaded defaults.
   */
  private loadAutoRetryState(): Promise<void> {
    this.autoRetryStateLoad ??= this.runStartupRecoveryStep(() => this.readAutoRetryState()).catch(
      (error: unknown) => {
        this.autoRetryStateLoad = null;
        throw error;
      }
    );
    return this.autoRetryStateLoad;
  }

  private async loadAutoRetryEnabledPreference(isCurrent = () => true): Promise<boolean> {
    await this.loadAutoRetryState();
    if (this.coordinator.closing || !isCurrent()) return false;
    return this.autoRetryEnabledPreference !== false;
  }

  private async readAutoRetryState(): Promise<void> {
    const raw = await readFile(this.getAutoRetryPreferencePath(), "utf-8").catch(
      (error: unknown) => {
        // An unreadable preference is not consent to restart; let bounded admission retry the I/O.
        if (!hasErrorCode(error, "ENOENT")) throw error;
        return null;
      }
    );
    if (this.coordinator.closing) return;
    let parsed: {
      enabled?: unknown;
      startupAutoRetryAbandon?: unknown;
      pendingRejectedTurnRepair?: unknown;
    } = {};
    try {
      const document: unknown = JSON.parse(raw ?? "{}");
      if (document !== null && (typeof document !== "object" || Array.isArray(document))) {
        throw new Error("preference document is not a JSON object");
      }
      parsed = (document as typeof parsed | null) ?? {};
    } catch (error) {
      // FAIL CLOSED: the document may have carried the rejected-turn repair
      // record, whose keys nothing else knows (see corruptRejectedTurnRecord).
      this.corruptRejectedTurnRecord = { kind: "document", raw: raw ?? "" };
      log.error("Auto-retry preference is malformed; refusing sends until it is removed", {
        workspaceId: this.workspaceId,
        preferencePath: this.getAutoRetryPreferencePath(),
        error: getErrorMessage(error),
      });
    }
    // Missing preference file is the default path. Use any legacy frontend hint
    // (captured at onChat subscribe time) before falling back to enabled.
    const enabled =
      raw == null ? this.legacyAutoRetryEnabledHint !== false : parsed.enabled !== false;
    this.autoRetryEnabledPreference = enabled;
    this.legacyAutoRetryEnabledHint = null;
    this.startupAutoRetryAbandon ??= this.parseStartupAutoRetryAbandon(
      parsed.startupAutoRetryAbandon
    );
    // The durable repair record rides in the same file. Union, not replace: a
    // key recorded in memory before this load settled must survive it, and so
    // must every key on disk.
    const persistedRepairRecord = parsed.pendingRejectedTurnRepair;
    if (persistedRepairRecord != null) {
      const persistedKeys = parseStrictPendingRejectedTurnRepairKeys(persistedRepairRecord);
      if (persistedKeys === null) {
        // FAIL CLOSED: a present record that cannot be parsed hides the keys
        // of refused turns whose row stamp failed, and nothing else knows
        // them; read as "no keys", the next request build would include
        // those rows. The value is held as an unknown quarantine instead.
        this.corruptRejectedTurnRecord = { kind: "record", value: persistedRepairRecord };
        log.error("Rejected-turn repair record is malformed; refusing sends until it is removed", {
          workspaceId: this.workspaceId,
          preferencePath: this.getAutoRetryPreferencePath(),
        });
      } else if (persistedKeys.length > 0) {
        const keys = new Set([
          ...(this.pendingRejectedTurnRepair?.userMessageIds ?? []),
          ...persistedKeys,
        ]);
        this.pendingRejectedTurnRepair = { userMessageIds: [...keys] };
      }
    }
    this.retryManager.setEnabled(enabled);
    if (raw == null && !enabled) {
      // Persist migrated legacy opt-out so restart behavior no longer depends
      // on renderer localStorage keys. This write runs inside the load, so
      // persistAutoRetryState must not wait for loadAutoRetryState.
      await this.persistAutoRetryState();
    }
  }

  /**
   * The rejected-turn repair record — or the whole preference document that
   * carries it — as found on disk when it could not be parsed. Non-null means
   * the quarantine is UNKNOWN: the keys of refused turns whose stamp failed
   * are recorded nowhere else, so request builds are refused and the
   * malformed content is written back verbatim (side channels keep failing
   * closed across restarts) until the file is removed by hand. The file is
   * written atomically, so reaching this state takes external corruption.
   */
  private corruptRejectedTurnRecord:
    | { kind: "document"; raw: string }
    | { kind: "record"; value: unknown }
    | null = null;

  private autoRetryPersistence: Promise<void> = Promise.resolve();

  // Best-effort: a failed write only sets autoRetryStateUnrecorded, which the one caller that must
  // not acknowledge an unrecorded write (a user Stop) checks via recordPendingAutoRetryState. Only
  // the latest state change's write marks it recorded. Callers change the state only after
  // loadAutoRetryState settled, so the file is never rebuilt from unloaded defaults.
  private persistAutoRetryState(): Promise<void> {
    const version = ++this.autoRetryStateVersion;
    this.autoRetryStateUnrecorded = true;
    const preferencePath = this.getAutoRetryPreferencePath();
    const enabled = this.autoRetryEnabledPreference !== false;
    const abandon = this.startupAutoRetryAbandon;
    // The durable repair record rides in the same file: it outlives the marker
    // (accepted sends clear the marker, never the record), so the file is the
    // default state only when BOTH are absent.
    const pendingRepair = this.pendingRejectedTurnRepair;
    const corrupt = this.corruptRejectedTurnRecord;
    // Capture the admitted update, then serialize every writer (including success policy
    // and public opt-out). Generation checks cannot cancel an already-issued unlink: it
    // must settle before a newer preference commits, or it can erase the user's opt-out.
    // Once memory reflects this admitted snapshot it must commit even if its generation
    // retires while queued; a later clear may already see null and have nothing to enqueue.
    // Callers admit against the retry generation synchronously, before the load await.
    //
    // A malformed record (or document) is written back VERBATIM: it must keep
    // reading as an unknown quarantine, never as "no keys", until removed by
    // hand. Sends are refused meanwhile, so no new key can need the slot; a
    // key recorded in memory before the load settled stays in memory.
    const payload =
      corrupt?.kind === "document"
        ? corrupt.raw
        : enabled && !abandon && !pendingRepair && corrupt === null
          ? undefined
          : JSON.stringify({
              ...(!enabled ? { enabled: false } : {}),
              ...(abandon ? { startupAutoRetryAbandon: abandon } : {}),
              ...(corrupt !== null
                ? { pendingRejectedTurnRepair: corrupt.value }
                : pendingRepair
                  ? { pendingRejectedTurnRepair: pendingRepair }
                  : {}),
            }) + "\n";
    const execution = this.coordinator.enterExecution();
    const persisted = this.autoRetryPersistence
      .then(async () => {
        try {
          // Serialized per file with the closed-workspace marker sweep, which
          // may still be in flight for this workspace from before it opened.
          await serializePreferenceFileUpdate(preferencePath, async () => {
            if (payload === undefined) {
              await unlink(preferencePath);
            } else {
              await mkdir(path.dirname(preferencePath), { recursive: true });
              await replacePreferenceFile(preferencePath, payload);
            }
          });
        } catch (error) {
          if (payload !== undefined || !isErrnoWithCode(error, "ENOENT")) {
            log.warn("Failed to persist auto-retry preference", {
              workspaceId: this.workspaceId,
              error: getErrorMessage(error),
            });
            return;
          }
        }
        this.markAutoRetryStateRecorded(version);
      })
      .finally(() => execution[Symbol.dispose]());
    this.autoRetryPersistence = persisted;
    return persisted;
  }

  private markAutoRetryStateRecorded(version: number): void {
    // A state change made while this write ran has its own queued write; disk still lags memory.
    if (version === this.autoRetryStateVersion) this.autoRetryStateUnrecorded = false;
  }

  /**
   * A user Stop is acknowledged only once the auto-retry state its stopped turn relies on is on
   * disk: the startup abandon marker, or the opt-out a RetryBarrier Stop records while no stream is
   * active. Otherwise the trailing row stays eligible for startup replay. A write that failed earlier
   * (a withdrawn monitor wake, an aborted stream, that opt-out) is retried here, so the obligation
   * survives the Stop that first reported it. The default state owes disk nothing: a file that
   * outlived a failed unlink can only disable retries or suppress a replay.
   */
  async recordPendingAutoRetryState(): Promise<boolean> {
    await this.loadAutoRetryState().catch(() => undefined);
    if (this.autoRetryEnabledPreference === null) return false;
    if (
      this.autoRetryEnabledPreference !== false &&
      this.startupAutoRetryAbandon === null &&
      this.pendingRejectedTurnRepair === null
    ) {
      return true;
    }
    if (this.autoRetryStateUnrecorded) await this.persistAutoRetryState();
    return !this.autoRetryStateUnrecorded;
  }

  private async persistAutoRetryEnabledPreference(enabled: boolean): Promise<void> {
    await this.loadAutoRetryState();
    this.autoRetryEnabledPreference = enabled;
    await this.persistAutoRetryState();
  }

  private async persistStartupAutoRetryAbandon(
    reason: string,
    userMessageId?: string,
    isCurrent = () => true
  ): Promise<void> {
    if (!isCurrent()) return;
    await this.loadAutoRetryState().catch(() => undefined);
    this.startupAutoRetryAbandon = {
      reason,
      ...(userMessageId ? { userMessageId } : {}),
    };
    // Keep new Stop intent owed on a failed initial read, without overwriting an unknown opt-out.
    if (this.autoRetryEnabledPreference === null) this.autoRetryStateUnrecorded = true;
    else await this.persistAutoRetryState();
  }

  private async clearStartupAutoRetryAbandon(isCurrent = () => true): Promise<void> {
    if (!isCurrent()) return;
    await this.loadAutoRetryState();
    if (this.startupAutoRetryAbandon === null) {
      return;
    }

    this.startupAutoRetryAbandon = null;
    await this.persistAutoRetryState();
  }

  /** Persist (or retire) the durable repair record; best-effort like the abandon marker. */
  private async setPendingRejectedTurnRepair(
    record: { userMessageIds: string[] } | null
  ): Promise<void> {
    if (JSON.stringify(record) === JSON.stringify(this.pendingRejectedTurnRepair)) {
      return;
    }
    this.pendingRejectedTurnRepair = record;
    await this.persistAutoRetryState();
  }

  /** Add one outstanding key to the durable repair record; never evicts an older one. */
  private async addPendingRejectedTurnRepairKey(userMessageId: string): Promise<void> {
    const existing = this.pendingRejectedTurnRepair?.userMessageIds ?? [];
    if (existing.includes(userMessageId)) {
      return;
    }
    await this.setPendingRejectedTurnRepair({ userMessageIds: [...existing, userMessageId] });
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
    errorMessage?: string,
    isCurrent = () => true
  ): Promise<void> {
    // A consent refusal that surfaced through the generic stream error
    // pipeline (per-step prepareStep rejection is a plain Error there):
    // preserve the recognizable non-retryable classification — the generic
    // clear below would erase the repair marker the rejection callback just
    // persisted, and a restart would lose the quarantine key with it.
    if (errorMessage?.includes(ROUTED_SKILL_TRUST_REVOKED_MESSAGE)) {
      await this.persistStartupAutoRetryAbandon("pre_stream_rejected", userMessageId);
      return;
    }
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

    // Preserve explicit gateway identities (coder:, mux-gateway:, ...) just
    // like normal send-option normalization: normalizeToCanonical would
    // rewrite a cross-typed canonical-name instance such as
    // coder:openai/<claude> (type anthropic) to openai:<claude>, sending the
    // recovered turn through direct OpenAI instead of the selected gateway.
    const normalized = normalizeSelectedModel(model);
    return isValidModelFormat(normalized) ? normalized : undefined;
  }

  private isPendingAskUserQuestion(message: MuxMessage | null | undefined): boolean {
    return (
      message?.role === "assistant" &&
      message.parts.some(
        (part) =>
          part.type === "dynamic-tool" &&
          part.toolName === "ask_user_question" &&
          part.state === "input-available"
      )
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
    return historyTail.findLast(
      (candidate) =>
        candidate.role !== "system" &&
        !this.isSyntheticGoalPauseBoundaryMessage(candidate) &&
        !isSyntheticSnapshotUserMessage(candidate)
    );
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
    if (manualSendPreservesGoalActivation(goal, input.enqueuedAtMs)) {
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
    const metadata = await this.aiService.getWorkspaceMetadata?.(this.workspaceId);
    return metadata?.success ? metadata.data : undefined;
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

  /** Rejected rows terminate retry lookup, including empty assistant capsules from newer builds. */
  /**
   * Consent context for a resume that arrived without internal arguments (the
   * renderer's manual Retry): the persisted retry options of the row being
   * replayed — routedProjectConsent seeded at acceptance, the routed compaction
   * policy — and that row's key for the refusal stamp. Mirrors what startup
   * recovery derives. An unreadable tail yields nothing; the request build's
   * own history read then fails the resume.
   */
  private async deriveResumeConsentFromTail(): Promise<
    Result<
      {
        routedProjectConsent?: boolean;
        compactionBaseOptions?: SendMessageOptions;
        userMessageId?: string;
      },
      SendMessageError
    >
  > {
    const history = await this.historyService.getHistoryFromLatestBoundary(this.workspaceId);
    // FAIL CLOSED: the persisted row is the only record of a routed turn's
    // consent obligation, so an unreadable tail refuses the resume instead of
    // replaying the row as an unrouted send.
    if (!history.success) {
      return Err(
        createUnknownSendMessageError(
          `Cannot resume: the workspace history could not be read (${history.error}). Retry.`
        )
      );
    }
    const row = this.findLastRetryUserMessage(history.data);
    const retry = row?.metadata?.retrySendOptions;
    return Ok({
      routedProjectConsent: retry?.routedProjectConsent === true ? true : undefined,
      compactionBaseOptions: sanitizePersistedCompactionBaseOptions(retry?.compactionBaseOptions),
      userMessageId: row?.id,
    });
  }

  private findLastRetryUserMessage(messages: MuxMessage[]): MuxMessage | undefined {
    return messages.findLast(
      (message) =>
        Boolean(message.metadata?.contextBudgetRejected) ||
        this.shouldUseUserMessageForRetry(message)
    );
  }

  private shouldUseUserMessageForRetry(message: MuxMessage): boolean {
    if (message.role !== "user" || message.metadata?.contextBudgetRejected) {
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
        message.metadata.muxMetadata?.contextBudgetContinuation === true ||
        isCompactionRequestMetadata(message.metadata?.muxMetadata)
      );
    }

    return true;
  }

  /**
   * Startup crash recovery replays the ORIGINAL interrupted request from
   * persisted retry options / history metadata / workspace buckets. This is
   * request replay, not preference resolution, so it intentionally does not go
   * through resolveAgentAiSettings: these layers reconstruct a specific prior
   * request rather than deriving a fresh choice or promoting new defaults.
   */
  private async deriveStartupAutoRetryRequest(params: {
    partial: MuxMessage | null;
    historyTail: MuxMessage[];
    workspaceMetadata?: WorkspaceMetadata;
  }): Promise<StartupRetrySendOptions | undefined> {
    const lastUserMessage = this.findLastRetryUserMessage(params.historyTail);
    if (lastUserMessage?.metadata?.contextBudgetRejected) return undefined;

    const lastAssistantMessage =
      params.partial?.role === "assistant"
        ? params.partial
        : params.historyTail.findLast(
            (message): message is MuxMessage & { role: "assistant" } => message.role === "assistant"
          );

    const workspaceMetadata =
      params.workspaceMetadata ?? (await this.getWorkspaceMetadataForRetry());
    if (!workspaceMetadata || workspaceMetadata.parentWorkspaceId != null) return undefined;

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
    const persistedAgentId = normalizePersistedAgentCandidate(persistedRetrySendOptions?.agentId);
    const assistantAgentId = normalizePersistedAgentCandidate(
      lastAssistantMessage?.metadata?.agentId
    );
    const baseAgentId = persistedAgentId ?? assistantAgentId ?? workspaceAgentId;
    const agentSettings =
      [baseAgentId, ...workspaceAgentIdCandidates]
        .map((agentId) => workspaceMetadata?.aiSettingsByAgent?.[agentId])
        .find((settings) => settings != null) ?? workspaceMetadata?.aiSettings;
    const compactSettings = workspaceMetadata?.aiSettingsByAgent?.compact;

    const persistedModel = this.normalizeStartupModel(persistedRetrySendOptions?.model);
    const assistantModel = this.normalizeStartupModel(lastAssistantMessage?.metadata?.model);
    const agentSettingsModel = this.normalizeStartupModel(agentSettings?.model);
    // A retry row carrying routed compaction context recorded the CLASS model
    // the turn streamed on, which persistedModel already restores; the
    // sanitized compaction options ride the resume request below.
    const persistedCompactionBaseOptions = sanitizePersistedCompactionBaseOptions(
      persistedRetrySendOptions?.compactionBaseOptions
    );
    const baseModel = persistedModel ?? assistantModel ?? agentSettingsModel ?? DEFAULT_MODEL;

    const persistedThinkingLevel = coerceThinkingLevel(persistedRetrySendOptions?.thinkingLevel);
    const assistantThinkingLevel = coerceThinkingLevel(
      lastAssistantMessage?.metadata?.thinkingLevel
    );
    const agentSettingsThinkingLevel = coerceThinkingLevel(agentSettings?.thinkingLevel);
    const baseThinkingLevel =
      persistedThinkingLevel ?? assistantThinkingLevel ?? agentSettingsThinkingLevel;

    // Pro reasoning mode threads alongside thinkingLevel from the same sources
    // (assistant message metadata does not carry it), so startup retries do not
    // silently downgrade a pro-mode turn to standard.
    const persistedReasoningMode = coerceOpenAIReasoningMode(
      persistedRetrySendOptions?.reasoningMode
    );
    const agentSettingsReasoningMode = coerceOpenAIReasoningMode(agentSettings?.reasoningMode);
    const baseReasoningMode = persistedReasoningMode ?? agentSettingsReasoningMode;

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
      // A routed turn's on-send compaction request persisted the consent
      // obligation (its retry options seed routedProjectConsent): the resumed
      // compaction reads that turn's project snapshot, possibly on the class
      // model, so recovery re-verifies Project Trust like the turn itself —
      // this branch returns before the shared restoration below.
      if (persistedRetrySendOptions?.routedProjectConsent === true) {
        compactionRequest.routedProjectConsent = true;
      }
      if (persistedCompactionBaseOptions != null) {
        compactionRequest.compactionBaseOptions = persistedCompactionBaseOptions;
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

    // Routed turns persist their pre-routing compaction context; restore it so
    // the post-relaunch retry keeps the routed compaction policy instead of
    // force-compacting at the workspace threshold against the routed window.
    if (persistedCompactionBaseOptions != null) {
      retryRequest.compactionBaseOptions = persistedCompactionBaseOptions;
    }

    // Routed project-skill turns re-verify Project Trust on every resumed
    // dispatch (the resume path bypasses the send gates).
    if (persistedRetrySendOptions?.routedProjectConsent === true) {
      retryRequest.routedProjectConsent = true;
    }

    return retryRequest;
  }

  private hasInterruptedStartupTail(partial: MuxMessage | null, history: MuxMessage[]): boolean {
    if (this.isPendingAskUserQuestion(partial)) return false;
    if (partial?.role === "assistant") return true;
    const last = this.getLastNonSystemHistoryMessage(history);
    return last?.role === "user"
      ? !this.isVisibleCompletedSubagentReportMessage(last)
      : last?.role === "assistant" &&
          last.metadata?.partial === true &&
          !this.isPendingAskUserQuestion(last);
  }

  async getStartupAutoRetryModelHint(): Promise<string | null> {
    this.assertNotDisposed("getStartupAutoRetryModelHint");

    const [partial, historyResult] = (await this.readStartupTail()) ?? [];
    if (partial === undefined || !historyResult?.success) {
      return null;
    }

    if (this.findLastRetryUserMessage(historyResult.data)?.metadata?.contextBudgetRejected) {
      return null;
    }
    if (this.lastAutoRetryResumeRequest?.options.model) {
      return this.lastAutoRetryResumeRequest.options.model;
    }
    if (!this.hasInterruptedStartupTail(partial, historyResult.data)) return null;

    const retryRequest = await this.deriveStartupAutoRetryRequest({
      partial,
      historyTail: historyResult.data,
    });
    return retryRequest?.model ?? null;
  }

  private async runStartupRecoveryStep<T>(step: () => T | Promise<T>): Promise<T | undefined> {
    if (this.coordinator.closing) return;
    using _execution = this.coordinator.enterExecution();
    return await step();
  }

  private async scheduleStartupAutoRetryIfNeeded(
    workspaceMetadata?: WorkspaceMetadata
  ): Promise<StartupRecoveryOutcome> {
    if (this.coordinator.closing) return "completed";
    using _execution = this.coordinator.enterExecution();
    const turn = this.coordinator.turnId;
    const generation = this.retryManager.captureGeneration();
    const isCurrent = () =>
      !this.coordinator.closing && generation() && this.coordinator.isCurrentTurn(turn);
    if (this.coordinator.disposed || this.isBusy() || this.isAiStreaming()) {
      return "deferred";
    }

    const autoRetryEnabled = await this.loadAutoRetryEnabledPreference(isCurrent).catch(
      () => undefined
    );
    if (autoRetryEnabled == null) return "retryable";
    if (!isCurrent()) return "completed";
    // Quarantine repair runs regardless of the auto-retry preference (which
    // loadAutoRetryEnabledPreference just hydrated): the hazard is the next
    // MANUAL send's request including unstamped rejected rows, not automatic
    // replay.
    // Nothing has streamed since a still-present refusal marker, so a key-less
    // marker's turn is the newest retry-eligible row — the identification
    // abandonMatchesCurrentTail below relies on as well.
    await this.repairUnstampedRejectedTurn({ recoverKeylessMarker: {} });
    if (!isCurrent() || !autoRetryEnabled) return "completed";

    const [partial, historyResult] = (await this.readStartupTail()) ?? [];
    if (!isCurrent()) return "completed";
    if (partial === undefined || !historyResult?.success) {
      log.warn("Failed to inspect history for startup auto-retry", {
        workspaceId: this.workspaceId,
        error: historyResult?.success ? undefined : historyResult?.error,
      });
      return "retryable";
    }

    const startupRetryUserMessage = this.findLastRetryUserMessage(historyResult.data);
    if (startupRetryUserMessage?.metadata?.contextBudgetRejected) return "completed";
    if (!this.hasInterruptedStartupTail(partial, historyResult.data)) return "completed";

    // Pre-stream gate rejections never streamed and must never be replayed:
    // the row-level stamp is atomic with the row itself, so it holds even
    // when the crash landed between the row append and the preference-file
    // abandon write below.
    if (startupRetryUserMessage?.metadata?.preStreamRejected === true) {
      this.emitRetryEvent({ type: "auto-retry-abandoned", reason: "pre_stream_rejected" });
      return "completed";
    }

    if (this.startupAutoRetryAbandon) {
      const abandonReason = this.startupAutoRetryAbandon.reason;
      const abandonMatchesCurrentTail =
        this.startupAutoRetryAbandon.userMessageId === undefined ||
        this.startupAutoRetryAbandon.userMessageId === startupRetryUserMessage?.id;

      if (
        abandonMatchesCurrentTail &&
        (abandonReason === "pre_stream_rejected" ||
          isNonRetryableSendError({ type: abandonReason }) ||
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
        workspaceMetadata,
      });

      // Derivation reads metadata. A manual successor may have installed its own retry
      // envelope during that await; never overwrite it with this stale disk snapshot.
      if (!isCurrent()) return "completed";
      if (!retryRequest) {
        this.emitRetryEvent({ type: "auto-retry-abandoned", reason: "missing_retry_options" });
        return "completed";
      }

      // compactionBaseOptions is retry-state metadata, not a send option: it
      // must feed the resume state's routed-compaction context, never ride
      // inside the replayed SendMessageOptions themselves.
      const {
        agentInitiated,
        goalKind,
        goalId,
        compactionBaseOptions,
        routedProjectConsent,
        ...resumeOptions
      } = retryRequest;
      this.setAutoRetryResumeState(
        resumeOptions,
        agentInitiated,
        goalKind,
        goalId,
        undefined,
        undefined,
        compactionBaseOptions,
        routedProjectConsent,
        // The row this recovery replays — a refused resume stamps it without
        // re-reading the tail.
        startupRetryUserMessage?.id
      );
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

  private async waitForStartupReadRetry(
    retryDelayMs: number,
    signal = this.closingSignal
  ): Promise<void> {
    const delayMs = Math.max(0, Math.trunc(retryDelayMs));
    if (delayMs > 0) {
      const runner = this.streamManager.effectRunner ?? defaultEffectRunner;
      const sleeper = runner.runFork(Effect.sleep(delayMs));
      try {
        await raceWithAbortAndTimeout(runner.runPromise(Fiber.await(sleeper)), { signal });
      } finally {
        sleeper.interruptUnsafe();
      }
    }
  }

  private async waitForStartupAutoRetryRerunWindow(retryDelayMs = 0): Promise<void> {
    await this.waitForStartupReadRetry(retryDelayMs);
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

  async getStartupRecoveryState(
    timeoutMs = STARTUP_RECOVERY_PROBE_TIMEOUT_MS
  ): Promise<StartupRecoveryState> {
    if (this.closingSignal.aborted) return "blocked";
    const deadline = new AbortController();
    const signal = AbortSignal.any([this.closingSignal, deadline.signal]);
    try {
      // Release admission on timeout, not the original read's physical I/O lease.
      const probe = retryStartupRead(
        () => this.readStartupRecoveryState(signal).catch(() => "blocked" as const),
        (state) => state === "blocked",
        { signal, wait: (delay) => this.waitForStartupReadRetry(delay, signal) }
      );
      const result = await raceWithAbortAndTimeout(probe, { signal, timeoutMs });
      return result.kind === "ok" ? (result.value ?? "blocked") : "blocked";
    } catch {
      return "blocked";
    } finally {
      deadline.abort();
    }
  }

  private readStartupTail(strictPartial = false) {
    // A rejected read does not cancel its sibling. Keep their lease until both physically settle.
    return this.runStartupRecoveryStep(() =>
      Promise.all([
        this.historyService
          .readPartial(this.workspaceId, { throwOnError: strictPartial })
          .catch(() => undefined),
        this.historyService.getLastMessages(this.workspaceId, 20).catch(() => null),
      ])
    );
  }

  private async readStartupRecoveryState(signal: AbortSignal): Promise<StartupRecoveryState> {
    await this.loadAutoRetryState();
    if (signal.aborted) return "blocked";
    if (this.autoRetryEnabledPreference === false) return "stopped";
    const [partial, history] = (await this.readStartupTail(true)) ?? [];
    if (!history?.success || partial === undefined) return "blocked";
    const abandon = this.startupAutoRetryAbandon;
    if (abandon?.reason === "aborted") {
      // Accepted synthetic guidance is new intent too; snapshots/notices are not.
      const latest = history.data.findLast(
        (message) =>
          this.shouldUseUserMessageForRetry(message) ||
          (message.role === "user" && message.metadata?.retrySendOptions != null)
      );
      if (!abandon.userMessageId || !latest || latest.id === abandon.userMessageId)
        return "stopped";
    }
    // A question may regain its lost queue, but must never override an applicable Stop.
    if (
      this.isPendingAskUserQuestion(partial) ||
      this.isPendingAskUserQuestion(this.getLastNonSystemHistoryMessage(history.data))
    )
      return "question";
    return this.hasInterruptedStartupTail(partial, history.data) ? "interrupted" : "idle";
  }

  ensureStartupAutoRetryCheck(): Promise<void> {
    return this.runStartupRecovery();
  }

  async runStartupRecovery(metadata?: WorkspaceMetadata): Promise<void> {
    // TaskService owns child recovery; replaying a stopped child must never restart it.
    metadata ??= await this.getWorkspaceMetadataForRetry();
    if (!metadata || metadata.parentWorkspaceId != null) return;
    // Reuse the bulk startup snapshot throughout retry derivation instead of rescanning all workspaces.
    return this.startupRecovery.run(() => this.scheduleStartupAutoRetryIfNeeded(metadata));
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

  scheduleStartupRecovery(metadata?: WorkspaceMetadata): void {
    this.runStartupRecovery(metadata).catch((error: unknown) => {
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
  ): Promise<AgentSessionResult<SendMessageAccepted | undefined>> {
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
      queued: internal?.turnReservation != null || internal?.dequeued === true,
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
        if (attempt.outcome !== "background")
          await attempt.preparedRequest?.[Symbol.asyncDispose]();
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
  ): Promise<AgentSessionResult<SendMessageAccepted | undefined>> {
    assert(typeof message === "string", "sendMessage requires a string message");

    const isManualUserMessage = internal?.synthetic !== true;

    // Single admission-staleness predicate for all three turn-admission gates below.
    const isAdmissionStale = () =>
      internal?.admissionEpochStale?.() === true ||
      internal?.admissionStale?.() === true ||
      !this.coordinator.isCurrentTurn(attempt.owner ?? attempt.expectedTurn) ||
      this.coordinator.editBlocked(attempt.editReservation?.id);
    // An edit's truncation is irreversible: past it, only the replacement row records the user's
    // input, so shutdown must let that row land (the PREPARING gate then refuses with rows
    // retained and startup recovery resumes the edit) rather than lose both versions.
    let editTailTruncated = false;
    const shutdownRefusesBeforePersist = (): boolean =>
      this.coordinator.closing && !editTailTruncated;

    const cancelSignal = internal?.cancelSignal;
    const persistedCancelableMessageIds: string[] = [];
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
      this.continuousCompactor.reset("delete-messages");
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
    const markRowsDurable = (): void => {
      if (attempt.durability !== "rollback-eligible") return;
      attempt.durability = "durable";
      if ((internal?.preTurnMessages?.length ?? 0) > 0) internal?.onPreTurnRowsPersisted?.();
    };
    const accept = async (): Promise<void> => {
      if (attempt.durability === "accepted") return;
      await internal?.onAccepted?.();
      attempt.durability = "accepted";
    };
    const refuseBeforeAcceptance = async (
      error: SendMessageError
    ): Promise<AgentSessionResult<SendMessageAccepted | undefined>> => {
      if (attempt.durability === "rollback-eligible" && !(await rollbackPersistedTurnRows()))
        markRowsDurable();
      return Err(error);
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
    // Resolve per-skill model routing before any gate or mutation below: the
    // pricing gate and PDF preflight must judge the model that will actually
    // stream, and a broken class binding must reject the send BEFORE the edit
    // path truncates history (see the invariant comment on the edit branch).
    // Mirroring the pricing gate: a manual send rejected here is persisted and
    // surfaced as a stream-error — a bare Err would let sendQueuedMessages()
    // drop the user's queued input with no visible feedback.
    const typedMuxMetadata = options?.muxMetadata as MuxMessageMetadata | undefined;
    const inspectedSkill: { package?: ResolvedAgentSkill } = {};
    const skillModelOverride = options
      ? await this.resolveSkillModelClassOverride(typedMuxMetadata, options, inspectedSkill)
      : null;
    // Package reuse for materialization: a routed turn's consent-anchoring
    // package, or the package the resolver already read to inspect an UNBOUND
    // skill's frontmatter — one (possibly remote) SKILL.md read per
    // invocation, not two.
    const preResolvedSkillPackage =
      (skillModelOverride?.kind === "override" ? skillModelOverride.resolvedPackage : undefined) ??
      inspectedSkill.package;
    const preResolvedSkills =
      preResolvedSkillPackage != null
        ? new Map([[preResolvedSkillPackage.package.directoryName, preResolvedSkillPackage]])
        : undefined;
    if (await cancelBeforeAcceptance()) {
      return Ok(undefined);
    }
    if (skillModelOverride?.kind === "config-error") {
      const routingError = createUnknownSendMessageError(skillModelOverride.message);
      // Preservation exists for dequeued sends whose composer already cleared —
      // a rejected EDIT must not append the edited text as a new tail turn
      // (the original message is untouched and the browser restores the draft).
      if (isManualUserMessage && options?.editMessageId == null && attempt.queued) {
        // Queue authoring time rides along like the pricing rejection below:
        // without it, a skill queued before a later goal activation reads as
        // post-goal and wrongly pauses the fresh goal (and the unstamped row
        // is misclassified again after restart).
        const persisted = await this.preserveRejectedManualSend(
          message,
          options,
          routingError,
          internal?.enqueuedAtMs
        );
        if (persisted) {
          await this.applyManualUserMessageGoalSafety({
            policy: "pause",
            enqueuedAtMs: internal?.enqueuedAtMs,
          });
        }
      }
      return Err(routingError);
    }
    // The model every downstream gate must validate: the routed class model
    // when routing applies, else the caller's model.
    const effectiveModelForGates = skillModelOverride?.model ?? options?.model;

    if (this.workspaceGoalService) {
      const pricingGate = await this.workspaceGoalService.assertPricedModelForBudgetedGoal(
        this.workspaceId,
        effectiveModelForGates
      );
      if (await cancelBeforeAcceptance()) {
        return Ok(undefined);
      }
      if (isAdmissionStale())
        return refuseBeforeAcceptance(
          createUnknownSendMessageError(CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE)
        );
      if (!pricingGate.success) {
        // Like the class-routing and PDF gates: preservation is for dequeued
        // sends whose composer already cleared — a rejected EDIT (now
        // reachable here via routed skill edits) must not append the edited
        // text as a new tail turn.
        if (isManualUserMessage && options?.editMessageId == null && attempt.queued) {
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

      if (pdfParts.length > 0 && effectiveModelForGates != null) {
        // Judge the routed class model when skill routing applies — the
        // workspace model's PDF support is irrelevant to what will stream.
        const caps = getModelCapabilitiesResolved(
          effectiveModelForGates,
          this.aiService.getProvidersConfig()
        );

        // Rejections persist + surface like the pricing/routing gates: routable
        // skill sends skip the browser PDF preflight and can arrive here from
        // the queue drain, where a bare Err would silently discard the user's
        // text and attachment (the composer already cleared on queue accept).
        const rejectPdf = async (
          errorMessage: string
        ): Promise<Result<undefined, SendMessageError>> => {
          const pdfError = createUnknownSendMessageError(errorMessage);
          // See the class-routing gate above: preservation is for dequeued
          // sends, never for rejected edits (which would duplicate the turn).
          if (isManualUserMessage && options?.editMessageId == null && attempt.queued) {
            // Same queue-timestamp threading as the routing and pricing gates.
            const persisted = await this.preserveRejectedManualSend(
              message,
              options,
              pdfError,
              internal?.enqueuedAtMs
            );
            if (persisted) {
              await this.applyManualUserMessageGoalSafety({
                policy: "pause",
                enqueuedAtMs: internal?.enqueuedAtMs,
              });
            }
          }
          return Err(pdfError);
        };

        if (caps && !caps.supportsPdfInput) {
          return rejectPdf(`Model ${effectiveModelForGates} does not support PDF input.`);
        }

        if (caps?.maxPdfSizeMb !== undefined) {
          const maxBytes = caps.maxPdfSizeMb * 1024 * 1024;
          for (const part of pdfParts) {
            const bytes = estimateBase64DataUrlBytes(part.url);
            if (bytes !== null && bytes > maxBytes) {
              const actualMb = (bytes / (1024 * 1024)).toFixed(1);
              const label = part.filename ?? "PDF";
              return rejectPdf(
                `${label} is ${actualMb}MB, but ${effectiveModelForGates} allows up to ${caps.maxPdfSizeMb}MB per PDF.`
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

    // Edit turns materialize skill snapshots BEFORE truncation (see below);
    // the persistence section reuses this instead of materializing again.
    let preTruncationSkillSnapshots: {
      messages: MuxMessage[];
      carriesProjectSkillContent: boolean;
      resolvedScopes: Map<string, AgentSkillScope>;
    } | null = null;
    // Whether project-scope skill content rides this routed turn: seeded
    // from the invoked package's scope, widened by materialization (an
    // inline $project-skill ref travels on a globally-invoked routed turn
    // too). The late consent gates key on this.
    let routedTurnCarriesProjectContent =
      skillModelOverride?.kind === "override" &&
      skillModelOverride.resolvedPackage?.package.scope === "project";

    if (editMessageId) {
      if (this.coordinator.editBlocked())
        return refuseBeforeAcceptance(
          createUnknownSendMessageError(CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE)
        );
      // Reserve before interrupting: terminal policy can otherwise start queued work
      // while stopStream settles, leaving this edit waiting on the wrong turn.
      attempt.editReservation = this.coordinator.reserve("edit");
      this.continuousCompactor.reset("edit");
      // Ignore our own reservation when deciding whether a turn needs to settle.
      if (this.coordinator.phase !== "idle") {
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
        if (!this.coordinator.preemptPreparation()) {
          await this.waitForIdle();
        }

        // Teardown may have started while completion cleanup was settling.
        if (this.coordinator.disposed) {
          return Ok(undefined);
        }
      }

      // Recheck admission after settlement: a context mutation may have already
      // claimed admission or discarded the target before we reserved the edit.
      if (this.coordinator.admissionBlocked || isAdmissionStale()) {
        return refuseBeforeAcceptance(
          createUnknownSendMessageError(CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE)
        );
      }
      if (this.coordinator.closing) {
        return refuseBeforeAcceptance(
          createUnknownSendMessageError(SESSION_SHUTDOWN_SEND_BLOCKED_MESSAGE)
        );
      }

      attempt.expectedTurn = this.coordinator.turnId;

      // The edit is about to truncate and rewrite history. Any queued content from
      // the previous turn was written in the old context — return it to the input
      // so the user can re-evaluate, and start the edit stream with an empty queue.
      this.restoreQueueToInput();

      // Provider-selection consent can be revoked while the edit waited for
      // idle above: recheck BEFORE the destructive truncation — rejecting
      // after it would leave a partial edit (deleted tail, no replacement
      // turn) with only the renderer draft restored.
      if (
        skillModelOverride?.kind === "override" &&
        skillModelOverride.resolvedPackage?.package.scope === "project" &&
        !(await this.isRoutedProjectSkillTurnStillTrusted())
      ) {
        return Err(createUnknownSendMessageError(ROUTED_SKILL_TRUST_REVOKED_MESSAGE));
      }

      // Materialize skill snapshots BEFORE the destructive truncation: the
      // materialization awaits (skill reads, dynamic context injection) are
      // where mid-send trust revocation and unresolvable-skill errors
      // surface, and any rejection there must land while the edited row and
      // tail still exist. Recent-snapshot dedupe is skipped — it would
      // compare against rows the truncation below is about to delete and
      // wrongly suppress a snapshot the rewritten history needs. The rows
      // are APPENDED later, in the same persistence order as a plain send.
      try {
        preTruncationSkillSnapshots = await this.materializeAgentSkillSnapshots(
          typedMuxMetadata,
          options?.disableWorkspaceAgents,
          // Not a fresh context window: the dedupe is skipped below anyway.
          false,
          preResolvedSkills,
          skillModelOverride?.kind === "override",
          true
        );
      } catch (error) {
        return Err(createUnknownSendMessageError(getErrorMessage(error)));
      }
      if (preTruncationSkillSnapshots?.carriesProjectSkillContent) {
        routedTurnCarriesProjectContent = true;
      }

      // A rejected turn whose durable stamp failed can still be unstamped
      // here: after a restart, startup recovery runs asynchronously and the
      // in-memory quarantine is empty. The truncation below removes rows for
      // good and the abandoned-branch summarizer reads them (possibly on
      // another provider), so the marker/record-gated repair must land first.
      await this.loadAutoRetryEnabledPreference();
      await this.repairUnstampedRejectedTurn();

      // Find the truncation target: the edited message or any immediately-preceding snapshots.
      // (snapshots are persisted immediately before their corresponding user message)
      // Pre-boundary edits are user-confirmed by the composer, so fall back to full-history lookup
      // when the edit target is outside the active context window.
      const truncateTargetId = await this.getEditTruncateTargetId(editMessageId);

      // Last recheck immediately before the destructive truncation: the
      // materialization and truncate-target reads above are awaits, and a
      // rejection AFTER truncation cannot restore the discarded tail. Uses
      // the widened flag (inline project refs discovered by the
      // materialization above included).
      if (
        skillModelOverride?.kind === "override" &&
        routedTurnCarriesProjectContent &&
        !(await this.isRoutedProjectSkillTurnStillTrusted())
      ) {
        return Err(createUnknownSendMessageError(ROUTED_SKILL_TRUST_REVOKED_MESSAGE));
      }

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
        editTailTruncated = true;
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
          // Rejected rows (durably stamped, or quarantined after a failed
          // stamp) are transcript-only: the side-channel summarizer must not
          // distill them either.
          abandonedMessages: this.excludeRejectedRows(truncateResult.data.removedMessages),
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
    // typedMuxMetadata was hoisted above the routing/pricing gates.
    const acpPromptId =
      normalizeAcpPromptId(options?.acpPromptId) ?? extractAcpPromptId(typedMuxMetadata);
    const delegatedToolNames =
      normalizeDelegatedToolNames(options?.delegatedToolNames) ??
      extractAcpDelegatedTools(typedMuxMetadata);
    const isCompactionRequest = isCompactionRequestMetadata(typedMuxMetadata);
    if (isCompactionRequest) {
      this.clearContextBudgetState();
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

    // Apply the per-skill routing override resolved at the top of sendMessage
    // (before the gates and the edit branch). Applied before the user message
    // is created so startup retries (retrySendOptions) replay the routed
    // model, and before the compaction threshold check so context-limit math
    // uses the model that will actually stream. preRoutingOptions feeds the
    // compaction REQUEST below: a turn routed to a small model must never
    // compact on that small model — the compaction model has to fit the full
    // uncompacted history.
    const preRoutingOptions = optionsForStream;
    let muxMetadataForMessage = typedMuxMetadata;
    // The invocation row's `scope` is CLIENT-stamped, yet the withholding
    // tracker (rowInvokesProjectSkill) reads it durably — a repeated project
    // invocation whose snapshot deduplicated leaves no snapshot row. Persist
    // the AUTHORITATIVE scope of the package the resolver read: a stale or
    // forged non-project scope on a project skill must not let the turn's
    // reply escape withholding after a trust revocation. Inline refs get the
    // same treatment after materialization (withAuthoritativeSkillScopes).
    if (preResolvedSkillPackage != null) {
      muxMetadataForMessage = withAuthoritativeSkillScopes(
        muxMetadataForMessage,
        new Map([
          [preResolvedSkillPackage.package.directoryName, preResolvedSkillPackage.package.scope],
        ])
      );
    }
    let routedThinkingLevel: ThinkingLevel | undefined;
    if (skillModelOverride != null) {
      modelForStream = skillModelOverride.model;
      // Numeric one-shot thinking is model-relative: the frontend resolved
      // options.thinkingLevel against the workspace model before routing was
      // known, so "/+0 /skill" must be re-resolved here to mean the ROUTED
      // model's lowest level, not the workspace model's.
      const reroutedOneShotThinking =
        options.oneShotThinkingIndex != null
          ? resolveThinkingInput(
              options.oneShotThinkingIndex,
              skillModelOverride.model,
              this.getProvidersConfigSafe()
            )
          : undefined;
      // Precedence: explicit numeric one-shot (re-resolved above) > class
      // thinking > ambient options. skipAiSettingsPersistence marks one-shot
      // sends, so a named "/+high /skill" keeps the user's level rather than
      // the class default.
      routedThinkingLevel =
        reroutedOneShotThinking ??
        (skillModelOverride.thinkingLevel != null && options.skipAiSettingsPersistence !== true
          ? skillModelOverride.thinkingLevel
          : undefined);
      optionsForStream = {
        ...optionsForStream,
        model: skillModelOverride.model,
        ...(routedThinkingLevel != null ? { thinkingLevel: routedThinkingLevel } : {}),
      };
      // The persisted request metadata must advertise the model that will
      // actually stream: the pending-turn label and downstream consumers read
      // requestedModel from the user message.
      if (muxMetadataForMessage != null) {
        muxMetadataForMessage = {
          ...muxMetadataForMessage,
          requestedModel: skillModelOverride.model,
        };
      }
    } else if (options.oneShotThinkingIndex != null) {
      // Unrouted (or no longer routable) send carrying a numeric one-shot: the
      // frontend resolved the index against the model it believed would
      // stream — after a compact-and-retry of a "/+N /skill" turn whose class
      // binding is gone, that can be the previous class model rather than
      // the selected one. The index is model-relative, so it is resolved here
      // against the model that actually streams, routed or not.
      const oneShotThinking = resolveThinkingInput(
        options.oneShotThinkingIndex,
        modelForStream,
        this.getProvidersConfigSafe()
      );
      if (oneShotThinking != null) {
        optionsForStream = { ...optionsForStream, thinkingLevel: oneShotThinking };
      }
    }

    // RLM keep-recent floor: stamp compaction requests (manual /compact,
    // mid-stream forced, idle) with the durable tail-start sequence before the
    // row is persisted. No-op when RLM is off. Takes the routing-aware
    // metadata so a routed re-stamp (requestedModel) survives; the two stamps
    // touch disjoint metadata types (compaction-request vs agent-skill).
    const stampedMuxMetadata =
      isCompactionRequest && muxMetadataForMessage?.type === "compaction-request"
        ? await this.withKeepRecentTailStamp(muxMetadataForMessage, optionsForStream)
        : muxMetadataForMessage;

    // Routed sends report the class model and the effective thinking level
    // back to the caller so successful-send telemetry attributes the
    // invocation to what actually streams. The level is whatever the stream
    // will receive (class suffix, re-resolved numeric one-shot, or a named
    // one-shot / ambient level riding through), clamped by the same per-model
    // floor enforcement the stream applies — "/+off /skill" routed onto a
    // floor-medium model reports medium, not off.
    const sendAccepted: SendMessageAccepted | undefined =
      skillModelOverride != null
        ? {
            routedModel: skillModelOverride.model,
            ...(optionsForStream.thinkingLevel != null
              ? {
                  routedThinkingLevel: this.enforceThinkingFloorsForModel(
                    skillModelOverride.model,
                    optionsForStream.thinkingLevel,
                    this.getProvidersConfigSafe()
                  ),
                }
              : {}),
          }
        : undefined;

    // A compaction replacing a routed stream (interruptForCompaction) inherits
    // that stream's consent gate: it reads the same project snapshot, possibly
    // on the class model (routed UP), so it re-verifies trust like the turn
    // and seeds the same obligation into its own retry state and row.
    const inheritedConsentRejection = internal?.inheritedConsentRejection;
    const inheritsRoutedConsent = inheritedConsentRejection != null;

    // Which options a routed turn's compaction (on-send or mid-stream forced)
    // must run with: the compaction request has to read the FULL uncompacted
    // history, so it needs whichever model has the larger usable window.
    // Routing usually shrinks the window (the user's model wins), but a class
    // can also route UP — repeated routed turns can then grow the history past
    // the user's model, and summarizing on it would just context-error again.
    const compactionBaseOptionsForRoutedTurn = ((): SendMessageOptions | undefined => {
      if (skillModelOverride == null) {
        return undefined;
      }
      const providersConfigForWindows = this.getProvidersConfigSafe();
      const userModel = preRoutingOptions.model;
      if (userModel == null) {
        return optionsForStream;
      }
      // Each option set's own OpenAI wire format decides whether the Codex
      // OAuth cap applies to its window: a Chat Completions send with an API
      // key has the full public window, and inferring the OAuth cap here would
      // misjudge which model can compact the history.
      const userLimit = getEffectiveContextLimit(
        userModel,
        this.is1MContextEnabledForModel(userModel, preRoutingOptions, providersConfigForWindows),
        providersConfigForWindows,
        { openaiWireFormat: preRoutingOptions.providerOptions?.openai?.wireFormat }
      );
      const routedLimit = getEffectiveContextLimit(
        skillModelOverride.model,
        this.is1MContextEnabledForModel(
          skillModelOverride.model,
          optionsForStream,
          providersConfigForWindows
        ),
        providersConfigForWindows,
        { openaiWireFormat: optionsForStream.providerOptions?.openai?.wireFormat }
      );
      return (routedLimit ?? 0) > (userLimit ?? 0) ? optionsForStream : preRoutingOptions;
    })();

    const userMessage = createMuxMessage(
      messageId,
      "user",
      message,
      {
        timestamp: Date.now(),
        toolPolicy: typedToolPolicy,
        disableWorkspaceAgents: options?.disableWorkspaceAgents,
        retrySendOptions: pickStartupRetrySendOptions(
          optionsForStream,
          agentInitiated,
          goalKind,
          compactionBaseOptionsForRoutedTurn,
          // Durable consent seed (invoked package's scope). Materialization
          // below can widen it for inline project references; it rewrites
          // this row's retry options before the row persists. A compaction
          // replacing a routed stream inherits the obligation.
          routedTurnCarriesProjectContent || inheritsRoutedConsent
        ),
        muxMetadata: stampedMuxMetadata, // Frontend metadata; requestedModel re-stamped when routing applied
        ...(acpPromptId != null ? { acpPromptId } : {}),
        ...(goalKind != null ? { kind: goalKind } : {}),
        // Scope goal-loop rows to their goal so a replaced goal's continuation
        // cannot reactivate its successor during chat-tail reconciliation.
        ...(goalKind != null && internal?.goalId != null ? { goalId: internal.goalId } : {}),
        // Persist the queue-entry authoring time so goal-safety reconciliation
        // can re-derive the pre-goal/post-goal distinction after a restart.
        ...(internal?.enqueuedAtMs != null ? { enqueuedAtMs: internal.enqueuedAtMs } : {}),
        // Auto-resume and other system-generated messages are synthetic + UI-visible
        ...(internal?.synthetic && {
          synthetic: true,
          uiVisible: !typedMuxMetadata?.contextBudgetContinuation,
        }),
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
    const tokenBudgetActive = this.isTokenBudgetActive(optionsForStream);
    // Token-budget mode went inactive with a reset pending: a flush turn may have stopped on a
    // required-tool success or a text-only finish, both of which bypass the settled-step callback
    // that normally drops the intent. Drop it here, unconditionally, so re-enabling the mode later
    // (possibly with a larger model) cannot seal a below-threshold context with a stale snapshot.
    if (!tokenBudgetActive && this.pendingRollover != null) this.dropContextBudgetIntent();
    // A queued flush entry dispatched after the mode went inactive cannot be admitted (no pinned
    // middleware snapshot, nothing to seal): dispatch it as an ordinary continuation instead of a
    // hidden memory-only turn, and drop its paired continuation (mirrors the pre-dispatch degrade).
    if (!tokenBudgetActive && userMessage.metadata?.muxMetadata?.contextBudgetFlush === true) {
      optionsForStream = this.degradeFlushEntryToContinuation(userMessage, optionsForStream);
    }
    // Await rejection at each return so the execution lease owns persistence and goal safety.
    const rejectBudgetSend = async (error: SendMessageError) => {
      if (isManualUserMessage) {
        const actionable = await this.preserveRejectedManualSend(
          message,
          options,
          error,
          internal?.enqueuedAtMs
        );
        // Rejection does not cancel the user's intervention; match the pricing gate's safety.
        if (actionable) {
          await this.applyManualUserMessageGoalSafety({
            policy: "pause",
            enqueuedAtMs: internal?.enqueuedAtMs,
          });
        }
      } else {
        this.emitChatEvent(createStreamErrorMessage(buildStreamErrorEventData(error)));
      }
      return Err(error);
    };
    let contextBudgetPrefix: MuxMessage[] = [];
    let requestAssemblySnapshot: RequestAssemblySnapshot | undefined;
    if (tokenBudgetActive && !editMessageId) {
      // A stopped turn's partial belongs to the old window, never after its reset.
      const committed = await this.historyService.commitPartial(this.workspaceId);
      if (!committed.success) return Err(createUnknownSendMessageError(committed.error));
      await this.seedUsageStateFromHistory();
      const prepared = await this.prepareContextBudgetSend(userMessage, optionsForStream);
      if (!prepared.success) {
        return await rejectBudgetSend(prepared.error);
      }
      contextBudgetPrefix = prepared.data.prefix;
      requestAssemblySnapshot = prepared.data.requestAssemblySnapshot;
    }
    const contextRollover =
      contextBudgetPrefix[0]?.metadata?.muxMetadata?.type === "context-window-rollover";
    // Pre-turn rows cannot ride the on-send compaction follow-up (its durable
    // metadata carries only text + send options), and compacting a payload row
    // away would dangle the trigger's message-ID reference. Family sends are
    // small and bounded, so skip on-send compaction for them; mid-stream
    // forcing still protects the context limit.
    const hasPreTurnMessages = (internal?.preTurnMessages?.length ?? 0) > 0;
    if (!tokenBudgetActive && !isCompactionRequest && !editMessageId && !hasPreTurnMessages) {
      // Seed usage state from persisted history on the first send after restart
      // so the compaction monitor can detect context limits even before any live
      // stream events have populated lastUsageState.
      await this.seedUsageStateFromHistory();
      if (await cancelBeforeAcceptance()) {
        return Ok(undefined);
      }

      const providersConfigForCompaction = this.getProvidersConfigSafe();
      // Recover before measuring pressure so the old pre-swap usage cannot force another fold.
      if (await this.continuousCompactor.recover()) this.clearUsageState();
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
        optionsForStream,
        compactionBaseOptionsForRoutedTurn != null
      );
      if (!continuousContext.enabled) this.continuousCompactor.reset("disabled");
      const continuousResult = continuousContext.enabled
        ? await this.continuousCompactor.observe(compactionResult.usagePercentage, {
            ...continuousContext,
            phase: "on-send",
          })
        : "none";
      if (continuousResult === "applied") this.clearUsageState();
      if (await cancelBeforeAcceptance()) return Ok(undefined);

      // A staged fold needs no compact turn. Without one, the experiment waits
      // until the force threshold; the legacy path retains its on-send threshold.
      //
      // Skill-routed sends compact only when the content genuinely risks
      // overrunning the routed model's window: applying the threshold (or the
      // experiment's force bar) to the (smaller) routed window would let a
      // one-off cheap-skill invocation force an unrequested, irreversible,
      // workspace-wide compaction of a session far under its own model's
      // limit. The headroom accounts for the pending turn (new message,
      // attachments, skill snapshot), which the recorded usage doesn't
      // include yet.
      // The recorded usage excludes the pending turn, and a routed window can
      // be far smaller than the workspace model's: size what this send adds
      // — the prompt, the invoked skill's body (bounded like its snapshot)
      // and text attachments — against the routed window before deciding
      // compaction is unnecessary, or the routed invocation fails with a
      // context error instead of taking the compaction path. Inline skill
      // references materialize after this decision and media attachments are
      // priced per image/page, not by bytes; both stay under the headroom.
      const routedPendingPercent =
        skillModelOverride?.kind === "override"
          ? this.estimateRoutedPendingSendPercent({
              message,
              skillBody: skillModelOverride.resolvedPackage?.package.body,
              // Inline $skill references materialize a snapshot each (bodies
              // unknown until then); count every one at the snapshot cap.
              inlineSkillRefCount: extractAgentSkillRefs(typedMuxMetadata).filter(
                (ref) => ref.source !== "slash"
              ).length,
              fileParts: effectiveFileParts,
              // The @file snapshot is already built (exact size); MCP prompt
              // snapshots materialize after this decision and their reference
              // list is uncapped, so each is priced at the prompt text cap.
              fileSnapshotChars:
                snapshotResult?.snapshotMessage.parts.reduce(
                  (sum, part) => sum + (part.type === "text" ? part.text.length : 0),
                  0
                ) ?? 0,
              mcpPromptRefCount: dedupeMcpPromptRefs(
                sanitizeMcpPromptRefs(typedMuxMetadata?.mcpPromptRefs)
              ).length,
              model: modelForStream,
              use1MContext: this.is1MContextEnabledForModel(
                modelForStream,
                optionsForStream,
                providersConfigForCompaction
              ),
              providersConfig: providersConfigForCompaction,
              openaiWireFormat: optionsForStream.providerOptions?.openai?.wireFormat,
            })
          : 0;
      const routedSendNearsWindow =
        compactionResult.usagePercentage + routedPendingPercent >=
        100 - ROUTED_SEND_COMPACTION_HEADROOM_PERCENT;
      const shouldCompactBeforeSend =
        this.compactionMonitor.getThreshold() < 1 &&
        (continuousContext.enabled
          ? continuousResult === "fallback" &&
            (skillModelOverride != null
              ? routedSendNearsWindow
              : compactionResult.shouldForceCompact)
          : skillModelOverride != null
            ? routedSendNearsWindow
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

        // Pre-routing options/model: the deferred follow-up re-enters
        // sendMessage with the same skill metadata and re-resolves routing at
        // dispatch time. Persisting the routed model here would pin a stale
        // decision — if the binding is gone by dispatch, the user's prompt
        // would stream on the routed model with no routing decision behind it.
        const followUpContent = this.buildAutoCompactionFollowUp({
          messageText: message,
          options: preRoutingOptions,
          modelForStream: preRoutingOptions.model,
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
          // The compaction request must run on the model able to read the full
          // history — usually the user's pre-routing model, or the routed model
          // when the class routes UP to a larger window. The deferred follow-up
          // re-enters sendMessage with the same skill metadata and re-routes
          // itself either way.
          baseOptions: compactionBaseOptionsForRoutedTurn ?? preRoutingOptions,
          reason: "on-send",
        });

        // The pricing gate above validated the ROUTED model, but the
        // compaction request may inherit the pre-routing ambient model (the
        // larger-window pick): for a budgeted goal that model must be priced
        // too, or the compaction stream's cost cannot be enforced against
        // the budget.
        if (this.workspaceGoalService) {
          const compactionPricingGate =
            await this.workspaceGoalService.assertPricedModelForBudgetedGoal(
              this.workspaceId,
              autoCompactionRequest.sendOptions.model
            );
          if (!compactionPricingGate.success) {
            if (isManualUserMessage && options?.editMessageId == null && attempt.queued) {
              const persisted = await this.preserveRejectedManualSend(
                message,
                options,
                compactionPricingGate.error,
                internal?.enqueuedAtMs
              );
              if (persisted) {
                await this.applyManualUserMessageGoalSafety({
                  policy: "pause",
                  enqueuedAtMs: internal?.enqueuedAtMs,
                });
              }
            }
            return Err(compactionPricingGate.error);
          }
        }

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
              autoCompactionRequest.agentInitiated,
              undefined,
              // Routed-origin marker: a resume of this row (startup, manual
              // Retry) reconstructs the compaction from the row alone, and
              // arms its consent gate only for rows marked routed — the flag
              // below, OR this compaction context. A routed GLOBAL skill's
              // compaction has no obligation of its own, yet the history it
              // summarizes can carry earlier project-skill content that only
              // the request scan detects, so every routed compaction row
              // carries the context.
              skillModelOverride?.kind === "override"
                ? compactionBaseOptionsForRoutedTurn
                : undefined,
              // A routed turn's compaction may run on the class model (routed
              // UP) with the project snapshot in its history: startup recovery
              // of this row re-verifies Project Trust like the turn itself.
              (skillModelOverride?.kind === "override" && routedTurnCarriesProjectContent) ||
                inheritsRoutedConsent
            ),
            muxMetadata: autoCompactionRequest.metadata,
            synthetic: true,
            uiVisible: true,
          }
        );

        if (this.coordinator.admissionBlocked || isAdmissionStale())
          return refuseBeforeAcceptance(
            createUnknownSendMessageError(CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE)
          );
        if (this.coordinator.closing)
          return refuseBeforeAcceptance(
            createUnknownSendMessageError(SESSION_SHUTDOWN_SEND_BLOCKED_MESSAGE)
          );

        // Persist compaction request (NOT the user message — it's the follow-up)
        const appendCompactionResult = await this.historyService.appendToHistory(
          this.workspaceId,
          autoCompactionMessage
        );
        if (!appendCompactionResult.success) {
          return Err(createUnknownSendMessageError(appendCompactionResult.error));
        }
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
      return refuseBeforeAcceptance(
        createUnknownSendMessageError(CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE)
      );
    }
    // Still pre-persist: a row appended now would read as a dispatched turn on the next startup
    // while streamWithHistory's own latch check keeps its stream from ever running.
    if (shutdownRefusesBeforePersist()) {
      return refuseBeforeAcceptance(
        createUnknownSendMessageError(SESSION_SHUTDOWN_SEND_BLOCKED_MESSAGE)
      );
    }

    // Persist snapshots only when this turn will be sent immediately.
    // On on-send compaction paths, snapshots are deferred with the follow-up turn.
    const shouldPersistTurnSnapshots = autoCompactionMessage === null;

    // On-send compaction DEFERS the skill: the invocation has not dispatched
    // (its persisted follow-up re-enters sendMessage and re-resolves routing
    // after compaction — mapping, trust, and availability may all differ by
    // then), so reporting a model now would attribute a dispatch that never
    // happened, on a model that may not be the one that streams. Report the
    // deferral like a queued send — for EVERY skill send, routed or not — and
    // let dispatchPendingFollowUp attribute the turn when it actually
    // streams (the renderer suppresses its own capture on { queued: true }).
    const sendAcceptedFinal: SendMessageAccepted | undefined =
      autoCompactionMessage !== null && typedMuxMetadata?.type === "agent-skill"
        ? { queued: true }
        : sendAccepted;

    // Consent recheck immediately before snapshots are built and persisted:
    // the queue wait and preflights sit between the routing gate and this
    // point. Runs the same dequeued-send preservation as the
    // routing/pricing/PDF gates — the materialization-internal throw below
    // surfaces as a bare Err, which would silently drop a queued prompt
    // whose composer already cleared. Edit turns are exempt: their consent
    // was checked (and their snapshots materialized) BEFORE the destructive
    // truncation, and a rejection here would land after it.
    if (
      options?.editMessageId == null &&
      skillModelOverride?.kind === "override" &&
      routedTurnCarriesProjectContent &&
      !(await this.isRoutedProjectSkillTurnStillTrusted())
    ) {
      const trustError = createUnknownSendMessageError(ROUTED_SKILL_TRUST_REVOKED_MESSAGE);
      if (isManualUserMessage && options?.editMessageId == null && attempt.queued) {
        const persisted = await this.preserveRejectedManualSend(
          message,
          options,
          trustError,
          internal?.enqueuedAtMs
        );
        if (persisted) {
          await this.applyManualUserMessageGoalSafety({
            policy: "pause",
            enqueuedAtMs: internal?.enqueuedAtMs,
          });
        }
      }
      // On-send compaction already persisted its request row (carrying this
      // prompt as the pending follow-up) while the user row itself was held
      // back: refusing without rolling it back would leave a hidden compaction
      // request that startup recovery resumes — dispatching a prompt whose
      // send was reported failed. Still pre-acceptance, so the set is exact.
      const rolledBack = await rollbackPersistedTurnRows();
      if (!rolledBack && autoCompactionMessage !== null) {
        // The row could not be verifiably removed: fail CLOSED. Compaction
        // requests are user rows, so the provider-request filter and the
        // startup replay check both honor the rejection stamp; a failed
        // stamp falls back to the in-memory quarantine plus the durable
        // repair record, and the abandon marker keyed to the row stops
        // startup recovery from replaying the compaction at all.
        await this.quarantineUnremovedRefusedRows([autoCompactionMessage.id]);
      }
      return Err(trustError);
    }

    let skillSnapshotMessages: MuxMessage[] = [];
    let mcpPromptSnapshotMessages: MuxMessage[] = [];
    if (shouldPersistTurnSnapshots) {
      try {
        const skillMaterialization =
          preTruncationSkillSnapshots ??
          (await this.materializeAgentSkillSnapshots(
            typedMuxMetadata,
            options?.disableWorkspaceAgents,
            contextRollover,
            preResolvedSkills,
            skillModelOverride?.kind === "override"
          ));
        skillSnapshotMessages = skillMaterialization.messages;
        if (userMessage.metadata != null) {
          userMessage.metadata.muxMetadata = withAuthoritativeSkillScopes(
            userMessage.metadata.muxMetadata,
            skillMaterialization.resolvedScopes
          );
        }
        if (skillMaterialization.carriesProjectSkillContent) {
          routedTurnCarriesProjectContent = true;
          // The user row's durable consent seed was computed from the invoked
          // package's scope. The row persists below, and startup recovery and
          // manual Retry read the obligation FROM it (the in-memory resume
          // state dies with the process), so it must carry the widened value:
          // otherwise a crash after acceptance and a later trust revocation
          // would replay the persisted project snapshot on the class model
          // with no consent gate armed.
          if (userMessage.metadata != null) {
            userMessage.metadata.retrySendOptions = pickStartupRetrySendOptions(
              optionsForStream,
              agentInitiated,
              goalKind,
              compactionBaseOptionsForRoutedTurn,
              true
            );
          }
        }
        mcpPromptSnapshotMessages = await this.materializeMcpPromptSnapshots(
          typedMuxMetadata,
          userMessage.id,
          cancelSignal
        );
      } catch (error) {
        const materializationError = createUnknownSendMessageError(getErrorMessage(error));
        // A queued prompt's composer already cleared: like the other
        // pre-stream gates, a materialization failure (including the
        // mid-materialization trust revocation throw) must leave a durable
        // transcript row + visible error instead of silently dropping the
        // send while sendQueuedMessages moves on.
        if (isManualUserMessage && options?.editMessageId == null && attempt.queued) {
          const persisted = await this.preserveRejectedManualSend(
            message,
            options,
            materializationError,
            internal?.enqueuedAtMs
          );
          if (persisted) {
            await this.applyManualUserMessageGoalSafety({
              policy: "pause",
              enqueuedAtMs: internal?.enqueuedAtMs,
            });
          }
        }
        return Err(materializationError);
      }
      if (await cancelBeforeAcceptance()) {
        return Ok(undefined);
      }
    }

    if (shouldPersistTurnSnapshots && !tokenBudgetActive && snapshotResult?.snapshotMessage) {
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

    if (shouldPersistTurnSnapshots && !tokenBudgetActive && skillSnapshotMessages.length > 0) {
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

    if (shouldPersistTurnSnapshots && !tokenBudgetActive && mcpPromptSnapshotMessages.length > 0) {
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
    for (const preTurnMessage of internal?.preTurnMessages ?? []) {
      // Family payloads are the only producer today: synthetic assistant rows
      // only, so a future caller cannot smuggle user-role content past the
      // provenance rules or non-synthetic rows past queue/restore projections.
      assert(
        preTurnMessage.role === "assistant" && preTurnMessage.metadata?.synthetic === true,
        "sendMessage: preTurnMessages must be synthetic assistant rows"
      );
    }
    // The late consent gates are defined BEFORE the token-budget block: a
    // proactive rollover prepares its provider request in there, with the turn
    // options baked in at preparation, and that request must carry the gate.
    //
    // Durable, request-visible rejection bookkeeping shared by the late
    // consent gates: stamp the accepted turn's PERSISTED rows
    // (filterPreStreamRejectedRows keys on ROW metadata — the sidecar abandon
    // marker alone would leave this turn provider-eligible for the NEXT
    // ordinary send), then belt with the abandon marker for startup recovery.
    // The rows are durable by the time a gate fires, so rejection is
    // non-destructive. On-send compaction persisted ONLY the compaction
    // request (the user row was never written; the prompt rides the request's
    // deferred follow-up), so that row — not the phantom user row, whose
    // missing id a stamp skips as success — is what goes provider-ineligible
    // and keys the marker. Otherwise startup recovery would resume the real
    // row, prompt included, without routed consent.
    const stampAcceptedTurnRejected = async (): Promise<void> => {
      const acceptedRowId = (autoCompactionMessage ?? userMessage).id;
      const rejectedRowIds =
        autoCompactionMessage !== null
          ? [autoCompactionMessage.id]
          : [
              userMessage.id,
              ...skillSnapshotMessages.map((msg) => msg.id),
              ...mcpPromptSnapshotMessages.map((msg) => msg.id),
              // The @file-mention snapshot persisted with this turn carries
              // repository contents too — an unstamped copy would stay
              // provider-eligible after the turn's rejection.
              ...(snapshotResult?.snapshotMessage != null
                ? [snapshotResult.snapshotMessage.id]
                : []),
            ];
      let stampResult = await this.historyService.markMessagesPreStreamRejected(
        this.workspaceId,
        rejectedRowIds
      );
      if (!stampResult.success) {
        // Fail CLOSED: without the row marker the rejected turn stays
        // provider-eligible for the next ordinary send (the sidecar abandon
        // is invisible to request construction, and a later manual send
        // clears it). Retry once; if the rewrite still fails, quarantine the
        // ids in memory — request assembly filters them for the rest of the
        // session, and startup recovery re-attempts the durable stamp when
        // it sees the abandon reason.
        stampResult = await this.historyService.markMessagesPreStreamRejected(
          this.workspaceId,
          rejectedRowIds
        );
      }
      if (!stampResult.success) {
        for (const id of rejectedRowIds) {
          this.unstampedRejectedRowIds.add(id);
        }
        log.warn("Failed to stamp rejected rows after consent revocation; quarantined in memory", {
          workspaceId: this.workspaceId,
          error: stampResult.error,
        });
        // The quarantine dies with the process; the repair record does not.
        await this.addPendingRejectedTurnRepairKey(acceptedRowId);
      }
      await this.persistStartupAutoRetryAbandon("pre_stream_rejected", acceptedRowId);
      if (!stampResult.success) {
        // Neither the row stamp nor (possibly) the record reached disk:
        // persistAutoRetryState is best-effort, so verify. Unrecorded, the
        // refusal is protected by process memory alone — a crash would leave
        // the rows provider-eligible. The visible error says so, and the next
        // request build refuses until the record (or stamp) is durable.
        const recorded = await this.recordPendingAutoRetryState();
        if (!recorded && !this.coordinator.disposed) {
          log.error("Refused turn's repair record could not be written; sends stay refused", {
            workspaceId: this.workspaceId,
            acceptedRowId,
          });
          this.emitChatEvent(
            createStreamErrorMessage(
              buildStreamErrorEventData(
                createUnknownSendMessageError(REJECTED_TURN_RECORD_UNRECORDED_MESSAGE)
              )
            )
          );
        }
      }
    };
    // Shared rejection for the late consent gates (pre-stream below and the
    // provider-dispatch boundary inside streamWithHistory): performs the
    // durable bookkeeping and returns the error to surface. The accepted row
    // must not be startup-resumable onto its persisted routed retry options
    // (recovery honors this abandon reason without rerunning the gates), and
    // the failure must be VISIBLE (these gates bypass streamWithHistory's own
    // error emission).
    const ownConsentRejection: RoutedConsentRejection = async (
      // Set by the provider-boundary caller when the assembled REQUEST
      // carries project-scope snapshot rows from EARLIER turns: an untrusted
      // workspace's history can hold a project snapshot even when the
      // current routed invocation is global with no project refs.
      requestCarriesProjectContent?: boolean,
      midStream?: boolean
    ): Promise<SendMessageError | null> => {
      if (
        skillModelOverride?.kind !== "override" ||
        !(routedTurnCarriesProjectContent || requestCarriesProjectContent === true)
      ) {
        return null;
      }
      if (await this.isRoutedProjectSkillTurnStillTrusted()) {
        return null;
      }
      const trustError = createUnknownSendMessageError(ROUTED_SKILL_TRUST_REVOKED_MESSAGE);
      await stampAcceptedTurnRejected();
      // Pre-start refusals bypass every stream error path, so this emission is
      // the only visible record. A per-step (mid-stream) refusal is thrown
      // through StreamManager's standard failure pipeline, whose
      // handleStreamError emits the row — emitting here too would leave two
      // error rows for one refusal.
      if (!this.coordinator.disposed && midStream !== true) {
        this.emitChatEvent(createStreamErrorMessage(buildStreamErrorEventData(trustError)));
      }
      return trustError;
    };
    // A compaction replacing a routed stream checks its own (empty) routing
    // first, then the inherited gate. An inherited refusal has already stamped
    // the original turn's rows and emitted the visible error; this request row
    // must not stay startup-resumable either.
    const routedConsentRejection: RoutedConsentRejection =
      inheritedConsentRejection == null
        ? ownConsentRejection
        : async (requestCarriesProjectContent?: boolean, midStream?: boolean) => {
            const ownError = await ownConsentRejection(requestCarriesProjectContent, midStream);
            if (ownError) {
              return ownError;
            }
            const inheritedError = await inheritedConsentRejection(
              requestCarriesProjectContent,
              midStream
            );
            if (inheritedError) {
              await stampAcceptedTurnRejected();
            }
            return inheritedError;
          };
    // Only a ROUTED turn (or the compaction replacing one) carries the gate
    // downstream: the provider-boundary assembly excludes historical project
    // content from UNTRUSTED workspaces whenever a gate is present, which an
    // unrouted turn on the user's own model must never do.
    const streamConsentRejection =
      skillModelOverride?.kind === "override" || inheritsRoutedConsent
        ? routedConsentRejection
        : undefined;

    if (tokenBudgetActive) {
      const requestPrelude = [
        ...(snapshotResult?.snapshotMessage ? [snapshotResult.snapshotMessage] : []),
        ...skillSnapshotMessages,
        ...mcpPromptSnapshotMessages,
        ...(internal?.preTurnMessages ?? []),
      ];
      // Admit the exact materialized snapshots, not their short invocation text,
      // before clearing context state or publishing a reset. Reuse these rows below:
      // skill directives and MCP prompt expansion must not execute a second time.
      if (requestPrelude.length > 0) {
        const freshBudget = await this.checkFreshContextBudget(
          userMessage,
          optionsForStream.model,
          optionsForStream,
          [...contextBudgetPrefix, ...requestPrelude]
        );
        if (await cancelBeforeAcceptance()) return Ok(undefined);
        if (
          isAdmissionStale() ||
          this.coordinator.admissionBlocked ||
          shutdownRefusesBeforePersist()
        ) {
          return Err(createUnknownSendMessageError(CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE));
        }
        if (!freshBudget.success) return await rejectBudgetSend(freshBudget.error);
        userMessage.metadata = {
          ...userMessage.metadata,
          requestPreludeMessageIds: requestPrelude.map((row) => row.id),
        };
      }
      let batch = [...contextBudgetPrefix, ...requestPrelude, userMessage];
      // The flush admission above happened several awaits ago (snapshots, goal safety, history).
      // Re-check at publication: if rollover was disabled or a Stop dropped the intent meanwhile,
      // the durable final warning would promise a fresh window nothing will deliver. Publish an
      // ordinary continuation instead (same degrade as the dispatch-time check).
      const flushPrefix =
        contextBudgetPrefix[0]?.metadata?.muxMetadata?.type === "context-budget-warning" &&
        contextBudgetPrefix[0].metadata.muxMetadata.final === true;
      if (
        flushPrefix &&
        (this.pendingRollover == null || this.compactionMonitor.getThreshold() >= 1) &&
        userMessage.metadata?.muxMetadata?.contextBudgetFlush === true
      ) {
        optionsForStream = this.degradeFlushEntryToContinuation(userMessage, optionsForStream);
        contextBudgetPrefix = [];
        batch = [...requestPrelude, userMessage];
        requestAssemblySnapshot = undefined;
        this.dropContextBudgetIntent();
      }
      if (contextRollover) {
        assert(requestAssemblySnapshot != null, "Rollover must pin request assembly");
        const generation = this.contextBudgetGeneration;
        const rolloverMemoryConsent = await this.createRoutedMemoryConsent(streamConsentRejection);
        const candidate = await this.prepareRolloverRequest(
          batch,
          optionsForStream.model,
          optionsForStream,
          requestAssemblySnapshot,
          agentInitiated,
          cancelSignal,
          manualGoalInterventionPolicy != null
            ? { enqueuedAtMs: internal?.enqueuedAtMs }
            : undefined,
          // A prepared request bakes its turn options in NOW, not at start():
          // the gate streamWithHistory passes later cannot be added to it, so
          // the routed turn's consent gate rides the preparation itself.
          this.bindRolloverConsentGate(streamConsentRejection, batch, rolloverMemoryConsent),
          rolloverMemoryConsent
        );
        if (candidate.success) attempt.preparedRequest = candidate.data;
        if (await cancelBeforeAcceptance()) return Ok(undefined);
        if (
          isAdmissionStale() ||
          this.coordinator.closing ||
          generation !== this.contextBudgetGeneration
        )
          return Err(createUnknownSendMessageError(CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE));
        if (!candidate.success) return await rejectBudgetSend(candidate.error);
      }
      try {
        if (contextRollover) {
          if (await cancelBeforeAcceptance()) return Ok(undefined);
          if (isAdmissionStale() || this.coordinator.admissionBlocked || this.coordinator.closing) {
            return Err(createUnknownSendMessageError(CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE));
          }
          // Fail closed before publication: a crash must not reopen a fresh window
          // with stale carryover/kernel state. An append failure may leave the old
          // transcript with disposable context state cleared (ADR-0005).
          await this.applyContextResetSideEffects();
        }
        if (await cancelBeforeAcceptance()) return Ok(undefined);
        if (
          isAdmissionStale() ||
          this.coordinator.admissionBlocked ||
          shutdownRefusesBeforePersist()
        ) {
          return Err(createUnknownSendMessageError(CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE));
        }
        // Ordinary sends stay append-only; only coupled snapshots/boundaries need an atomic batch.
        const appended =
          batch.length === 1
            ? await this.historyService.appendToHistory(this.workspaceId, userMessage)
            : await this.historyService.appendManyToHistory(this.workspaceId, batch);
        if (!appended.success) return Err(createUnknownSendMessageError(appended.error));
      } catch (error) {
        return Err(createUnknownSendMessageError(getErrorMessage(error)));
      }
      persistedCancelableMessageIds.push(...batch.map((row) => row.id));
      if (contextRollover) {
        const sequences = [batch[0], batch[1], userMessage].map(
          (row) => row.metadata?.historySequence
        );
        assert(
          sequences.every((seq) => seq != null),
          "rollover rows must be sequenced"
        );
        assert(
          sequences[0] < sequences[1] && sequences[1] < sequences[2],
          "rollover rows must be ordered"
        );
      }
      if (await cancelBeforeAcceptance()) return Ok(undefined);
    } else if (internal?.preTurnMessages != null && internal.preTurnMessages.length > 0) {
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
      const appendResult = await this.historyService.appendToHistory(this.workspaceId, userMessage);
      if (!appendResult.success) {
        await rollbackPersistedTurnRows();
        return Err(createUnknownSendMessageError(appendResult.error));
      }
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
      return Err(
        createUnknownSendMessageError(
          "Send refused: the caller's admission became stale before the turn was accepted."
        )
      );
    }
    // The shutdown latch was checked before the snapshot materialization and history I/O above,
    // and isCurrentTurn stays true while merely closing. Refuse while the rows are still
    // rollback-eligible: retained, they read as a dispatched turn to the next startup.
    if (shutdownRefusesBeforePersist()) {
      return refuseBeforeAcceptance(
        createUnknownSendMessageError(SESSION_SHUTDOWN_SEND_BLOCKED_MESSAGE)
      );
    }

    if (contextRollover) {
      // Branch summaries must remain discoverable if the append/rollback failed. Only
      // discard their registration once the new window has crossed the rollback horizon.
      this.clearContextBudgetState();
      (internal?.onContextWindowRollover ?? this.onContextWindowRollover)?.();
      await clearPendingBranchSummary(this.workspaceId);
    } else if (tokenBudgetActive) {
      this.contextBudgetWarningClaimed ||=
        contextBudgetPrefix.length > 0 ||
        userMessage.metadata?.muxMetadata?.type === "context-budget-warning";
      this.contextBudgetFlushClaimed ||= contextBudgetPrefix.some(
        (row) =>
          row.metadata?.muxMetadata?.type === "context-budget-warning" &&
          row.metadata.muxMetadata.final === true
      );
      this.pendingBudgetWarning = undefined;
    }

    // Rollover clears old tracking before append; register only the snapshot that
    // actually survived into the accepted window, using the bytes already read.
    for (const file of snapshotResult?.fileStates ?? []) {
      await this.recordFileState(file.path, file.state);
    }
    if (shouldPersistTurnSnapshots && snapshotResult && !isAdmissionStale()) {
      this.acceptedFileSnapshotBaseline = {
        messageId: snapshotResult.snapshotMessage.id,
        tracking: this.fileChangeTracker.captureSnapshotBaseline(
          snapshotResult.fileStates.map((file) => file.state)
        ),
      };
    }

    // Goal synchronization can mutate goal.json based on this durable user row. Once it begins, the
    // turn has crossed the cancellation point-of-no-return: a concurrent monitor stop must let this
    // wake finish acceptance rather than delete the row after goal state has already observed it.
    if (cancelSignal != null) {
      cancellationDisabled = true;
    }
    // A send that opted into withdrawal and is withdrawn past the point of no return (a hard Stop
    // retiring owed attention during goal sync or acceptance) keeps its durable, accepted rows but
    // never streams: the Stop saw no turn to abort. The trailing UI-visible row would read as an
    // interrupted turn to startup recovery, so every exit below that skips PREPARING records the
    // same abandon marker a user-aborted stream leaves, before the send resolves (Stop joins the
    // send for this). The withdrawal can land during any await on the way out, including
    // acceptance I/O, so each exit runs this check after its last other await.
    const withdrawn = () =>
      internal?.withdrawAcceptedOnCancel === true && cancelSignal?.aborted === true;
    const abandonWithdrawnSend = async (): Promise<void> => {
      if (withdrawn()) {
        // Startup recovery matches the marker against the trailing durable row, which under on-send
        // compaction is the compaction request, not the never-persisted user message.
        await this.updateStartupAutoRetryAbandonFromAbort(
          "user",
          (autoCompactionMessage ?? userMessage).id
        );
      }
    };
    // A stale refusal past this point keeps the durable, already accepted row, which the manual
    // turn that made the admission stale consumes as context.
    const refuseStaleDurableSend = async (): Promise<
      AgentSessionResult<SendMessageAccepted | undefined>
    > => {
      await abandonWithdrawnSend();
      return Err(createUnknownSendMessageError(CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE));
    };
    // r54: the pre-turn batch is now irrevocable — rollbackPersistedTurnRows
    // is never invoked past this point, so even a failure in goal sync or
    // acceptance leaves the payload + trigger rows durable in the transcript.
    markRowsDurable();
    // A cancelable wake is accepted the moment its row is durable, before goal sync: its
    // dispatcher treats the transcript row as proof of acceptance (a restart consumes a signal
    // whose row is already there), so no later await may leave a durable, unaccepted row behind
    // a crash. Startup recovery resumes the row without redelivering it, unless a Stop withdrew
    // the wake.
    if (cancelSignal != null) {
      try {
        await accept();
      } catch (error) {
        await abandonWithdrawnSend();
        return Err(createUnknownSendMessageError(getErrorMessage(error)));
      }
    }
    try {
      await this.workspaceGoalService?.syncGoalModeWithChatTail(this.workspaceId);
    } catch (error) {
      await abandonWithdrawnSend();
      throw error;
    }

    if (manualGoalInterventionPolicy != null) {
      await this.applyManualUserMessageGoalSafety({
        policy: manualGoalInterventionPolicy,
        enqueuedAtMs: internal?.enqueuedAtMs,
      });
    }

    // Workspace may be tearing down while we await filesystem IO.
    // If so, skip event emission + streaming to avoid races with dispose().
    if (this.coordinator.disposed) {
      await abandonWithdrawnSend();
      return Ok(undefined);
    }

    // Turn durably accepted + options finalized: open the mid-turn thinking
    // override window BEFORE the user-message emit / onAccepted / any further
    // await, so a slider change during PREPARING (runtime warmup, model
    // creation) lands in the holder the stream's prepareStep will read.
    const turnThinkingOverride: ActiveTurnThinkingOverride = {};
    if (isAdmissionStale()) return refuseStaleDurableSend();
    this.coordinator.acceptThinkingOverride(
      turnThinkingOverride,
      attempt.owner ?? attempt.expectedTurn
    );

    for (const row of contextBudgetPrefix) this.emitChatEvent({ ...row, type: "message" });

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
      // The abandon marker gates the rejected-turn repair. A manual send
      // accepted while startup recovery is still pending would clear it
      // first, so the request build's marker-gated pass would find nothing
      // and the unstamped rejected rows (plus a surviving partial) would ride
      // this very request. Repair BEFORE the marker goes. Nothing has streamed
      // since a still-present refusal marker, so a key-less marker's turn is
      // the newest retry-eligible row other than the one this send just
      // persisted.
      await this.repairUnstampedRejectedTurn({
        recoverKeylessMarker: { excludeRowId: (autoCompactionMessage ?? userMessage).id },
      });
      // A fresh accepted user send supersedes any persisted startup-abandon
      // classification from previous turns.
      if (isAdmissionStale()) return refuseStaleDurableSend();
      await this.clearStartupAutoRetryAbandon();
      if (isAdmissionStale()) return refuseStaleDurableSend();
      this.retryManager.cancel();
      this.retryManager.setEnabled(true);
      await this.persistAutoRetryEnabledPreference(true);
    }

    // Same-session retry should resume the exact accepted request we just finalized
    // in history, even if runtime warmup fails before streamWithHistory() starts.
    if (isAdmissionStale()) return refuseStaleDurableSend();
    this.setAutoRetryResumeState(
      optionsForStream,
      agentInitiated,
      goalKind,
      internal?.goalId,
      requestAssemblySnapshot,
      contextRollover,
      compactionBaseOptionsForRoutedTurn,
      // FINAL consent flag (post-materialization, inline refs included) —
      // retries of this accepted request re-verify Project Trust; a
      // compaction replacing a routed stream inherits the obligation.
      (skillModelOverride?.kind === "override" && routedTurnCarriesProjectContent) ||
        inheritsRoutedConsent,
      // The row a refused resume stamps. On-send compaction persisted ONLY the
      // compaction request (the prompt rides its deferred follow-up).
      (autoCompactionMessage ?? userMessage).id
    );
    try {
      await accept();
    } catch (error) {
      // Pre-stream failure: identity-guarded so a replacement turn's holder
      // (created while this one unwound) is never cleared by mistake.
      if (this.coordinator.thinkingOverride === turnThinkingOverride) {
        this.coordinator.releaseThinkingOverride(turnThinkingOverride);
      }
      await abandonWithdrawnSend();
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
      await abandonWithdrawnSend();
      return Err(error);
    }
    // A withdrawn send must not claim PREPARING (see abandonWithdrawnSend); it resolves Ok without
    // a stream, like cancelBeforeAcceptance and the disposed path above.
    if (withdrawn()) {
      if (this.coordinator.thinkingOverride === turnThinkingOverride) {
        this.coordinator.releaseThinkingOverride(turnThinkingOverride);
      }
      await abandonWithdrawnSend();
      return Ok(undefined);
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
      return Err(
        createUnknownSendMessageError(
          admission.status === "rejected" && admission.reason === "closing"
            ? SESSION_SHUTDOWN_SEND_BLOCKED_MESSAGE
            : CONTEXT_MUTATION_SEND_BLOCKED_MESSAGE
        )
      );
    }
    const preparedTurn = admission.turnId;

    internal?.onTurnAdmissionCommitted?.();

    const startPreparedStream = async (
      startup: PreparationAttempt
    ): Promise<AgentSessionResult<SendMessageAccepted | undefined>> => {
      if (
        !this.coordinator.isCurrentTurn(preparedTurn) ||
        preparedTurnAbortController.signal.aborted
      ) {
        await this.settlePreparationFailure(
          startup,
          createUnknownSendMessageError("Accepted stream startup was canceled before it began.")
        );
        return Ok(ACCEPTED_WITHOUT_STREAM);
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
        return Ok(ACCEPTED_WITHOUT_STREAM);
      }

      // Consent check before streamWithHistory's startup work: every await
      // since the last gate (branch summary, file snapshot, MCP snapshots,
      // history writes) is a revocation window — on edits those all run
      // AFTER truncation. Post-acceptance, so the rejection settles as an
      // accepted pre-stream failure (the emitted stream error is the visible
      // record); an Err here would make the renderer restore the draft of a
      // prompt that is already a durable transcript row.
      {
        const consentError = streamConsentRejection ? await streamConsentRejection() : null;
        if (consentError) {
          await this.settlePreparationFailure(startup, consentError);
          return Ok(ACCEPTED_WITHOUT_STREAM);
        }
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
        startup,
        contextRollover,
        requestAssemblySnapshot,
        undefined,
        compactionBaseOptionsForRoutedTurn,
        streamConsentRejection
      );
      // The provider-boundary consent gate inside streamWithHistory surfaces
      // here: same accepted-pre-stream conversion as above.
      if (
        !streamResult.success &&
        streamResult.error.type === "unknown" &&
        streamResult.error.raw === ROUTED_SKILL_TRUST_REVOKED_MESSAGE
      ) {
        await this.settlePreparationFailure(startup, streamResult.error);
        return Ok(ACCEPTED_WITHOUT_STREAM);
      }
      if (streamResult.success && preparedTurnAbortController.signal.aborted) {
        await this.settlePreparationFailure(
          startup,
          createUnknownSendMessageError("Accepted stream startup was canceled during preparation.")
        );
      }
      // Only a startup that reached the provider is a dispatch: an Ok from a
      // pre-provider abort check (or the canceled controller above) streamed
      // nothing, and reporting the routed model for it would attribute a
      // request that never happened.
      return streamResult.success
        ? Ok(startup.outcome === "delivered" ? sendAcceptedFinal : ACCEPTED_WITHOUT_STREAM)
        : streamResult;
    };

    if (editMessageId || internal?.startStreamInBackground === true) {
      // Transfer physical work before the foreground lease releases. The child has its own
      // completion outcome so a resolved foreground Ok cannot finish a still-starting turn.
      attempt.outcome = "background";
      const backgroundAttempt: PreparationAttempt = { ...attempt, outcome: "preparing" };
      attempt.preparedRequest = undefined;
      // Handoff callbacks may already have preempted back to idle. Transfer the edit
      // exclusion too, so only the child's settled startup can release queued work.
      attempt.editReservation = undefined;
      // This response leaves BEFORE the late consent gate runs, so the
      // renderer cannot settle a SKILL send's dispatch attribution: report it
      // deferred ({ queued: true } — the renderer skips its capture, as for a
      // busy-queued skill send) and attribute here once startup resolves, or
      // never, when the gate refused and nothing streamed.
      const deferredSkillAttribution = typedMuxMetadata?.type === "agent-skill";
      this.completePreparation(backgroundAttempt, () => startPreparedStream(backgroundAttempt))
        .then(async (result) => {
          // Same rule as the queue-dispatch path: a compaction-DEFERRED skill
          // ({ queued: true }) has not streamed — what started here is the
          // compaction request, and dispatchPendingFollowUp attributes the
          // skill when it actually streams; capturing here would double-count
          // it against the compaction model.
          if (
            result.success &&
            deferredSkillAttribution &&
            result.data?.queued !== true &&
            result.data?.acceptedWithoutStream !== true
          ) {
            await this.captureBackendMessageSent({
              model: result.data?.routedModel ?? modelForStream,
              agentId: optionsForStream.agentId,
              messageLength: message.length,
              thinkingLevel: result.data?.routedThinkingLevel ?? optionsForStream.thinkingLevel,
            });
            // The original answer was deferred ({ queued: true }): the
            // service's fork auto-title waited for this delivery too.
            this.onDeferredSendDelivered?.(message);
          }
        })
        .catch((error: unknown) => {
          log.error("Accepted background stream failed before startup completed", {
            workspaceId: this.workspaceId,
            error: getErrorMessage(error),
          });
        });
      return Ok(
        deferredSkillAttribution ? { ...sendAcceptedFinal, queued: true } : sendAcceptedFinal
      );
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
      requestAssemblySnapshot?: RequestAssemblySnapshot;
      contextBudgetRetried?: boolean;
      /** Routed-turn compaction context carried across same-session retries. */
      compactionBaseOptions?: SendMessageOptions;
      /** Routed project-skill turn: re-verify Project Trust before dispatch. */
      routedProjectConsent?: boolean;
      /** Retry-eligible row the resumed turn replays (see AutoRetryResumeRequest.userMessageId). */
      userMessageId?: string;
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

    // The public (manual Retry) resume carries no internal consent arguments,
    // yet replays the persisted row — possibly a routed turn's compaction
    // request on the class model. Derive the obligation, the routed compaction
    // policy and the row key from the durable tail then, as startup recovery
    // does; internal callers (auto-retry, recovery) pass their own.
    const routedResumeResult =
      internal?.routedProjectConsent != null ||
      internal?.compactionBaseOptions != null ||
      internal?.userMessageId != null
        ? Ok({
            routedProjectConsent: internal?.routedProjectConsent,
            compactionBaseOptions: internal?.compactionBaseOptions,
            userMessageId: internal?.userMessageId,
          })
        : await this.deriveResumeConsentFromTail();
    if (!routedResumeResult.success) return Err(routedResumeResult.error);
    const routedResume = routedResumeResult.data;
    if (this.coordinator.closing || startupController?.signal.aborted) {
      return Ok({ started: false });
    }
    // Routing consent is re-verified on EVERY resumed dispatch: trust can be
    // revoked between the original acceptance and a same-session retry or a
    // startup recovery, and this path bypasses the send gates. The Err is
    // bounded by the retry machinery's attempt caps — and re-granting trust
    // lets a later attempt proceed legitimately.
    if (
      routedResume.routedProjectConsent === true &&
      !(await this.isRoutedProjectSkillTurnStillTrusted())
    ) {
      return Err(await this.rejectResumedRoutedTurn(routedResume.userMessageId));
    }
    // The same verdict rides to the provider-dispatch boundary (pricing,
    // history reconstruction, request building, and stream startup below are
    // all revocation windows). Fires on the persisted acceptance-time seed
    // OR on the request scan — the replayed request carries the original
    // turn's persisted snapshot rows, so history-carried and
    // materialization-discovered project content is covered even when the
    // pre-crash seed missed it. A refusal stamps the replayed turn's rows
    // (rejectResumedRoutedTurn) by the row key the resume request carries:
    // they belong to the ORIGINAL accepted send, and nothing downstream
    // knows them otherwise.
    const isRoutedResume =
      routedResume.routedProjectConsent === true || routedResume.compactionBaseOptions != null;
    const resumedConsentRejection: RoutedConsentRejection | undefined = isRoutedResume
      ? async (requestCarriesProjectContent?: boolean): Promise<SendMessageError | null> => {
          if (routedResume.routedProjectConsent !== true && requestCarriesProjectContent !== true) {
            return null;
          }
          if (await this.isRoutedProjectSkillTurnStillTrusted()) {
            return null;
          }
          return await this.rejectResumedRoutedTurn(routedResume.userMessageId);
        }
      : undefined;

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
      // A resumed attempt becomes the latest live resume request as soon as we
      // accept its options, even if startup fails before the stream fully begins.
      this.setAutoRetryResumeState(
        optionsForStream,
        internal?.agentInitiated,
        internal?.goalKind,
        internal?.goalId,
        internal?.requestAssemblySnapshot,
        internal?.contextBudgetRetried,
        routedResume.compactionBaseOptions,
        routedResume.routedProjectConsent,
        routedResume.userMessageId
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
        attempt,
        internal?.contextBudgetRetried === true,
        internal?.requestAssemblySnapshot,
        undefined,
        routedResume.compactionBaseOptions,
        resumedConsentRejection
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

  /**
   * Per-model thinking floor: the configured minThinkingLevelByModel override
   * resolved against the model's policy. Tests may provide partial config
   * mocks, so read overrides only when available. providersConfig lets mapped
   * aliases (mappedToModel) resolve against the target model's policy.
   */
  private resolveThinkingFloorForModel(
    modelString: string,
    providersConfig: ProvidersConfigMap | null
  ): ThinkingLevel {
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
    return resolveMinimumThinkingLevel(modelString, minThinkingOverride, providersConfig);
  }

  /**
   * Apply per-model thinking floors + policy clamping — the single definition
   * used by streamWithHistory's request build AND the accepted-send payload,
   * so telemetry can never report a level the stream doesn't run at.
   */
  private enforceThinkingFloorsForModel(
    modelString: string,
    thinkingLevel: ThinkingLevel,
    providersConfig: ProvidersConfigMap | null
  ): ThinkingLevel {
    return enforceThinkingPolicy(
      modelString,
      thinkingLevel,
      this.resolveThinkingFloorForModel(modelString, providersConfig),
      providersConfig
    );
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

  /**
   * Share of the routed model's window the pending send itself will occupy,
   * by the budget code's chars-per-token heuristic: the prompt, the invoked
   * skill's body bounded to what its snapshot row will hold, every inline
   * skill reference at that same cap (their bodies are resolved only at
   * materialization, and neither the reference count nor their total size is
   * bounded), and text attachments by size. 0 when the window is unknown (no
   * compaction signal, as the monitor treats it).
   */
  private estimateRoutedPendingSendPercent(args: {
    message: string;
    skillBody: string | undefined;
    inlineSkillRefCount: number;
    fileParts: ReadonlyArray<{ url: string; mediaType: string }> | undefined;
    /** Text size of the already-materialized @file mention snapshot (0 without one). */
    fileSnapshotChars: number;
    /** MCP prompt references, each priced at MCP_PROMPT_MAX_TEXT_BYTES (materialized later). */
    mcpPromptRefCount: number;
    model: string;
    use1MContext: boolean;
    providersConfig: ProvidersConfigMap | null;
    openaiWireFormat: OpenAIWireFormat | null | undefined;
  }): number {
    const limit = getEffectiveContextLimit(args.model, args.use1MContext, args.providersConfig, {
      openaiWireFormat: args.openaiWireFormat,
    });
    if (limit == null || limit <= 0) return 0;
    // Composer attachments are images (SVG included) or PDFs. Text-like media
    // (SVG is inlined as text) counts by decoded size; the rest is priced the
    // way the budget code prices a fresh request's attachments (per part).
    const textLike = (part: { mediaType: string }) =>
      part.mediaType.startsWith("text/") || part.mediaType === "image/svg+xml";
    const textLikeChars = (args.fileParts ?? [])
      .filter(textLike)
      .reduce((sum, part) => sum + decodedAttachmentChars(part.url), 0);
    // PDFs are billed per page, never as one media unit (estimatePdfAttachmentTokens).
    const isPdf = (part: { mediaType: string }) =>
      normalizeMediaType(part.mediaType) === "application/pdf";
    const pdfTokens = (args.fileParts ?? [])
      .filter(isPdf)
      .reduce((sum, part) => sum + estimatePdfAttachmentTokens(part.url), 0);
    const mediaTokens = estimateFreshRequestTokens({
      userText: "",
      attachments: (args.fileParts ?? []).filter((part) => !textLike(part) && !isPdf(part)),
      // The recorded usage already includes the system prompt.
      systemFloorTokens: 0,
    });
    // Materialization substitutes $ARGUMENTS/$N and expands whole-line
    // dynamic-context directives, either of which can grow the body up to the
    // snapshot cap; a raw body that can expand is priced at the cap.
    const skillBody = args.skillBody;
    const skillChars =
      skillBody == null
        ? 0
        : skillBodyHasArgumentPlaceholders(skillBody) ||
            extractSkillDynamicCommands(skillBody).length > 0
          ? MAX_AGENT_SKILL_SNAPSHOT_CHARS
          : Math.min(skillBody.length, MAX_AGENT_SKILL_SNAPSHOT_CHARS);
    const chars =
      args.message.length +
      skillChars +
      args.inlineSkillRefCount * MAX_AGENT_SKILL_SNAPSHOT_CHARS +
      args.fileSnapshotChars +
      args.mcpPromptRefCount * MCP_PROMPT_MAX_TEXT_BYTES +
      textLikeChars;
    return ((Math.ceil(chars / APPROX_CHARS_PER_TOKEN) + mediaTokens + pdfTokens) / limit) * 100;
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
    this.clearContextBudgetState();
    this.continuousCompactor.reset("context-changed");
    this.lastUsageState = undefined;
  }

  private isTokenBudgetActive(options?: SendMessageOptions): boolean {
    const enabled = (id: ExperimentId) =>
      typeof this.aiService.isExperimentEnabled === "function" &&
      this.aiService.isExperimentEnabled(id);
    if (!(options?.experiments?.tokenBudget ?? enabled(EXPERIMENT_IDS.TOKEN_BUDGET))) return false;
    if (
      (options?.experiments?.continuousCompaction ??
        enabled(EXPERIMENT_IDS.CONTINUOUS_COMPACTION)) ||
      this.isRlmCompactionEnabled(options)
    ) {
      log.debug("Token-budget rollover yields to continuous/RLM compaction", {
        workspaceId: this.workspaceId,
      });
      return false;
    }
    return !isCompactionRequestMetadata(options?.muxMetadata);
  }

  /**
   * A flush entry that can no longer run as the hidden memory-only step (mode inactive, rollover
   * disabled, intent dropped) becomes an ordinary continuation: neither the trigger text nor the
   * flag may reach the provider, delegated turns resolve stream metadata from the send options
   * (strip it there too), and the paired rollover continuation is dropped.
   */
  private degradeFlushEntryToContinuation(
    userMessage: MuxMessage,
    options: SendMessageOptions
  ): SendMessageOptions {
    assert(
      userMessage.metadata?.muxMetadata?.contextBudgetFlush === true,
      "only flush entries are degraded"
    );
    userMessage.parts = [{ type: "text", text: "Continue" }];
    const { contextBudgetFlush: _dropped, ...rest } = userMessage.metadata.muxMetadata;
    userMessage.metadata.muxMetadata = rest;
    let next = options;
    if ((options.muxMetadata as MuxMessageMetadata | undefined)?.contextBudgetFlush === true) {
      const { contextBudgetFlush: _optionFlag, ...optionRest } =
        options.muxMetadata as MuxMessageMetadata;
      next = { ...options, muxMetadata: optionRest };
    }
    if (this.messageQueue.removeByDedupeKeyPrefix(CONTEXT_CONTINUE_DEDUPE_KEY).removedCount > 0)
      this.emitQueuedMessageChanged();
    return next;
  }

  /**
   * Drop a pending reset (intent, pinned snapshot, flush claim) without touching queued
   * continuations: used when rollover can no longer seal the window but a paired "Continue"
   * must still dispatch as an ordinary continuation.
   */
  private dropContextBudgetIntent(): void {
    this.pendingRollover = undefined;
    this.pendingRolloverSnapshot = undefined;
    this.contextBudgetFlushClaimed = false;
  }

  private clearContextBudgetState(): void {
    this.contextBudgetGeneration += 1;
    this.pendingRollover = undefined;
    this.pendingRolloverSnapshot = undefined;
    this.pendingBudgetWarning = undefined;
    this.contextBudgetWarningClaimed = false;
    this.contextBudgetFlushClaimed = false;
    this.contextBudgetMemoryWritable = undefined;
    this.contextBudgetHistoryAvailable = false;
    this.messageQueue.removeByDedupeKeyPrefix(CONTEXT_CONTINUE_DEDUPE_KEY);
    this.messageQueue.removeByDedupeKeyPrefix(CONTEXT_WARNING_DEDUPE_KEY);
  }

  /** Shared with manual reset, but only context-scoped state: tasks, costs and goal consent survive. */
  async applyContextResetSideEffects(): Promise<void> {
    assert(
      !this.streamManager.isStreaming(this.workspaceId),
      "context reset requires a settled stream"
    );
    this.retryManager.cancel();
    this.setAutoRetryResumeState(undefined);
    this.lastUsageState = undefined;
    this.continuousCompactor.reset("context-changed");
    this.clearFileState();
    this.memoryContextByModelString.clear();
    try {
      await this.clearPostCompactionState();
    } catch (error) {
      throw new Error(
        `The persisted post-compaction carryover could not be durably discarded (${getErrorMessage(error)}). Pre-reset read/skill context may be re-injected after a restart.`,
        { cause: error }
      );
    }
    try {
      await sandboxHostService.discardScope(
        this.workspaceId,
        path.join(this.config.sessionsDir, this.workspaceId)
      );
    } catch (error) {
      throw new Error(
        `The sandbox kernel state could not be durably invalidated (${getErrorMessage(error)}). The sandbox stays unavailable and cleared variables may reappear after a restart.`,
        { cause: error }
      );
    }
  }

  private async checkContextBudgetHistoryAccess(
    options: SendMessageOptions | undefined
  ): Promise<Result<void, SendMessageError>> {
    const blocked: Result<void, SendMessageError> = Err({
      type: "context_budget_blocked",
      message:
        "Context budget reached, but session_history is disabled. Enable it, use /compact, or /clear --soft.",
    });
    if (isSessionHistoryDisabled(options?.toolPolicy)) {
      return blocked;
    }
    // Agent allowlists and removals are absent from caller options. Resolve them before sealing
    // history, including after restart or switching agents between turns.
    const resolved = await this.resolveAgentForBudgetChecks(options);
    if (!resolved.success) return resolved;
    return isSessionHistoryDisabled(resolved.data.effectiveToolPolicy) ? blocked : Ok(undefined);
  }

  private async resolveAgentForBudgetChecks(
    options: SendMessageOptions | undefined
  ): Promise<Result<AgentResolutionResult, SendMessageError>> {
    try {
      const metadata = await this.aiService.getWorkspaceMetadata(this.workspaceId);
      if (!metadata.success) return Err(createUnknownSendMessageError(metadata.error));
      const resolved = await resolveAgentForStream({
        workspaceId: this.workspaceId,
        metadata: metadata.data,
        ...createRuntimeContextForWorkspace(metadata.data),
        requestedAgentId: options?.agentId,
        strictAgentResolution: options?.strictAgentResolution,
        disableWorkspaceAgents: options?.disableWorkspaceAgents ?? false,
        callerToolPolicy: options?.toolPolicy,
        cfg: this.config.loadConfigOrDefault(),
        emitError: () => undefined,
        isAdvisorExperimentEnabled:
          options?.experiments?.advisorTool ??
          this.aiService.isExperimentEnabled(EXPERIMENT_IDS.ADVISOR_TOOL),
        includeAgentPlugins: this.aiService.isAgentPluginsEnabled?.() ?? false,
      });
      return resolved.success ? Ok(resolved.data) : Err(resolved.error);
    } catch (error) {
      return Err(createUnknownSendMessageError(getErrorMessage(error)));
    }
  }

  private async rejectActiveContextBudgetRequest(): Promise<Result<void, SendMessageError>> {
    const turn = this.coordinator.turnId;
    const operation = this.coordinator.operationId;
    const userMessageId = this.activeStreamUserMessageId;
    const history = await this.historyService.getHistoryFromLatestBoundary(this.workspaceId);
    if (!this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation))
      return Ok(undefined);
    if (!history.success) return Err(createUnknownSendMessageError(history.error));
    const trigger = history.data.findLast((row) => row.id === userMessageId);
    if (!trigger) return Ok(undefined);
    const updated = await this.historyService.rejectContextBudgetRequest(this.workspaceId, trigger);
    if (!this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation))
      return Ok(undefined);
    if (!updated.success) return Err(createUnknownSendMessageError(updated.error));
    const baseline = this.acceptedFileSnapshotBaseline;
    if (baseline && updated.data.some((row) => row.id === baseline.messageId)) {
      baseline.tracking.forget();
      this.acceptedFileSnapshotBaseline = undefined;
    }
    for (const row of updated.data) this.emitChatEvent({ ...row, type: "message" });
    return Ok(undefined);
  }

  private async captureRolloverRequestAssembly(): Promise<
    Result<RequestAssemblySnapshot, SendMessageError>
  > {
    if (!this.aiService.captureRequestAssemblySnapshot)
      return Err({
        type: "context_budget_blocked",
        message: "Request assembly safety is unavailable; use /compact or retry after restarting.",
      });
    const captured = await this.aiService.captureRequestAssemblySnapshot(this.workspaceId);
    if (!captured.success) return captured;
    assert(
      captured.data.workspaceId === this.workspaceId,
      "Rollover snapshot must match its workspace"
    );
    if (!captured.data.preservesToolset)
      return Err({
        type: "context_budget_blocked",
        message:
          "Context rollover is unavailable with request middleware that can change tools. Use /compact or a context-only integration.",
      });
    return captured;
  }

  /** Emergency retries reuse the accepted user row; never rerun a completed tool to recover context. */
  private async rolloverAfterBudgetFailure(
    model: string,
    estimate?: number,
    // An edited startup may recover its own request without admitting competing turns.
    editReservation?: PreparationAttempt["editReservation"]
  ): Promise<
    Result<
      | {
          snapshot: RequestAssemblySnapshot;
          request: PreparedStreamMessage;
          /** Send options for the retry (a flush trigger's marker is stripped). */
          options: SendMessageOptions | undefined;
        }
      | undefined,
      SendMessageError
    >
  > {
    const turn = this.coordinator.turnId;
    const operation = this.coordinator.operationId;
    const userMessageId = this.activeStreamUserMessageId;
    const context = this.activeStreamContext;
    const generation = this.contextBudgetGeneration;
    if (
      !context ||
      context.contextBudgetRetried ||
      this.compactionMonitor.getThreshold() >= 1 ||
      this.coordinator.admissionBlocked ||
      this.coordinator.editBlocked(editReservation?.id) ||
      this.coordinator.disposed ||
      this.coordinator.closing
    )
      return Ok(undefined);
    try {
      // StreamManager's completion settles after teardown. Commit its error partial,
      // including any settled fallback tool outputs, before sealing the old window.
      const committed = await this.historyService.commitPartial(this.workspaceId);
      if (!this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation))
        return Ok(undefined);
      if (!committed.success) return Err(createUnknownSendMessageError(committed.error));
      const history = await this.historyService.getHistoryFromLatestBoundary(this.workspaceId);
      if (!this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation))
        return Ok(undefined);
      if (!history.success) return Err(createUnknownSendMessageError(history.error));
      const user = history.data.findLast((row) => row.id === userMessageId);
      if (!user) return Ok(undefined);
      const preludeIds = new Set(
        getRequestPreludeMessageIds(user.metadata?.requestPreludeMessageIds)
      );
      const priorRows = history.data.filter(
        (row) =>
          row !== user &&
          !isSyntheticSnapshotUserMessage(row) &&
          !(preludeIds.has(row.id) && row.role === "assistant" && row.metadata?.synthetic === true)
      );
      if (!hasRolloverEligibleMessages(priorRows)) return Ok(undefined);
      const maxTokens = getEffectiveContextLimit(
        model,
        this.is1MContextEnabledForModel(model, context.options, context.providersConfig),
        context.providersConfig,
        { openaiWireFormat: context.options?.providerOptions?.openai?.wireFormat }
      );
      if (maxTokens == null || maxTokens <= 0) return Ok(undefined);
      // An admitted final-flush trigger that overflowed at assembly must not carry its
      // internal text or flag into the fresh window; without the flag the request builder
      // applies the ordinary toolset again, so it continues as a normal turn. Delegated turns
      // resolve stream metadata from the send options, so strip the flag there too.
      const wasFlush = user.metadata?.muxMetadata?.contextBudgetFlush === true;
      const optionsMuxMetadata = context.options?.muxMetadata as MuxMessageMetadata | undefined;
      let retryOptions = context.options;
      if (wasFlush && context.options && optionsMuxMetadata?.contextBudgetFlush === true) {
        const { contextBudgetFlush: _flag, ...rest } = optionsMuxMetadata;
        retryOptions = { ...context.options, muxMetadata: rest };
      }
      const access = await this.checkContextBudgetHistoryAccess(retryOptions);
      if (!this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation))
        return Ok(undefined);
      if (!access.success) return access;
      // A flush's promised reset was admitted when the flush dispatched; reuse that snapshot
      // so registry changes during the flush cannot reject the emergency reset either.
      const captured =
        wasFlush && this.pendingRolloverSnapshot
          ? Ok(this.pendingRolloverSnapshot)
          : await this.captureRolloverRequestAssembly();
      if (!this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation))
        return Ok(undefined);
      if (!captured.success) return captured;
      const rollover: ContextWindowRollover = {
        type: "context-window-rollover",
        rolloverId: randomUUID(),
        reason: "context-exceeded",
        previousWindowId: currentContextWindowId(history.data),
        flushOpportunity: false,
        contextTokens: estimate ?? maxTokens,
        maxTokens,
      };
      const { historySequence: _sequence, ...metadata } = user.metadata ?? {};
      const { contextBudgetFlush: _flushFlag, ...muxMetadata } = metadata.muxMetadata ?? {
        type: "context-window-continuation" as const,
      };
      const continuation: MuxMessage = {
        ...user,
        id: createUserMessageId(),
        ...(wasFlush ? { parts: [{ type: "text", text: "Continue" }] } : {}),
        metadata: {
          ...metadata,
          timestamp: Date.now(),
          muxMetadata: { ...muxMetadata, rolloverId: rollover.rolloverId },
        },
      };
      // Snapshot/payload rows are part of the accepted request, not just its
      // fixed trigger. Preserve their roles and rebind server-owned ID references.
      let copiedFileBaseline: AgentSession["acceptedFileSnapshotBaseline"];
      const requestPrelude = [...preludeIds].flatMap((id) => {
        const row = history.data.findLast((message) => message.id === id);
        // Tolerant history parsing can drop a damaged snapshot or payload while
        // retaining its trigger. Don't let stale references prevent recovery.
        if (
          !id ||
          !row ||
          !(
            isSyntheticSnapshotUserMessage(row) ||
            (row.role === "assistant" && row.metadata?.synthetic === true)
          )
        ) {
          log.warn("Skipping damaged context-budget request prelude", {
            workspaceId: this.workspaceId,
          });
          return [];
        }
        const newId = randomUUID();
        if (this.acceptedFileSnapshotBaseline?.messageId === id) {
          copiedFileBaseline = { ...this.acceptedFileSnapshotBaseline, messageId: newId };
        }
        continuation.parts = continuation.parts.map((part) =>
          part.type === "text" ? { ...part, text: part.text.replaceAll(id, newId) } : part
        );
        const { historySequence: _preludeSequence, ...rowMetadata } = row.metadata!;
        return {
          ...row,
          id: newId,
          metadata: {
            ...rowMetadata,
            uiVisible: false,
            ...(rowMetadata.mcpPromptSnapshot
              ? {
                  mcpPromptSnapshot: {
                    ...rowMetadata.mcpPromptSnapshot,
                    invokingMessageId: continuation.id,
                  },
                }
              : {}),
          },
        };
      });
      // Retry the accepted skill instructions, not their dynamic commands. They
      // may have been deduped against a snapshot elsewhere in the sealed window.
      const skillSnapshots = extractAgentSkillRefs(user.metadata?.muxMetadata).flatMap((ref) => {
        const snapshot = history.data.findLast(
          (row) =>
            !row.metadata?.contextBudgetRejected &&
            row.metadata?.agentSkillSnapshot?.skillName === ref.skillName
        );
        if (!snapshot || preludeIds.has(snapshot.id)) return [];
        const { historySequence: _snapshotSequence, ...snapshotMetadata } = snapshot.metadata!;
        return [
          { ...snapshot, id: createAgentSkillSnapshotMessageId(), metadata: snapshotMetadata },
        ];
      });
      // The retry owns deduped skill copies too: a terminal rejection must quarantine them.
      continuation.metadata!.requestPreludeMessageIds = [...skillSnapshots, ...requestPrelude].map(
        (row) => row.id
      );
      const retryPrelude = [
        ...createRolloverPrefix(rollover),
        ...skillSnapshots,
        ...requestPrelude,
      ];
      // A smaller fallback can reject snapshots that fit the primary. Admit the
      // complete copied payload before clearing state or sealing the old window;
      // neither dynamic skill commands nor other accepted inputs may be rerun.
      const freshBudget = await this.checkFreshContextBudget(
        continuation,
        model,
        retryOptions,
        retryPrelude,
        context.providersConfig
      );
      if (
        !this.coordinator.isCurrentTurn(turn) ||
        !this.coordinator.isCurrentOperation(operation) ||
        this.activeStreamContext !== context ||
        this.contextBudgetGeneration !== generation ||
        this.coordinator.admissionBlocked ||
        this.coordinator.editBlocked(editReservation?.id) ||
        this.coordinator.disposed ||
        this.coordinator.closing
      )
        return Ok(undefined);
      if (!freshBudget.success) return freshBudget;
      const rows = [...retryPrelude, continuation];
      const retryMemoryConsent = await this.createRoutedMemoryConsent(
        context.routedConsentRejection
      );
      const candidate = await this.prepareRolloverRequest(
        rows,
        model,
        retryOptions,
        captured.data,
        context.agentInitiated,
        undefined,
        undefined,
        // The fresh window copies the routed turn's snapshot rows: the class
        // provider must not receive them without the turn's consent verdict.
        this.bindRolloverConsentGate(context.routedConsentRejection, rows, retryMemoryConsent),
        retryMemoryConsent
      );
      if (!candidate.success) return candidate;
      let transferred = false;
      await using _candidateOwner = {
        [Symbol.asyncDispose]: async () => {
          if (!transferred) await candidate.data[Symbol.asyncDispose]();
        },
      };
      if (
        !this.coordinator.isCurrentTurn(turn) ||
        !this.coordinator.isCurrentOperation(operation) ||
        this.coordinator.closing ||
        this.coordinator.admissionBlocked ||
        this.contextBudgetGeneration !== generation
      )
        return Ok(undefined);
      await this.applyContextResetSideEffects();
      if (
        !this.coordinator.isCurrentTurn(turn) ||
        !this.coordinator.isCurrentOperation(operation) ||
        this.activeStreamContext !== context ||
        this.contextBudgetGeneration !== generation ||
        this.coordinator.admissionBlocked ||
        this.coordinator.disposed ||
        this.coordinator.closing
      )
        return Ok(undefined);
      const appended = await this.historyService.appendManyToHistory(this.workspaceId, rows);
      if (
        !this.coordinator.isCurrentTurn(turn) ||
        !this.coordinator.isCurrentOperation(operation) ||
        this.coordinator.closing ||
        this.contextBudgetGeneration !== generation
      )
        return Ok(undefined);
      if (!appended.success) return Err(createUnknownSendMessageError(appended.error));
      // Only the copied snapshot belongs in the new window. Its accepted bytes—not a newer
      // disk read or tool-tracked hash—must drive subsequent external-edit notifications.
      copiedFileBaseline?.tracking.restore();
      this.acceptedFileSnapshotBaseline = copiedFileBaseline;
      this.clearContextBudgetState();
      this.onContextWindowRollover?.();
      await clearPendingBranchSummary(this.workspaceId);
      if (!this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation))
        return Ok(undefined);
      for (const row of rows) this.emitChatEvent({ ...row, type: "message" });
      transferred = true;
      return Ok({ snapshot: captured.data, request: candidate.data, options: retryOptions });
    } catch (error) {
      return Err(createUnknownSendMessageError(getErrorMessage(error)));
    }
  }

  /**
   * Consent gate for a token-budget rollover request. Prepared requests bake
   * their turn options in at preparation (`PreparedStreamMessage.start()`
   * reuses them), so the routed turn's gate has to be bound HERE — at both
   * rollover sites, the proactive on-send one and the budget-failure retry —
   * armed when the fresh window's rows carry project-scope snapshot content,
   * the same arming rule as streamWithHistory's request scan. Unrouted turns
   * (no gate) bind nothing.
   */
  private bindRolloverConsentGate(
    routedConsentRejection: RoutedConsentRejection | undefined,
    rows: MuxMessage[],
    memoryConsent?: RoutedMemoryConsent
  ): StreamMessageOptions["preDispatchConsentGate"] {
    if (routedConsentRejection == null) return undefined;
    const carriesProjectContent = messagesCarryProjectSkillContent(rows);
    return (context) =>
      routedConsentRejection(
        carriesProjectContent ||
          memoryConsent?.carriesProjectSkillContent === true ||
          gateContextCarriesProjectSkillContent(context),
        context?.midStream === true
      );
  }

  private async prepareRolloverRequest(
    messages: MuxMessage[],
    modelString: string,
    options: SendMessageOptions | undefined,
    snapshot: RequestAssemblySnapshot,
    agentInitiated?: boolean,
    signal?: AbortSignal,
    manualIntervention?: { enqueuedAtMs?: number },
    // The request is built NOW (turn options included), not at start(): a
    // routed turn's consent gate must be part of the preparation.
    preDispatchConsentGate?: StreamMessageOptions["preDispatchConsentGate"],
    // Same routed turn's memory channel (createRoutedMemoryConsent).
    memoryConsent?: RoutedMemoryConsent
  ): Promise<Result<PreparedStreamMessage, SendMessageError>> {
    if (!this.aiService.prepareStreamMessage)
      return Err({
        type: "context_budget_blocked",
        message: "Full request preparation is unavailable; use /compact or restart.",
      });
    const cache = new Map<string, CachedMemoryContext>();
    // Admission must not pause the goal yet, but the pinned tools must match the later manual pause.
    let prospectiveGoalStatusForToolAvailability: StreamMessageOptions["prospectiveGoalStatusForToolAvailability"];
    if (manualIntervention && this.workspaceGoalService) {
      const goal = await this.workspaceGoalService.getGoal(this.workspaceId);
      prospectiveGoalStatusForToolAvailability =
        goal?.status === "active" &&
        !manualSendPreservesGoalActivation(goal, manualIntervention.enqueuedAtMs)
          ? "paused"
          : (goal?.status ?? null);
    }

    const providersConfig = this.getProvidersConfigSafe();
    const minThinkingLevel = resolveMinimumThinkingLevel(
      modelString,
      lookupMinThinkingLevelOverride(
        this.config.loadConfigOrDefault().minThinkingLevelByModel,
        modelString
      ),
      providersConfig
    );
    // Abort unfinished assembly, not a ready request: failed rollback can force its delivery.
    // Ready candidates use explicit cancellation guards/disposal; shutdown remains permanent.
    const admissionController = new AbortController();
    const cancelAdmission = () => admissionController.abort(signal?.reason);
    const detachAdmissionCancellation = () => signal?.removeEventListener("abort", cancelAdmission);
    if (signal?.aborted) cancelAdmission();
    else signal?.addEventListener("abort", cancelAdmission, { once: true });
    const optionsMuxMetadata = options?.muxMetadata as MuxMessageMetadata | undefined;
    let prepared: Result<PreparedStreamMessage, SendMessageError>;
    try {
      prepared = await this.aiService.prepareStreamMessage({
        workspaceId: this.workspaceId,
        messages,
        preDispatchConsentGate,
        modelString,
        abortSignal: signal
          ? AbortSignal.any([this.closingSignal, admissionController.signal])
          : this.closingSignal,
        thinkingLevel: options?.thinkingLevel
          ? enforceThinkingPolicy(
              modelString,
              options.thinkingLevel,
              minThinkingLevel,
              providersConfig
            )
          : undefined,
        minThinkingLevel,
        reasoningMode: options?.reasoningMode,
        toolPolicy: options?.toolPolicy,
        additionalSystemContext: options?.additionalSystemContext,
        additionalSystemInstructions: options?.additionalSystemInstructions,
        maxOutputTokens: options?.maxOutputTokens,
        muxProviderOptions: options?.providerOptions,
        agentInitiated,
        agentId: options?.agentId,
        acpPromptId:
          normalizeAcpPromptId(options?.acpPromptId) ?? extractAcpPromptId(optionsMuxMetadata),
        delegatedToolNames:
          normalizeDelegatedToolNames(options?.delegatedToolNames) ??
          extractAcpDelegatedTools(optionsMuxMetadata),
        muxMetadata: resolveStreamMuxMetadata(
          optionsMuxMetadata,
          this.findLastRetryUserMessage(messages)?.metadata?.muxMetadata,
          messages
        ),
        recordFileState: this.fileChangeTracker.record.bind(this.fileChangeTracker),
        postCompactionAttachments: null,
        resolveMemoryContext: async (model, memoryOptions) => {
          const memoryContext = await this.resolveMemoryContext(
            model,
            {
              ...memoryOptions,
              tokenBudgetActive: this.isTokenBudgetActive(options),
              excludeProjectSkillContent: memoryConsent?.excludeProjectSkillContent === true,
            },
            cache
          );
          if (memoryConsent && memoryContext?.carriesProjectSkillContent === true) {
            memoryConsent.carriesProjectSkillContent = true;
          }
          return memoryContext;
        },
        memoryWritesCarryProjectSkillContent: messagesCarryProjectSkillContent(messages),
        workspaceGoalService: this.workspaceGoalService,
        prospectiveGoalStatusForToolAvailability,
        allowAgentSetGoal: options?.allowAgentSetGoal === true,
        experiments: options?.experiments,
        disableWorkspaceAgents: options?.disableWorkspaceAgents,
        strictAgentResolution: options?.strictAgentResolution,
        hasQueuedMessages: this.hasQueuedMessages.bind(this),
        getQueuedInputStopCause: this.getQueuedInputStopCause.bind(this),
        contextBudgetRolloverAvailable:
          this.isTokenBudgetActive(options) && this.compactionMonitor.getThreshold() < 1,
        onStepSettled: (step) => this.onContextBudgetStepSettled(step),
        requestAssemblySnapshot: snapshot,
      });
    } finally {
      detachAdmissionCancellation();
    }
    if (prepared.success && admissionController.signal.aborted) {
      await prepared.data[Symbol.asyncDispose]();
      return Err(
        createUnknownSendMessageError("Request preparation was canceled before admission.")
      );
    }
    if (!prepared.success)
      return prepared.error.type === "context_budget_exceeded"
        ? Err({
            type: "context_budget_blocked",
            message: `The complete request does not fit in a fresh context window for ${prepared.error.model}. Shorten system instructions or tool schemas, or choose a larger model.`,
          })
        : prepared;
    return Ok({
      start: (startOptions) => {
        this.memoryContextByModelString = cache;
        return prepared.data.start(startOptions);
      },
      [Symbol.asyncDispose]: () => prepared.data[Symbol.asyncDispose](),
    });
  }

  private async checkFreshContextBudget(
    userMessage: MuxMessage,
    model: string,
    options: SendMessageOptions | undefined,
    prelude: readonly MuxMessage[],
    providersConfig: ProvidersConfigMap | null = this.getProvidersConfigSafe()
  ): Promise<Result<void, SendMessageError>> {
    const maxTokens = getEffectiveContextLimit(
      model,
      this.is1MContextEnabledForModel(model, options, providersConfig),
      providersConfig,
      { openaiWireFormat: options?.providerOptions?.openai?.wireFormat }
    );
    if (maxTokens == null || maxTokens <= 0) return Ok(undefined);
    // Historical usage includes old user/history content, not just system/schema
    // overhead. Keep the model-scaled floor; final assembly checks the actual prompt.
    const estimate = await estimateFreshRequestTokensForModel(
      {
        userText: userMessage.parts
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n"),
        attachments: userMessage.parts.filter((part) => part.type === "file"),
        prelude: prelude.map((row) => row.parts),
        modelContextLimit: maxTokens,
      },
      {
        model,
        metadataModel: resolveModelForMetadata(model, providersConfig),
      }
    );
    return estimate >= getContextBudgetHardCeiling(maxTokens)
      ? Err({
          type: "context_budget_blocked",
          message: `This message plus its snapshots and system context does not fit in a fresh context window for ${model}; shorten it, remove attachments, or use a larger model.`,
        })
      : Ok(undefined);
  }

  private async prepareContextBudgetSend(
    userMessage: MuxMessage,
    options: SendMessageOptions
  ): Promise<
    Result<
      { prefix: MuxMessage[]; requestAssemblySnapshot?: RequestAssemblySnapshot },
      SendMessageError
    >
  > {
    const history = await this.historyService.getHistoryFromLatestBoundary(this.workspaceId);
    if (!history.success) return Err(createUnknownSendMessageError(history.error));
    // A filesystem error can be reported after an atomic replacement became visible.
    // Disk wins over an unconsumed in-memory claim: never append the same rollover twice.
    if (
      this.pendingRollover &&
      history.data.some(
        (row) =>
          row.metadata?.muxMetadata?.type === "context-window-rollover" &&
          row.metadata.muxMetadata.rolloverId === this.pendingRollover?.rolloverId
      )
    ) {
      this.clearContextBudgetState();
    }
    this.contextBudgetWarningClaimed = history.data.some(
      (row) => row.metadata?.muxMetadata?.type === "context-budget-warning"
    );
    // `||=`: the in-memory claim set at offer time must survive a read that runs before the
    // final row is durable.
    this.contextBudgetFlushClaimed ||= history.data.some(
      (row) =>
        row.metadata?.muxMetadata?.type === "context-budget-warning" &&
        row.metadata.muxMetadata.final === true
    );
    const providersConfig = this.getProvidersConfigSafe();
    const maxTokens = getEffectiveContextLimit(
      options.model,
      this.is1MContextEnabledForModel(options.model, options, providersConfig),
      providersConfig,
      { openaiWireFormat: options.providerOptions?.openai?.wireFormat }
    );
    // Without a known limit the budget cannot be evaluated, but an already pending or durably
    // requested (new_context) rollover must still seal the window; the row then records the
    // observed usage as its limit.
    const knownLimit = maxTokens != null && maxTokens > 0;
    if (!knownLimit)
      log.warn("Token budget has no known model context limit", { model: options.model });
    const lastAssistant = history.data.findLast(
      (row) => row.role === "assistant" && row.metadata?.contextUsage
    );
    // History parsing is tolerant: discard corrupt counters at this boundary,
    // while the final assembled-request preflight still enforces the hard limit.
    const tokenCount = (value: unknown): number | undefined =>
      isNonNegativeInteger(value) && Number.isSafeInteger(value) ? value : undefined;
    const persistedUsage: AiSdkUsageLike | undefined = lastAssistant?.metadata?.contextUsage;
    const persistedProviderMetadata =
      lastAssistant?.metadata?.contextProviderMetadata ?? lastAssistant?.metadata?.providerMetadata;
    const persistedCacheWrite = (
      persistedProviderMetadata?.anthropic as { cacheCreationInputTokens?: unknown } | undefined
    )?.cacheCreationInputTokens;
    // A best-effort restart seed may be absent. Validate before display conversion:
    // SDK input is cache-inclusive, so adding raw cache counters would count them twice.
    const usage =
      this.lastUsageState?.lastContextUsage ??
      createDisplayUsage(
        {
          inputTokens: tokenCount(persistedUsage?.inputTokens),
          cachedInputTokens:
            tokenCount(persistedUsage?.cachedInputTokens) ??
            tokenCount(persistedUsage?.inputTokenDetails?.cacheReadTokens),
          inputTokenDetails: {
            cacheWriteTokens:
              tokenCount(persistedCacheWrite) ??
              tokenCount(persistedUsage?.inputTokenDetails?.cacheWriteTokens),
          },
        },
        options.model
      );
    const contextTokens =
      (tokenCount(usage?.input.tokens) ?? 0) +
      (tokenCount(usage?.cached.tokens) ?? 0) +
      (tokenCount(usage?.cacheCreate.tokens) ?? 0);
    const userText = userMessage.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const attachments = userMessage.parts.filter((part) => part.type === "file");
    const budgetModel = {
      model: options.model,
      metadataModel: resolveModelForMetadata(options.model, providersConfig),
    };
    const recordedLimit = knownLimit ? maxTokens : Math.max(1, contextTokens);
    // The estimate only feeds the budget decision; without a limit there is nothing to compare
    // against, so skip the (tokenizer-backed) work and its failure modes entirely.
    const newRequestTokens = knownLimit
      ? await estimateFreshRequestTokensForModel(
          { userText, attachments, systemFloorTokens: 0, modelContextLimit: maxTokens },
          budgetModel
        )
      : 0;
    const decision: StepBudgetEvaluation = knownLimit
      ? evaluateStepBudget({
          contextTokens: contextTokens + newRequestTokens,
          outputTokens: tokenCount(lastAssistant?.metadata?.contextUsage?.outputTokens) ?? 0,
          ...estimateLastStepToolResults(lastAssistant),
          modelContextLimit: maxTokens,
          threshold: this.compactionMonitor.getThreshold(),
          warningEmitted: this.contextBudgetWarningClaimed,
        })
      : {
          decision: "continue",
          flushOpportunity: true,
          projected: contextTokens + newRequestTokens,
          hardCeiling: undefined,
        };
    // The queued flush entry must be recognized before the rollover logic below, which
    // `pendingRollover` would otherwise pre-empt. Re-check the headroom and the tool gates
    // with on-send numbers; degrade to an ordinary continuation when any no longer holds.
    if (userMessage.metadata?.muxMetadata?.contextBudgetFlush === true) {
      const rolloverEnabled = this.compactionMonitor.getThreshold() < 1;
      // The hard ceiling reserves OUTPUT_RESERVE_TOKENS for the step's output; a model whose
      // inherent thinking minimum needs a larger flush cap must find that extra room too. A
      // refusal may hand the flush to a fallback model with its own (possibly higher) minimum,
      // so size the headroom for the largest cap any model in the chain would run with.
      const flushOutputBeyondReserve = Math.max(
        0,
        ...[
          options.model,
          ...resolveWorkspaceModelFallbackChain(
            this.config.loadConfigOrDefault(),
            this.workspaceId,
            options.model,
            providersConfig
          ),
        ].map(
          (model) =>
            resolveContextBudgetFlushThinking(model, providersConfig).maxOutputTokens -
            OUTPUT_RESERVE_TOKENS
        )
      );
      const flushStillSafe =
        decision.hardCeiling !== undefined &&
        decision.projected + FLUSH_RESERVE_TOKENS + flushOutputBeyondReserve < decision.hardCeiling;
      // The prompt promises that the next message seals the window, so require the same
      // admission the rollover itself needs (history access, toolset-preserving middleware).
      // Threshold 100% disables automatic rollover: a flush promising a sealed window would lie.
      const generation = this.contextBudgetGeneration;
      const admitted =
        this.pendingRollover != null &&
        rolloverEnabled &&
        flushStillSafe &&
        this.contextBudgetMemoryWritable === true &&
        this.contextBudgetHistoryAvailable &&
        (await this.checkContextBudgetHistoryAccess(options)).success
          ? await this.captureRolloverRequestAssembly()
          : undefined;
      // Re-read the gates after the last await: the slider may have moved meanwhile, and a Stop
      // (interruptStream → clearContextBudgetState) drops the intent and its paired
      // continuation, so a flush accepted now would run with nothing to seal the window.
      if (
        admitted?.success &&
        this.contextBudgetGeneration === generation &&
        this.pendingRollover != null &&
        this.compactionMonitor.getThreshold() < 1
      ) {
        // Keep pendingRollover and pin this admitted snapshot: the promised reset must not be
        // invalidated by registry changes that happen during the flush turn itself. The flush
        // request runs the same pinned middleware, so a tool-mutating hook registered after
        // this capture cannot add an executable tool to the memory-only turn either.
        this.pendingRolloverSnapshot = admitted.data;
        return Ok({
          prefix: [
            createContextBudgetWarning({
              contextTokens: decision.projected,
              maxTokens: recordedLimit,
              budgetTokens: this.pendingRollover.budgetTokens,
              memoryWritable: true,
              sessionHistoryAvailable: true,
              final: true,
            }),
          ],
          requestAssemblySnapshot: admitted.data,
        });
      }
      // Neither the trigger text nor the flush flag may leak into the fresh window.
      userMessage.parts = [{ type: "text", text: "Continue" }];
      const { contextBudgetFlush: _dropped, ...rest } = userMessage.metadata.muxMetadata;
      userMessage.metadata.muxMetadata = rest;
      if (this.compactionMonitor.getThreshold() >= 1) {
        // Rollover was disabled after the pair was queued: drop the paired rollover entry and
        // the stale claims so nothing seals the window if rollover is re-enabled later, and a
        // later genuine rollover may offer the flush this turn never delivered.
        this.pendingRollover = undefined;
        this.contextBudgetFlushClaimed = false;
        if (this.messageQueue.removeByDedupeKeyPrefix(CONTEXT_CONTINUE_DEDUPE_KEY).removedCount > 0)
          this.emitQueuedMessageChanged();
      }
    }
    if (this.pendingRollover != null && this.compactionMonitor.getThreshold() >= 1) {
      // Rollover was disabled after the intent was recorded (e.g. during a flush turn that
      // ended without a settled tool step): a stale intent must not seal a later, unrelated
      // send once rollover is re-enabled.
      this.pendingRollover = undefined;
      this.pendingRolloverSnapshot = undefined;
      this.contextBudgetFlushClaimed = false;
    }
    // Durable model request: a successful new_context result in the window's last completed
    // assistant row whose rollover has not happened yet (it would sit behind a boundary
    // otherwise). Survives a restart that lost the in-memory intent and its queued
    // continuation; an interrupted (partial) row or a manual reset cancels it.
    // The receipt stays the window's last assistant row while history access is denied, so a
    // rejected send here would repeat on every later send: require access before honoring it.
    const modelRequested =
      this.pendingRollover == null &&
      hasUnconsumedNewContextRequest(history.data) &&
      (await this.checkContextBudgetHistoryAccess(options)).success;
    const shouldRollover =
      this.compactionMonitor.getThreshold() < 1 &&
      (this.pendingRollover != null || decision.decision === "rollover" || modelRequested);
    const rollover: AgentSession["pendingRollover"] =
      shouldRollover && hasRolloverEligibleMessages(history.data)
        ? (this.pendingRollover ?? {
            type: "context-window-rollover",
            rolloverId: randomUUID(),
            reason: "on-send",
            ...(modelRequested ? { requestedBy: "model" as const } : {}),
            previousWindowId: currentContextWindowId(history.data),
            flushOpportunity: decision.flushOpportunity,
            contextTokens: decision.projected,
            maxTokens: recordedLimit,
            budgetTokens: getContextBudgetRolloverPoint(
              recordedLimit,
              this.compactionMonitor.getThreshold()
            ),
          })
        : undefined;
    // Recovery access is required only when sealing old context, not for a
    // first request that crosses the proactive threshold but still fits below.
    if (rollover) {
      const access = await this.checkContextBudgetHistoryAccess(options);
      if (!access.success) return access;
    }
    const freshBudget = await this.checkFreshContextBudget(
      userMessage,
      options.model,
      options,
      rollover ? createRolloverPrefix(rollover) : []
    );
    if (!freshBudget.success) return freshBudget;
    if (rollover) {
      const pinned =
        this.pendingRollover != null && rollover === this.pendingRollover
          ? this.pendingRolloverSnapshot
          : undefined;
      const captured = pinned ? Ok(pinned) : await this.captureRolloverRequestAssembly();
      if (!captured.success) return captured;
      this.pendingRollover = rollover;
      userMessage.metadata = {
        ...userMessage.metadata,
        muxMetadata: {
          ...(userMessage.metadata?.muxMetadata ?? { type: "context-window-continuation" }),
          rolloverId: rollover.rolloverId,
        },
      };
      // An enqueued warning superseded by rollover must not warn in the fresh window.
      if (userMessage.metadata?.muxMetadata?.type === "context-budget-warning") {
        userMessage.parts = [{ type: "text", text: "Continue" }];
        userMessage.metadata.muxMetadata = undefined;
      }
      return Ok({ prefix: createRolloverPrefix(rollover), requestAssemblySnapshot: captured.data });
    }
    if (shouldRollover) {
      log.warn("Context-budget window is already fresh; skipping duplicate reset", {
        workspaceId: this.workspaceId,
      });
      this.pendingRollover = undefined;
    }
    if (userMessage.metadata?.muxMetadata?.type === "context-budget-warning") {
      this.pendingBudgetWarning = undefined;
      return Ok({ prefix: [] });
    }
    if (
      !this.contextBudgetWarningClaimed &&
      this.contextBudgetMemoryWritable !== undefined &&
      this.compactionMonitor.getThreshold() < 1 &&
      (this.pendingBudgetWarning != null || decision.decision === "warn")
    ) {
      return Ok({
        prefix: [
          createContextBudgetWarning({
            contextTokens: decision.projected,
            maxTokens: recordedLimit,
            budgetTokens: getContextBudgetRolloverPoint(
              recordedLimit,
              this.compactionMonitor.getThreshold()
            ),
            memoryWritable: this.contextBudgetMemoryWritable,
            sessionHistoryAvailable:
              this.contextBudgetHistoryAvailable && !isSessionHistoryDisabled(options.toolPolicy),
          }),
        ],
      });
    }
    return Ok({ prefix: [] });
  }

  /** Sealed tool-end continuation shared by the mid-stream and resume-hydration paths. */
  private enqueueContextBudgetContinuation(args: {
    text: string;
    dedupeKey: string;
    options: SendMessageOptions;
    model: string;
    muxMetadata: MuxMessageMetadata;
    goalKind?: GoalSyntheticMessageKind;
    goalId?: string;
  }): void {
    this.messageQueue.addOnce(
      args.text,
      {
        ...args.options,
        model: args.model,
        queueDispatchMode: "tool-end",
        muxMetadata: args.muxMetadata,
      },
      args.dedupeKey,
      {
        synthetic: true,
        agentInitiated: true,
        sealed: true,
        removableDedupeKey: true,
        goalKind: args.goalKind,
        goalId: args.goalId,
      }
    );
  }

  private async onContextBudgetStepSettled(
    step: SettledStepBudget
  ): Promise<"continue" | "warn" | "rollover" | "block"> {
    const context = this.activeStreamContext;
    const generation = this.contextBudgetGeneration;
    if (!context?.options || !this.isTokenBudgetActive(context.options)) {
      // Token-budget mode was disabled after the flush trigger was persisted or queued: nothing
      // restores or seals the window any more, so end the hidden turn after its single step
      // and drop whatever intent the disabled mode left behind. A queued paired "Continue"
      // stays: without a reset it is an ordinary continuation of the interrupted work, and for
      // a delegated turn it keeps the notes-only finish from being recorded as the task's
      // outcome (WorkspaceTurnManager defers while a same-turn continuation is pending).
      if (context?.contextBudgetFlushTurn === true) {
        this.dropContextBudgetIntent();
        return "rollover";
      }
      return "continue";
    }
    // Fallbacks rebuild this callback's model binding; never use the requested primary's limit.
    context.modelString = step.model;
    // A flush turn's memory-only toolset says nothing about what ordinary turns can use.
    if (context.contextBudgetFlushTurn !== true) {
      this.contextBudgetMemoryWritable = step.memoryWritable;
      this.contextBudgetHistoryAvailable = step.sessionHistoryAvailable;
    }
    const usage = createDisplayUsage(step.usage, step.model, step.providerMetadata);
    const maxTokens = getEffectiveContextLimit(
      step.model,
      this.is1MContextEnabledForModel(step.model, context.options, context.providersConfig ?? null),
      context.providersConfig ?? null,
      { openaiWireFormat: context.options?.providerOptions?.openai?.wireFormat }
    );
    const threshold = this.compactionMonitor.getThreshold();
    const contextTokens = usage
      ? usage.input.tokens + usage.cached.tokens + usage.cacheCreate.tokens
      : 0;
    // A settled successful new_context result asks for a rollover regardless of usage. Without
    // session_history nothing could be retrieved from the sealed window (and the reset could not
    // be admitted), and with automatic rollover disabled nothing could seal it, so such requests
    // are ignored rather than left to fail every send.
    const modelRequested =
      step.newContextRequested === true &&
      step.sessionHistoryAvailable &&
      threshold < 1 &&
      context.contextBudgetFlushTurn !== true;
    const knownLimit = maxTokens != null && maxTokens > 0;
    if (!knownLimit) {
      log.warn("Token budget has no known model context limit", { model: step.model });
      // Budget evaluation is impossible, but an explicit request needs no limit to be honored.
      if (!modelRequested) return "continue";
    }
    const decision: StepBudgetEvaluation = knownLimit
      ? evaluateStepBudget({
          contextTokens,
          outputTokens: step.usage?.outputTokens ?? 0,
          toolResultChars: step.toolResultChars,
          imageParts: step.imageParts,
          toolResultTokens: step.toolResultTokens,
          modelContextLimit: maxTokens,
          threshold,
          warningEmitted: this.contextBudgetWarningClaimed,
        })
      : {
          decision: "continue",
          flushOpportunity: true,
          projected: contextTokens,
          hardCeiling: undefined,
        };
    // Rollover metadata records the limit the window was measured against; an unknown limit is
    // recorded as the observed usage so the row stays valid for display and downgrade parsing.
    const recordedLimit = knownLimit ? maxTokens : Math.max(1, contextTokens);
    // "block" only exists at threshold 100%, where requests are not offered and never honored.
    if (decision.decision === "block") return "block";
    if (context.contextBudgetFlushTurn === true) {
      if (this.compactionMonitor.getThreshold() >= 1) {
        // Rollover was disabled while the flush ran: nothing may seal this window, so drop the
        // stale intent. The paired "Continue" is kept on purpose: with the intent gone it
        // dispatches as an ordinary continuation of the interrupted work in this window, and a
        // delegated turn must not record the notes-only flush finish as the task's outcome
        // (WorkspaceTurnManager defers finalization while a same-turn continuation is pending).
        this.dropContextBudgetIntent();
        return "rollover";
      }
      // A flush turn is bounded to one provider step even when the step no longer crosses the
      // threshold (larger model after a restart): stopping here lets the queued rollover
      // continuation seal the window.
      if (decision.decision === "continue") return "rollover";
    }
    // A model request is honored like a budget rollover (continuation queued after every sibling
    // settled) so the model never re-executes side effects; the persisted tool result doubles as
    // the durable receipt that prepareRolloverRequest recovers after a restart.
    if (decision.decision === "continue" && !modelRequested) return "continue";
    let offerFlush = false;
    if (decision.decision === "rollover" || modelRequested) {
      const history = await this.historyService.getHistoryFromLatestBoundary(this.workspaceId);
      if (!history.success) throw new Error(history.error);
      if (this.activeStreamContext !== context || this.contextBudgetGeneration !== generation)
        return "continue";
      // Offer one final notes flush before sealing when a writing step still fits and the
      // reset that follows can actually be admitted (session_history available). A model that
      // asked for the reset itself has already had its chance to write notes.
      offerFlush =
        !modelRequested &&
        decision.decision === "rollover" &&
        this.pendingRollover == null &&
        !this.contextBudgetFlushClaimed &&
        decision.flushOpportunity &&
        step.memoryWritable &&
        step.sessionHistoryAvailable &&
        this.messageQueue.isEmpty();
      this.pendingRollover ??= {
        type: "context-window-rollover",
        rolloverId: randomUUID(),
        reason: "mid-stream",
        ...(modelRequested ? { requestedBy: "model" as const } : {}),
        previousWindowId: currentContextWindowId(history.data),
        flushOpportunity: decision.flushOpportunity,
        contextTokens: decision.projected,
        maxTokens: recordedLimit,
        budgetTokens: getContextBudgetRolloverPoint(recordedLimit, threshold),
      };
    } else {
      this.contextBudgetWarningClaimed = true;
      this.pendingBudgetWarning = true;
    }
    // Keep the continuation's delegated-turn/goal attribution; the warning
    // itself is a separate durable prefix row when this entry dispatches.
    // Attachments of the triggering send must not ride along on maintenance continuations
    // (they would be re-sent, and could consume the flush's reserved headroom).
    const { fileParts: _fileParts, ...streamOptions } = context.options as SendMessageOptions & {
      fileParts?: unknown;
    };
    // SECURITY: the flush turn is a hidden, automatically dispatched step running on a
    // transcript that may already contain injected tool output. The request builder derives
    // its memory-only tool ceiling, pinned notes path, and disabled hooks/PTC from the
    // `contextBudgetFlush` flag, independent of these send options.
    const enqueue = (text: string, dedupeKey: string, flush: boolean) =>
      this.enqueueContextBudgetContinuation({
        text,
        dedupeKey,
        options: streamOptions,
        model: step.model,
        muxMetadata: {
          ...(context.workspaceTurnMetadata ?? { type: "normal" }),
          contextBudgetContinuation: true,
          ...(flush ? { contextBudgetFlush: true as const } : {}),
        },
        goalKind: context.goalKind,
        goalId: context.goalId,
      });
    if (offerFlush) {
      assert(
        !this.messageQueue.hasDedupeKey(CONTEXT_WARNING_DEDUPE_KEY) &&
          !this.messageQueue.hasDedupeKey(CONTEXT_CONTINUE_DEDUPE_KEY),
        "flush offer requires no pending budget continuation"
      );
      this.contextBudgetFlushClaimed = true;
      // Entry 1 is the flush turn (hidden trigger text; the visible prefix carries the prompt).
      // Entry 2 is the unconditional rollover; its tool-end dispatch also bounds the flush
      // turn to a single provider step.
      enqueue("Flush context notes now.", CONTEXT_WARNING_DEDUPE_KEY, true);
      enqueue("Continue", CONTEXT_CONTINUE_DEDUPE_KEY, false);
      this.emitQueuedMessageChanged();
    } else if (this.messageQueue.isEmpty()) {
      enqueue(
        "Continue",
        decision.decision === "warn" ? CONTEXT_WARNING_DEDUPE_KEY : CONTEXT_CONTINUE_DEDUPE_KEY,
        false
      );
      this.emitQueuedMessageChanged();
    }
    return modelRequested ? "rollover" : decision.decision;
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
    // True only once the row is durably in history: callers gate marker
    // cleanup (dispatchPendingFollowUp's pendingFollowUp is the ONLY other
    // durable copy of the prompt) and goal-safety pauses on it, so a failed
    // append must report false — logging alone would let the caller delete
    // the prompt's last copy.
    let persisted = false;
    try {
      const typedMuxMetadata = options?.muxMetadata as MuxMessageMetadata | undefined;
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
          // A rejected skill invocation keeps its invocation metadata: this
          // preserved row is the ONLY transcript record of the send, and for
          // queued skills `message` is the rewritten model-facing prompt —
          // without rawCommand the user's typed "/skill args" and its badge
          // are lost. Other metadata types stay off (a compaction-request
          // stamp on a plain rejected row would confuse compaction detection).
          ...(typedMuxMetadata?.type === "agent-skill" ? { muxMetadata: typedMuxMetadata } : {}),
          // Atomic with the row (unlike the preference-file abandon marker
          // below, which a crash between the two writes can lose): startup
          // recovery must never replay a send its gate rejected.
          preStreamRejected: true,
          ...(enqueuedAtMs != null ? { enqueuedAtMs } : {}),
        },
        additionalParts.length > 0 ? additionalParts : undefined
      );
      const persistedMessage =
        rejection.type === "context_budget_blocked" || rejection.type === "context_budget_exceeded"
          ? createContextBudgetRejectedMessage(userMessage)
          : userMessage;
      const appendResult = await this.historyService.appendToHistory(
        this.workspaceId,
        persistedMessage
      );
      if (!appendResult.success) {
        log.warn("Failed to persist user message after pre-stream gate rejection", {
          workspaceId: this.workspaceId,
          error: appendResult.error,
        });
      } else {
        // Durable from this point even if the marker write below throws: the
        // row-atomic preStreamRejected stamp already gates startup recovery.
        persisted = true;
        // The preserved row is a REJECTED send, not an interrupted one:
        // without a durable abandon marker, startup recovery would treat this
        // tail user row as an interrupted request and resumeStream() it on
        // the ambient model — bypassing the very gate (class routing,
        // pricing, PDF) that rejected it.
        await this.persistStartupAutoRetryAbandon("pre_stream_rejected", persistedMessage.id);
        if (!this.coordinator.disposed) {
          this.emitChatEvent({ ...persistedMessage, type: "message" });
        }
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
    return persisted;
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
    /** The interrupted stream ran with a routed consent gate (see CompactionFollowUpRequest). */
    routedProjectConsent?: boolean;
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

    if (params.routedProjectConsent === true) {
      followUp.routedProjectConsent = true;
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
    options?: SendMessageOptions,
    routedTurn = false
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
      routedTurn,
    };
  }

  private async observeContinuousCompactionAtStreamEnd(
    model: string,
    options?: SendMessageOptions,
    routedTurn = false
  ): Promise<void> {
    // fastApply waits for this handler to reach IDLE; waiting on its latch here
    // (or re-entering it from the generated Continue send) would deadlock.
    if (
      this.midStreamCompactionPending ||
      this.continuousCompactor.isApplying() ||
      this.coordinator.editBlocked()
    )
      return;
    try {
      const context = this.getContinuousCompactionContext(model, options, routedTurn);
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
      if (result === "applied") this.clearUsageState();
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
    while (this.continuousCompactionObservation) await this.continuousCompactionObservation;
  }

  private async runContinuousCompactionObservation<T>(
    observe: (token: CompactionToken) => Promise<T>
  ): Promise<T | undefined> {
    if (this.coordinator.closing) return undefined;
    // Own the actual apply and its continuation; the compactor separately owns detached eager work.
    using _execution = this.coordinator.enterExecution();
    if (this.continuousCompactionObservation) {
      await this.continuousCompactionObservation;
      return undefined;
    }
    const token = this.coordinator.beginCompactionObservation("continuous");
    if (token == null) return undefined;
    let finish!: () => void;
    const observation = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.continuousCompactionObservation = observation;
    try {
      return await observe(token);
    } catch (error) {
      await this.recoverContinuousCompactionFailure(error, true);
      return undefined;
    } finally {
      // Reserve through dispatch and cleanup, not just the compactor's apply latch.
      // Waiters/duplicate invalidations never own or clear these flags.
      if (this.continuousCompactionObservation === observation) {
        this.coordinator.finishCompactionObservation(token);
        this.continuousCompactionObservation = null;
        try {
          this.drainQueuedMessagesIfIdle();
        } catch (error) {
          log.warn("[continuous-compaction] queued drain failed", error);
        }
      }
      finish();
    }
  }

  private async interruptForContinuousCompaction(
    apply: (pendingFollowUp?: CompactionFollowUpRequest) => Promise<boolean>
  ): Promise<boolean> {
    const context = this.activeStreamContext;
    const observation = this.coordinator.compactionIntent.observation;
    if (
      observation?.kind !== "continuous" ||
      this.midStreamCompactionPending ||
      !context?.options ||
      this.coordinator.disposed ||
      this.coordinator.closing
    ) {
      return false;
    }
    this.coordinator.setCompactionStage(observation.token, "stopping");
    const stopped = await this.streamManager.stopStream(this.workspaceId, {
      abortReason: "system",
    });
    if (!stopped.success) return false;
    this.coordinator.setCompactionStage(observation.token, "stopped");
    await this.waitForIdle();
    if (
      this.coordinator.disposed ||
      this.coordinator.closing ||
      this.continuousCompactionAbandoned ||
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
      // The continuation streams on the routed options with the folded
      // history (tail copies, post-compaction attachments): it inherits the
      // stream's consent obligation, durably — the fast-apply dispatch or a
      // post-restart recovery reads it back from the summary row.
      routedProjectConsent: context.routedConsentRejection != null,
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
    const observation = this.coordinator.compactionIntent.observation;
    if (observation?.token !== token || observation.stage !== "stopped" || !context.options) return;
    // A consumed journal is an outstanding durable obligation, not a failed
    // speculative summary. Leave it retryable instead of resetting into legacy compaction.
    if (!applied && this.continuousCompactor.hasConsumedSwap()) return;
    if (!applied) {
      const followUp = this.buildContinuousCompactionFollowUp(context);
      // The completed step can outgrow the staged tail budget during stop.
      // We already interrupted the turn, so recover using its captured context
      // rather than relying on activeStreamContext (cleared by stream-abort).
      if (
        this.continuousCompactionAbandoned ||
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
      const fallback = pressure.shouldForceCompact
        ? this.buildAutoCompactionRequest({
            baseOptions: context.options,
            followUpContent: followUp,
            reason: "mid-stream",
          })
        : undefined;
      this.continuousCompactor.reset("failed-fast-apply");
      const sent = await this.sendMessage(
        fallback?.messageText ?? followUp.text,
        fallback ? { ...fallback.sendOptions, muxMetadata: fallback.metadata } : context.options,
        {
          synthetic: true,
          agentInitiated: fallback?.agentInitiated ?? context.agentInitiated,
          goalKind: fallback ? undefined : context.goalKind,
          goalId: fallback ? undefined : context.goalId,
          admissionStale: () => this.continuousCompactionAbandoned,
          // Whether it compacts or simply continues, the replacement reads the
          // routed stream's project content (possibly on the class model): it
          // keeps verifying that stream's consent like the legacy mid-stream
          // compaction request does.
          inheritedConsentRejection: context.routedConsentRejection,
        }
      );
      if (!sent.success && !sent.failureHandled && !this.continuousCompactionAbandoned) {
        this.emitChatEvent(createStreamErrorMessage(buildStreamErrorEventData(sent.error)));
      }
      return;
    }
    this.lastUsageState = undefined;
    const summaryId = this.pendingCompactionFollowUpSummaryId;
    await this.dispatchPendingFollowUp(
      summaryId ?? undefined,
      () => this.continuousCompactionAbandoned,
      false,
      // The stream's own gate is still in hand here; the persisted
      // routedProjectConsent flag covers dispatches that are not.
      context.routedConsentRejection
    );
    if (this.pendingCompactionFollowUpSummaryId === summaryId)
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

    const interruptedUserMessageId = this.activeStreamUserMessageId;
    this.continuousCompactor.reset("legacy-fallback");

    const token = this.coordinator.beginCompactionObservation("legacy");
    if (token == null) return;
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
      if (this.coordinator.disposed) {
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
        // The post-compaction "Continue" streams on the routed options and can
        // still carry the routed turn's project content (tail copies,
        // post-compaction skill attachments): it inherits the obligation.
        routedProjectConsent: streamContext.routedConsentRejection != null,
      });
      // Waterfall hook point: see the on-send compaction.prepare run above.
      await eventSpine.run("compaction.prepare", {
        workspaceId: this.workspaceId,
        reason: "mid-stream",
      });

      const autoCompactionRequest = this.buildAutoCompactionRequest({
        followUpContent,
        // Pre-routing options when the stream was skill-routed: the compaction
        // request must never inherit a routed small model (it has to read the
        // full uncompacted history) — mirrors the on-send compaction site.
        baseOptions: streamContext.compactionBaseOptions ?? streamContext.options,
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
          // The replacement reads the routed stream's project snapshot
          // (possibly on the class model): it keeps verifying that stream's
          // consent at startup, at dispatch and per step.
          inheritedConsentRejection: streamContext.routedConsentRejection,
        }
      );
      if (!sendResult.success) {
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
            interruptedUserMessageId,
            this.extractRetryFailureMessage(sendResult.error)
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
      this.coordinator.finishCompactionObservation(token);
      // Preflight drains deferred to this pending compaction have no other retry: if the
      // compaction request never became a turn, release the queue now (no-op when it did).
      this.drainQueuedMessagesIfIdle();
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
    this.clearContextBudgetState();
    if (options?.abandonPartial || this.midStreamCompactionPending) {
      this.coordinator.abandonCompaction();
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
      return { success: false, error, failureHandled: true };
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
      await this.updateStartupAutoRetryAbandonFromFailure(
        failureType,
        failedUserMessageId,
        this.extractRetryFailureMessage(error)
      );
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
    preparation?: PreparationAttempt,
    contextBudgetRetried = false,
    requestAssemblySnapshot?: RequestAssemblySnapshot,
    admittedRequest?: PreparedStreamMessage,
    // Pre-skill-routing options for compaction requests spawned off this
    // stream (see activeStreamContext.compactionBaseOptions). Passed
    // explicitly like the thinking holder so retry paths stay unaffected.
    compactionBaseOptions?: SendMessageOptions,
    // Late consent gate for routed project-skill turns, threaded to the
    // provider-dispatch boundary inside AIService (invoked immediately
    // before the stream manager starts the provider operation, and again
    // per step). Receives whether the assembled request carries historical
    // project content. Performs rejection bookkeeping and returns the error
    // to surface; absent on unrouted internal paths (resumeStream supplies
    // its own for resumed routed turns).
    routedConsentRejection?: RoutedConsentRejection
  ): Promise<AgentSessionResult<void>> {
    const preparedRequest = admittedRequest ?? preparation?.preparedRequest;
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

    // Delayed retries belong to this admitted turn; do not lose its pinned chain on teardown.
    if (requestAssemblySnapshot) {
      // Refresh, never replace: the accepted send (or resume) seeded this
      // turn's routed consent obligation, compaction policy and refused-row
      // key into the resume state moments ago. The setter swaps the whole
      // object, so a retry after a transient failure would otherwise rebuild
      // the project-skill request with no trust gate and no row to stamp.
      // Same options object = the same turn's seed.
      const seeded =
        this.lastAutoRetryResumeRequest?.options === options
          ? this.lastAutoRetryResumeRequest
          : undefined;
      this.setAutoRetryResumeState(
        options,
        agentInitiated,
        goalKind,
        goalId,
        requestAssemblySnapshot,
        contextBudgetRetried,
        seeded?.compactionBaseOptions ?? compactionBaseOptions,
        seeded?.routedProjectConsent,
        seeded?.userMessageId
      );
    }

    const operation = this.coordinator.registerOperation(turn);
    let completionTransferred = false;
    try {
      // Reset per-stream flags (used for retries / crash-safe bookkeeping).
      this.compactionMonitor.resetForNewStream();
      this.clearLiveUsageState();
      this.pendingPostCompactionStateToAcknowledge = null;
      this.activeStreamHadAnyDelta = false;
      this.activeStreamHadPostCompactionInjection = false;
      const providersConfig = this.getProvidersConfigSafe();
      this.activeStreamContext = {
        modelString,
        contextBudgetRetried,
        requestAssemblySnapshot,
        options,
        agentInitiated,
        openaiTruncationModeOverride,
        ...(goalKind != null ? { goalKind } : {}),
        ...(goalId != null ? { goalId } : {}),
        providersConfig,
        ...(compactionBaseOptions != null ? { compactionBaseOptions } : {}),
        ...(routedConsentRejection != null ? { routedConsentRejection } : {}),
      };
      this.activeStreamUserMessageId = undefined;

      // Request-time quarantine repair: a send can race the asynchronous
      // startup recovery (getOrCreateSession exposes the session without
      // awaiting it, and a PREPARING turn makes the recovery defer), so the
      // rejected turn's row stamps and surviving partial must be repaired
      // BEFORE this request commits partials or reads history: commitPartial
      // below would otherwise promote the rejected turn's surviving in-flight
      // assistant into an unmarked history row the repair no longer finds.
      // Marker-gated — a no-op in the common case.
      await this.loadAutoRetryEnabledPreference();
      if (
        this.corruptRejectedTurnRecord !== null &&
        !(await this.recoverFromCorruptRejectedTurnRecord())
      ) {
        // FAIL CLOSED: which earlier turns a refusal still protects is unknown
        // (see corruptRejectedTurnRecord) and the reconstruction could not be
        // made durable, so no request leaves.
        return await fail(
          createUnknownSendMessageError(
            rejectedTurnRecordCorruptMessage(this.getAutoRetryPreferencePath())
          )
        );
      }
      const repair = await this.repairUnstampedRejectedTurn();
      if (isStreamStartAborted()) {
        return Ok(undefined);
      }
      if (!repair.partialSecured) {
        // A rejected partial that could not be deleted (or a pass that could not
        // read history to tell whose partial survives): committing below would
        // promote it into an unmarked assistant row a later repair no longer
        // finds, leaving it protected only by process memory. Refuse this
        // request instead; the record keeps every key, and the next attempt
        // re-runs the repair. Outstanding ROW stamps alone do not refuse: the
        // in-memory quarantine filters those rows from this request.
        return await fail(createUnknownSendMessageError(REJECTED_TURN_REPAIR_PENDING_MESSAGE));
      }
      if (
        this.outstandingRejectedTurnKeys().length > 0 &&
        this.autoRetryStateUnrecorded &&
        !(await this.recordPendingAutoRetryState())
      ) {
        // Outstanding keys that exist only in memory: the repair record write
        // failed (again). Until it lands, a crash would leave the refused rows
        // provider-eligible, so no request leaves either.
        return await fail(createUnknownSendMessageError(REJECTED_TURN_REPAIR_PENDING_MESSAGE));
      }

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
      // Fresh candidates already fix the admitted rows; detect later edits on the next request.
      const fileChangeDetection = preparedRequest
        ? { attachments: [], commit: () => undefined }
        : await this.fileChangeTracker.getChangedAttachments();
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

      const lastUserMessage = this.findLastRetryUserMessage(historyResult.data);
      if (lastUserMessage?.metadata?.contextBudgetRejected) {
        this.activeStreamUserMessageId = lastUserMessage.id;
        return await fail({
          type: "context_budget_blocked",
          message: "Cannot retry a rejected request. Edit it or send a new message instead.",
        });
      }

      let resumedFlushCannotWrite = false;
      // A resumed flush runs the middleware chain admitted for its promised reset (see
      // prepareContextBudgetSend), never the live registry.
      let resumedFlushSnapshot: RequestAssemblySnapshot | undefined;
      if (this.isTokenBudgetActive(options)) {
        this.contextBudgetWarningClaimed ||= historyResult.data.some(
          (row) => row.metadata?.muxMetadata?.type === "context-budget-warning"
        );
        // A resumed final-flush turn must not offer a second flush in the same window.
        this.contextBudgetFlushClaimed ||= historyResult.data.some(
          (row) =>
            row.metadata?.muxMetadata?.type === "context-budget-warning" &&
            row.metadata.muxMetadata.final === true
        );
        // Resuming a persisted flush turn must also restore its sealing intent: the durable
        // final warning promised that the next message starts fresh, so re-queue the rollover
        // continuation and keep the pending claim even if the resumed step no longer crosses
        // the threshold (e.g. a larger model was selected).
        const finalRow = historyResult.data.findLast(
          (row) =>
            row.metadata?.muxMetadata?.type === "context-budget-warning" &&
            row.metadata.muxMetadata.final === true
        )?.metadata?.muxMetadata;
        const flushMuxMetadata = lastUserMessage?.metadata?.muxMetadata;
        if (
          options &&
          flushMuxMetadata?.contextBudgetFlush === true &&
          finalRow?.type === "context-budget-warning" &&
          this.pendingRollover == null &&
          this.compactionMonitor.getThreshold() < 1
        ) {
          // The promised reset needs the same admission as any rollover; surface a failure
          // now (as the reset itself would) instead of resuming a flush that cannot be sealed.
          const access = await this.checkContextBudgetHistoryAccess(options);
          if (isStreamStartAborted()) return Ok(undefined);
          if (!access.success) return await fail(access.error);
          const captured = await this.captureRolloverRequestAssembly();
          if (isStreamStartAborted()) return Ok(undefined);
          if (!captured.success) return await fail(captured.error);
          this.pendingRolloverSnapshot = captured.data;
          resumedFlushSnapshot = captured.data;
          // The promised notes write needs a writable memory tool under the *current* options
          // and agent; when it is gone, degrade the resumed flush to a tool-less step so the
          // queued rollover still seals the window instead of running an unwritable flush.
          const resolvedAgent = await this.resolveAgentForBudgetChecks(options);
          if (isStreamStartAborted()) return Ok(undefined);
          const memoryEnabled =
            options.experiments?.memory ??
            this.aiService.isExperimentEnabled(EXPERIMENT_IDS.MEMORY);
          resumedFlushCannotWrite =
            !memoryEnabled ||
            !resolvedAgent.success ||
            applyToolPolicyToNames(["memory"], resolvedAgent.data.effectiveToolPolicy).length ===
              0 ||
            resolveMemoryAccessPolicy({
              planLike: resolvedAgent.data.agentIsPlanLike,
              editingCapable: isExecLikeEditingCapableInResolvedChain(
                resolvedAgent.data.agentInheritanceChain
              ),
            }).workspace !== "readwrite";
          this.pendingRollover = {
            type: "context-window-rollover",
            rolloverId: randomUUID(),
            reason: "mid-stream",
            previousWindowId: currentContextWindowId(historyResult.data),
            flushOpportunity: true,
            contextTokens: finalRow.contextTokens,
            maxTokens: finalRow.maxTokens,
            // Legacy final warnings reported the full model limit.
            budgetTokens: finalRow.budgetTokens ?? finalRow.maxTokens,
          };
          if (this.messageQueue.isEmpty()) {
            const { contextBudgetFlush: _flush, ...continuationMetadata } = flushMuxMetadata;
            this.enqueueContextBudgetContinuation({
              text: "Continue",
              dedupeKey: CONTEXT_CONTINUE_DEDUPE_KEY,
              options,
              model: modelString,
              muxMetadata: continuationMetadata,
              goalKind,
              goalId,
            });
            this.emitQueuedMessageChanged();
          }
        }
      } else if (lastUserMessage?.metadata?.muxMetadata?.contextBudgetFlush === true) {
        // Token-budget mode is inactive but the persisted trigger still makes this a hidden
        // memory-only turn: pin a toolset-preserving middleware chain for it too, or run it
        // without tools when none can be pinned (the turn then only ends).
        const captured = await this.captureRolloverRequestAssembly();
        if (isStreamStartAborted()) return Ok(undefined);
        if (captured.success) resumedFlushSnapshot = captured.data;
        else resumedFlushCannotWrite = true;
      }

      // A crash between snapshot and user-row appends can leave orphaned prompt
      // expansions on disk; exclude them from every provider request.
      // Rows preserved by pre-stream gate rejections stay visible in the
      // transcript but never reach the provider — replaying them would
      // duplicate the prompt after a retry (or re-fail on an incompatible PDF
      // forever).
      let requestMessages = this.excludeRejectedRows(
        filterOrphanedMcpPromptSnapshots(historyResult.data)
      );

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
          requestMessages = this.excludeRejectedRows(
            filterOrphanedMcpPromptSnapshots(refreshed.data)
          );
        }
      }

      // Capture the current user message id so retries are stable across assistant message ids.
      // Retry-eligible rows only: startup recovery matches this persisted ID
      // against shouldUseUserMessageForRetry candidates, so selecting an
      // invisible synthetic row (file-update notification, [CONTINUE] sentinel,
      // snapshot) would persist non-retryable failures against a row recovery
      // never selects and break the tail match after restart.
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
      let postCompactionAttachments =
        disablePostCompactionAttachments === true || preparedRequest != null
          ? null
          : await this.getPostCompactionAttachmentsIfNeeded(this.isRlmCompactionEnabled(options));
      if (isStreamStartAborted()) {
        return Ok(undefined);
      }

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
      const streamMuxMetadata = resolveStreamMuxMetadata(
        optionsMuxMetadata,
        lastUserMessage?.metadata?.muxMetadata,
        requestMessages
      );
      // A final-flush trigger (fresh dispatch or resumed after restart) keeps its flag so the
      // request builder applies the memory-only ceiling regardless of the caller's current send
      // options; the flag is request-local and never becomes the workspace-turn correlation.
      const contextBudgetFlushTurn =
        lastUserMessage?.metadata?.muxMetadata?.contextBudgetFlush === true;
      // The flush is one mechanical memory call: lowest thinking the model allows (the user's
      // configured floor is for real work) and a bounded cap sized for that level, so an
      // inherited medium/high level cannot make the only preservation step fail or overrun.
      const flushThinking = contextBudgetFlushTurn
        ? resolveContextBudgetFlushThinking(modelString, providersConfig)
        : undefined;
      // The flush turn is bounded to one provider step. If a crash left that step's completed
      // memory call on disk (committed above), the resumed request gets no tools at all so the
      // turn can only end, after which the queued rollover seals the window.
      const flushAlreadyStepped =
        contextBudgetFlushTurn &&
        lastUserMessage != null &&
        historyResult.data.slice(historyResult.data.indexOf(lastUserMessage) + 1).some(
          (row) =>
            row.role === "assistant" &&
            // An empty placeholder is appended before streaming; only a settled tool call
            // proves the single flush step actually happened.
            row.parts.some(
              (part) => part.type === "dynamic-tool" && part.state === "output-available"
            )
        );
      // Mid-stream compaction runs after the original send options have already been resolved against
      // history (notably bash-monitor wakes). Persist the actual correlation used by this stream so the
      // post-compaction continuation remains the same delegated workspace turn.
      if (this.activeStreamContext != null) {
        this.activeStreamContext.workspaceTurnMetadata = streamMuxMetadata;
        this.activeStreamContext.contextBudgetFlushTurn = contextBudgetFlushTurn;
      }
      const acpPromptId =
        normalizeAcpPromptId(options?.acpPromptId) ?? extractAcpPromptId(optionsMuxMetadata);
      const delegatedToolNames =
        normalizeDelegatedToolNames(options?.delegatedToolNames) ??
        extractAcpDelegatedTools(optionsMuxMetadata);

      // Provider-boundary consent gate, deferred INTO AIService (invoked
      // immediately before streamManager.startStream — runtime init, model
      // creation, and request building are all revocation windows). Bound here
      // because only this scope can scan the assembled request for
      // project-scope snapshots persisted by EARLIER turns: an untrusted
      // workspace's history can carry one even when the current routed
      // invocation is global. The gate performs the rejection bookkeeping; the
      // caller converts the Err into an accepted pre-stream failure.
      let preDispatchConsentGate: StreamMessageOptions["preDispatchConsentGate"];
      // Third channel, resolved later inside AIService: the memory context
      // (index + preloaded files). Excluded without trust, gate-arming with it.
      const memoryConsent = await this.createRoutedMemoryConsent(routedConsentRejection);
      if (routedConsentRejection) {
        // Every channel repository-controlled project skill content takes into
        // a request: synthetic snapshot rows AND agent_skill_read results — a
        // project skill the model read through the tool in an earlier turn
        // persists inside an assistant tool-result row, not in row metadata.
        let requestCarriesProjectContent = messagesCarryProjectSkillContent(requestMessages);
        // Post-compaction loaded-skill attachments carry the same repository-
        // controlled content by a different channel: once the original snapshot
        // row sits behind the boundary, the history scan above no longer sees
        // it, but the attachment still ships the project skill's body.
        let attachmentsCarryProjectSkills = carriesProjectLoadedSkills(postCompactionAttachments);
        if (
          (requestCarriesProjectContent || attachmentsCarryProjectSkills) &&
          memoryConsent?.excludeProjectSkillContent === true
        ) {
          // Historical project content in an UNTRUSTED workspace: exclude it
          // from the routed request (least privilege, mirroring the
          // fresh-snapshot omission) instead of rejecting the turn — global
          // and built-in skills are allowed to route in untrusted projects,
          // and rejecting on rows the rejection cannot remove would fail every
          // later routed send deterministically. Snapshot rows drop out; tool
          // results are redacted in place so the call/result pairing survives.
          requestMessages = withholdProjectSkillContentFromRequest(requestMessages);
          postCompactionAttachments = excludeProjectLoadedSkills(postCompactionAttachments);
          log.warn("Excluding historical project skill content from routed request", {
            workspaceId: this.workspaceId,
          });
          requestCarriesProjectContent = false;
          attachmentsCarryProjectSkills = false;
        }
        // Bound at assembly: content kept under trust arms the gate so a
        // revocation BETWEEN this assembly and any step's provider call still
        // rejects. Re-scanned per step: a project skill the model reads
        // through agent_skill_read DURING this stream enters the next step's
        // messages without ever passing the scan above.
        const carriesForGate = requestCarriesProjectContent || attachmentsCarryProjectSkills;
        preDispatchConsentGate = (context) =>
          routedConsentRejection(
            carriesForGate ||
              memoryConsent?.carriesProjectSkillContent === true ||
              gateContextCarriesProjectSkillContent(context),
            context?.midStream === true
          );
      }
      // Memory files this turn writes inherit the request's provenance (the
      // model can copy project content into them); an untrusted routed
      // request already withheld it above, so this scans the FINAL rows.
      const memoryWritesCarryProjectSkillContent =
        messagesCarryProjectSkillContent(requestMessages) ||
        carriesProjectLoadedSkills(postCompactionAttachments);

      this.activeStreamHadPostCompactionInjection =
        postCompactionAttachments !== null && postCompactionAttachments.length > 0;

      // Fatal pre-start failures (runtime readiness, strict agent resolution)
      // emit an error event for fire-and-forget senders and then return Err;
      // collect them so the Err path resolves each exactly once.
      const preStartErrors: StreamErrorPayload[] = [];
      this.coordinator.configureOperation(operation, this.activeCompactionRequest != null);
      const startRequest = preparedRequest
        ? preparedRequest.start.bind(preparedRequest)
        : this.aiService.streamMessage.bind(this.aiService);
      const streamResult = await startRequest({
        messages: requestMessages,
        preDispatchConsentGate,
        workspaceId: this.workspaceId,
        modelString,
        abortSignal,
        thinkingLevel: flushThinking?.level ?? effectiveThinkingLevel,
        // Orthogonal to thinking level; buildRequestHeaders gates it per model.
        reasoningMode: options?.reasoningMode,
        toolPolicy:
          flushAlreadyStepped || resumedFlushCannotWrite
            ? [...(options?.toolPolicy ?? []), { regex_match: ".*", action: "disable" }]
            : options?.toolPolicy,
        additionalSystemContext: options?.additionalSystemContext,
        additionalSystemInstructions: options?.additionalSystemInstructions,
        // The flush step gets its own bounded cap: a terse caller cap could cut the notes payload
        // short and waste the single step, while an unbounded one would let transcript-influenced
        // text run to a model-sized reply. The paired continuation keeps the caller's cap.
        maxOutputTokens: flushThinking?.maxOutputTokens ?? options?.maxOutputTokens,
        muxProviderOptions: options?.providerOptions,
        agentInitiated,
        agentId: options?.agentId,
        acpPromptId,
        delegatedToolNames,
        muxMetadata: contextBudgetFlushTurn
          ? { ...(streamMuxMetadata ?? { type: "normal" }), contextBudgetFlush: true }
          : streamMuxMetadata,
        recordFileState,
        postCompactionAttachments,
        // Invoked by AIService after runtime.ensureReady() (project-scope
        // listing needs a running runtime). Still ordered after the
        // post-compaction check above: a just-consumed compaction boundary has
        // already reset the segment cache, so this stream recomputes the context.
        resolveMemoryContext: async (forModelString, memoryOptions) => {
          const memoryContext = await this.resolveMemoryContext(forModelString, {
            ...memoryOptions,
            tokenBudgetActive: this.isTokenBudgetActive(options),
            excludeProjectSkillContent: memoryConsent?.excludeProjectSkillContent === true,
          });
          if (memoryConsent && memoryContext?.carriesProjectSkillContent === true) {
            memoryConsent.carriesProjectSkillContent = true;
          }
          return memoryContext;
        },
        memoryWritesCarryProjectSkillContent,
        allowAgentSetGoal: options?.allowAgentSetGoal === true,
        workspaceGoalService: this.workspaceGoalService,
        experiments: options?.experiments,
        disableWorkspaceAgents: options?.disableWorkspaceAgents,
        strictAgentResolution: options?.strictAgentResolution,
        hasQueuedMessages: this.hasQueuedMessages.bind(this),
        getQueuedInputStopCause: this.getQueuedInputStopCause.bind(this),
        contextBudgetRolloverAvailable:
          this.isTokenBudgetActive(options) && this.compactionMonitor.getThreshold() < 1,
        requestAssemblySnapshot: requestAssemblySnapshot ?? resumedFlushSnapshot,
        // A flush turn stays bounded to one step even when token-budget mode was disabled
        // after its trigger was persisted (the callback then only stops it).
        onStepSettled:
          this.isTokenBudgetActive(options) || contextBudgetFlushTurn
            ? (step) => this.onContextBudgetStepSettled(step)
            : undefined,
        openaiTruncationModeOverride,
        // Mid-turn thinking overrides clamp against the same floor as the
        // send-time level above (single source of truth for the floor).
        minThinkingLevel,
        // A mid-turn thinking raise must not push the flush's budget past its bounded cap.
        activeTurnThinkingOverride: contextBudgetFlushTurn ? undefined : activeTurnThinkingOverride,
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
          return { success: false, error: streamResult.error, failureHandled: true };
        }
        if (
          streamResult.error.type === "context_budget_exceeded" &&
          this.isTokenBudgetActive(options)
        ) {
          const rolled = await this.rolloverAfterBudgetFailure(
            streamResult.error.model,
            streamResult.error.estimate,
            preparation?.editReservation
          );
          await using _rolloverRequest = rolled.success ? rolled.data?.request : undefined;
          if (
            !this.coordinator.isCurrentTurn(turn) ||
            !this.coordinator.isCurrentOperation(operation)
          ) {
            for (const payload of preStartErrors) {
              this.coordinator.resolveErrorDecision(payload.messageId, "terminal");
            }
            return { success: false, error: streamResult.error, failureHandled: true };
          }
          if (rolled.success && rolled.data) {
            return await this.streamWithHistory(
              turn,
              streamResult.error.model,
              rolled.data.options ?? options,
              openaiTruncationModeOverride,
              true,
              agentInitiated,
              abortSignal,
              goalKind,
              goalId,
              activeTurnThinkingOverride,
              preparation,
              true,
              rolled.data.snapshot,
              rolled.data.request,
              compactionBaseOptions,
              routedConsentRejection
            );
          }
          // This row passed send-time admission but never fit the final request.
          // Keep it visible without poisoning subsequent sends (including after restart).
          const rejected = await this.rejectActiveContextBudgetRequest();
          if (
            !this.coordinator.isCurrentTurn(turn) ||
            !this.coordinator.isCurrentOperation(operation)
          ) {
            for (const payload of preStartErrors) {
              this.coordinator.resolveErrorDecision(payload.messageId, "terminal");
            }
            return { success: false, error: streamResult.error, failureHandled: true };
          }
          if (!rejected.success) return await fail(rejected.error, acpPromptId);
          if (!rolled.success) return await fail(rolled.error, acpPromptId);
          return await fail(
            {
              type: "context_budget_blocked",
              message: `The assembled request exceeds the safe context budget for ${streamResult.error.model}. Shorten the message, remove attachments, use /compact, or choose a larger model.`,
            },
            acpPromptId
          );
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
    // The routed turn's consent gate and row key too: this retry recreates the
    // stream outside StreamManager's gate-preserving recreations, and a later
    // auto-retry of the retry resumes through resumeStream.
    const retryConsentRejection = this.activeStreamContext?.routedConsentRejection;
    const retryUserMessageId = this.activeStreamUserMessageId;
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
      retryGoalId,
      undefined,
      undefined,
      undefined,
      retryConsentRejection != null,
      retryUserMessageId
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
        retryGoalId,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        retryConsentRejection
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

  private async maybeRetryWithoutPostCompactionOnContextExceeded(
    data: { messageId: string; errorType?: string },
    pendingState = this.pendingPostCompactionStateToAcknowledge
  ): Promise<boolean> {
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
    if (this.postCompactionState === pendingState) {
      this.postCompactionLoadedSkills = [];
      this.postCompactionReadFilePaths = [];
      this.postCompactionState = null;
    }
    try {
      await this.compactionHandler.discardPendingState("context_exceeded", pendingState);
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
        context.goalId,
        undefined,
        undefined,
        context.contextBudgetRetried,
        context.requestAssemblySnapshot,
        undefined,
        // A routed turn's retry keeps its routed compaction policy AND its
        // consent gate: the rebuilt history still carries the project-skill
        // snapshot, and trust may have been revoked since the failed attempt.
        context.compactionBaseOptions,
        context.routedConsentRejection
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
    // Housekeeping flush turns are excluded from goal accounting (see
    // recordGoalAccountingFromUsage); their usage must not leak into the live preview either.
    if (this.activeStreamContext?.contextBudgetFlushTurn === true) {
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
    // The context-budget final flush is housekeeping, like compaction: it must not consume a
    // goal turn or charge the goal's cost cap. Its row keeps the goal attribution on purpose,
    // because a restart re-derives the paired continuation's goalKind/goalId from that row.
    if (this.activeStreamContext?.contextBudgetFlushTurn === true) {
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
    this.pendingPostCompactionStateToAcknowledge = null;
  }

  private async handleStreamError(
    data: StreamErrorPayload,
    operation = this.coordinator.operationId
  ): Promise<void> {
    const turn = this.coordinator.turnId;
    const pendingStateToDiscard = this.pendingPostCompactionStateToAcknowledge;
    this.coordinator.beginPolicy(turn);
    if (!this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation))
      return;

    this.queuedProviderToolEndAbortInFlight = false;
    this.clearLiveUsageState();
    const hadCompactionRequest = this.activeCompactionRequest !== undefined;
    const context = this.activeStreamContext;
    const budgetFailure =
      context &&
      !hadCompactionRequest &&
      this.isTokenBudgetActive(context.options) &&
      ((data.errorType === "context_exceeded" && !this.activeStreamHadAnyDelta) ||
        data.contextBudgetExceeded != null);
    const rejectBudgetRequest = budgetFailure && !this.activeStreamHadAnyDelta;
    if (budgetFailure) {
      const model = data.contextBudgetExceeded?.model ?? context.modelString;
      const rolled = await this.rolloverAfterBudgetFailure(
        model,
        data.contextBudgetExceeded?.estimate
      );
      await using _rolloverRequest = rolled.success ? rolled.data?.request : undefined;
      if (
        !this.coordinator.isCurrentTurn(turn) ||
        !this.coordinator.isCurrentOperation(operation)
      ) {
        this.coordinator.resolveErrorDecision(data.messageId, "terminal");
        return;
      }
      if (rolled.success && rolled.data) {
        let claimedTurn: TurnId | undefined;
        using _preparation = {
          [Symbol.dispose]: () => {
            if (claimedTurn != null) this.coordinator.finishPreparation(claimedTurn);
          },
        };
        const admission = this.coordinator.prepare(
          { kind: "fresh", intent: "handoff", expectedTurnId: turn },
          undefined,
          (turnId) => {
            claimedTurn = turnId;
            this.preparingWorkspaceTurnMetadata = getWorkspaceTurnMuxMetadata(
              context.options?.muxMetadata
            );
          }
        );
        if (admission.status !== "admitted") {
          this.coordinator.resolveErrorDecision(data.messageId, "terminal");
          return;
        }
        const preparedTurn = admission.turnId;
        let retry: Result<void, SendMessageError>;
        try {
          retry = await this.streamWithHistory(
            preparedTurn,
            model,
            rolled.data.options ?? context.options,
            context.openaiTruncationModeOverride,
            true,
            context.agentInitiated,
            undefined,
            context.goalKind,
            context.goalId,
            undefined,
            undefined,
            true,
            rolled.data.snapshot,
            rolled.data.request,
            context.compactionBaseOptions,
            context.routedConsentRejection
          );
        } finally {
          if (this.coordinator.isCurrentTurn(preparedTurn)) {
            this.coordinator.finishPreparation(preparedTurn);
          }
        }
        this.coordinator.resolveErrorDecision(
          data.messageId,
          retry.success ? "retry-started" : "terminal"
        );
        return;
      }
      if (!rolled.success)
        data = { ...data, ...buildStreamErrorEventData(rolled.error), messageId: data.messageId };
    }
    if (
      await this.maybeRetryCompactionOnContextExceeded({
        messageId: data.messageId,
        errorType: data.errorType,
      })
    ) {
      return; // retry set PREPARING
    }

    if (!this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation))
      return;

    if (
      await this.maybeRetryWithoutPostCompactionOnContextExceeded(
        { messageId: data.messageId, errorType: data.errorType },
        pendingStateToDiscard
      )
    ) {
      return; // retry set PREPARING
    }

    if (!this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation))
      return;

    // Provider overflow arrives asynchronously, but must exclude the same
    // undelivered request payloads as preflight rejection. Preserve started turns.
    if (rejectBudgetRequest) {
      const rejected = await this.rejectActiveContextBudgetRequest();
      if (
        !this.coordinator.isCurrentTurn(turn) ||
        !this.coordinator.isCurrentOperation(operation)
      ) {
        this.coordinator.resolveErrorDecision(data.messageId, "terminal");
        return;
      }
      if (!rejected.success)
        data = { ...data, ...buildStreamErrorEventData(rejected.error), messageId: data.messageId };
    }

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

    // A mid-turn consent rejection (per-step gate) leaves the turn's
    // in-flight assistant parts in partial.json — persisted by the stream
    // error path BEFORE this handler runs. The next send would commit them
    // as an orphaned assistant row that the user-row rejection filter cannot
    // remove (and that can break tool/message ordering). Delete them with
    // the rejected turn; if the delete fails, quarantine the would-be
    // committed row id.
    if (typeof data.error === "string" && data.error.includes(ROUTED_SKILL_TRUST_REVOKED_MESSAGE)) {
      try {
        const rejectedPartial = await this.historyService.readPartial(this.workspaceId);
        const deleteResult = await this.historyService.deletePartial(this.workspaceId);
        if (!deleteResult.success && rejectedPartial?.id != null) {
          this.unstampedRejectedRowIds.add(rejectedPartial.id);
          // Durable record for the repair the next request build (or
          // startup) must finish; the in-memory quarantine alone dies with
          // the process. Keyed by the turn's row: the repair ties a
          // surviving partial to its turn through that key.
          if (failedUserMessageId != null) {
            await this.addPendingRejectedTurnRepairKey(failedUserMessageId);
          }
        }
      } catch (error) {
        log.warn("Failed to remove in-flight assistant after consent rejection", {
          workspaceId: this.workspaceId,
          error: getErrorMessage(error),
        });
      }
    }

    await this.handleStreamFailureForAutoRetry({
      type: failureType,
      message: data.error,
    });
    if (!this.coordinator.isCurrentTurn(turn) || !this.coordinator.isCurrentOperation(operation))
      return;
    await this.updateStartupAutoRetryAbandonFromFailure(
      failureType,
      failedUserMessageId,
      data.error
    );
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
      // A configured fallback can bill a different model than the requested one.
      const activeModelForAbort = payload.metadata?.model ?? this.activeStreamContext?.modelString;
      const activeOptionsForAbort = this.activeStreamContext?.options;
      const activeRoutedForAbort = this.activeStreamContext?.compactionBaseOptions != null;
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
        this.clearContextBudgetState();
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
          metadataModel: payload.metadata?.metadataModel,
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
          activeOptionsForAbort,
          activeRoutedForAbort
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
    const pendingStateToAcknowledge = this.pendingPostCompactionStateToAcknowledge;
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
    const activeStreamRouted = this.activeStreamContext?.compactionBaseOptions != null;
    // A final-flush turn is housekeeping, not the goal's work: its text-only finish must never
    // count as an implicit complete_goal.
    const activeStreamWasContextBudgetFlush =
      this.activeStreamContext?.contextBudgetFlushTurn === true;

    let goalContinuationRequest: {
      sendOptions: SendMessageOptions;
      streamEndedAtMs: number;
    } | null = null;
    let emittedStreamEnd = false;
    const completedCompactionRequest = this.activeCompactionRequest;
    let continuedAfterCompaction = false;

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

        if (pendingStateToAcknowledge) {
          if (this.pendingPostCompactionStateToAcknowledge === pendingStateToAcknowledge)
            this.pendingPostCompactionStateToAcknowledge = null;
          try {
            await this.compactionHandler.ackPendingStateConsumed(pendingStateToAcknowledge);
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
          activeStreamOptions,
          activeStreamRouted
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
      if (this.coordinator.editBlocked() || continuousApplyPending) {
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
        !this.coordinator.editBlocked() &&
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
          if (
            activeStreamGoalKind === GOAL_CONTINUATION_KIND &&
            !activeStreamWasContextBudgetFlush
          ) {
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
        // Includes nested PTC calls and directory/rename mutations that affect notes.
        // Reads can also change hot-set ranking; rebuild at the next request, not mid-step.
        if (
          payload.toolName === "memory" &&
          typeof payload.result === "object" &&
          payload.result != null &&
          "success" in payload.result &&
          payload.result.success === true
        ) {
          this.memoryContextByModelString.clear();
        }
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
            ...this.getContinuousCompactionContext(
              context.modelString,
              context.options,
              context.compactionBaseOptions != null
            ),
            phase: "mid-stream",
          });
          // The observation's finally settles the pending window only after this dispatches the
          // continuation; settling earlier would let an idle waiter race the follow-up send.
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
        this.continuousCompactionObserving ||
        this.isTokenBudgetActive(this.activeStreamContext?.options)
      ) {
        return;
      }

      const streamContext = this.activeStreamContext;
      const streamOptions = streamContext?.options;
      if (streamContext?.modelString !== modelForUsage) return;
      const continuousContext = this.getContinuousCompactionContext(
        modelForUsage,
        streamOptions,
        streamContext?.compactionBaseOptions != null
      );
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
          if (result === "applied") this.clearUsageState();
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
        // A routed turn (compactionBaseOptions set) uses the routed-send
        // policy mid-stream too: the ordinary threshold+buffer against the
        // (usually smaller) routed window would immediately force the exact
        // workspace-wide compaction the pre-send band declined to run.
        ...(streamContext?.compactionBaseOptions != null
          ? { forceThresholdPercentOverride: 100 - ROUTED_SEND_COMPACTION_HEADROOM_PERCENT }
          : {}),
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
   * Resolves once no mid-stream compaction request is pending. The window closes with no
   * chat event when the compaction request never becomes a turn, so idle waiters need this
   * signal rather than the stream lifecycle.
   */
  waitForMidStreamCompactionSettled(): Promise<void> {
    return this.coordinator.waitForMidStreamCompactionSettled();
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
    this.clearContextBudgetState();
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
    this.continuousCompactor.reset("context-mutation");
    return this.coordinator.reserve("admission");
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

  getQueuedInputStopCause(): QueuedInputStopCause | undefined {
    const candidate = this.messageQueue.getNextQueueCutCandidate();
    if (candidate?.dispatchMode !== "tool-end") return undefined;
    return {
      kind: "queued-input",
      entryId: candidate.entryId,
      // Monitor wakes acquire this execution correlation when they dispatch.
      muxMetadata: structuredClone(
        this.messageQueue.isNextEntryBashMonitorWake()
          ? (this.activeStreamContext?.workspaceTurnMetadata ?? candidate.muxMetadata)
          : candidate.muxMetadata
      ),
    };
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

  /**
   * Correlation of the delegated workspace turn whose PREPARING send has already handed its
   * startup to the engine, the only PREPARING state stopStream() cancels: earlier PREPARING
   * work (history acceptance, request preparation) has no pending stream start, so a stop
   * there only notifies and the turn still streams. Undefined for user sends and every other
   * phase. The interrupt_active archive gates use this to tell an interruptible delegated
   * turn from user input that merely looks like a queued message.
   */
  getStoppablePreparingWorkspaceTurn(): WorkspaceTurnTaskCorrelation | undefined {
    const preparing = this.preparingWorkspaceTurnMetadata;
    if (
      preparing == null ||
      this.coordinator.phase !== "preparing" ||
      !this.coordinator.startupRegistered
    ) {
      return undefined;
    }
    return {
      taskHandleId: preparing.taskHandleId,
      ownerWorkspaceId: preparing.ownerWorkspaceId,
      turnId: preparing.turnId,
    };
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
      abortReason !== "user" && !this.coordinator.editBlocked() && !this.messageQueue.isEmpty();
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
    if (this.hasActiveOrPendingTurnWork() || this.messageQueue.isEmpty()) {
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
      this.coordinator.editBlocked() ||
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
      }).then(async (result) => {
        // Busy-queued SKILL sends suppressed the renderer's messageSent
        // (routing unknown at queue time): attribute at dispatch, routed or
        // unbound. A compaction-DEFERRED dispatch ({ queued: true }) has not
        // streamed the skill — dispatchPendingFollowUp owns its attribution —
        // and an accepted pre-stream refusal never streamed at all; capturing
        // either here would double-count or attribute a request that never
        // happened.
        if (
          result.success &&
          result.data?.queued !== true &&
          result.data?.acceptedWithoutStream !== true &&
          (options?.muxMetadata as MuxMessageMetadata | undefined)?.type === "agent-skill"
        ) {
          const dispatchModel = result.data?.routedModel ?? options?.model;
          if (dispatchModel != null) {
            await this.captureBackendMessageSent({
              model: dispatchModel,
              agentId: options?.agentId,
              messageLength: message.length,
              thinkingLevel: result.data?.routedThinkingLevel ?? options?.thinkingLevel,
            });
          }
        }
        return result;
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
    cancelResume?: () => boolean,
    startStreamInBackground = false,
    // The interrupted stream's own gate when the dispatch happens in-session
    // with it still in hand (continuous fast-apply). The persisted
    // routedProjectConsent flag reconstructs one otherwise (stream end after a
    // legacy compaction, startup recovery), so the continuation re-verifies
    // Project Trust either way.
    inheritedConsentRejection?: RoutedConsentRejection
  ): Promise<boolean> {
    if (this.coordinator.disposed || this.coordinator.closing) {
      return false;
    }
    using _execution = this.coordinator.enterExecution();

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

    // A user can abandon after the boundary commits but before its continuation
    // dispatches. Keep the fold, but remove the crash-recoverable resume intent.
    if (cancelResume?.()) {
      await this.clearPendingFollowUpFromSummary(lastMessage);
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
      await this.clearPendingFollowUpFromSummary(lastMessage);
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
      await this.clearPendingFollowUpFromSummary(lastMessage);
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
        hasActiveNonCompletingTurn
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
        await this.clearPendingFollowUpFromSummary(lastMessage);
        return false;
      }
      goalAdmissionStale = admission.admissionStale;
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
    const followUpAdmissionStale =
      idleRuleStale != null || goalAdmissionStale != null || cancelResume != null
        ? () =>
            idleRuleStale?.() === true ||
            goalAdmissionStale?.() === true ||
            cancelResume?.() === true
        : undefined;

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
      // An explicit one-shot carried through compaction keeps bypassing class routing.
      skipSkillModelRouting: followUp.skipSkillModelRouting,
      // A raw numeric thinking index re-resolves against the routed model if
      // this re-dispatched send gets class-routed.
      oneShotThinkingIndex: followUp.oneShotThinkingIndex,
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
      await this.clearPendingFollowUpFromSummary(lastMessage);
      return false;
    }

    // The compaction summary is now the source of truth for the next live resume
    // request. Pre-arm retry state from the reconstructed follow-up so failures
    // before stream startup do not fall back to the already-completed compact turn.
    // A routed stream's continuation streams on the routed options and may
    // carry the project snapshot (tail copies) or post-compaction project-skill
    // attachments: it inherits the consent obligation like the compaction
    // request that replaced the stream did — and seeds it into the pre-armed
    // retry state so a pre-stream failure's resume re-verifies trust too.
    const followUpConsentRejection =
      inheritedConsentRejection ??
      (followUp.routedProjectConsent === true
        ? this.createDurableFollowUpConsentGate()
        : undefined);
    this.setAutoRetryResumeState(
      options,
      followUp.agentInitiated,
      persistedGoalKind,
      persistedGoalId,
      undefined,
      undefined,
      undefined,
      followUpConsentRejection != null
    );

    // Startup waits for durable acceptance, not provider completion. Other callers still await fully.
    // Either way, the follow-up message is written to history
    // before sendQueuedMessages() runs, preventing race conditions.
    // Mark as synthetic so recovery/background dispatches do not implicitly
    // re-enable auto-retry after a user explicitly opted out.
    // Acceptance boundary marker for the failure branch below: once the
    // session accepted the send, the user row is durable and emitted — any
    // later startup failure must not re-preserve (duplicate) it.
    let followUpAccepted = false;
    const sendResult = await this.sendMessage(finalText, options, {
      startStreamInBackground,
      synthetic: true,
      onAccepted: () => {
        followUpAccepted = true;
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
      inheritedConsentRejection: followUpConsentRejection,
    });
    if (!sendResult.success) {
      if (cancelResume?.()) {
        await this.clearPendingFollowUpFromSummary(lastMessage);
        return false;
      }
      // A stale-admission refusal is the idle rule (or a goal transition)
      // working as intended, not a recovery failure: route it through the
      // same skip path as the pre-send check instead of throwing.
      if (followUpAdmissionStale?.() === true) {
        log.info("Pending follow-up refused at send admission; skipping it", {
          workspaceId: this.workspaceId,
          summaryMessageId: lastMessage.id,
        });
        await this.skipIdleRuleFollowUp(
          lastMessage,
          this.hasPendingManualFollowUp() || this.hasExternalSendPreflight?.() === true,
          this.isBusy() && this.coordinator.phase !== "completing"
        );
        return false;
      }
      const message = this.extractRetryFailureMessage(sendResult.error) ?? sendResult.error.type;
      if (followUpAccepted) {
        // The user row is already durable and emitted (post-acceptance
        // startup failure): re-preserving would duplicate it. The pre-armed
        // resume state above owns recovery; clear the marker so a later
        // stream-end cannot dispatch the same follow-up again on top of the
        // durable row.
        await this.clearPendingFollowUpFromSummary(lastMessage);
        throw new Error(`Failed to dispatch pending follow-up: ${message}`);
      }
      // Only genuinely user-authored follow-ups get manual rejection
      // recovery: heartbeat prompts and mid-stream compaction's "Continue"
      // sentinel ride the same pendingFollowUp field, but no user typed them
      // — persisting them as manual rows (and pausing a goal) would fabricate
      // an intervention.
      const userAuthoredFollowUp =
        persistedGoalKind == null &&
        (options.muxMetadata as MuxMessageMetadata | undefined)?.type !== "heartbeat-request" &&
        // Persisted provenance, not content matching: a user who literally
        // typed "Continue" must keep manual recovery, while the generated
        // mid-stream resume sentinel carries dispatchOptions.source.
        followUp.dispatchOptions?.source !== "internal-resume";
      if (userAuthoredFollowUp) {
        // The follow-up text is the USER's prompt (their composer cleared
        // when compaction started), redispatched synthetically — so the
        // routing/pricing rejection branches inside sendMessage skip their
        // manual-send preservation for it, and a bare throw reaches only the
        // logs while the summary keeps re-arming the same failing dispatch.
        const persisted = await this.preserveRejectedManualSend(
          finalText,
          options,
          sendResult.error
        );
        if (persisted) {
          await this.applyManualUserMessageGoalSafety({ policy: "pause" });
          // The preserved row is the durable copy now; only then may the
          // summary's pending marker go. A failed preservation KEEPS the
          // marker — it is the only durable copy of the prompt, and the next
          // stream-end/idle pass re-attempts the dispatch.
          await this.clearPendingFollowUpFromSummary(lastMessage);
        }
      } else {
        // Synthetic content: nothing user-visible to preserve; drop the
        // marker so the same failing dispatch cannot loop.
        await this.clearPendingFollowUpFromSummary(lastMessage);
      }
      throw new Error(`Failed to dispatch pending follow-up: ${message}`);
    }

    if (sendResult.data?.acceptedWithoutStream === true) {
      // Accepted (row durable, visible stream error emitted) but refused
      // before any provider request: no stream will start, so no stream-end
      // will ever follow — callers (TaskService's compaction-completion
      // decision) must not treat this as a running continuation, and there
      // is no dispatch to attribute. The durable row is the copy now; retire
      // the summary's pending marker so no later pass redispatches it.
      await this.clearPendingFollowUpFromSummary(lastMessage);
      return false;
    }

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

    // Dispatch-time attribution for a compaction-DEFERRED skill send: the
    // original send reported { queued: true } (the renderer's messageSent
    // deliberately skipped), so the turn is attributed here, when it actually
    // streams — routed or unbound. Routing is re-resolved after compaction
    // and can disappear (class binding removed, trust revoked); the skill
    // then streams on the ambient model and the event must still fire. Not
    // when this dispatch itself deferred again ({ queued: true }: a
    // background-started startup dispatch attributes on its own completion,
    // or another on-send compaction defers the skill once more) — that would
    // record a request that has not happened (yet); the accepted-without-
    // stream case returned above.
    if (
      sendResult.data?.queued !== true &&
      (options.muxMetadata as MuxMessageMetadata | undefined)?.type === "agent-skill"
    ) {
      const dispatchModel = sendResult.data?.routedModel ?? options.model;
      if (dispatchModel != null) {
        await this.captureBackendMessageSent({
          model: dispatchModel,
          agentId: options.agentId,
          messageLength: finalText.length,
          thinkingLevel: sendResult.data?.routedThinkingLevel ?? options.thinkingLevel,
        });
      }
    }
    // Delivery of a deferred send: the service's fork auto-title waited for
    // this (see onDeferredSendDelivered). Not when this dispatch deferred
    // again — its own delivery reports then.
    if (sendResult.data?.queued !== true) {
      this.onDeferredSendDelivered?.(finalText);
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
    hasActiveNonCompletingTurn: boolean
  ): Promise<void> {
    if (
      summaryMessage.metadata?.compacted === "heartbeat" &&
      hasUserContention &&
      !hasActiveNonCompletingTurn
    ) {
      const turn = this.coordinator.turnId;
      const rollbackResult = await this.compactionHandler.rollbackHeartbeatContextResetBoundary(
        summaryMessage,
        () => this.coordinator.turnId === turn
      );
      if (!rollbackResult.success) {
        throw new Error(`Failed to rollback heartbeat reset boundary: ${rollbackResult.error}`);
      }
      if (rollbackResult.data === "applied") this.onPostCompactionStateChange?.();
    } else {
      await this.clearPendingFollowUpFromSummary(summaryMessage);
    }
  }

  private async clearPendingFollowUpFromSummary(summaryMessage: MuxMessage): Promise<void> {
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

    const turn = this.coordinator.turnId;
    const updateResult = await this.historyService.cleanupCompactionFollowUp(
      this.workspaceId,
      summaryMessage,
      "clear",
      () => this.coordinator.turnId === turn
    );
    if (!updateResult.success) {
      throw new Error(`Failed to clear skipped pending follow-up: ${updateResult.error}`);
    }
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
    this.acceptedFileSnapshotBaseline = undefined;
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
    this.postCompactionState = null;
    this.memoryContextByModelString.clear();
    // In-memory clears stay unconditional: they stop THIS session from
    // injecting carryover even when the durable discard below fails.
    this.compactionOccurred = false;
    this.turnsSinceLastAttachment = TURNS_BETWEEN_ATTACHMENTS;
    this.postCompactionLoadedSkills = [];
    this.postCompactionReadFilePaths = [];
    this.pendingPostCompactionStateToAcknowledge = null;
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
    options?: {
      includeHotMemories?: boolean;
      tokenBudgetActive?: boolean;
      onlyContextNotes?: boolean;
      /** Routed turn without Project Trust: withhold memories carrying project skill provenance. */
      excludeProjectSkillContent?: boolean;
    },
    cache = this.memoryContextByModelString
  ): Promise<MemorySessionContext | undefined> {
    assert(modelString.length > 0, "resolveMemoryContext requires a model string");
    const includeHotMemories = options?.includeHotMemories !== false;
    const tokenBudgetActive = options?.tokenBudgetActive === true;
    const excludeProjectSkillContent = options?.excludeProjectSkillContent === true;
    if (options?.onlyContextNotes === true) {
      // SECURITY: a final-flush turn must not see other memories (index or preloaded
      // contents); this narrowed context is never cached for ordinary turns.
      const narrowed =
        typeof this.aiService.buildMemorySessionContext === "function"
          ? await this.aiService.buildMemorySessionContext(this.workspaceId, modelString, {
              includeHotMemories,
              tokenBudgetActive,
              onlyContextNotes: true,
              excludeProjectSkillContent,
            })
          : null;
      return narrowed ?? undefined;
    }
    const enabled = (id: ExperimentId) =>
      typeof this.aiService.isExperimentEnabled === "function" &&
      this.aiService.isExperimentEnabled(id);
    const memoryEnabled = enabled(EXPERIMENT_IDS.MEMORY);
    const hotSetEnabled = enabled(EXPERIMENT_IDS.MEMORY_HOT_SET);
    const cached = cache.get(modelString);
    // Policy changes must not retain a previously injected extra (including index-only lookups).
    if (
      cached?.tokenBudgetActive === tokenBudgetActive &&
      cached.memoryEnabled === memoryEnabled &&
      cached.hotSetEnabled === hotSetEnabled &&
      cached.excludesProjectSkillContent === excludeProjectSkillContent &&
      (cached.includesHotMemories || !includeHotMemories)
    ) {
      return cached.context ?? undefined;
    }

    // Guard for test mocks that may not implement buildMemorySessionContext.
    const context =
      typeof this.aiService.buildMemorySessionContext === "function"
        ? await this.aiService.buildMemorySessionContext(this.workspaceId, modelString, {
            includeHotMemories,
            tokenBudgetActive,
            excludeProjectSkillContent,
          })
        : null;
    cache.set(modelString, {
      context,
      includesHotMemories: includeHotMemories,
      tokenBudgetActive,
      memoryEnabled,
      hotSetEnabled,
      excludesProjectSkillContent: excludeProjectSkillContent,
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
      this.postCompactionState = pendingState;
      this.pendingPostCompactionStateToAcknowledge = pendingState;
      this.compactionOccurred = true;
      this.turnsSinceLastAttachment = 0;
      this.postCompactionLoadedSkills = pendingState.loadedSkills;
      this.postCompactionReadFilePaths = pendingState.readFiles;
      // Compaction boundary: invalidate the session-cached memory context so
      // the next stream recomputes the index and hot set from current
      // files/pins/usage stats.
      this.memoryContextByModelString.clear();
      // Clear file state cache since history context is gone
      this.clearFileState();

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
      this.pendingPostCompactionStateToAcknowledge = this.postCompactionState;
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

    // Rejected turns (stamped or quarantined) never reached the provider;
    // nothing extracted from them may re-enter it as carryover.
    const epochMessages = this.excludeRejectedRows(historyResult.data);
    const fileDiffs = extractEditedFileDiffs(epochMessages);
    const loadedSkills = mergeLoadedSkillSnapshots([
      ...this.postCompactionLoadedSkills,
      ...extractLoadedSkillSnapshotsFromMessages(epochMessages),
    ]);
    // Mirror loadedSkills: cumulative pre-boundary reads carried in memory,
    // merged with reads from the current epoch (newest-first, capped).
    const readFilePaths = includeReadFiles
      ? mergeReadFilePaths(this.postCompactionReadFilePaths, extractReadFilePaths(epochMessages))
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
   * Captures file state for registration after acceptance, so rollover cleanup
   * cannot erase the new snapshot's <system-file-update> tracking.
   *
   * @returns The snapshot message and list of materialized mentions, or null if no mentions found
   */
  private async materializeFileAtMentionsSnapshot(messageText: string): Promise<{
    snapshotMessage: MuxMessage;
    materializedTokens: string[];
    fileStates: Array<{ path: string; state: FileState }>;
  } | null> {
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

    const fileStates: Array<{ path: string; state: FileState }> = [];
    for (const mention of materialized) {
      if (
        mention.content !== undefined &&
        mention.modifiedTimeMs !== undefined &&
        mention.resolvedPath
      ) {
        fileStates.push({
          path: mention.resolvedPath,
          state: { content: mention.content, timestamp: mention.modifiedTimeMs },
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

    return { snapshotMessage, materializedTokens: tokens, fileStates };
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

  /**
   * Build a reader that resolves a skill package with the same roots and
   * precedence as skill discovery for this workspace. Shared by snapshot
   * materialization and per-skill model routing so both resolve identically.
   */
  private buildSkillReader(args: {
    metadata: WorkspaceMetadata;
    runtime: Runtime;
    workspacePath: string;
    disableWorkspaceAgents: boolean | undefined;
  }): (skillName: string) => Promise<Awaited<ReturnType<typeof readAgentSkill>>> {
    // When workspace agents are disabled, resolve skills from the project path instead of
    // the worktree so skill invocation uses the same precedence/discovery root as the UI.
    const skillDiscoveryPath = args.disableWorkspaceAgents
      ? args.metadata.projectPath
      : args.workspacePath;

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
      !args.disableWorkspaceAgents &&
      typeof this.aiService.resolveXumToolScopeForWorkspace === "function"
        ? this.aiService.resolveXumToolScopeForWorkspace(
            args.metadata,
            args.runtime,
            args.workspacePath
          )
        : null;
    const skillCtx =
      xumScope?.type === "project"
        ? resolveSkillStorageContext({
            runtime: args.runtime,
            workspacePath: skillDiscoveryPath,
            xumScope,
            includeClaudeSkills,
            includeAgentPlugins,
          })
        : null;
    return (skillName: string) =>
      readAgentSkill(
        skillCtx?.runtime ?? args.runtime,
        skillCtx?.workspacePath ?? skillDiscoveryPath,
        skillName,
        {
          ...(skillCtx != null ? { roots: skillCtx.roots, containment: skillCtx.containment } : {}),
          includeClaudeSkills,
          includeAgentPlugins,
        }
      );
  }

  /**
   * Per-skill model routing: a slash-invoked skill bound to a model class
   * (config `skillModelClasses` table, else skill frontmatter metadata
   * "model-class") streams on the class's model for this send only.
   *
   * Explicit overrides win: sends carrying skipAiSettingsPersistence (one-shot
   * /model commands, compaction requests) are never re-routed. Workspace AI
   * settings are untouched: persistence happens in WorkspaceService (with the
   * user's model) before this runs.
   *
   * Error posture: a *bound* skill whose routing cannot be delivered — unknown
   * class, malformed class value, or a class model no configured route can
   * serve — returns a config-error so the send fails with an actionable
   * message instead of silently streaming on an unintended (often expensive)
   * model. Unbound skills route nothing, and infrastructure failures (config
   * or skill unreadable, providers state unavailable) still fail open: those
   * are not user mapping mistakes, and a skill send must survive them.
   */
  private async resolveSkillModelClassOverride(
    muxMetadata: MuxMessageMetadata | undefined,
    options: SendMessageOptions,
    // Out-channel for the package this resolver read (a possibly remote
    // SKILL.md): an UNBOUND skill still had its frontmatter inspected, and
    // materialization must reuse that read instead of repeating it.
    inspection?: { package?: ResolvedAgentSkill }
  ): Promise<
    | {
        kind: "override";
        className: string;
        model: string;
        thinkingLevel?: ThinkingLevel;
        /**
         * The scope-checked package this routing consent was granted against
         * (present whenever the resolver read one — always in untrusted
         * projects). Materialization reuses it so a project shadow appearing
         * between routing and the snapshot read cannot swap repo-controlled
         * content into a class-provider turn.
         */
        resolvedPackage?: ResolvedAgentSkill;
      }
    | { kind: "config-error"; message: string }
    | null
  > {
    // Only an explicit model override suppresses routing. This must NOT key
    // off skipAiSettingsPersistence: thinking-only one-shots (/+2 /skill) and
    // several internal senders set that flag purely to protect persisted
    // preferences and still want class routing to apply.
    if (options.skipSkillModelRouting === true) {
      return null;
    }
    if (muxMetadata?.type !== "agent-skill") {
      return null;
    }

    try {
      // Defensive config access mirroring getPreferredCompactionSettings: test
      // harnesses may provide a partial Config.
      const maybeConfig = this.config as Config & {
        loadConfigOrDefault?: () => {
          modelClasses?: Record<string, string>;
          skillModelClasses?: Record<string, string>;
          routePriority?: string[];
          routeOverrides?: Record<string, string>;
        } | null;
      };
      if (typeof maybeConfig.loadConfigOrDefault !== "function") {
        return null;
      }
      const cfg = maybeConfig.loadConfigOrDefault();
      const modelClasses = cfg?.modelClasses;
      const skillModelClasses = cfg?.skillModelClasses;

      const skillName = muxMetadata.skillName;
      if (!SkillNameSchema.safeParse(skillName).success) {
        return null;
      }

      // Fast path: with no classes configured and no table binding for this
      // skill, routing can never apply — skip the (possibly remote) SKILL.md
      // frontmatter read entirely. The non-empty-after-trim requirement must
      // match resolveSkillModelClassBinding's boundViaTable exactly: a blank
      // hand-edited table entry ({done: ""}) must not suppress the frontmatter
      // read and then fail the table lookup, silently unrouting the skill.
      const hasModelClasses = modelClasses != null && Object.keys(modelClasses).length > 0;
      const tableClassRaw = skillModelClasses?.[skillName];
      const hasTableBinding = typeof tableClassRaw === "string" && tableClassRaw.trim().length > 0;
      if (!hasModelClasses && !hasTableBinding) {
        return null;
      }

      // Security: repo-controlled content must not silently reroute the
      // transcript to a different configured provider — an attacker's
      // repository could bind its skill to a class the user pointed at any
      // provider. Project Trust is the existing consent boundary for
      // repo-controlled configuration, so in an UNTRUSTED project a
      // project-scope skill gets no class routing at all: neither its own
      // frontmatter nor a name-keyed skillModelClasses entry — the table
      // consent belongs to the (global/built-in) skill the user knew by that
      // name, and project skills win name collisions, so a repo shadow would
      // otherwise inherit it. Global/built-in skills are user-authored and
      // route normally. Fail closed when trust cannot be determined.
      if (typeof this.aiService.getWorkspaceMetadata !== "function") {
        return null;
      }
      const metadataResult = await this.aiService.getWorkspaceMetadata(this.workspaceId);
      if (!metadataResult.success) {
        return null;
      }
      const projectTrusted = (() => {
        try {
          // Scratch workspaces are app-trusted for capability purposes
          // (isWorkspaceProjectTrusted returns true by design), but their
          // workdirs routinely hold CLONED third-party repositories whose
          // .xum/skills ARE discovered — for provider-selection consent a
          // scratch checkout is exactly the untrusted-repository case, so
          // scratch project skills never route. Global/built-in skills still
          // route normally there.
          if (metadataResult.data.kind === "scratch") {
            return false;
          }
          return isWorkspaceProjectTrusted(this.config, metadataResult.data);
        } catch {
          return false;
        }
      })();

      // Package resolution (a possibly remote SKILL.md read) is ALWAYS
      // performed: the resolved package is the consent anchor. Its
      // AUTHORITATIVE scope gates the trust decision here AND the mid-send
      // revocation rechecks (client-supplied invocation scope must never
      // gate a security decision), and materialization reuses the exact
      // package via preResolvedSkills so no shadow can swap content in
      // between. A trusted table binding previously skipped this read, which
      // left the routed invocation unidentifiable at recheck time.
      const { runtime, workspacePath } = createRuntimeContextForWorkspace(metadataResult.data);
      const resolved = await this.buildSkillReader({
        metadata: metadataResult.data,
        runtime,
        workspacePath,
        disableWorkspaceAgents: options.disableWorkspaceAgents,
      })(skillName);
      if (inspection) inspection.package = resolved;
      if (resolved.package.scope === "project" && !projectTrusted) {
        return null;
      }
      const consentCheckedPackage = resolved;
      // Table bindings take precedence; frontmatter feeds the binding
      // resolver only when no table entry names this skill.
      const frontmatterMetadata = hasTableBinding
        ? undefined
        : resolved.package.frontmatter.metadata;

      const providersConfig = this.getProvidersConfigSafe();
      const binding = resolveSkillModelClassBinding({
        skillName,
        frontmatterMetadata,
        modelClasses,
        skillModelClasses,
        providersConfig,
      });

      switch (binding.status) {
        case "unbound":
          return null;
        case "unknown-class":
          return {
            kind: "config-error",
            message: describeSkillModelClassRoutingProblem({
              kind: "unknown-class",
              skillName,
              className: binding.className,
            }),
          };
        case "invalid-value":
          return {
            kind: "config-error",
            message: describeSkillModelClassRoutingProblem({
              kind: "invalid-value",
              skillName,
              className: binding.className,
              value: binding.value,
            }),
          };
        case "resolved": {
          // Availability is a routing-state question (gateways count: a model
          // can be servable via OpenRouter without a direct provider key).
          // Null providersConfig means "cannot determine", never "unavailable".
          if (
            providersConfig != null &&
            !isModelServableWithProvidersConfig({
              canonicalModel: binding.model,
              routePriority: cfg?.routePriority,
              routeOverrides: cfg?.routeOverrides,
              providersConfig,
              // The factory honors the request's own OpenAI wire format when
              // none is stored; the verdict must judge the same request.
              openaiWireFormat: options.providerOptions?.openai?.wireFormat,
            })
          ) {
            return {
              kind: "config-error",
              message: describeSkillModelClassRoutingProblem({
                kind: "model-unavailable",
                skillName,
                className: binding.className,
                model: binding.model,
              }),
            };
          }

          log.debug(
            `skill model routing: /${skillName} → class "${binding.className}" → ${binding.model}` +
              (binding.thinkingLevel != null ? `+${binding.thinkingLevel}` : "")
          );
          return {
            kind: "override",
            className: binding.className,
            model: binding.model,
            ...(binding.thinkingLevel != null ? { thinkingLevel: binding.thinkingLevel } : {}),
            resolvedPackage: consentCheckedPackage,
          };
        }
      }
    } catch (error) {
      log.debug(`skill model routing: fail-open for skill send: ${getErrorMessage(error)}`);
      return null;
    }
  }

  /**
   * Memory channel of a ROUTED turn: memories the turn's system prompt and
   * tool description carry can hold project skill content (harvested from a
   * trusted project-skill epoch, written under such content). Without trust
   * they are excluded from the memory context; under trust their presence
   * (recorded by the resolver callback) arms the consent gate so a revocation
   * before dispatch refuses. Undefined for unrouted turns.
   */
  private async createRoutedMemoryConsent(
    routedConsentRejection: RoutedConsentRejection | undefined
  ): Promise<RoutedMemoryConsent | undefined> {
    if (routedConsentRejection == null) return undefined;
    return {
      excludeProjectSkillContent: !(await this.isRoutedProjectSkillTurnStillTrusted()),
      carriesProjectSkillContent: false,
    };
  }

  /**
   * Fresh provider-selection consent verdict for a routed project-skill
   * turn. Read IMMEDIATELY before each irreversible step (edit truncation,
   * snapshot materialization, snapshot persistence): consent granted at the
   * routing gate can be revoked mid-send. Fails closed — an unreadable
   * verdict must not ship repo-controlled content to the class provider.
   * Same scratch rule as resolveSkillModelClassOverride: scratch workdirs
   * hold cloned third-party repositories and never carry this consent.
   */
  private async isRoutedProjectSkillTurnStillTrusted(): Promise<boolean> {
    try {
      if (typeof this.aiService.getWorkspaceMetadata !== "function") {
        return false;
      }
      const metadataResult = await this.aiService.getWorkspaceMetadata(this.workspaceId);
      if (!metadataResult.success) {
        return false;
      }
      if (metadataResult.data.kind === "scratch") {
        return false;
      }
      return isWorkspaceProjectTrusted(this.config, metadataResult.data);
    } catch {
      return false;
    }
  }

  /**
   * Backend message_sent attribution for dispatches whose renderer telemetry
   * was deliberately suppressed (busy-queued and compaction-deferred skill
   * sends report { queued: true } before routing is known). Telemetry must
   * never fail the dispatch.
   */
  private async captureBackendMessageSent(args: {
    model: string;
    agentId?: string;
    messageLength: number;
    thinkingLevel?: ThinkingLevel;
  }): Promise<void> {
    if (this.telemetryService == null) {
      return;
    }
    try {
      const metadataResult =
        typeof this.aiService.getWorkspaceMetadata === "function"
          ? await this.aiService.getWorkspaceMetadata(this.workspaceId)
          : null;
      const runtimeType =
        metadataResult?.success === true && metadataResult.data.runtimeConfig?.type != null
          ? metadataResult.data.runtimeConfig.type
          : "local";
      this.telemetryService.capture({
        event: "message_sent",
        properties: {
          workspaceId: this.workspaceId,
          model: args.model,
          agentId: args.agentId,
          message_length_b2: roundToBase2(args.messageLength),
          runtimeType,
          // Backend-originated event: there is no renderer to describe.
          frontendPlatform: { userAgent: "backend", platform: process.platform },
          thinkingLevel: args.thinkingLevel ?? "off",
        },
      });
    } catch (error) {
      log.debug("Failed to capture backend message_sent telemetry", {
        workspaceId: this.workspaceId,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Rows quarantined after a failed durable rejection stamp: side-channel
   * model calls (refine) exclude them like request assembly does.
   */
  getQuarantinedRejectedRowIds(): ReadonlySet<string> {
    return this.unstampedRejectedRowIds;
  }

  /**
   * Row keys of refused turns whose durable stamp is still outstanding: the
   * repair record plus a rejected abandon marker's key. Named rows whose
   * stamp the repair could not (yet) re-attempt — a transient history read
   * failure leaves them out of the in-memory quarantine too.
   */
  private outstandingRejectedTurnKeys(): string[] {
    const keys = [...(this.pendingRejectedTurnRepair?.userMessageIds ?? [])];
    const abandon = this.startupAutoRetryAbandon;
    if (abandon?.reason === "pre_stream_rejected" && abandon.userMessageId != null) {
      keys.push(abandon.userMessageId);
    }
    return keys;
  }

  /**
   * Rows a provider request (or a side-channel summarizer) must never carry:
   * durably stamped pre-stream rejections, the in-memory quarantine of rows
   * whose stamp failed, and the whole turn of every outstanding repair key —
   * the last so a repair pass that could not read history still protects the
   * rows it was meant to stamp.
   */
  private excludeRejectedRows(messages: MuxMessage[]): MuxMessage[] {
    const quarantined = collectRejectedTurnRowIds(messages, [
      ...this.unstampedRejectedRowIds,
      ...this.outstandingRejectedTurnKeys(),
    ]);
    return filterPreStreamRejectedRows(messages).filter((msg) => !quarantined.has(msg.id));
  }

  /**
   * Provider-facing copy of continuous-compaction rows (the summarizer's head,
   * the swapped prefix's sources). The compactor reads RAW history, but what it
   * sends is a provider request like any other: durably stamped and quarantined
   * rejected rows never ride it, and during a ROUTED turn — the summary or the
   * prefix leaves for the routed/compact provider — an untrusted workspace's
   * project skill content is withheld exactly as the routed request's own
   * assembly withholds it (withholdProjectSkillContentFromRequest). Content
   * kept under trust is flagged so the dispatch-time recheck can catch a
   * revocation in the model-creation window. Null: the rejected-turn record is
   * corrupt (its recovery deletes the partial and cannot run under a live
   * stream) or unreadable — the compactor stands down and the legacy
   * compaction request, which recovers first, stays in charge.
   */
  private async prepareContinuousCompactionRows(
    rows: MuxMessage[],
    routedTurn: boolean
  ): Promise<{
    rows: MuxMessage[];
    trustedProjectContent: boolean;
    projectContentWithheld: boolean;
  } | null> {
    try {
      await this.loadAutoRetryState();
    } catch {
      return null;
    }
    if (this.corruptRejectedTurnRecord !== null) return null;
    const eligible = this.excludeRejectedRows(rows);
    if (!routedTurn) {
      return { rows: eligible, trustedProjectContent: false, projectContentWithheld: false };
    }
    if (await this.isRoutedProjectSkillTurnStillTrusted()) {
      return {
        rows: eligible,
        trustedProjectContent: messagesCarryProjectSkillContent(eligible),
        projectContentWithheld: false,
      };
    }
    return {
      rows: withholdProjectSkillContentFromRequest(eligible),
      trustedProjectContent: false,
      projectContentWithheld: true,
    };
  }

  /** Dispatch-time recheck of prepareContinuousCompactionRows' verdict, right before the provider call. */
  private async continuousCompactionRowsStillEligible(prepared: {
    rows: MuxMessage[];
    trustedProjectContent: boolean;
  }): Promise<boolean> {
    if (this.corruptRejectedTurnRecord !== null) return false;
    if (this.excludeRejectedRows(prepared.rows).length !== prepared.rows.length) return false;
    return !prepared.trustedProjectContent || (await this.isRoutedProjectSkillTurnStillTrusted());
  }

  /**
   * Self-healing for a late-gate rejection whose durable row stamp FAILED
   * (transient rewrite error; the in-memory quarantine died with the
   * process): the abandon marker and the durable repair record name the
   * rejected user rows — re-attempt the stamp for each row AND its turn's
   * snapshot rows (skill, MCP prompt, @file — persisted immediately before
   * the user row) so the whole rejected turn goes provider-ineligible
   * together. Runs regardless of the auto-retry preference: the hazard is
   * the next MANUAL send.
   *
   * Gated on the abandon marker OR the durable repair record, and idempotent.
   * Runs at startup recovery, at manual-send acceptance (BEFORE the accepted
   * send clears the marker) and at the top of every request build (BEFORE
   * partials are committed), so a send racing the recovery cannot slip the
   * unstamped rows past it. Every outstanding key is repaired on its own and
   * retires only once ITS rows verified — a newer refusal's already-stamped
   * row must never report an older key's repair complete. Reports whether the
   * repair is durably complete — anything short of that leaves (or records)
   * the outstanding keys on disk, since the in-memory quarantine protecting
   * the current request dies with the process — and, separately, whether the
   * rejected turn's surviving partial is gone: outstanding ROW stamps are
   * covered by the in-memory quarantine for the current request, but a partial
   * that could not be deleted (or a pass that could not read history to tell
   * whose partial it is) must stop the request build from committing it.
   *
   * `recoverKeylessMarker`: a `pre_stream_rejected` marker without a row key
   * (a refused resume that could not read the tail) names the newest
   * retry-eligible row — nothing has streamed since the marker was written,
   * so no later turn can hold that position (the identification startup
   * recovery's tail match makes as well). Only callers that can vouch for
   * this pass it; acceptance excludes the row the accepted send itself just
   * persisted.
   */
  /**
   * Self-healing for a malformed rejected-turn record (or preference
   * document): its keys — the refused turns whose row stamp failed — are
   * recorded nowhere else, so they are RECONSTRUCTED conservatively rather
   * than requiring the user to delete the file. A pre-stream refusal never
   * gets an assistant reply, so every retry-eligible user turn in the active
   * segment without a TERMINAL reply is treated as refused — an interrupted
   * stream's committed partial or a failed reply does not settle a turn, and a
   * Retry of such a routed turn can be the refused turn: their rows (and
   * snapshot prefixes) are stamped provider-ineligible, a surviving partial
   * is deleted, and the record is rewritten as a valid document. Turns caught
   * by the rule become non-resumable and must be re-sent — the price of not
   * knowing, paid only after external corruption; turns that ran to
   * completion stay valid context. False when the reconstruction itself could
   * not be made durable; the caller keeps refusing.
   */
  private async recoverFromCorruptRejectedTurnRecord(): Promise<boolean> {
    const corrupt = this.corruptRejectedTurnRecord;
    if (corrupt === null) return true;
    const historyResult = await this.historyService.getHistoryFromLatestBoundary(this.workspaceId);
    if (!historyResult.success) return false;
    const rows = historyResult.data;
    const candidates: string[] = [];
    rows.forEach((row, index) => {
      if (!this.shouldUseUserMessageForRetry(row)) return;
      const rest = rows.slice(index + 1);
      // Turn boundaries are TURN-STARTING user rows (isTurnStartingUserRow):
      // a synthetic <system-file-update> notification between a user row and
      // its reply belongs to that turn — read as a boundary it would make a
      // completed turn look unanswered and stamp it away from its reply.
      const nextTurn = rest.findIndex(isTurnStartingUserRow);
      const turnRows = rest.slice(0, nextTurn === -1 ? rest.length : nextTurn);
      // Only a TERMINAL reply settles a turn (isCommittedAssistantReply): an
      // interrupted routed stream's committed partial or a failed reply leaves
      // it retryable, and a trust-revoked Retry of it can be exactly the
      // refused turn the record named. A turn that ran to completion is
      // valid context and must not be stamped and orphaned from its reply.
      if (!turnRows.some(isCommittedAssistantReply)) candidates.push(row.id);
    });
    // A refused turn's in-flight output may still sit in partial.json.
    const partialDeleted = await this.historyService.deletePartial(this.workspaceId);
    if (!partialDeleted.success) return false;
    const stamp = await this.historyService.markMessagesPreStreamRejected(this.workspaceId, [
      ...collectRejectedTurnRowIds(rows, candidates),
    ]);
    // Rows that could not be stamped stay protected by the (now valid) record.
    const outstanding = stamp.success ? [] : candidates;
    for (const id of outstanding) this.unstampedRejectedRowIds.add(id);
    this.corruptRejectedTurnRecord = null;
    if (outstanding.length > 0) {
      const keys = new Set([
        ...(this.pendingRejectedTurnRepair?.userMessageIds ?? []),
        ...outstanding,
      ]);
      this.pendingRejectedTurnRepair = { userMessageIds: [...keys] };
    }
    // Rewrite the sidecar unconditionally (a clean default state unlinks it):
    // the malformed bytes must not survive, or every side channel reading
    // them through the strict reader stays closed.
    await this.persistAutoRetryState();
    if (this.autoRetryStateUnrecorded) {
      // The sidecar could not be rewritten: stay in the unknown state (the
      // stamps that landed still protect their rows).
      this.corruptRejectedTurnRecord = corrupt;
      return false;
    }
    log.warn("Rejected-turn repair record was malformed; reconstructed it from unanswered turns", {
      workspaceId: this.workspaceId,
      quarantinedTurns: candidates.length,
      unstamped: outstanding.length,
    });
    return true;
  }

  private async repairUnstampedRejectedTurn(context?: {
    recoverKeylessMarker?: { excludeRowId?: string };
  }): Promise<RejectedTurnRepairOutcome> {
    const abandon = this.startupAutoRetryAbandon;
    const pending = this.pendingRejectedTurnRepair;
    const abandonRejected = abandon?.reason === "pre_stream_rejected";
    if (!abandonRejected && pending === null) {
      return { durable: true, partialSecured: true };
    }
    const keys = new Set<string>(pending?.userMessageIds ?? []);
    if (abandonRejected && abandon.userMessageId != null) {
      keys.add(abandon.userMessageId);
    }
    let readFailed = false;
    let partialDurable = true;
    const outstanding = new Set<string>();
    try {
      // Full active epoch, not a bounded tail: a turn's synthetic snapshot
      // prefix (one row per distinct skill/MCP/@file ref) has no count
      // limit, and a truncated read would stamp only the newest subset.
      const historyResult = await this.historyService.getHistoryFromLatestBoundary(
        this.workspaceId
      );
      const rows = historyResult.success ? historyResult.data : null;
      if (rows === null) {
        readFailed = true;
      }
      const excludeRowId = context?.recoverKeylessMarker?.excludeRowId;
      const newestRetryEligibleRow =
        rows === null
          ? undefined
          : [...rows]
              .reverse()
              .find((msg) => msg.id !== excludeRowId && this.shouldUseUserMessageForRetry(msg));
      if (
        abandonRejected &&
        abandon.userMessageId == null &&
        context?.recoverKeylessMarker != null &&
        newestRetryEligibleRow != null
      ) {
        keys.add(newestRetryEligibleRow.id);
        // Key the marker so every later pass (request build, resume) can
        // work from it without a tail to vouch for.
        await this.persistStartupAutoRetryAbandon("pre_stream_rejected", newestRetryEligibleRow.id);
      }

      // The rejected turn's in-flight assistant may still sit in
      // partial.json: its delete can fail at rejection time, and the
      // in-memory quarantine died with the process. It is the rejected
      // turn's only while that turn is the newest one: a marker still present
      // means no send succeeded since the rejection (any accepted manual send
      // clears it), while the repair record alone survives later accepted
      // sends and vouches for the partial only when one of its keys is the
      // newest retry-eligible row — otherwise the partial is a LATER turn's
      // (crash-interrupted output, pending ask-user/tool state) and stays for
      // startup recovery. Remove ours before any request-build path commits
      // it as an unmarked assistant row; runs even when the row stamp itself
      // succeeded (the two failures are independent).
      const partialBelongsToRejectedTurn =
        abandonRejected || (newestRetryEligibleRow != null && keys.has(newestRetryEligibleRow.id));
      if (partialBelongsToRejectedTurn) {
        // STRICT read: the lenient default swallows every non-ENOENT failure
        // as "no partial", which would let this pass report the partial as
        // secured while a transiently unreadable file still holds the refused
        // turn's output for a later commitPartial to promote. An unreadable
        // partial is unsecured; only a missing one is gone.
        let rejectedPartial: MuxMessage | null = null;
        try {
          rejectedPartial = await this.historyService.readPartial(this.workspaceId, {
            throwOnError: true,
          });
        } catch (error) {
          partialDurable = false;
          log.warn("Refused turn's partial could not be read; treating it as unsecured", {
            workspaceId: this.workspaceId,
            error: getErrorMessage(error),
          });
        }
        if (rejectedPartial != null) {
          const deletePartialResult = await this.historyService.deletePartial(this.workspaceId);
          if (!deletePartialResult.success) {
            this.unstampedRejectedRowIds.add(rejectedPartial.id);
            partialDurable = false;
          }
        }
      }

      for (const userMessageId of keys) {
        if (rows === null) {
          outstanding.add(userMessageId);
          continue;
        }
        const userIdx = rows.findIndex((msg) => msg.id === userMessageId);
        // A row that is gone (truncated by an edit) or already stamped needs
        // nothing more.
        if (userIdx === -1 || rows[userIdx].metadata?.preStreamRejected === true) {
          continue;
        }
        // The user row plus its contiguous synthetic snapshot prefix.
        const restampIds = [...collectRejectedTurnRowIds(rows, [userMessageId])];
        const restamp = await this.historyService.markMessagesPreStreamRejected(
          this.workspaceId,
          restampIds
        );
        if (!restamp.success) {
          for (const id of restampIds) {
            this.unstampedRejectedRowIds.add(id);
          }
          outstanding.add(userMessageId);
        }
      }
    } catch (error) {
      readFailed = true;
      log.warn("Failed to repair unstamped rejected turn", {
        workspaceId: this.workspaceId,
        error: getErrorMessage(error),
      });
    }
    const durable = !readFailed && partialDurable && outstanding.size === 0;
    // Retire only verified keys. An unverifiable pass (read failure) or a
    // surviving partial keeps every key: the partial's association above
    // needs them on the next pass.
    const recordKeys = durable ? [] : readFailed || !partialDurable ? [...keys] : [...outstanding];
    await this.setPendingRejectedTurnRepair(
      recordKeys.length > 0 ? { userMessageIds: recordKeys } : null
    );
    // An unreadable history cannot vouch whose partial survives, so it counts
    // as unsecured like a failed delete.
    return { durable, partialSecured: !readFailed && partialDurable };
  }

  /**
   * Refused-turn rows a rollback could not verifiably delete: stamp them
   * provider-ineligible, fall back to the in-memory quarantine plus the
   * durable repair record when even the stamp fails, and key the abandon
   * marker to the first row so startup recovery abandons instead of replaying
   * it.
   */
  private async quarantineUnremovedRefusedRows(rowIds: string[]): Promise<void> {
    if (rowIds.length === 0) {
      return;
    }
    const stamp = await this.historyService.markMessagesPreStreamRejected(this.workspaceId, rowIds);
    if (!stamp.success) {
      for (const id of rowIds) {
        this.unstampedRejectedRowIds.add(id);
      }
      log.warn("Failed to stamp refused rows left behind by a rollback failure; quarantined", {
        workspaceId: this.workspaceId,
        error: stamp.error,
      });
      await this.addPendingRejectedTurnRepairKey(rowIds[0]);
    }
    await this.persistStartupAutoRetryAbandon("pre_stream_rejected", rowIds[0]);
  }

  /**
   * A resumed routed turn refused by the consent gate. Unlike a fresh send,
   * the refused rows are the ORIGINAL accepted turn's (its user row plus the
   * snapshot prefix the retry replays). The resume request carries that
   * turn's row key — captured by whatever decided the resume: startup
   * recovery's tail scan or the accepted send itself — so the refusal does
   * not depend on re-reading history. A request without one (none of the
   * session's own callers) falls back to the tail scan startup recovery
   * performs; should even that fail, the marker persists key-less and the
   * next repair pass that can vouch nothing streamed since (startup,
   * acceptance) identifies the turn from the tail — the refusal never
   * completes as a retirable no-op. Persist the abandon marker WITH the key,
   * then run the marker-gated repair, which stamps the whole turn and removes
   * a surviving partial; a failed stamp still leaves startup recovery a key
   * to retry with. Returns the visible error for the caller to surface.
   */
  /**
   * Consent gate for a persisted compaction follow-up whose interrupted stream
   * was routed (`CompactionFollowUpRequest.routedProjectConsent`): the
   * in-memory gate died with the process or the stream context, so the verdict
   * comes from durable Project Trust. Least privilege like the request scan —
   * only a continuation whose assembled request actually carries project
   * content needs consent; content an UNTRUSTED workspace's assembly already
   * excluded never arms it. The follow-up's own composite gate stamps its rows
   * on refusal; this one supplies the verdict and its visible record.
   */
  private createDurableFollowUpConsentGate(): RoutedConsentRejection {
    return async (requestCarriesProjectContent, midStream) => {
      if (requestCarriesProjectContent !== true) return null;
      if (await this.isRoutedProjectSkillTurnStillTrusted()) return null;
      const trustError = createUnknownSendMessageError(ROUTED_SKILL_TRUST_REVOKED_MESSAGE);
      // Pre-start refusals bypass every stream error path (this emission is
      // the visible record); a per-step refusal surfaces through StreamManager's
      // own failure pipeline, which emits the row itself.
      if (!this.coordinator.disposed && midStream !== true) {
        this.emitChatEvent(createStreamErrorMessage(buildStreamErrorEventData(trustError)));
      }
      return trustError;
    };
  }

  private async rejectResumedRoutedTurn(resumedUserMessageId?: string): Promise<SendMessageError> {
    const trustError = createUnknownSendMessageError(ROUTED_SKILL_TRUST_REVOKED_MESSAGE);
    try {
      let userMessageId = resumedUserMessageId;
      if (userMessageId == null) {
        const historyResult = await this.historyService.getLastMessages(this.workspaceId, 20);
        userMessageId = historyResult.success
          ? [...historyResult.data]
              .reverse()
              .find((message) => this.shouldUseUserMessageForRetry(message))?.id
          : undefined;
      }
      if (userMessageId == null) {
        log.warn(
          "Refused a resumed routed turn without its row key; the next repair pass identifies it from the tail",
          { workspaceId: this.workspaceId }
        );
      }
      await this.persistStartupAutoRetryAbandon("pre_stream_rejected", userMessageId);
      await this.repairUnstampedRejectedTurn();
    } catch (error) {
      log.warn("Failed to stamp a consent-refused resumed turn", {
        workspaceId: this.workspaceId,
        error: getErrorMessage(error),
      });
    }
    return trustError;
  }

  private async materializeAgentSkillSnapshots(
    muxMetadata: MuxMessageMetadata | undefined,
    disableWorkspaceAgents: boolean | undefined,
    freshContext = false,
    // Routing consent binds to a specific resolved package: reuse it here so
    // a project shadow appearing between routing and this snapshot read
    // cannot swap repo-controlled content into a class-provider turn.
    preResolvedSkills?: Map<string, ResolvedAgentSkill>,
    // True when this turn streams on a routed class model: EVERY
    // repository-controlled snapshot in it needs the provider-selection
    // consent gate, not just the slash-invoked package (an inline
    // $project-skill ref would otherwise ride the routed request).
    routedTurn?: boolean,
    // Edit turns materialize BEFORE truncation: recent-snapshot dedupe would
    // compare against rows the truncation is about to delete and wrongly
    // suppress a snapshot the rewritten history needs.
    skipRecentSnapshotDedupe?: boolean
    // carriesProjectSkillContent: whether any project-scope skill content
    // (fresh or deduped-into-history) rides this routed turn — the later
    // consent gates must fire even when the routed invocation itself is
    // global/built-in but an inline $project-skill ref travels with it.
  ): Promise<{
    messages: MuxMessage[];
    carriesProjectSkillContent: boolean;
    /** Authoritative scope of every package resolved, by skill name (withAuthoritativeSkillScopes). */
    resolvedScopes: Map<string, AgentSkillScope>;
  }> {
    const resolvedScopes = new Map<string, AgentSkillScope>();
    const none = { messages: [], carriesProjectSkillContent: false, resolvedScopes };
    const refs = extractAgentSkillRefs(muxMetadata);
    if (refs.length === 0) {
      return none;
    }

    // Guard for test mocks that may not implement getWorkspaceMetadata.
    if (typeof this.aiService.getWorkspaceMetadata !== "function") {
      return none;
    }

    const metadataResult = await this.aiService.getWorkspaceMetadata(this.workspaceId);
    if (!metadataResult.success) {
      const hasSlash = refs.some((ref) => ref.source === "slash");
      if (hasSlash) {
        throw new Error("Cannot materialize agent skill: workspace metadata not found");
      }
      return none;
    }

    const metadata = metadataResult.data;
    const { runtime, workspacePath } = createRuntimeContextForWorkspace(metadata);
    const trustedForRoutedSnapshots =
      routedTurn === true ? await this.isRoutedProjectSkillTurnStillTrusted() : true;

    // Dedupe per skill against recent persisted snapshots. A wider window keeps multi-skill
    // turns from reloading snapshots that were persisted together on the previous turn.
    const recentSnapshots: Array<{ skillName: string; sha256: string }> = [];
    // Sealed-window snapshots cannot satisfy a skill invocation in the fresh
    // request, and an edit turn materializes BEFORE truncation (dedupe would
    // compare against rows about to be deleted): neither dedupes.
    const historyResult =
      freshContext || skipRecentSnapshotDedupe
        ? null
        : await this.historyService.getLastMessages(this.workspaceId, 10);
    if (historyResult?.success) {
      for (const msg of sliceMessagesForProviderFromLatestContextBoundary(historyResult.data)) {
        const metadata = msg.metadata;
        if (metadata?.synthetic && metadata.agentSkillSnapshot && !metadata.contextBudgetRejected) {
          recentSnapshots.push({
            skillName: metadata.agentSkillSnapshot.skillName,
            sha256: metadata.agentSkillSnapshot.sha256,
          });
        }
      }
    }

    const snapshotMessages: MuxMessage[] = [];
    // Tracked for the post-loop trust revalidation below. Every resolved
    // project-scope ref counts (slash or inline), recorded BEFORE dedupe: a
    // deduped snapshot still means repo-controlled content rides the routed
    // request via history.
    const projectScopeSnapshotIds = new Set<string>();
    let projectScopeRefSeen = false;
    let routedSlashProjectSkillSeen = false;
    let dedupedProjectScopeRefSeen = false;
    for (const ref of refs) {
      const parsedName = SkillNameSchema.safeParse(ref.skillName);
      if (!parsedName.success) {
        if (ref.source === "slash") {
          throw new Error(`Invalid agent skill name: ${ref.skillName}`);
        }
        continue;
      }

      let resolved: Awaited<ReturnType<typeof readAgentSkill>>;
      const preResolved = preResolvedSkills?.get(parsedName.data);
      if (preResolved != null) {
        resolved = preResolved;
      } else {
        try {
          resolved = await this.buildSkillReader({
            metadata,
            runtime,
            workspacePath,
            disableWorkspaceAgents,
          })(parsedName.data);
        } catch (error) {
          if (ref.source === "slash") {
            throw error;
          }
          continue;
        }
      }

      const skill = resolved.package;
      resolvedScopes.set(parsedName.data, skill.scope);

      if (routedTurn === true && skill.scope === "project") {
        projectScopeRefSeen = true;
        if (ref.source === "slash") {
          routedSlashProjectSkillSeen = true;
        }
      }

      // Routed turns stream to the class provider: an untrusted project
      // skill's snapshot must not ride along.
      if (!trustedForRoutedSnapshots && skill.scope === "project") {
        if (ref.source === "slash") {
          // The slash ref IS the routed invocation (identified by source,
          // not by preResolved presence — a trusted table binding resolves
          // its package right here): revocation between the routing gate and
          // materialization means the class route itself is no longer
          // authorized, and the route stays on the turn regardless of
          // snapshot omission. Reject before any row persists; a re-send
          // resolves routing against the revoked trust and proceeds
          // unrouted.
          throw new Error(ROUTED_SKILL_TRUST_REVOKED_MESSAGE);
        }
        // Inline refs are subject to the same rule — the snapshot is omitted
        // rather than failing the turn (least privilege, and the invoked
        // skill's own content still dispatches).
        log.warn("Omitting untrusted project skill snapshot from routed turn", {
          workspaceId: this.workspaceId,
          skillName: skill.directoryName,
        });
        continue;
      }

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
        if (routedTurn === true && skill.scope === "project") {
          // The recent snapshot this dedupes against rides the routed
          // request via history — omission cannot exclude it, so the
          // post-loop revalidation must treat it like the invocation.
          dedupedProjectScopeRefSeen = true;
        }
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
      if (skill.scope === "project") {
        projectScopeSnapshotIds.add(snapshotId);
      }

      // Defense-in-depth: avoid double-loading this skill within the same turn even if
      // future metadata shapes bypass extractAgentSkillRefs dedupe.
      recentSnapshots.push({ skillName: skill.frontmatter.name, sha256 });
    }

    // The loop above awaits (remote SKILL.md reads, dynamic context
    // injection): trust can be revoked WHILE those ran, after the pre-loop
    // verdict was taken. Revalidate after the last await, immediately before
    // these snapshots are returned for persistence. The routed invocation —
    // and any deduped project snapshot, which already rides history and
    // cannot be omitted — rejects the turn; fresh incidental inline
    // snapshots are dropped.
    if (routedTurn === true && projectScopeRefSeen) {
      const stillTrusted = await this.isRoutedProjectSkillTurnStillTrusted();
      if (!stillTrusted) {
        if (routedSlashProjectSkillSeen || dedupedProjectScopeRefSeen) {
          throw new Error(ROUTED_SKILL_TRUST_REVOKED_MESSAGE);
        }
        log.warn("Dropping project skill snapshots after mid-materialization trust revocation", {
          workspaceId: this.workspaceId,
        });
        return {
          messages: snapshotMessages.filter((msg) => !projectScopeSnapshotIds.has(msg.id)),
          carriesProjectSkillContent: false,
          resolvedScopes,
        };
      }
    }

    return {
      messages: snapshotMessages,
      carriesProjectSkillContent: projectScopeRefSeen,
      resolvedScopes,
    };
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

    // A restart can run this before asynchronous startup recovery repaired a
    // refused turn whose row stamp failed: the boundary would seal those rows
    // where the repair no longer finds them, after the pending state had
    // already cached their project snapshot for the follow-up. Load the durable
    // record and repair first; whatever stays unstamped is excluded from the
    // carried-over state by key (see the compaction handler's quarantine).
    await this.loadAutoRetryEnabledPreference();
    await this.repairUnstampedRejectedTurn();
    if (this.coordinator.disposed || this.coordinator.closing) {
      return Err("Cannot reset heartbeat context while the session is closing.");
    }
    // Like request builds: a malformed record yields no keys for the handler's
    // quarantine filter, so the reset could cache a refused turn's project
    // snapshot in the carried-over state and seal its rows behind the
    // boundary — content a later follow-up would replay. Reconstruct the
    // record first; fail closed if that cannot be made durable.
    if (
      this.corruptRejectedTurnRecord !== null &&
      !(await this.recoverFromCorruptRejectedTurnRecord())
    ) {
      return Err(rejectedTurnRecordCorruptMessage(this.getAutoRetryPreferencePath()));
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

  async dispatchPendingCompactionFollowUpIfNeeded(
    summaryMessageId?: string,
    startStreamInBackground = false
  ): Promise<boolean> {
    this.assertNotDisposed("dispatchPendingCompactionFollowUpIfNeeded");
    return this.dispatchPendingFollowUp(summaryMessageId, undefined, startStreamInBackground);
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

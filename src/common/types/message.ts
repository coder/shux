import type { ModelMessage, UIMessage } from "ai";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import type { StreamErrorType } from "./errors";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";
import type { FilePart, MuxToolPartSchema } from "@/common/orpc/schemas";
import type {
  ContextBoundaryKind,
  PersistedContextBoundaryKind,
} from "@/common/constants/contextBoundary";
import type { GoalSyntheticMessageKind } from "@/constants/goals";
import type { SendMessageOptions } from "@/common/orpc/types";
import { withLegacyPtcExclusiveMirror } from "@/common/constants/experiments";
import type { z } from "zod";
import type { AgentMode } from "./mode";
import type { AgentSkillScope } from "./agentSkill";
import type {
  AgentMessageRelationship,
  AgentPeerMessageMeta,
} from "@/common/utils/agentMessageEnvelope";
import type { ThinkingLevel } from "./thinking";
import { type ReviewNoteData, formatReviewForModel } from "./review";
import { isMcpPromptCommandKey } from "@/common/utils/tools/mcpPromptCommandKey";

export type { ModelMessage };

/**
 * Review data stored in message metadata for display.
 * Alias for ReviewNoteData - they have identical shape.
 */
export type ReviewNoteDataForDisplay = ReviewNoteData;

/**
 * Content that a user wants to send in a message.
 * Shared between normal send and continue-after-compaction to ensure
 * both paths handle the same fields (text, attachments, reviews).
 */
export interface UserMessageContent {
  text: string;
  fileParts?: FilePart[];
  /** Review data - formatted into message text AND stored in metadata for display */
  reviews?: ReviewNoteDataForDisplay[];
}

/**
 * Input for follow-up content - what call sites provide when triggering compaction.
 * Does not include model/agentId since those come from sendMessageOptions.
 */
export interface CompactionFollowUpInput extends UserMessageContent {
  /** Message metadata to apply to the queued follow-up user message (e.g., preserve /skill display) */
  muxMetadata?: MuxMessageMetadata;
}

/**
 * SendMessageOptions fields that should be preserved across compaction.
 * These affect how the follow-up message is processed (thinking level, system instructions, etc.)
 * and should use the user's original settings, not compaction defaults.
 */
type PreservedSendOptions = Pick<
  SendMessageOptions,
  | "thinkingLevel"
  | "reasoningMode"
  | "additionalSystemInstructions"
  | "providerOptions"
  | "experiments"
  | "disableWorkspaceAgents"
  | "toolPolicy"
  | "strictAgentResolution"
  | "allowAgentSetGoal"
  | "skipAiSettingsPersistence"
>;

/**
 * Extract the send options that should be preserved across compaction.
 * Use this helper to avoid duplicating the field list when building CompactionFollowUpRequest.
 */
export function pickPreservedSendOptions(options: SendMessageOptions): PreservedSendOptions {
  // Unset fields are OMITTED, not emitted as explicit undefined: compaction recovery spreads
  // this pick over an already-persisted follow-up, and an undefined key would clobber the
  // original preserved value (e.g. a restricted turn's toolPolicy) instead of leaving it.
  return {
    ...(options.thinkingLevel !== undefined ? { thinkingLevel: options.thinkingLevel } : {}),
    ...(options.reasoningMode !== undefined ? { reasoningMode: options.reasoningMode } : {}),
    ...(options.additionalSystemInstructions !== undefined
      ? { additionalSystemInstructions: options.additionalSystemInstructions }
      : {}),
    ...(options.providerOptions !== undefined ? { providerOptions: options.providerOptions } : {}),
    // Downgrade-compat (see withLegacyPtcExclusiveMirror): preserved options
    // can persist across restarts and build versions.
    ...(options.experiments !== undefined
      ? { experiments: withLegacyPtcExclusiveMirror(options.experiments) }
      : {}),
    ...(options.disableWorkspaceAgents !== undefined
      ? { disableWorkspaceAgents: options.disableWorkspaceAgents }
      : {}),
    // Security: a restricted turn (including a terminal-wake send restoring the caller's
    // policy) that triggers on-send compaction must not redispatch its follow-up allow-all.
    ...(options.toolPolicy !== undefined ? { toolPolicy: options.toolPolicy } : {}),
    // Delegated turns with explicit agent overrides must stay loud across the
    // compaction replay too — dropping this would let the follow-up silently
    // fall back to exec if the agent vanished in the meantime.
    ...(options.strictAgentResolution !== undefined
      ? { strictAgentResolution: options.strictAgentResolution }
      : {}),
    ...(options.allowAgentSetGoal !== undefined
      ? { allowAgentSetGoal: options.allowAgentSetGoal }
      : {}),
    ...(options.skipAiSettingsPersistence !== undefined
      ? { skipAiSettingsPersistence: options.skipAiSettingsPersistence }
      : {}),
  };
}

export type StartupRetrySendOptions = Pick<
  SendMessageOptions,
  | "model"
  | "agentId"
  | "thinkingLevel"
  | "reasoningMode"
  | "toolPolicy"
  | "additionalSystemInstructions"
  | "maxOutputTokens"
  | "providerOptions"
  | "experiments"
  | "disableWorkspaceAgents"
  | "strictAgentResolution"
  | "allowAgentSetGoal"
> & {
  /**
   * Correlation metadata that must survive restart recovery: delegated
   * workspace turns and interrupted compaction requests. A resumed compaction
   * stream needs its original metadata so trailing synthetic rows cannot break
   * compaction detection (resolveCompactionRequest only skips synthetic rows
   * when the stream itself identifies as a compaction request).
   */
  muxMetadata?:
    | Extract<MuxMessageMetadata, { type: "workspace-turn-task" }>
    | Extract<MuxMessageMetadata, { type: "compaction-request" }>;
  /** Internal-only Copilot billing override for startup auto-retry. */
  agentInitiated?: boolean;
  /** Internal goal continuation classification for startup auto-retry accounting. */
  goalKind?: GoalSyntheticMessageKind;
  /**
   * Goal identity matching `goalKind`. Not persisted by
   * pickStartupRetrySendOptions (the user row's own metadata.goalId is the
   * durable copy); startup recovery re-derives it so resumed streams keep
   * goal-scoped compaction follow-ups (Codex P2 PRRT_kwDOPxxmWM6cIv2E).
   */
  goalId?: string;
};

/**
 * Snapshot retry-relevant send options so startup recovery can resume interrupted
 * turns with the same request configuration (model/provider options/system hints).
 */
export function pickStartupRetrySendOptions(
  options: SendMessageOptions,
  agentInitiated?: boolean,
  goalKind?: GoalSyntheticMessageKind
): StartupRetrySendOptions {
  const typedMuxMetadata = options.muxMetadata as MuxMessageMetadata | undefined;
  const workspaceTurnMuxMetadata =
    typedMuxMetadata?.type === "workspace-turn-task" ? typedMuxMetadata : undefined;
  return {
    model: options.model,
    agentId: options.agentId,
    thinkingLevel: options.thinkingLevel,
    reasoningMode: options.reasoningMode,
    toolPolicy: options.toolPolicy,
    additionalSystemInstructions: options.additionalSystemInstructions,
    maxOutputTokens: options.maxOutputTokens,
    providerOptions: options.providerOptions,
    // Downgrade-compat: retry snapshots persist to chat.jsonl and cross build
    // versions, so an enabled merged PTC also stamps the legacy exclusive key.
    experiments: withLegacyPtcExclusiveMirror(options.experiments),
    disableWorkspaceAgents: options.disableWorkspaceAgents,
    // Keep explicit-agent turns loud across restart recovery (see pickPreservedSendOptions).
    strictAgentResolution: options.strictAgentResolution,
    allowAgentSetGoal: options.allowAgentSetGoal,
    ...(workspaceTurnMuxMetadata != null ? { muxMetadata: workspaceTurnMuxMetadata } : {}),
    ...(agentInitiated === true ? { agentInitiated: true } : {}),
    ...(goalKind != null ? { goalKind } : {}),
  };
}

export interface CompactionFollowUpDispatchOptions {
  /** Source marker for internal resume follow-ups, not user-authored prompts. */
  source?: "internal-resume";
  /** Skip the queued follow-up instead of replaying it later if the workspace stopped being idle. */
  requireIdle?: boolean;
}

/**
 * Content to send after compaction completes.
 * Extends CompactionFollowUpInput with model/agentId for the follow-up message,
 * plus preserved send options so the follow-up uses the same settings as the
 * original user message.
 *
 * These fields are required because compaction uses its own agentId ("compact")
 * and potentially a different model for summarization. The follow-up message
 * should use the user's original model, agentId, and send options.
 *
 * Call sites provide CompactionFollowUpInput; prepareCompactionMessage converts
 * it to CompactionFollowUpRequest by adding model/agentId/options from sendMessageOptions.
 */
export interface CompactionFollowUpRequest extends CompactionFollowUpInput, PreservedSendOptions {
  /** Model to use for the follow-up message (user's original model, not compaction model) */
  model: string;
  /** Agent ID for the follow-up message (user's original agentId, not "compact") */
  agentId: string;
  /** Preserve internal sub-agent/automation attribution across the mechanical compact turn. */
  agentInitiated?: boolean;
  /** Internal goal continuation classification for synthetic follow-up accounting. */
  goalKind?: GoalSyntheticMessageKind;
  /**
   * Goal identity matching `goalKind`. Preserved through compaction so the
   * re-dispatched follow-up row stays goal-scoped for chat-tail
   * reconciliation instead of degrading to a legacy unscoped row (Codex P2
   * PRRT_kwDOPxxmWM6cIv2E).
   */
  goalId?: string;
  /** Internal dispatch guardrails for crash-safe follow-up recovery. */
  dispatchOptions?: CompactionFollowUpDispatchOptions;
  /**
   * Open delegated workspace-turn correlation captured before on-send
   * compaction consumed this follow-up (e.g. a bash-monitor wake continuing a
   * turn cut at a tool boundary). Compaction hides the correlated assistant
   * behind the new boundary, so the continuation stream re-inherits the
   * correlation from this stamp on the persisted summary instead (see
   * AgentSession.inheritOpenWorkspaceTurnMetadata).
   */
  workspaceTurnMetadata?: Extract<MuxMessageMetadata, { type: "workspace-turn-task" }>;
}

/**
 * True when the content is the default resume sentinel ("Continue")
 * with no attachments.
 */
export function isDefaultSourceContent(content?: Partial<UserMessageContent>): boolean {
  if (!content) return false;
  const text = typeof content.text === "string" ? content.text.trim() : "";
  const hasFiles = (content.fileParts?.length ?? 0) > 0;
  const hasReviews = (content.reviews?.length ?? 0) > 0;
  return text === "Continue" && !hasFiles && !hasReviews;
}

// Parsed compaction request data (shared type for consistency)
export interface CompactionRequestData {
  model?: string; // Custom model override for compaction
  maxOutputTokens?: number;
  /** Content to send after compaction completes. Backend binds model/agentId at send time. */
  followUpContent?: CompactionFollowUpRequest;
}

/**
 * Process UserMessageContent into final message text and metadata.
 * Used by both normal send path and backend continue message processing.
 *
 * @param content - The user message content (text, attachments, reviews)
 * @param existingMetadata - Optional existing metadata to merge with (e.g., for compaction messages)
 * @returns Object with finalText (reviews prepended) and metadata (reviews for display)
 */
export function prepareUserMessageForSend(
  content: UserMessageContent,
  existingMetadata?: MuxMessageMetadata
): {
  finalText: string;
  metadata: MuxMessageMetadata | undefined;
} {
  const { text, reviews } = content;

  // Format reviews into message text
  const reviewsText = reviews?.length ? reviews.map(formatReviewForModel).join("\n\n") : "";
  const finalText = reviewsText ? reviewsText + (text ? "\n\n" + text : "") : text;

  // Build metadata with reviews for display
  let metadata: MuxMessageMetadata | undefined = existingMetadata;
  if (reviews?.length) {
    metadata = metadata ? { ...metadata, reviews } : { type: "normal", reviews };
  }

  return { finalText, metadata };
}

export interface InlineSkillSnapshotForDisplay {
  skillName: string;
  scope: AgentSkillScope;
  snapshot: { frontmatterYaml?: string; body?: string };
}

export type InlineSkillSnapshotMap = Record<string, InlineSkillSnapshotForDisplay>;

export interface AgentSkillReference {
  skillName: string;
  scope: AgentSkillScope;
  source: "slash" | "inline";
}

export function dedupeAgentSkillRefs(refs: AgentSkillReference[]): AgentSkillReference[] {
  const dedupedRefs: AgentSkillReference[] = [];
  const indexBySkillName = new Map<string, number>();

  for (const ref of refs) {
    const existingIndex = indexBySkillName.get(ref.skillName);
    if (existingIndex === undefined) {
      indexBySkillName.set(ref.skillName, dedupedRefs.length);
      dedupedRefs.push(ref);
      continue;
    }

    const existingRef = dedupedRefs[existingIndex];
    if (!existingRef) {
      throw new Error(`Missing agent skill ref for index ${existingIndex}`);
    }

    if (existingRef.source === "inline" && ref.source === "slash") {
      dedupedRefs[existingIndex] = ref;
    }
  }

  return dedupedRefs;
}

export function mergeAgentSkillRefs(
  existing: AgentSkillReference[] | undefined,
  additions: AgentSkillReference[]
): AgentSkillReference[] {
  return dedupeAgentSkillRefs([...(existing ?? []), ...additions]);
}

function getExistingAgentSkillRefs(
  metadata: MuxMessageMetadata | undefined
): AgentSkillReference[] | undefined {
  const refs = metadata?.agentSkillRefs;
  return Array.isArray(refs) ? refs : undefined;
}

export function withAgentSkillRefs(
  metadata: MuxMessageMetadata | undefined,
  refs: AgentSkillReference[]
): MuxMessageMetadata | undefined {
  const existingRefs = getExistingAgentSkillRefs(metadata);
  if (refs.length === 0 && (!existingRefs || existingRefs.length === 0)) {
    return metadata;
  }

  if (!metadata) {
    return { type: "normal", agentSkillRefs: dedupeAgentSkillRefs(refs) };
  }

  return {
    ...metadata,
    agentSkillRefs: mergeAgentSkillRefs(existingRefs, refs),
  };
}

export interface MCPPromptReference {
  serverName: string;
  promptName: string;
  commandKey: string;
  source: "slash" | "inline";
  arguments?: Record<string, string>;
}

export function getMcpPromptReferenceKey(serverName: string, promptName: string): string {
  return `${serverName}\u0000${promptName}`;
}

export function buildMcpPromptUserText(
  serverName: string,
  promptName: string,
  argumentText: string
): string {
  const base = `Using MCP prompt ${serverName}/${promptName}`;
  return argumentText ? `${base}: ${argumentText}` : base;
}

export function isMcpPromptReference(value: unknown): value is MCPPromptReference {
  if (value === null || typeof value !== "object") return false;
  const ref = value as Partial<MCPPromptReference>;
  // Empty identities would make snapshot materialization fail on every
  // compact-and-retry instead of self-healing, so reject them here.
  return (
    typeof ref.serverName === "string" &&
    ref.serverName.length > 0 &&
    typeof ref.promptName === "string" &&
    ref.promptName.length > 0 &&
    typeof ref.commandKey === "string" &&
    isMcpPromptCommandKey(ref.commandKey) &&
    (ref.source === "slash" || ref.source === "inline")
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

/** muxMetadata persists as z.any(), so corrupted references require read-time filtering. */
export function sanitizeMcpPromptRefs(value: unknown): MCPPromptReference[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isMcpPromptReference).map((ref) => {
    if (ref.arguments === undefined || isStringRecord(ref.arguments)) return ref;
    // Drop malformed persisted arguments so prompt expansion can retry without them.
    const { arguments: _malformed, ...rest } = ref;
    return rest;
  });
}

export function isAgentSkillReference(value: unknown): value is AgentSkillReference {
  if (value === null || typeof value !== "object") return false;
  const ref = value as Partial<AgentSkillReference>;
  return (
    typeof ref.skillName === "string" &&
    typeof ref.scope === "string" &&
    (ref.source === "slash" || ref.source === "inline")
  );
}

export function sanitizeAgentSkillRefs(value: unknown): AgentSkillReference[] {
  return Array.isArray(value) ? value.filter(isAgentSkillReference) : [];
}

/** Shared with the node-side ID factory so snapshot rows stay identifiable. */
export const MCP_PROMPT_SNAPSHOT_MESSAGE_ID_PREFIX = "mcp-prompt-snapshot-";

function isMcpPromptSnapshotBaseShape(
  value: unknown
): value is { serverName: string; promptName: string; invokingMessageId?: string } {
  if (value === null || typeof value !== "object") return false;
  const snapshot = value as Partial<NonNullable<MuxMetadata["mcpPromptSnapshot"]>>;
  return typeof snapshot.serverName === "string" && typeof snapshot.promptName === "string";
}

/**
 * Drops MCP prompt snapshots orphaned by a crash between snapshot persistence
 * and the user-row append: a snapshot survives only when its invoking user row
 * exists and still references the same prompt.
 */
export function filterOrphanedMcpPromptSnapshots(messages: MuxMessage[]): MuxMessage[] {
  // Drop only genuine expansion rows: the reserved ID prefix marks one even
  // when corruption removed its metadata, and synthetic rows with a valid
  // snapshot shape cover legacy IDs. Other rows may be corrupted with this
  // field and must survive after it is stripped.
  const isMcpSnapshotRow = (message: MuxMessage): boolean =>
    message.role === "user" &&
    (message.id.startsWith(MCP_PROMPT_SNAPSHOT_MESSAGE_ID_PREFIX) ||
      (message.metadata?.synthetic === true &&
        isMcpPromptSnapshotBaseShape(message.metadata.mcpPromptSnapshot)));

  const promptRefKeysByMessageId = new Map<string, Set<string>>();
  for (const message of messages) {
    if (message.role !== "user" || isMcpSnapshotRow(message)) continue;
    const refs = sanitizeMcpPromptRefs(message.metadata?.muxMetadata?.mcpPromptRefs);
    if (refs.length === 0) continue;
    promptRefKeysByMessageId.set(
      message.id,
      new Set(refs.map((ref) => getMcpPromptReferenceKey(ref.serverName, ref.promptName)))
    );
  }
  return messages.flatMap((message): MuxMessage[] => {
    const snapshot: unknown = message.metadata?.mcpPromptSnapshot;
    if (!isMcpSnapshotRow(message)) {
      if (snapshot === undefined || message.metadata === undefined) return [message];
      const { mcpPromptSnapshot: _stripped, ...metadata } = message.metadata;
      return [{ ...message, metadata }];
    }
    // Raw chat.jsonl bypasses oRPC sanitization. Absent or malformed expansion
    // snapshots and legacy snapshots without an invoking ID are crash orphans.
    if (!isMcpPromptSnapshotBaseShape(snapshot) || snapshot.invokingMessageId === undefined) {
      return [];
    }
    const invokingRefKeys = promptRefKeysByMessageId.get(snapshot.invokingMessageId);
    return invokingRefKeys?.has(
      getMcpPromptReferenceKey(snapshot.serverName, snapshot.promptName)
    ) === true
      ? [message]
      : [];
  });
}

export function dedupeMcpPromptRefs(refs: MCPPromptReference[]): MCPPromptReference[] {
  const deduped = new Map<string, MCPPromptReference>();
  for (const ref of refs) {
    const key = getMcpPromptReferenceKey(ref.serverName, ref.promptName);
    const existing = deduped.get(key);
    if (!existing || (existing.source === "inline" && ref.source === "slash")) {
      deduped.set(key, ref);
    }
  }
  return [...deduped.values()];
}

export function withMcpPromptRefs(
  metadata: MuxMessageMetadata | undefined,
  refs: MCPPromptReference[]
): MuxMessageMetadata | undefined {
  const existingRefs = sanitizeMcpPromptRefs(metadata?.mcpPromptRefs);
  if (existingRefs.length === 0 && refs.length === 0) {
    return metadata;
  }

  const mcpPromptRefs = dedupeMcpPromptRefs([...existingRefs, ...refs]);
  return metadata ? { ...metadata, mcpPromptRefs } : { type: "normal", mcpPromptRefs };
}

export interface BuildAgentSkillMetadataOptions {
  rawCommand: string;
  skillName: string;
  scope: AgentSkillScope;
  commandPrefix?: string;
  /** Trimmed argument text after the slash command (drives placeholder substitution). */
  arguments?: string;
}

export function buildAgentSkillMetadata(
  options: BuildAgentSkillMetadataOptions
): MuxMessageMetadata {
  return {
    type: "agent-skill",
    rawCommand: options.rawCommand,
    commandPrefix: options.commandPrefix,
    skillName: options.skillName,
    scope: options.scope,
    arguments: options.arguments,
    agentSkillRefs: [{ skillName: options.skillName, scope: options.scope, source: "slash" }],
  };
}

/**
 * Stable display-only insertion point captured while an assistant message is streaming.
 * Content lengths split merged text/reasoning parts; partIndex counts canonical adjacent-merged parts.
 */
export interface TranscriptAnchor {
  messageId: string;
  historySequence: number;
  textLength: number;
  reasoningLength: number;
  partIndex: number;
}

/** Base fields common to all metadata types */
interface MuxMessageMetadataBase {
  /** Correlates a rollover continuation without replacing its original attribution. */
  rolloverId?: string;
  /** Structured review data for rich UI display (orthogonal to message type) */
  reviews?: ReviewNoteDataForDisplay[];
  /** Command prefix to highlight in UI (e.g., "/compact -m sonnet" or "/react-effects") */
  commandPrefix?: string;
  /**
   * Model used for the pending send (UI-only).
   *
   * We stash this so the "starting" label reflects the actual model for one-shot
   * and compaction sends instead of whatever happens to be persisted in localStorage.
   */
  requestedModel?: string;
  /**
   * All skills referenced in this user message turn (slash and/or inline).
   * Backend uses this to materialize one synthetic agentSkillSnapshot per ref
   * before the user message. Persisted refs intentionally exclude parser
   * ranges (startIndex/endIndex) because reviews, one-shots, edits, retries,
   * and slash rewrites make those ranges ambiguous. The ORPC schema keeps
   * muxMetadata loose by design, so this orthogonal field needs no schema change.
   */
  agentSkillRefs?: AgentSkillReference[];
  mcpPromptRefs?: MCPPromptReference[];
  /** Internal budget control turn; retains delegation metadata without a human prompt bubble. */
  contextBudgetContinuation?: true;
  /** Display-only insertion point within an assistant message that was streaming. */
  transcriptAnchor?: TranscriptAnchor;
}

/** Status to display in sidebar during background operations */
export interface DisplayStatus {
  emoji: string;
  message: string;
}

export type BashMonitorFailedOperation = "readOutput" | "getExitCode";

/**
 * Compact per-record summary attached to bash monitor wake turns so the
 * transcript can render a small card (process + filter) while keeping the full
 * prompt (matched lines, task_await guidance) collapsed by default.
 */
export interface BashMonitorWakeDisplayRecord {
  /** Stable process identifier used to suppress redelivery after accepted-store write failures. */
  processId?: string;
  /** Persisted wake snapshot version; paired with processId for accepted-delivery recovery. */
  wakeUpdatedAt?: string;
  kind: "match" | "monitor-lost";
  /** Missing on legacy monitor-lost records, which represent restart losses. */
  lostReason?: "restart" | "runtime-failure";
  displayName: string;
  filter: string;
  filterExclude: boolean;
  /**
   * Present when the wake reported process settlement (exit, kill, timeout). "unknown" is the
   * backend's read-time degrade of malformed persisted metadata — still a settlement for
   * display.
   */
  terminal?: { status: "exited" | "killed" | "failed" | "unknown"; exitCode?: number };
  /**
   * Present when the wake carries a dead earlier generation's settlement whose processId was
   * re-armed by a new live process — still a settlement for display, never "monitor matched".
   */
  staleTerminal?: { status: "exited" | "killed" | "failed" | "unknown"; exitCode?: number };
}

export type MuxMessageMetadata = MuxMessageMetadataBase &
  (
    | {
        type: "context-window-rollover";
        rolloverId: string;
        reason: "on-send" | "mid-stream" | "context-exceeded";
        previousWindowId: string;
        flushOpportunity: boolean;
        contextTokens: number;
        maxTokens: number;
      }
    | {
        type: "context-window-continuation";
        rolloverId: string;
      }
    | {
        type: "context-window-lead-in";
        rolloverId: string;
      }
    | {
        type: "context-budget-warning";
        contextTokens: number;
        maxTokens: number;
      }
    | {
        type: "compaction-request";
        rawCommand: string; // The original /compact command as typed by user (for display)
        parsed: CompactionRequestData;
        /**
         * Source of compaction request:
         * - undefined: user-initiated (/compact)
         * - idle-compaction: backend idle compaction
         * - auto-compaction: threshold-triggered compaction (on-send / mid-stream)
         */
        source?: "idle-compaction" | "auto-compaction";
        /**
         * RLM keep-recent floor (rlm-mode experiment): history rows at or after
         * this historySequence are excluded from the summarization request and
         * preserved verbatim (re-appended after the boundary) instead of being
         * summarized. Stamped at request-persist time so live assembly,
         * compaction completion, and replay all derive the same tail from
         * durable rows. Absent when RLM is off — behavior is then unchanged.
         */
        keepRecentTail?: { startHistorySequence: number };
        /** Transient status to display in sidebar during this operation */
        displayStatus?: DisplayStatus;
      }
    | {
        type: "compaction-summary";
        /** Distinguishes eager prefix compaction from the existing full compaction flow. */
        strategy?: "continuous";
        /**
         * Follow-up content to dispatch after compaction completes.
         * Stored on the summary so it survives crashes - the user message
         * persisted by dispatch serves as proof of completion.
         */
        pendingFollowUp?: CompactionFollowUpRequest;
      }
    | {
        type: "agent-skill";
        /** The original /{skillName} invocation as typed by user (for display) */
        rawCommand: string;
        skillName: string;
        scope: "project" | "global" | "built-in";
        /**
         * Trimmed argument text after the slash command (e.g. "123 high" for
         * "/fix-issue 123 high"). Used to substitute $ARGUMENTS/$1..$9 placeholders in
         * the materialized skill snapshot body. Absent on messages persisted before
         * this field existed; consumers treat that as "".
         */
        arguments?: string;
      }
    | {
        type: "plan-display"; // Ephemeral plan display from /plan command
        path: string;
      }
    | {
        type: "goal-cleared-summary";
      }
    | {
        // Synthetic wake-up appended when background bash monitors match output or
        // are lost to a Xum restart. The full prompt stays in the message text for
        // the model; this metadata lets the transcript render the compact card.
        type: "bash-monitor-wake";
        /** One entry per wake record in the prompt, in prompt order. */
        records: BashMonitorWakeDisplayRecord[];
      }
    | {
        type: "goal-pause-boundary";
        /**
         * Goal this boundary pauses. Chat-tail reconciliation ignores
         * boundaries stamped for a different goal so a stale pause finalizer
         * racing a replacement cannot silently pause the newer goal (Codex P2
         * PRRT_kwDOPxxmWM6cEl4F). Optional for legacy rows, which keep the
         * old any-goal semantics.
         */
        goalId?: string;
      }
    | {
        // Durable, provider-visible summary of an abandoned history branch
        // (rlm-mode experiment): appended after a fork-from-message or an
        // edit-resend truncation so the new branch retains context from the
        // discarded tail. The labeled summary stays in the message text for
        // the model; this marker identifies the row for UI/tests.
        type: "branch-summary";
      }
    | {
        // Durable summary of a completed /refine pass (rlm-mode experiment):
        // lists each applied self-modification with its refinement journal id
        // so users can audit and roll edits back (r6). The labeled summary
        // stays in the message text; this marker identifies the row for
        // UI/tests.
        type: "refine-summary";
        /**
         * Staged-mode proposals only: sha256 over the canonical staged-edit
         * set rendered in this row. /refine apply verifies refine-staged.json
         * still hashes to this value, binding approval to the displayed bytes.
         */
        stagedSetHash?: string;
      }
    | {
        // Child-controlled family-message payload (task_message_parent),
        // stored as an ASSISTANT-role synthetic row so prompt-injected child
        // output never gains user-priority trust; a separate fixed-content
        // user trigger row (no child bytes) wakes the parent turn.
        type: "family-message";
      }
    | {
        type: "heartbeat-request";
        /** Synthetic heartbeat follow-ups use an explicit marker so future backend dispatch stays inspectable. */
        source?: "heartbeat";
        /** Transient status to display while the heartbeat is running. */
        displayStatus?: DisplayStatus;
        /**
         * When the schedule slot fired (epoch ms). Queue-mode busy deliveries write the
         * history row only after the running turn finishes, so the message timestamp can
         * be minutes late; fixed-interval restart anchoring must use this instead
         * (HeartbeatService.deriveInitialIntervalNextEligibleAt), matching the live
         * advanceAnchoredDeadline anchor.
         */
        firedAt?: number;
      }
    | {
        type: "normal"; // Regular messages
        /** Original user input for one-shot overrides (e.g., "/opus+high do something") — used as display content so the command prefix remains visible. */
        rawCommand?: string;
      }
    | {
        // Durable UI-only row that shows the slash command that launched a workflow run.
        // Provider requests filter this out; the completed workflow result is sent later.
        type: "workflow-trigger-display";
        rawCommand: string;
        runId: string;
      }
    | {
        // Durable UI-only assistant row containing the workflow_run card.
        // Provider requests filter this out; the completed workflow result is sent later.
        type: "workflow-run-card-display";
        runId: string;
      }
    | {
        // Provider-visible workflow result message. The transcript hides this row because the
        // user already sees the original slash command plus the workflow card.
        type: "workflow-result";
        rawCommand: string;
        runId: string;
      }
    | {
        // Internal correlation marker for full-workspace turns launched through task(kind="workspace").
        // The workspace remains a normal workspace; this metadata only lets TaskService correlate the
        // final assistant stream-end/error back to the durable workspace-turn handle.
        type: "workspace-turn-task";
        taskHandleId: string;
        ownerWorkspaceId: string;
        turnId: string;
        /**
         * Peer attribution for a peer-message wake trigger that must carry the delegated turn's
         * correlation (stream-end settlement reads this variant's type). Carrying the full
         * attribution — not just a flag — lets correlation stripping downgrade the row to plain
         * peer metadata, so the UI keeps rendering it as a machine notification, never as a
         * human prompt.
         */
        agentPeerMessageTrigger?: AgentPeerMessageMeta;
      }
    | {
        // Intra-tree agent peer message (sibling/cousin or descendant→ancestor task_send_message).
        // The <mux_agent_message> envelope stays in the message text for the model; this metadata
        // drives the compact transcript card and queue-entry counting without re-parsing it.
        type: "agent-peer-message";
        /** Sender's tree target id — the reply address for task_send_message. */
        fromWorkspaceId: string;
        fromTitle?: string;
        /** The sender's relationship to the recipient (mirrors the envelope enum). */
        relationship: AgentMessageRelationship;
      }
  );

/** Rollover internals do not make an otherwise empty window eligible for another reset. */
export function isTokenBudgetInternalMessage(message: MuxMessage): boolean {
  const type = message.metadata?.muxMetadata?.type;
  return (
    type === "context-window-lead-in" ||
    type === "context-budget-warning" ||
    (message.metadata?.synthetic === true &&
      message.metadata.muxMetadata?.contextBudgetContinuation === true)
  );
}

export function isRolloverBoundary(message: MuxMessage): boolean {
  return (
    message.metadata?.contextBoundaryKind === "reset" &&
    message.metadata.muxMetadata?.type === "context-window-rollover"
  );
}

/** Correlation identifying which delegated workspace turn a stream belongs to. */
export interface WorkspaceTurnTaskCorrelation {
  taskHandleId: string;
  ownerWorkspaceId: string;
  turnId: string;
}

/**
 * Parse untyped muxMetadata (from persisted history or live stream info) into a
 * workspace-turn correlation. Returns null unless the value is a well-formed
 * "workspace-turn-task" marker — callers use this to attribute a workspace's active
 * stream to a specific delegated turn (e.g. archive interruption must not stop a user
 * stream that replaced an ended delegated stream).
 */
export function parseWorkspaceTurnTaskCorrelation(
  muxMetadata: unknown
): WorkspaceTurnTaskCorrelation | null {
  if (typeof muxMetadata !== "object" || muxMetadata == null || Array.isArray(muxMetadata)) {
    return null;
  }
  const data = muxMetadata as Record<string, unknown>;
  if (data.type !== "workspace-turn-task") {
    return null;
  }
  const taskHandleId = typeof data.taskHandleId === "string" ? data.taskHandleId.trim() : "";
  const ownerWorkspaceId =
    typeof data.ownerWorkspaceId === "string" ? data.ownerWorkspaceId.trim() : "";
  const turnId = typeof data.turnId === "string" ? data.turnId.trim() : "";
  if (taskHandleId.length === 0 || ownerWorkspaceId.length === 0 || turnId.length === 0) {
    return null;
  }
  return { taskHandleId, ownerWorkspaceId, turnId };
}

export function getCompactionFollowUpContent(
  metadata?: MuxMessageMetadata
): CompactionRequestData["followUpContent"] | undefined {
  // Keep follow-up extraction centralized so callers don't duplicate legacy handling.
  if (!metadata || metadata.type !== "compaction-request") {
    return undefined;
  }

  // Malformed persisted compaction metadata has no recoverable follow-up content.
  const parsed: unknown = metadata.parsed;
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  // Legacy compaction requests stored follow-up content in `continueMessage`.
  const legacyParsed = parsed as CompactionRequestData & {
    continueMessage?: CompactionRequestData["followUpContent"];
  };
  return legacyParsed.followUpContent ?? legacyParsed.continueMessage;
}

/** Type for compaction-summary metadata variant */
export type CompactionSummaryMetadata = Extract<MuxMessageMetadata, { type: "compaction-summary" }>;

/** Type guard for compaction-summary metadata */
export function isCompactionSummaryMetadata(
  metadata: MuxMessageMetadata | undefined
): metadata is CompactionSummaryMetadata {
  return metadata?.type === "compaction-summary";
}

export interface PersistedToolModelUsage {
  toolName: string;
  toolCallId?: string;
  timestamp?: number;
  model: string;
  /** Resolved pricing model for token/cost metadata lookups when the tool model uses Treat as mapping. */
  metadataModel?: string;
  usage: LanguageModelV2Usage;
  providerMetadata?: Record<string, unknown>;
}

/**
 * PersistedToolModelUsage.toolName marker for a refused fallback attempt.
 * Analytics keys on this exact string (events.tool_name), the sidecar flatten
 * path uses it to relabel refusal usage as "refused_stream", and the session
 * ledger rebuild uses it to skip zero-usage refusal markers (which exist only
 * so analytics can count refused attempts, never as ledger entries).
 */
export const MODEL_FALLBACK_REFUSAL_TOOL_NAME = "model_fallback_refusal";

/** True when any token counter on the usage payload is positive. */
export function hasTokenUsage(
  usage: LanguageModelV2Usage | undefined
): usage is LanguageModelV2Usage {
  return (
    usage !== undefined &&
    ((usage.inputTokens ?? 0) > 0 ||
      (usage.outputTokens ?? 0) > 0 ||
      (usage.totalTokens ?? 0) > 0 ||
      (usage.cachedInputTokens ?? 0) > 0 ||
      (usage.reasoningTokens ?? 0) > 0)
  );
}

/**
 * Record of a model-fallback chain application. `requestedModel` is the model
 * originally asked for; `refusedModels` lists every model that refused, in
 * chain order (the requested model is always the first entry). The effective
 * (answering) model is recorded separately as the message's `model`.
 */
export interface ModelFallbackRecord {
  requestedModel: string;
  refusedModels: string[];
}

export interface ContextBudgetRejectedMessage {
  role: "user" | "assistant";
  parts: MuxMessage["parts"];
  metadata?: Omit<MuxMetadata, "contextBudgetRejectedMessage">;
}

// Our custom metadata type
export interface MuxMetadata {
  /** Highest persisted history sequence included in the provider request that produced this assistant. */
  requestHistorySequence?: number;
  historySequence?: number; // Assigned by backend for global message ordering (required when writing to history)
  /** Provider step boundaries in parts, persisted so continuous compaction can keep complete steps. */
  stepStartPartIndices?: number[];
  duration?: number;
  ttftMs?: number; // Time-to-first-token measured from stream start; omitted when unavailable
  finishReason?: string; // Provider/model finish reason for the final step (e.g. stop, length)
  /** @deprecated Legacy base mode derived from agent definition. */
  mode?: AgentMode;
  timestamp?: number;
  model?: string;
  /** Resolved pricing model for token/cost metadata lookups when the selected model uses Treat as mapping. */
  metadataModel?: string;
  /** Effective thinking/reasoning level used for this response (after model policy clamping). */
  thinkingLevel?: ThinkingLevel;
  /** @deprecated Legacy gateway flag; prefer routeProvider for source attribution. */
  routedThroughGateway?: boolean;
  routeProvider?: string;
  /**
   * Legacy marker for usage that the app classified as subscription-covered.
   * The UI preserves token counts and $0 costs for these historical records.
   */
  costsIncluded?: boolean;
  // Total usage across all steps (for cost calculation)
  usage?: LanguageModelV2Usage;
  // Last step's usage only (for context window display - inputTokens = current context size)
  contextUsage?: LanguageModelV2Usage;
  // Aggregated provider metadata across all steps (for cost calculation)
  providerMetadata?: Record<string, unknown>;
  // Per-tool invocation usage snapshots recorded during this assistant turn.
  toolModelUsages?: PersistedToolModelUsage[];
  /**
   * Present when a configured model-fallback chain was applied after a
   * provider refusal. `model` records the effective (answering) model; this
   * records the originally requested model and the models that refused, in
   * order. Refused-attempt token usage is attributed via toolModelUsages.
   */
  modelFallback?: ModelFallbackRecord;
  // Last step's provider metadata (for context window cache display)
  contextProviderMetadata?: Record<string, unknown>;
  systemMessageTokens?: number; // Token count for system message sent with this request (calculated by AIService)
  partial?: boolean; // Whether this message was interrupted and is incomplete
  synthetic?: boolean; // Whether this message was synthetically generated (e.g., [CONTINUE] sentinel)
  /**
   * For queue-dispatched user turns: when the user last added to the queued
   * entry. The row `timestamp` is stamped at dispatch (after the blocking turn
   * ends), so goal safety needs this to durably tell messages typed before a
   * mid-turn goal existed from genuine interventions against a visible goal.
   */
  enqueuedAtMs?: number;
  /**
   * UI hint: show in the chat UI even when synthetic.
   *
   * Synthetic messages are hidden by default because most are for model context only.
   * Set this flag for synthetic notices that should be visible to users.
   */
  uiVisible?: boolean;
  /** Display-only input rejected by the token-budget gate before provider submission. */
  contextBudgetRejected?: true;
  /** Inert original content for transcript display only; never restore it for provider requests. */
  contextBudgetRejectedMessage?: ContextBudgetRejectedMessage;
  /** Accepted snapshots and assistant payloads that must travel with this turn on retry. */
  requestPreludeMessageIds?: string[];
  /** Display-only insertion point within an assistant message that was streaming. */
  transcriptAnchor?: TranscriptAnchor;
  error?: string; // Error message if stream failed
  errorType?: StreamErrorType; // Error type/category if stream failed
  // Compaction source: "user" (manual /compact), "idle" (auto-triggered summary),
  // "heartbeat" (synthetic heartbeat reset boundary), or legacy boolean `true`.
  // Readers should use helper: isCompacted = compacted !== undefined && compacted !== false
  compacted?: "user" | "idle" | "heartbeat" | boolean;
  /**
   * Monotonic compaction epoch identifier.
   *
   * Legacy histories may omit this; compaction code backfills by counting historical compacted summaries.
   */
  compactionEpoch?: number;
  /**
   * Durable boundary marker for compaction summaries.
   *
   * This lets downstream logic identify compaction boundaries without mutating history.
   */
  compactionBoundary?: boolean;
  /** Durable provider-context boundary kind. Existing compaction rows are also boundaries via compactionBoundary. */
  contextBoundaryKind?: PersistedContextBoundaryKind;
  toolPolicy?: ToolPolicy; // Tool policy active when this message was sent (user messages only)
  disableWorkspaceAgents?: boolean; // Whether workspace-local agent files were disabled for this user turn
  /** Snapshot of send options used for this user turn (for startup retry recovery). */
  retrySendOptions?: StartupRetrySendOptions;
  agentId?: string; // Agent id active when this message was sent (assistant messages only)
  cmuxMetadata?: MuxMessageMetadata; // Command metadata persisted for legacy message formats
  muxMetadata?: MuxMessageMetadata; // Command metadata used by both frontend and backend message flows
  /** Persisted discriminator for synthetic user turns created by the active-goal loop. */
  kind?: "goal_continuation" | "goal_budget_limit";
  /**
   * Goal identity for `kind` rows. Chat-tail reconciliation only accepts a
   * continuation row as "goal is active" evidence when it was dispatched for
   * the goal being reconciled — a replaced goal's continuation must not
   * reactivate its successor (Codex P2 PRRT_kwDOPxxmWM6cH3kV). Legacy rows
   * without a goalId keep the old any-goal semantics.
   */
  goalId?: string;

  /**
   * ACP-only correlation id propagated through stream events so prompt() can
   * match terminal events to the originating ACP request in shared workspaces.
   */
  acpPromptId?: string;

  /**
   * RLM keep-recent floor: marks a sanitized copy of a pre-compaction message
   * re-appended after its compaction boundary so the model keeps the recent
   * tail verbatim. Copies are synthetic (UI-hidden — the originals remain
   * visible above the boundary) and carry no usage/cost metadata so session
   * usage rebuilds never double-count them.
   */
  rlmPreservedTailCopy?: boolean;

  /**
   * @file mention snapshot token(s) this message provides content for.
   * Marks send-time materialized snapshot rows (the only @mention expansion
   * path); requests are built purely from history, so these rows carry the
   * file content and preserve prompt cache stability across turns.
   */
  fileAtMentionSnapshot?: string[];

  /**
   * Agent skill snapshot metadata for synthetic messages that inject skill bodies.
   */
  agentSkillSnapshot?: {
    skillName: string;
    scope: AgentSkillScope;
    sha256: string;
    /**
     * YAML frontmatter for the resolved skill (no `---` delimiters).
     * Optional for backwards compatibility with older histories.
     */
    frontmatterYaml?: string;
  };
  mcpPromptSnapshot?: {
    serverName: string;
    promptName: string;
    commandKey: string;
    /** Missing legacy values are treated as crash orphans. */
    invokingMessageId?: string;
    description?: string;
  };
}

// Extended tool part type that supports interrupted tool calls (input-available state)
// Standard AI SDK ToolUIPart only supports output-available (completed tools)
// Uses discriminated union: output is required when state is "output-available", absent when "input-available"
export type MuxToolPart = z.infer<typeof MuxToolPartSchema>;

// Text part type
export interface MuxTextPart {
  type: "text";
  text: string;
  timestamp?: number;
}

// Reasoning part type for extended thinking content
export interface MuxReasoningPart {
  type: "reasoning";
  text: string;
  timestamp?: number;
  /**
   * Anthropic thinking block signature for replay.
   * Required to send reasoning back to Anthropic - the API validates signatures
   * to ensure thinking blocks haven't been tampered with. Reasoning without
   * signatures will be stripped before sending to avoid "empty content" errors.
   */
  signature?: string;
  /**
   * Persisted replay data for reasoning parts. The SDK's convertToModelMessages
   * only reads `providerMetadata` from UI parts, so attachReasoningReplayMetadata
   * mirrors this field there at request time so reasoning can be replayed:
   * - Anthropic: { anthropic: { signature } }
   * - OpenAI/xAI Responses (esp. store=false/ZDR): itemId + reasoningEncryptedContent
   *   so the next turn can restore encrypted reasoning without server-side storage.
   * - Google: { google: { thoughtSignature } }
   */
  providerOptions?: {
    anthropic?: {
      signature?: string;
    };
    openai?: {
      itemId?: string;
      reasoningEncryptedContent?: string | null;
    };
    xai?: {
      itemId?: string;
      reasoningEncryptedContent?: string | null;
    };
    google?: {
      thoughtSignature?: string;
    };
  };
}

// File part type for multimodal messages (matches AI SDK FileUIPart)
export interface MuxFilePart {
  type: "file";
  mediaType: string; // IANA media type, e.g., "image/png", "application/pdf"
  url: string; // Data URL (e.g., "data:application/pdf;base64,...") or hosted URL
  filename?: string; // Optional filename
  /**
   * Part-level metadata convertToModelMessages forwards as FilePart.providerOptions.
   * Used to mark request-only synthetic tool-media parts (see
   * SYNTHETIC_TOOL_MEDIA_PART_METADATA in toolResultAttachments.ts) so per-step
   * transforms can evict the oldest ones under the request-wide media cap
   * instead of treating them like immutable user uploads (r34).
   */
  providerMetadata?: Record<string, Record<string, unknown>>;
}

// XumMessage extends UIMessage with our metadata and custom parts
// Supports text, reasoning, file, and tool parts (including interrupted tool calls)
export type MuxMessage = Omit<UIMessage<MuxMetadata, never, never>, "parts"> & {
  parts: Array<MuxTextPart | MuxReasoningPart | MuxFilePart | MuxToolPart>;
};

// DisplayedMessage represents a single UI message block
// This is what the UI components consume, splitting complex messages into separate visual blocks
export type DisplayedMessage =
  | {
      type: "user";
      id: string; // Display ID for UI/React keys
      historyId: string; // Original XumMessage ID for history operations
      content: string;
      /**
       * Command prefix to highlight in the UI (e.g. "/compact -m sonnet" or "/react-effects").
       * Only set when a slash command was processed.
       */
      commandPrefix?: string;
      fileParts?: FilePart[]; // Optional attachments
      historySequence: number; // Global ordering across all messages
      isSynthetic?: boolean;
      /** True only for synthetic messages intentionally rendered in the normal transcript. */
      isUiVisible?: boolean;
      /** Durable terminal rejection: keep visible, but never retry this or an older turn. */
      contextBudgetRejected?: true;
      timestamp?: number;
      /** True for synthetic user turns created by the active-goal continuation loop. */
      isGoalContinuation?: boolean;
      /** True for the one-shot wrap-up turn after a goal continuation exhausts its budget. */
      isBudgetLimitWrapup?: boolean;
      /** True when this row is loaded above the latest Context Boundary and must not mutate active context. */
      isBeforeLatestContextBoundary?: boolean;
      /** Present when this message invoked an agent skill or MCP prompt via slash command. */
      agentSkill?: {
        skillName: string;
        scope: AgentSkillScope;
        /** Trimmed slash-command argument text; preserved so compaction retry can rebuild metadata. */
        arguments?: string;
        /**
         * Optional snapshot content attached later by message aggregation (e.g. tooltips).
         * Not persisted on the user message itself.
         */
        snapshot?: {
          frontmatterYaml?: string;
          body?: string;
        };
      };
      /** Preserved so compaction retry can rematerialize MCP prompt invocations. */
      mcpPromptRefs?: MCPPromptReference[];
      /** Preserved so compaction retry can rematerialize inline skill references. */
      agentSkillRefs?: AgentSkillReference[];
      /**
       * Inline skill and MCP prompt snapshots are derived from prior synthetic messages.
       * They are not persisted on the user message itself.
       */
      inlineSkillSnapshots?: InlineSkillSnapshotMap;
      /** Present when this message is a /compact command */
      compactionRequest?: {
        parsed: CompactionRequestData;
      };
      /** Structured review data for rich UI display (from muxMetadata) */
      reviews?: ReviewNoteDataForDisplay[];
      /** Present when this synthetic turn is a background bash monitor wake-up. */
      bashMonitorWake?: {
        records: BashMonitorWakeDisplayRecord[];
      };
      /**
       * True for the fixed user-role notification that wakes a peer-message recipient (the
       * payload itself is a separate assistant row). Excluded from human-prompt navigation.
       */
      agentPeerMessageTrigger?: true;
      /** Synthetic flush warning; displayed as a machine row, not a human prompt. */
      contextBudgetWarning?: {
        contextTokens: number;
        maxTokens: number;
      };
    }
  | {
      type: "assistant";
      id: string; // Display ID for UI/React keys
      historyId: string; // Original XumMessage ID for history operations
      content: string;
      historySequence: number; // Global ordering across all messages
      isStreaming: boolean;
      isPartial: boolean; // Whether this message was interrupted
      isLastPartOfMessage?: boolean; // True if this is the last part of a multi-part message
      isCompacted: boolean; // Whether this is a compacted summary
      isIdleCompacted: boolean; // Whether this compaction was auto-triggered due to inactivity
      /** True when this assistant row predates the latest Context Boundary. */
      isBeforeLatestContextBoundary?: boolean;
      model?: string;
      routedThroughGateway?: boolean;
      routeProvider?: string;
      /** Present when a fallback model answered after the requested model refused. */
      modelFallback?: ModelFallbackRecord;
      agentId?: string; // Agent id active when this message was sent (assistant messages only)
      /** @deprecated Legacy base mode derived from agent definition. */
      mode?: AgentMode;
      timestamp?: number;
      tokens?: number;
      /** Presentation hint for smooth streaming — indicates if this is live or replayed content. */
      streamPresentation?: {
        source: "live" | "replay";
      };
      /**
       * Present when this synthetic assistant row is an intra-tree agent peer message payload
       * (delivered as an assistant pre-turn row so peer bytes never gain user-role authority).
       */
      agentPeerMessage?: {
        fromWorkspaceId: string;
        fromTitle?: string;
        relationship: AgentMessageRelationship;
      };
    }
  | {
      type: "tool";
      id: string; // Display ID for UI/React keys
      historyId: string; // Original XumMessage ID for history operations
      toolCallId: string;
      toolName: string;
      args: unknown;
      result?: unknown;
      status: "pending" | "executing" | "completed" | "failed" | "interrupted" | "redacted";
      isPartial: boolean; // Whether the parent message was interrupted
      historySequence: number; // Global ordering across all messages
      isLastPartOfMessage?: boolean; // True if this is the last part of a multi-part message
      timestamp?: number;
      /**
       * When the tool's execute() actually began running. Parallel tool calls are
       * serialized, so this can be much later than `timestamp`; elapsed timers must
       * start here (and stay hidden while the call is still queued).
       */
      executionStartedAt?: number;
      /** Durable workflow run attachment recovered from partial history. */
      workflowRun?: MuxToolPart["workflowRun"];
      // Nested tool calls for code_execution (from PTC streaming or reconstructed from result)
      // input is optional to mirror NestedToolCallSchema: zero-arg kernel calls
      // persist without an input key.
      nestedCalls?: Array<{
        toolCallId: string;
        toolName: string;
        input?: unknown;
        output?: unknown;
        state: "input-available" | "output-available" | "output-redacted";
        failed?: boolean;
        timestamp?: number;
        /** Durable run identity for nested workflow tool calls (see NestedToolCallSchema). */
        workflowRun?: MuxToolPart["workflowRun"];
      }>;
    }
  | {
      type: "reasoning";
      id: string; // Display ID for UI/React keys
      historyId: string; // Original XumMessage ID for history operations
      content: string;
      historySequence: number; // Global ordering across all messages
      isStreaming: boolean;
      isPartial: boolean; // Whether the parent message was interrupted
      isLastPartOfMessage?: boolean; // True if this is the last part of a multi-part message
      /** True when this is the only renderable content in the parent assistant message
       *  (no text or tool parts). Used to suppress auto-collapse so a reasoning-only
       *  turn (e.g. one truncated mid-thinking by max_tokens) doesn't visually disappear
       *  the moment the stream ends. */
      isOnlyMessageContent?: boolean;
      timestamp?: number;
      tokens?: number; // Reasoning tokens if available
      /** Presentation hint for smooth streaming — indicates if this is live or replayed content. */
      streamPresentation?: {
        source: "live" | "replay";
      };
    }
  | {
      type: "stream-error";
      id: string; // Display ID for UI/React keys
      historyId: string; // Original XumMessage ID for history operations
      error: string; // Error message
      errorType: StreamErrorType; // Error type/category
      historySequence: number; // Global ordering across all messages
      timestamp?: number;
      model?: string;
      routedThroughGateway?: boolean;
      errorCount?: number; // Number of consecutive identical errors merged into this message
    }
  | {
      type: "compaction-boundary";
      id: string; // Display ID for UI/React keys
      historySequence: number; // Sequence of the compaction summary this boundary belongs to
      boundaryKind?: ContextBoundaryKind;
      /** Distinguishes automatic rollover from a manual reset without changing boundary semantics. */
      contextWindowRollover?: true;
      position: "start" | "end";
      compactionEpoch?: number;
      strategy?: CompactionSummaryMetadata["strategy"];
    }
  | {
      type: "history-hidden";
      id: string; // Display ID for UI/React keys
      hiddenCount: number; // Number of messages hidden
      historySequence: number; // Global ordering across all messages
      /** Breakdown of omitted message types (when truncating for performance). */
      omittedMessageCounts?: {
        tool: number;
        reasoning: number;
      };
    }
  | {
      type: "workspace-init";
      id: string; // Display ID for UI/React keys
      historySequence: number; // Position in message stream (-1 for ephemeral, non-persisted events)
      status: "running" | "success" | "error";
      hookPath: string; // Path to the init script being executed
      lines: Array<{ line: string; isError: boolean }>; // Accumulated output lines (stderr tagged via isError)
      exitCode: number | null; // Final exit code (null while running)
      timestamp: number;
      durationMs: number | null; // Duration in milliseconds (null while running)
      truncatedLines?: number; // Number of lines dropped from middle when output was too long
    }
  | {
      type: "plan-display"; // Ephemeral plan display from /plan command
      id: string; // Display ID for UI/React keys
      historyId: string; // Original XumMessage ID (same as id for ephemeral messages)
      content: string; // Plan markdown content
      path: string; // Path to the plan file
      historySequence: number; // Global ordering across all messages
    };

/** Convenience type alias for user-role DisplayedMessage */
export type DisplayedUserMessage = Extract<DisplayedMessage, { type: "user" }>;

type QueueDispatchMode = NonNullable<SendMessageOptions["queueDispatchMode"]>;

export interface QueuedMessage {
  id: string;
  content: string;
  fileParts?: FilePart[];
  /** Structured review data for rich UI display (from muxMetadata) */
  reviews?: ReviewNoteDataForDisplay[];
  /** How the backend will flush this queue (step-level vs turn-level boundary). */
  queueDispatchMode?: QueueDispatchMode;
  /** True when the queued message is a compaction request (/compact) */
  hasCompactionRequest?: boolean;
}

/** Keep every snapshot kind here so history scans and edits retain it with its user message. */
export function isSyntheticSnapshotUserMessage(message: MuxMessage): boolean {
  return (
    message.role === "user" &&
    message.metadata?.synthetic === true &&
    (message.metadata.fileAtMentionSnapshot !== undefined ||
      message.metadata.agentSkillSnapshot !== undefined ||
      message.metadata.mcpPromptSnapshot !== undefined)
  );
}

// Helper to create a simple text message
export function createMuxMessage(
  id: string,
  role: "user" | "assistant",
  content: string,
  metadata?: MuxMetadata,
  additionalParts?: MuxMessage["parts"]
): MuxMessage {
  const textPart = content
    ? [{ type: "text" as const, text: content, state: "done" as const }]
    : [];
  const parts = [...textPart, ...(additionalParts ?? [])];

  // Validation: User messages must have at least one part with content
  // This prevents empty user messages from being created (defense-in-depth)
  if (role === "user" && parts.length === 0) {
    throw new Error(
      "Cannot create user message with no parts. Empty messages should be rejected upstream."
    );
  }

  return {
    id,
    role,
    metadata,
    parts,
  };
}

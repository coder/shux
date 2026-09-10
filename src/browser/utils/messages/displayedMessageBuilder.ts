import { restoreContextBudgetRejectedMessageForDisplay } from "@/common/utils/messages/contextBudgetRejection";
import type {
  BashMonitorWakeDisplayRecord,
  CompactionRequestData,
  DisplayedMessage,
  InlineSkillSnapshotMap,
  MuxFilePart,
  MuxMessage,
  MuxMessageMetadata,
} from "@/common/types/message";
import {
  getCompactionFollowUpContent,
  isRolloverBoundary,
  sanitizeAgentSkillRefs,
  sanitizeMcpPromptRefs,
} from "@/common/types/message";
import type { StreamErrorType } from "@/common/types/errors";
import {
  getValidAgentPeerMessageMeta,
  getValidAgentPeerTriggerMeta,
  parseAgentMessageEnvelope,
} from "@/common/utils/agentMessageEnvelope";
import { GOAL_BUDGET_LIMIT_KIND, GOAL_CONTINUATION_KIND } from "@/constants/goals";
import { getFollowUpContentText } from "@/browser/utils/compaction/format";
import { getGoalClearedSummaryDisplayText } from "@/common/utils/goalClearedSummaryDisplay";
import { assert } from "@/common/utils/assert";
import {
  CONTEXT_BOUNDARY_KINDS,
  getContextBoundaryKind,
} from "@/common/utils/messages/compactionBoundary";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { isRefusalFinishReason } from "@/common/utils/messages/refusalFinishReason";
import { isDynamicToolPart, type DynamicToolPart } from "@/common/types/toolParts";

/**
 * Check if a tool result indicates success (for tools that return { success: boolean })
 */
export function hasSuccessResult(result: unknown): boolean {
  return (
    typeof result === "object" && result !== null && "success" in result && result.success === true
  );
}

/**
 * Check if a tool result indicates failure.
 * Handles both explicit failure ({ success: false }) and implicit failure ({ error: "..." })
 */
export function hasFailureResult(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  // Explicit failure
  if ("success" in result && result.success === false) return true;
  // Implicit failure - error field present
  if ("error" in result && result.error) return true;
  return false;
}

export function resolveRouteProvider(
  routeProvider: string | undefined,
  routedThroughGateway: boolean | undefined
): string | undefined {
  return routeProvider ?? (routedThroughGateway === true ? "mux-gateway" : undefined);
}

export function normalizeMessageRouteProvider(message: MuxMessage): MuxMessage {
  const routeProvider = resolveRouteProvider(
    message.metadata?.routeProvider,
    message.metadata?.routedThroughGateway
  );

  if (!message.metadata || routeProvider === message.metadata.routeProvider) {
    return message;
  }

  return {
    ...message,
    metadata: {
      ...message.metadata,
      routeProvider,
    },
  };
}

/**
 * Merge adjacent text/reasoning parts using array accumulation + join().
 * Avoids O(n²) string allocations from repeated concatenation.
 * Tool parts are preserved as-is between merged text/reasoning runs.
 */
export function mergeAdjacentParts(parts: MuxMessage["parts"]): MuxMessage["parts"] {
  if (parts.length <= 1) return parts;

  const merged: MuxMessage["parts"] = [];
  let pendingTexts: string[] = [];
  let pendingTextTimestamp: number | undefined;
  let pendingReasonings: string[] = [];
  let pendingReasoningTimestamp: number | undefined;

  const flushText = () => {
    if (pendingTexts.length > 0) {
      merged.push({
        type: "text",
        text: pendingTexts.join(""),
        timestamp: pendingTextTimestamp,
      });
      pendingTexts = [];
      pendingTextTimestamp = undefined;
    }
  };

  const flushReasoning = () => {
    if (pendingReasonings.length > 0) {
      merged.push({
        type: "reasoning",
        text: pendingReasonings.join(""),
        timestamp: pendingReasoningTimestamp,
      });
      pendingReasonings = [];
      pendingReasoningTimestamp = undefined;
    }
  };

  for (const part of parts) {
    if (part.type === "text") {
      flushReasoning();
      pendingTexts.push(part.text);
      pendingTextTimestamp ??= part.timestamp;
    } else if (part.type === "reasoning") {
      flushText();
      pendingReasonings.push(part.text);
      pendingReasoningTimestamp ??= part.timestamp;
    } else {
      // Tool part - flush and keep as-is
      flushText();
      flushReasoning();
      merged.push(part);
    }
  }
  flushText();
  flushReasoning();

  return merged;
}

export function getTextPartContent(parts: ReadonlyArray<MuxMessage["parts"][number]>): string {
  const content: string[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      content.push(part.text);
    }
  }
  return content.join("");
}

function createCompactionBoundaryRow(
  message: MuxMessage,
  historySequence: number
): Extract<DisplayedMessage, { type: "compaction-boundary" }> {
  assert(message.role === "assistant", "compaction boundaries must belong to assistant summaries");

  const rawCompactionEpoch = message.metadata?.compactionEpoch;
  const compactionEpoch =
    typeof rawCompactionEpoch === "number" &&
    Number.isInteger(rawCompactionEpoch) &&
    rawCompactionEpoch > 0
      ? rawCompactionEpoch
      : undefined;

  // Self-healing read path: malformed persisted compactionEpoch should not crash transcript rendering.
  return {
    type: "compaction-boundary",
    id: `${message.id}-compaction-boundary`,
    historySequence,
    boundaryKind: getContextBoundaryKind(message) ?? CONTEXT_BOUNDARY_KINDS.COMPACTION,
    position: "start",
    contextWindowRollover: isRolloverBoundary(message) ? true : undefined,
    compactionEpoch,
    ...(message.metadata?.muxMetadata?.type === "compaction-summary" &&
    message.metadata.muxMetadata.strategy === "continuous"
      ? { strategy: "continuous" }
      : {}),
  };
}

export interface BuildDisplayedMessagesForMessageOptions {
  message: MuxMessage;
  agentSkillSnapshot?: { frontmatterYaml?: string; body?: string };
  inlineSkillSnapshots?: InlineSkillSnapshotMap;
  hasActiveStream: boolean;
  streamIsReplay?: boolean;
  isContextBoundaryMessage: (message: MuxMessage) => boolean;
}

type ToolDisplayStatus = Extract<DisplayedMessage, { type: "tool" }>["status"];
type NestedToolCalls = NonNullable<DynamicToolPart["nestedCalls"]>;

function buildPlanDisplayMessages(
  message: MuxMessage,
  historySequence: number
): DisplayedMessage[] | undefined {
  const muxMeta = message.metadata?.muxMetadata;
  if (muxMeta?.type !== "plan-display") {
    return undefined;
  }

  return [
    {
      type: "plan-display",
      id: message.id,
      historyId: message.id,
      content: getTextPartContent(message.parts),
      path: muxMeta.path,
      historySequence,
    },
  ];
}

/**
 * muxMetadata is a black box across the oRPC boundary, so a corrupted
 * chat.jsonl can persist `type: "bash-monitor-wake"` with missing/mistyped
 * records. Validate the shape here and fall back to the normal full-text user
 * message rendering (return undefined) so one malformed line can't brick the
 * transcript (see AGENTS.md self-healing rule).
 */
function getValidBashMonitorWakeRecords(
  muxMeta: MuxMessageMetadata | undefined
): BashMonitorWakeDisplayRecord[] | undefined {
  if (muxMeta?.type !== "bash-monitor-wake") return undefined;
  const records: unknown = muxMeta.records;
  if (!Array.isArray(records) || records.length === 0) return undefined;
  const isValidRecord = (record: unknown): record is BashMonitorWakeDisplayRecord =>
    isPlainObject(record) &&
    (record.kind === "match" || record.kind === "monitor-lost") &&
    typeof record.displayName === "string" &&
    typeof record.filter === "string" &&
    typeof record.filterExclude === "boolean";
  if (!records.every(isValidRecord)) return undefined;
  // Self-healing for the optional settlement fields: an invalid terminal or staleTerminal shape
  // drops that field, not the record, so the wake still renders with its base summary.
  const isValidTerminal = (
    terminal: unknown
  ): terminal is NonNullable<BashMonitorWakeDisplayRecord["terminal"]> =>
    isPlainObject(terminal) &&
    (terminal.status === "exited" ||
      terminal.status === "killed" ||
      terminal.status === "failed" ||
      terminal.status === "unknown") &&
    (terminal.exitCode === undefined || typeof terminal.exitCode === "number");
  return records.map((record) => {
    const terminalValid = record.terminal === undefined || isValidTerminal(record.terminal);
    const staleValid = record.staleTerminal === undefined || isValidTerminal(record.staleTerminal);
    if (terminalValid && staleValid) return record;
    const { terminal, staleTerminal, ...rest } = record;
    return {
      ...rest,
      ...(terminalValid && terminal !== undefined ? { terminal } : {}),
      ...(staleValid && staleTerminal !== undefined ? { staleTerminal } : {}),
    };
  });
}

/**
 * Same self-healing contract as getValidBashMonitorWakeRecords: peer metadata is persisted
 * black-box data, so a corrupted row (e.g. object-valued fromTitle rendered as a React child)
 * must fall back to normal user-message rendering instead of bricking the transcript.
 *
 * Authenticity mirrors the provider sanitizer: the row must carry synthetic provenance and its
 * text must be a well-formed envelope whose sender fields MATCH the metadata. A partially
 * corrupted row (valid-looking metadata on ordinary model output, or a metadata/envelope sender
 * mismatch) renders as an ordinary assistant message instead of collapsing under another
 * sender's attribution.
 */
function getValidAgentPeerMessage(
  message: { metadata?: { muxMetadata?: MuxMessageMetadata; synthetic?: boolean } },
  partText: string
): NonNullable<Extract<DisplayedMessage, { type: "assistant" }>["agentPeerMessage"]> | undefined {
  const meta = getValidAgentPeerMessageMeta(message.metadata?.muxMetadata);
  if (meta == null || message.metadata?.synthetic !== true) {
    return undefined;
  }
  const parsed = parseAgentMessageEnvelope(partText);
  if (
    parsed == null ||
    parsed.from !== meta.fromWorkspaceId ||
    parsed.relationship !== meta.relationship ||
    parsed.fromTitle !== meta.fromTitle
  ) {
    return undefined;
  }
  return meta;
}

function getRawCommand(muxMetadata: unknown): string | undefined {
  if (!isPlainObject(muxMetadata) || typeof muxMetadata.type !== "string") {
    return undefined;
  }

  // Unknown persisted metadata must render as an ordinary row rather than
  // inheriting command-specific display behavior from a coincidental field.
  switch (muxMetadata.type) {
    case "compaction-request":
    case "agent-skill":
    case "normal":
    case "workflow-trigger-display":
    case "workflow-result":
      return typeof muxMetadata.rawCommand === "string" ? muxMetadata.rawCommand : undefined;
    default:
      return undefined;
  }
}

function buildUserDisplayedMessages(options: {
  message: MuxMessage;
  agentSkillSnapshot?: { frontmatterYaml?: string; body?: string };
  inlineSkillSnapshots?: InlineSkillSnapshotMap;
  baseTimestamp?: number;
  historySequence: number;
}): DisplayedMessage[] {
  const { message, agentSkillSnapshot, inlineSkillSnapshots, baseTimestamp, historySequence } =
    options;
  const muxMeta = message.metadata?.muxMetadata;
  const partsContent = getTextPartContent(message.parts);

  const fileParts = message.parts
    .filter((p): p is MuxFilePart => p.type === "file")
    .map((p) => ({
      url: typeof p.url === "string" ? p.url : "",
      mediaType: p.mediaType,
      filename: p.filename,
    }));

  let rawCommand = getRawCommand(muxMeta);
  const sanitizedMcpPromptRefs = sanitizeMcpPromptRefs(muxMeta?.mcpPromptRefs);
  const mcpPromptRefs = sanitizedMcpPromptRefs.length > 0 ? sanitizedMcpPromptRefs : undefined;
  const sanitizedAgentSkillRefs = sanitizeAgentSkillRefs(muxMeta?.agentSkillRefs);
  const agentSkillRefs = sanitizedAgentSkillRefs.length > 0 ? sanitizedAgentSkillRefs : undefined;
  const slashMcpPromptRef = mcpPromptRefs?.find((ref) => ref.source === "slash");
  const agentSkill =
    muxMeta?.type === "agent-skill"
      ? {
          skillName: muxMeta.skillName,
          scope: muxMeta.scope,
          arguments: muxMeta.arguments,
          snapshot: agentSkillSnapshot,
        }
      : slashMcpPromptRef
        ? {
            skillName: slashMcpPromptRef.commandKey,
            scope: "built-in" as const,
            snapshot: agentSkillSnapshot,
          }
        : undefined;

  const bashMonitorWakeRecords = getValidBashMonitorWakeRecords(muxMeta);

  const compactionFollowUp = getCompactionFollowUpContent(muxMeta);
  const compactionRequest =
    muxMeta?.type === "compaction-request"
      ? {
          parsed: {
            model: muxMeta.parsed.model,
            maxOutputTokens: muxMeta.parsed.maxOutputTokens,
            followUpContent: compactionFollowUp,
          } satisfies CompactionRequestData,
        }
      : undefined;

  // Reconstruct full rawCommand if follow-up text isn't already included.
  if (rawCommand && compactionRequest?.parsed.followUpContent && !rawCommand.includes("\n")) {
    const followUpText = getFollowUpContentText(compactionRequest.parsed.followUpContent);
    if (followUpText) {
      rawCommand = `${rawCommand}\n${followUpText}`;
    }
  }

  return [
    {
      type: "user",
      id: message.id,
      historyId: message.id,
      content: rawCommand ?? partsContent,
      commandPrefix: muxMeta?.commandPrefix,
      fileParts: fileParts.length > 0 ? fileParts : undefined,
      historySequence,
      isSynthetic: message.metadata?.synthetic === true ? true : undefined,
      isUiVisible: message.metadata?.uiVisible === true ? true : undefined,
      contextBudgetRejected: message.metadata?.contextBudgetRejected === true ? true : undefined,
      isGoalContinuation: message.metadata?.kind === GOAL_CONTINUATION_KIND ? true : undefined,
      isBudgetLimitWrapup: message.metadata?.kind === GOAL_BUDGET_LIMIT_KIND ? true : undefined,
      timestamp: baseTimestamp,
      agentSkill,
      mcpPromptRefs,
      agentSkillRefs,
      inlineSkillSnapshots,
      compactionRequest,
      reviews: muxMeta?.reviews,
      bashMonitorWake: bashMonitorWakeRecords ? { records: bashMonitorWakeRecords } : undefined,
      // Only genuine machine rows get collapsed; corrupted metadata must not hide human input.
      contextBudgetWarning:
        message.metadata?.synthetic === true &&
        muxMeta?.type === "context-budget-warning" &&
        Number.isFinite(muxMeta.contextTokens) &&
        muxMeta.contextTokens >= 0 &&
        Number.isFinite(muxMeta.maxTokens) &&
        muxMeta.maxTokens > 0
          ? {
              contextTokens: muxMeta.contextTokens,
              maxTokens: muxMeta.maxTokens,
              final: muxMeta.final === true,
            }
          : undefined,
      // The peer-message wake trigger is a synthetic machine row: mark it so prompt
      // navigation skips it (the envelope payload itself is a separate assistant row). When the
      // recipient is executing a delegated workspace turn, the trigger carries that turn's
      // correlation metadata with the attribution nested on it. SECURITY/self-healing: require
      // synthetic provenance AND validated attribution before collapsing the row — a corrupted
      // human user row wearing peer metadata must fall back to ordinary rendering, not be
      // disguised as a machine notification hidden from prompt navigation.
      agentPeerMessageTrigger:
        message.metadata?.synthetic === true &&
        (muxMeta?.type === "agent-peer-message"
          ? getValidAgentPeerMessageMeta(muxMeta) != null
          : muxMeta?.type === "workspace-turn-task" &&
            getValidAgentPeerTriggerMeta(muxMeta.agentPeerMessageTrigger) != null)
          ? true
          : undefined,
    },
  ];
}

function isRenderableDisplayPart(part: MuxMessage["parts"][number]): boolean {
  return (
    part.type === "reasoning" ||
    (part.type === "text" && Boolean(part.text)) ||
    isDynamicToolPart(part)
  );
}

function getRenderablePartStats(parts: MuxMessage["parts"]): {
  lastPartIndex: number;
  isReasoningOnlyMessage: boolean;
} {
  let lastPartIndex = -1;
  let renderableCount = 0;
  let renderableReasoningCount = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!isRenderableDisplayPart(part)) continue;
    lastPartIndex = i;
    renderableCount++;
    if (part.type === "reasoning") renderableReasoningCount++;
  }

  return {
    lastPartIndex,
    isReasoningOnlyMessage: renderableCount > 0 && renderableCount === renderableReasoningCount,
  };
}

function appendReasoningRow(
  displayedMessages: DisplayedMessage[],
  options: {
    message: MuxMessage;
    part: Extract<MuxMessage["parts"][number], { type: "reasoning" }>;
    partIndex: number;
    historySequence: number;
    isStreaming: boolean;
    isPartial: boolean;
    isLastPartOfMessage: boolean;
    isReasoningOnlyMessage: boolean;
    baseTimestamp?: number;
    streamIsReplay?: boolean;
  }
): void {
  displayedMessages.push({
    type: "reasoning",
    id: `${options.message.id}-${options.partIndex}`,
    historyId: options.message.id,
    content: options.part.text,
    historySequence: options.historySequence,
    isStreaming: options.isStreaming,
    isPartial: options.isPartial,
    isLastPartOfMessage: options.isLastPartOfMessage,
    isOnlyMessageContent: options.isReasoningOnlyMessage,
    timestamp: options.part.timestamp ?? options.baseTimestamp,
    streamPresentation: options.isStreaming
      ? { source: options.streamIsReplay ? "replay" : "live" }
      : undefined,
  });
}

function appendAssistantTextRow(
  displayedMessages: DisplayedMessage[],
  options: {
    message: MuxMessage;
    part: Extract<MuxMessage["parts"][number], { type: "text" }>;
    partIndex: number;
    historySequence: number;
    isStreaming: boolean;
    isPartial: boolean;
    isLastPartOfMessage: boolean;
    baseTimestamp?: number;
    streamIsReplay?: boolean;
  }
): void {
  const { message, part } = options;
  displayedMessages.push({
    type: "assistant",
    id: `${message.id}-${options.partIndex}`,
    historyId: message.id,
    content: getGoalClearedSummaryDisplayText(part.text, message.metadata?.muxMetadata),
    historySequence: options.historySequence,
    isStreaming: options.isStreaming,
    isPartial: options.isPartial,
    isLastPartOfMessage: options.isLastPartOfMessage,
    // Support both new enum ("user"|"idle") and legacy boolean (true).
    isCompacted: !!message.metadata?.compacted,
    isIdleCompacted: message.metadata?.compacted === "idle",
    model: message.metadata?.model,
    routedThroughGateway: message.metadata?.routedThroughGateway,
    routeProvider: resolveRouteProvider(
      message.metadata?.routeProvider,
      message.metadata?.routedThroughGateway
    ),
    modelFallback: message.metadata?.modelFallback,
    mode: message.metadata?.mode,
    agentId: message.metadata?.agentId ?? message.metadata?.mode,
    timestamp: part.timestamp ?? options.baseTimestamp,
    streamPresentation: options.isStreaming
      ? { source: options.streamIsReplay ? "replay" : "live" }
      : undefined,
    // Backend-attached metadata (never model-authored text) gates the peer-message card, so a
    // model-emitted lookalike envelope still renders as an ordinary assistant message.
    agentPeerMessage: getValidAgentPeerMessage(message, part.text),
  });
}

function getToolDisplayStatus(part: DynamicToolPart, isPartial: boolean): ToolDisplayStatus {
  if (part.state === "output-available") {
    return hasFailureResult(part.output) ? "failed" : "completed";
  }
  if (part.state === "output-redacted") {
    return part.failed ? "failed" : "redacted";
  }
  if (part.state === "input-available") {
    return part.toolName === "ask_user_question"
      ? "executing"
      : isPartial
        ? "interrupted"
        : "executing";
  }
  return "pending";
}

function getObjectField(value: unknown, field: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[field]
    : undefined;
}

function reconstructCodeExecutionNestedCalls(part: DynamicToolPart): NestedToolCalls | undefined {
  if (part.toolName !== "code_execution" || part.state !== "output-available") {
    return undefined;
  }

  const toolCalls = getObjectField(part.output, "toolCalls");
  if (!Array.isArray(toolCalls)) {
    return undefined;
  }

  const nestedCalls: NestedToolCalls = [];
  for (const [idx, toolCall] of toolCalls.entries()) {
    if (typeof toolCall !== "object" || toolCall === null) {
      continue;
    }
    const record = toolCall as Record<string, unknown>;
    if (typeof record.toolName !== "string" || typeof record.duration_ms !== "number") {
      continue;
    }

    const output =
      record.result ??
      (typeof record.error === "string"
        ? // success:false matches the failure shape tool cards and
          // isFailedToolOutput already understand, so the error stays
          // visible (e.g. bash's ErrorBox) after reload.
          { success: false, error: record.error }
        : undefined);
    // RLM kernel-mode compact record (r12): the full nested result never
    // persists in the tool output, so degraded detail after reload is expected
    // (live streaming keeps full detail via part.nestedCalls, which takes
    // precedence). Failure travels out-of-band via `failed` instead of a
    // synthetic output shape, so a real tool result can never be mistaken
    // for a reconstruction stand-in.
    const kernelFailure = output === undefined && record.ok === false;

    nestedCalls.push({
      toolCallId: `${part.toolCallId}-nested-${idx}`,
      toolName: record.toolName,
      input: record.args,
      output,
      ...(kernelFailure ? { failed: true } : {}),
      state: "output-available",
      timestamp: part.timestamp,
    });
  }

  return nestedCalls.length > 0 ? nestedCalls : undefined;
}

function getNestedCallsForDisplay(part: DynamicToolPart): NestedToolCalls | undefined {
  return part.nestedCalls ?? reconstructCodeExecutionNestedCalls(part);
}

function appendToolRows(
  displayedMessages: DisplayedMessage[],
  options: {
    message: MuxMessage;
    part: DynamicToolPart;
    partIndex: number;
    historySequence: number;
    isPartial: boolean;
    isLastPartOfMessage: boolean;
    baseTimestamp?: number;
  }
): void {
  const { message, part } = options;
  const status = getToolDisplayStatus(part, options.isPartial);
  const nestedCalls = getNestedCallsForDisplay(part);
  displayedMessages.push({
    type: "tool",
    id: `${message.id}-${options.partIndex}`,
    historyId: message.id,
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    args: part.input,
    result: part.state === "output-available" ? part.output : undefined,
    status,
    isPartial: options.isPartial,
    historySequence: options.historySequence,
    isLastPartOfMessage: options.isLastPartOfMessage,
    ...(part.workflowRun != null ? { workflowRun: part.workflowRun } : {}),
    timestamp: part.timestamp ?? options.baseTimestamp,
    ...(part.executionStartedAt != null ? { executionStartedAt: part.executionStartedAt } : {}),
    nestedCalls,
  });
}

function getNestedString(value: unknown, path: string[]): string | undefined {
  let current = value;
  for (const segment of path) {
    if (!isPlainObject(current)) {
      return undefined;
    }
    current = current[segment];
  }

  return typeof current === "string" ? current : undefined;
}

// @ai-sdk/anthropic >=3.0.82 maps refusal stop details to this providerMetadata
// shape; older persisted turns simply omit it and fall back to the generic row.
function getProviderRefusalExplanation(message: MuxMessage): string | undefined {
  return getNestedString(message.metadata?.providerMetadata, [
    "anthropic",
    "stopDetails",
    "explanation",
  ]);
}

function buildRefusalFinishMessage(message: MuxMessage): string {
  const finishReason = message.metadata?.finishReason ?? "content-filter";
  const explanation = getProviderRefusalExplanation(message);
  const base =
    `The provider refused to continue this response (finishReason: ${finishReason}). ` +
    "This legacy turn may end abruptly because the older backend treated the refusal as complete.";
  return explanation ? `${base}\n\n${explanation}` : base;
}

function appendStreamErrorRows(
  displayedMessages: DisplayedMessage[],
  options: {
    message: MuxMessage;
    historySequence: number;
    hasActiveStream: boolean;
    baseTimestamp?: number;
  }
): void {
  const pushStreamErrorRow = (
    idSuffix: string,
    error: string,
    errorType: StreamErrorType
  ): void => {
    displayedMessages.push({
      type: "stream-error",
      id: `${options.message.id}-${idSuffix}`,
      historyId: options.message.id,
      error,
      errorType,
      historySequence: options.historySequence,
      model: options.message.metadata?.model,
      routedThroughGateway: options.message.metadata?.routedThroughGateway,
      timestamp: options.baseTimestamp,
    });
  };

  if (options.message.metadata?.error) {
    pushStreamErrorRow(
      "error",
      options.message.metadata.error,
      options.message.metadata.errorType ?? "unknown"
    );
    return;
  }

  // Stream ended cleanly *but* the provider truncated us at max_tokens. The
  // backend treats that as a successful completion, so synthesize a visible row
  // after the stream settles instead of silently ending the chat.
  if (!options.hasActiveStream && options.message.metadata?.finishReason === "length") {
    pushStreamErrorRow(
      "length",
      "The model hit its max output token limit before finishing this response. " +
        "Lower the thinking level (or split the turn into smaller steps) to give it more headroom.",
      "max_output_tokens"
    );
  }

  // Legacy/self-healing path: older backends finalized partial refusals as a
  // clean stream-end with finishReason=content-filter. Surface that explicitly
  // so a refused turn never looks like the assistant simply stopped.
  if (!options.hasActiveStream && isRefusalFinishReason(options.message.metadata?.finishReason)) {
    pushStreamErrorRow("refusal", buildRefusalFinishMessage(options.message), "model_refusal");
  }
}

function buildAssistantDisplayedMessages(options: {
  message: MuxMessage;
  baseTimestamp?: number;
  historySequence: number;
  hasActiveStream: boolean;
  streamIsReplay?: boolean;
  isContextBoundaryMessage: (message: MuxMessage) => boolean;
}): DisplayedMessage[] {
  const {
    message,
    baseTimestamp,
    historySequence,
    hasActiveStream,
    streamIsReplay,
    isContextBoundaryMessage,
  } = options;
  const displayedMessages: DisplayedMessage[] = [];
  const isPartial = message.metadata?.partial === true;
  const mergedParts = mergeAdjacentParts(message.parts);
  const { lastPartIndex, isReasoningOnlyMessage } = getRenderablePartStats(mergedParts);

  if (isContextBoundaryMessage(message)) {
    displayedMessages.push(createCompactionBoundaryRow(message, historySequence));
  }

  mergedParts.forEach((part, partIndex) => {
    const isLastPart = partIndex === lastPartIndex;
    const isStreaming = hasActiveStream && isLastPart;

    if (part.type === "reasoning") {
      appendReasoningRow(displayedMessages, {
        message,
        part,
        partIndex,
        historySequence,
        isStreaming,
        isPartial,
        isLastPartOfMessage: isLastPart,
        isReasoningOnlyMessage,
        baseTimestamp,
        streamIsReplay,
      });
      return;
    }

    if (part.type === "text" && part.text) {
      appendAssistantTextRow(displayedMessages, {
        message,
        part,
        partIndex,
        historySequence,
        isStreaming,
        isPartial,
        isLastPartOfMessage: isLastPart,
        baseTimestamp,
        streamIsReplay,
      });
      return;
    }

    if (isDynamicToolPart(part)) {
      appendToolRows(displayedMessages, {
        message,
        part,
        partIndex,
        historySequence,
        isPartial,
        isLastPartOfMessage: isLastPart,
        baseTimestamp,
      });
    }
  });

  appendStreamErrorRows(displayedMessages, {
    message,
    historySequence,
    hasActiveStream,
    baseTimestamp,
  });

  return displayedMessages;
}

export function buildDisplayedMessagesForMessage(
  options: BuildDisplayedMessagesForMessageOptions
): DisplayedMessage[] {
  const { agentSkillSnapshot, inlineSkillSnapshots, hasActiveStream } = options;
  const message = restoreContextBudgetRejectedMessageForDisplay(options.message);
  const baseTimestamp = message.metadata?.timestamp;
  const historySequence = message.metadata?.historySequence ?? 0;
  const planRows = buildPlanDisplayMessages(message, historySequence);
  if (planRows) {
    return planRows;
  }

  if (message.role === "user") {
    return buildUserDisplayedMessages({
      message,
      agentSkillSnapshot,
      inlineSkillSnapshots,
      baseTimestamp,
      historySequence,
    });
  }

  if (message.role === "assistant") {
    return buildAssistantDisplayedMessages({
      message,
      baseTimestamp,
      historySequence,
      hasActiveStream,
      streamIsReplay: options.streamIsReplay,
      isContextBoundaryMessage: options.isContextBoundaryMessage,
    });
  }

  return [];
}

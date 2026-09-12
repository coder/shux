import type { EventEmitter } from "events";
import { isDeepStrictEqual } from "node:util";
import assert from "@/common/utils/assert";
import { isNonNegativeInteger, isPositiveInteger } from "@/common/utils/numbers";
import * as path from "path";

import type { CompactionFollowUpCleanupOutcome, HistoryService } from "./historyService";

import type { CompactionCompletionMetadata } from "@/common/types/compaction";
import type { ContinuousCompactionPublication } from "./continuousCompactionJournal";
import { exactJson } from "./continuousCompactionJournal";
import { POST_COMPACTION_STATE_FILENAME } from "@/constants/compaction";
import {
  CompactionPendingState,
  type CompactionPendingBoundaryWrite,
} from "./compactionPendingState";
import {
  CompactionPreparationLifecycle,
  type CompactionPreparation,
  type CompactionPreparationSnapshot,
} from "./compactionPreparationLifecycle";
import type { StreamEndEvent } from "@/common/types/stream";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";

import {
  createMuxMessage,
  getCompactionFollowUpContent,
  type CompactionFollowUpRequest,
  type CompactionSummaryMetadata,
  type MuxMessage,
} from "@/common/types/message";
import { createCompactionSummaryMessageId } from "@/node/services/utils/messageIds";
import type { TelemetryService } from "@/node/services/telemetryService";
import { MAX_EDITED_FILES } from "@/common/constants/attachments";
import { roundToBase2 } from "@/common/telemetry/utils";
import { log } from "@/node/services/log";
import { computeRecencyFromMessages } from "@/common/utils/recency";
import {
  extractEditedFileDiffs,
  type FileEditDiff,
} from "@/common/utils/messages/extractEditedFiles";
import {
  isDurableCompactedMarker,
  isDurableContextBoundaryMarker,
  sliceMessagesFromLatestCompactionBoundary,
} from "@/common/utils/messages/compactionBoundary";
import { extractReadFilePaths, mergeReadFilePaths } from "@/common/utils/messages/extractReadFiles";
import {
  estimateMuxMessageTokens,
  getKeepRecentTailStartHistorySequence,
} from "@/common/utils/messages/keepRecentTail";
import { createPreservedTailCopyMessageId } from "@/node/services/utils/messageIds";
import {
  mergeLoadedSkillSnapshots,
  extractLoadedSkillSnapshotsFromMessages,
} from "@/node/services/agentSkills/loadedSkillSnapshots";

/**
 * Check if a string is just a raw JSON object, which suggests the model
 * tried to output a tool call as text (happens when tools are disabled).
 *
 * A valid compaction summary should be prose text describing the conversation,
 * not a JSON blob. This general check catches any tool that might leak through.
 */
export function looksLikeRawJsonObject(text: string): boolean {
  const trimmed = text.trim();

  // Must be a JSON object (not array, not primitive)
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return false;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    // Must parse as a non-null, non-array object
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function mergeFileEditDiffs(existing: FileEditDiff[], incoming: FileEditDiff[]): FileEditDiff[] {
  const merged: FileEditDiff[] = [];
  const seenPaths = new Set<string>();

  for (const diff of incoming) {
    if (seenPaths.has(diff.path)) {
      continue;
    }
    seenPaths.add(diff.path);
    merged.push(diff);
    if (merged.length >= MAX_EDITED_FILES) {
      return merged;
    }
  }

  for (const diff of existing) {
    if (seenPaths.has(diff.path)) {
      continue;
    }
    seenPaths.add(diff.path);
    merged.push(diff);
    if (merged.length >= MAX_EDITED_FILES) {
      return merged;
    }
  }

  return merged;
}

function isCompactedSummaryMessage(message: MuxMessage): boolean {
  return isDurableCompactedMarker(message.metadata?.compacted);
}

function getLatestBoundaryHistorySequence(messages: readonly MuxMessage[]): number | undefined {
  let latest: number | undefined;
  for (const message of messages) {
    if (!isDurableContextBoundaryMarker(message)) continue;
    const sequence = message.metadata?.historySequence;
    if (!isNonNegativeInteger(sequence)) continue;
    if (latest === undefined || sequence > latest) latest = sequence;
  }
  return latest;
}

function getNextCompactionEpoch(messages: MuxMessage[]): number {
  let epochCursor = 0;

  for (const message of messages) {
    const metadata = message.metadata;
    if (!metadata) {
      continue;
    }

    const isCompactedSummary = isCompactedSummaryMessage(message);
    const hasBoundaryMarker = metadata.compactionBoundary === true;
    const epoch = metadata.compactionEpoch;

    if (hasBoundaryMarker && !isCompactedSummary) {
      // Self-healing read path: skip malformed persisted boundary markers.
      // Boundary markers are only valid on compacted summaries.
      log.warn("Skipping malformed compaction boundary while deriving next epoch", {
        messageId: message.id,
        reason: "compactionBoundary set on non-compacted message",
      });
      continue;
    }

    if (!isCompactedSummary) {
      continue;
    }

    if (hasBoundaryMarker) {
      if (!isPositiveInteger(epoch)) {
        // Self-healing read path: invalid boundary metadata should not brick compaction.
        log.warn("Skipping malformed compaction boundary while deriving next epoch", {
          messageId: message.id,
          reason: "compactionBoundary missing positive integer compactionEpoch",
        });
        continue;
      }
      epochCursor = Math.max(epochCursor, epoch);
      continue;
    }

    if (epoch === undefined) {
      // Legacy compacted summaries predate compactionEpoch metadata.
      epochCursor += 1;
      continue;
    }

    if (!isPositiveInteger(epoch)) {
      // Self-healing read path: malformed compactionEpoch should not crash compaction.
      log.warn("Skipping malformed compactionEpoch while deriving next epoch", {
        messageId: message.id,
        reason: "compactionEpoch must be a positive integer when present",
      });
      continue;
    }

    epochCursor = Math.max(epochCursor, epoch);
  }

  const nextEpoch = epochCursor + 1;
  assert(nextEpoch > 0, "next compaction epoch must be positive");
  return nextEpoch;
}

interface CompactionHandlerOptions {
  workspaceId: string;
  historyService: HistoryService;
  sessionDir: string;
  telemetryService?: TelemetryService;
  emitter: EventEmitter;
  /** Called when compaction completes successfully (e.g., to clear idle compaction pending state) */
  onCompactionComplete?: (metadata: CompactionCompletionMetadata) => void;
  /**
   * Called with the terminal outcome of an idle compaction (source === "idle-compaction"),
   * after the summary is actually persisted (success) or a post-stream persistence failure
   * (empty/invalid summary, history write error). Lets the idle loop stop re-attempting a
   * workspace whose compaction keeps failing even though the provider stream ended cleanly.
   */
  onIdleCompactionOutcome?: (success: boolean) => void;
}

/**
 * Handles history compaction for agent sessions
 *
 * Responsible for:
 * - Detecting compaction requests in stream events
 * - Appending compacted summaries as durable history boundaries
 * - Preserving cumulative usage across compactions
 */
export class CompactionHandler {
  private readonly workspaceId: string;
  private readonly historyService: HistoryService;
  private readonly pendingLifecycle: CompactionPreparationLifecycle;
  private readonly telemetryService?: TelemetryService;
  private readonly emitter: EventEmitter;
  private readonly processedCompactionRequestIds: Set<string> = new Set<string>();

  private readonly onCompactionComplete?: (metadata: CompactionCompletionMetadata) => void;
  private readonly onIdleCompactionOutcome?: (success: boolean) => void;

  constructor(options: CompactionHandlerOptions) {
    assert(options, "CompactionHandler requires options");
    assert(typeof options.sessionDir === "string", "sessionDir must be a string");
    const trimmedSessionDir = options.sessionDir.trim();
    assert(trimmedSessionDir.length > 0, "sessionDir must not be empty");

    this.workspaceId = options.workspaceId;
    this.historyService = options.historyService;
    this.pendingLifecycle = new CompactionPreparationLifecycle(
      new CompactionPendingState(
        path.join(trimmedSessionDir, POST_COMPACTION_STATE_FILENAME),
        this.historyService.getCompactionPendingHistory(this.workspaceId)
      )
    );
    this.telemetryService = options.telemetryService;
    this.emitter = options.emitter;
    this.onCompactionComplete = options.onCompactionComplete;
    this.onIdleCompactionOutcome = options.onIdleCompactionOutcome;
  }

  beginPreparation(isCurrent: () => boolean): CompactionPreparation {
    return this.pendingLifecycle.begin(isCurrent);
  }

  async peekPendingState(): Promise<CompactionPreparationSnapshot | null> {
    return (await this.pendingLifecycle.capture("pending")) ?? null;
  }

  async peekCarryoverState(): Promise<CompactionPreparationSnapshot | null> {
    return (await this.pendingLifecycle.capture("carryover")) ?? null;
  }

  async peekPendingDiffs(): Promise<FileEditDiff[] | null> {
    return (await this.peekPendingState())?.diffs ?? null;
  }

  async ackPendingStateConsumed(expected?: CompactionPreparationSnapshot | null): Promise<void> {
    const snapshot = expected === undefined ? await this.peekPendingState() : expected;
    if (snapshot) await this.pendingLifecycle.consume(snapshot, "ack");
  }

  async discardPendingState(
    reason: string,
    expected?: CompactionPreparationSnapshot | null
  ): Promise<void> {
    log.debug("Discarding pending post-compaction state", {
      workspaceId: this.workspaceId,
      reason,
    });
    const snapshot = expected === undefined ? await this.peekPendingState() : expected;
    if (snapshot) await this.pendingLifecycle.consume(snapshot, "discard");
  }

  /** The destructive history generation is already durable; future-format bytes remain inert. */
  async discardPendingStateDurably(_reason: string): Promise<void> {
    await this.pendingLifecycle.discardAfterBoundary();
  }

  private async publishPreparedBoundary(
    preparation: CompactionPreparation,
    messages: MuxMessage[],
    boundary: CompactionPendingBoundaryWrite
  ) {
    messages = structuredClone(messages);
    boundary = {
      ...boundary,
      summaryMessage: structuredClone(boundary.summaryMessage),
      tailCopies: structuredClone(boundary.tailCopies),
      publication: structuredClone(boundary.publication),
    };
    // Every producer reaches this seam, including continuous recovery. Strict publication
    // must not leave a malformed partial permanently blocking otherwise valid compaction.
    const retired = await this.historyService.deletePartialIfMatches(
      this.workspaceId,
      null,
      preparation.isCurrent
    );
    if (!retired.success) return retired;
    const pending = await this.peekPendingState();
    const warm = await this.peekCarryoverState();
    const epoch = sliceMessagesFromLatestCompactionBoundary(messages);
    return this.pendingLifecycle.publish(preparation, {
      ...boundary,
      attachments: {
        diffs: mergeFileEditDiffs(pending?.diffs ?? [], extractEditedFileDiffs(epoch)),
        loadedSkills: mergeLoadedSkillSnapshots([
          ...(warm?.loadedSkills ?? []),
          ...(pending?.loadedSkills ?? []),
          ...extractLoadedSkillSnapshotsFromMessages(epoch),
        ]),
        readFiles: mergeReadFilePaths(
          mergeReadFilePaths(warm?.readFiles ?? [], pending?.readFiles ?? []),
          extractReadFilePaths(epoch)
        ),
      },
    });
  }

  private async retirePartial(
    preparation: CompactionPreparation,
    messageId?: string
  ): Promise<void> {
    const partial = await this.historyService.readPartial(this.workspaceId);
    if (!partial || (messageId != null && partial.id !== messageId)) return;
    // A new turn can flush while preparation awaits; only the captured partial may be removed.
    const result = await this.historyService.deletePartialIfMatches(
      this.workspaceId,
      partial,
      preparation.isCurrent
    );
    if (!result.success) log.warn("Failed to retire compaction partial", result.error);
  }

  private getMaxExistingHistorySequence(messages: MuxMessage[]): number {
    return messages.reduce((maxSeq, message) => {
      const sequence = message.metadata?.historySequence;
      if (sequence === undefined) {
        return maxSeq;
      }

      if (!isNonNegativeInteger(sequence)) {
        // Self-healing read path: malformed persisted historySequence should not brick boundary writes.
        log.warn(
          "Ignoring malformed historySequence while deriving compaction monotonicity bound",
          {
            workspaceId: this.workspaceId,
            messageId: message.id,
            historySequence: sequence,
          }
        );
        return maxSeq;
      }

      return Math.max(maxSeq, sequence);
    }, -1);
  }

  async appendHeartbeatContextResetBoundary(params: {
    boundaryText: string;
    pendingFollowUp: CompactionFollowUpRequest;
    publication?: ContinuousCompactionPublication;
    isCurrent?: () => boolean;
  }): Promise<Result<{ summaryMessageId: string }, string>> {
    assert(
      params.boundaryText.trim().length > 0,
      "appendHeartbeatContextResetBoundary requires non-empty boundary text"
    );

    const preparation = this.beginPreparation(params.isCurrent ?? (() => true));
    const { boundaryText } = params;
    const pendingFollowUp = structuredClone(params.pendingFollowUp);
    // Session callers capture before cancellation admission; never adopt a Stop that lands
    // while the heartbeat gate or boundary preparation is awaiting disk I/O.
    const publication = params.publication
      ? structuredClone(params.publication)
      : {
          generation: await this.historyService
            .getContinuousCompactionJournal(this.workspaceId)
            .captureGeneration(),
        };
    await this.retirePartial(preparation);

    const historyResult = await this.historyService.getHistoryFromLatestBoundary(this.workspaceId);
    if (!historyResult.success) {
      return Err(`Failed to read history for heartbeat reset boundary: ${historyResult.error}`);
    }

    const messages = historyResult.data;

    const nextCompactionEpoch = getNextCompactionEpoch(messages);
    assert(
      Number.isInteger(nextCompactionEpoch) && nextCompactionEpoch > 0,
      "heartbeat reset boundary must compute a positive compaction epoch"
    );

    const summaryMessage = createMuxMessage(
      createCompactionSummaryMessageId(),
      "assistant",
      boundaryText,
      {
        timestamp: Date.now(),
        synthetic: true,
        uiVisible: true,
        compacted: "heartbeat",
        compactionEpoch: nextCompactionEpoch,
        compactionBoundary: true,
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp,
        },
      }
    );

    assert(
      summaryMessage.metadata?.compacted === "heartbeat",
      "heartbeat reset boundary must persist the heartbeat compacted marker"
    );
    assert(
      summaryMessage.metadata?.compactionBoundary === true,
      "heartbeat reset boundary must be marked as a durable boundary"
    );
    assert(
      summaryMessage.metadata?.compactionEpoch === nextCompactionEpoch,
      "heartbeat reset boundary must persist the computed compaction epoch"
    );

    const maxExistingHistorySequence = this.getMaxExistingHistorySequence(messages);
    const fingerprint = exactJson(messages);
    const persistenceResult = await this.publishPreparedBoundary(preparation, messages, {
      summaryMessage,
      tailCopies: [],
      updateExisting: false,
      publication,
      shouldPersist: (current, partial) =>
        !partial &&
        isDeepStrictEqual(
          exactJson(sliceMessagesFromLatestCompactionBoundary(current)),
          fingerprint
        ),
    });
    if (!persistenceResult.success) {
      return Err(`Failed to append heartbeat reset boundary: ${persistenceResult.error}`);
    }

    const persisted = persistenceResult.data.summaryMessage;
    const persistedSequence = persisted.metadata?.historySequence;
    assert(
      isNonNegativeInteger(persistedSequence),
      "heartbeat reset boundary persistence must produce a non-negative historySequence"
    );
    if (maxExistingHistorySequence >= 0) {
      assert(
        persistedSequence > maxExistingHistorySequence,
        "heartbeat reset boundary historySequence must remain monotonic"
      );
    }

    this.emitChatEvent({ ...persisted, type: "message" });
    return Ok({ summaryMessageId: persisted.id });
  }

  async rollbackHeartbeatContextResetBoundary(
    summaryMessage: MuxMessage,
    isCurrent: () => boolean = () => true
  ): Promise<Result<CompactionFollowUpCleanupOutcome, string>> {
    assert(
      summaryMessage.role === "assistant",
      "rollbackHeartbeatContextResetBoundary requires an assistant boundary message"
    );
    assert(
      summaryMessage.metadata?.compacted === "heartbeat",
      "rollbackHeartbeatContextResetBoundary requires a heartbeat reset boundary"
    );

    const deleteResult = await this.pendingLifecycle.rollbackHeartbeat(summaryMessage, isCurrent);
    if (!deleteResult.success) {
      return Err(`Failed to delete heartbeat reset boundary: ${deleteResult.error}`);
    }
    // A replacement retained its boundary, so its cached state and renderer row must survive too.
    if (deleteResult.data.outcome === "skipped") return Ok("skipped");

    const historySequence = summaryMessage.metadata?.historySequence;
    if (isNonNegativeInteger(historySequence)) {
      this.emitChatEvent({
        type: "delete",
        historySequences: [historySequence],
      });
    }

    return Ok("applied");
  }

  async peekCachedFilePaths(): Promise<string[] | null> {
    return (await this.peekPendingState())?.diffs.map((diff) => diff.path) ?? null;
  }

  /**
   * Handle compaction stream completion
   *
   * Detects when a compaction stream finishes, extracts the summary,
   * and appends a durable compaction boundary message.
   */
  async handleCompletion(
    event: StreamEndEvent,
    compactionRequestMessageId?: string,
    isCurrent: () => boolean = () => true,
    publication?: ContinuousCompactionPublication
  ): Promise<boolean> {
    const preparation = this.beginPreparation(isCurrent);
    event = structuredClone(event);
    publication = publication && structuredClone(publication);
    // Live producers retain their admission generation: completion after Stop must not
    // adopt its new frontier. Legacy/unowned callers may capture only without Stop debt.
    // Defer errors until classification so ordinary completion still runs its policy.
    const capture = publication
      ? Ok({ nonce: null, generation: publication.generation })
      : await this.historyService.captureCompactionReplacement(this.workspaceId);
    // The current stream identifies its request when available. Synthetic prompt snapshots can
    // follow that request in history, so the last user row is not always the compaction request.
    const historyResult = compactionRequestMessageId
      ? await this.historyService.getHistoryFromLatestBoundary(this.workspaceId)
      : await this.historyService.getLastMessages(this.workspaceId, 10);
    if (!historyResult.success) {
      return false;
    }

    const messages = historyResult.data;
    const compactionRequestMessage = compactionRequestMessageId
      ? messages.find((message) => message.id === compactionRequestMessageId)
      : [...messages].reverse().find((message) => message.role === "user");
    const muxMeta = compactionRequestMessage?.metadata?.muxMetadata;
    const isCompaction =
      compactionRequestMessage?.role === "user" && muxMeta?.type === "compaction-request";

    if (!isCompaction || !compactionRequestMessage) {
      return false;
    }

    if (!capture.success) throw new Error(capture.error);
    if (capture.data.nonce !== null) return false;
    publication ??= { generation: capture.data.generation };

    // Determine idle-compaction (auto-triggered due to inactivity) up-front so the
    // post-stream failure paths below can report a terminal outcome to the idle loop.
    const isIdleCompaction =
      muxMeta?.type === "compaction-request" && muxMeta.source === "idle-compaction";

    // Dedupe: If we've already processed this compaction-request, skip
    if (this.processedCompactionRequestIds.has(compactionRequestMessage.id)) {
      return true;
    }

    const summary = event.parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");

    // Self-healing: Reject empty summaries (stream crashed before producing content)
    if (!summary.trim()) {
      // Log detailed part info to help debug why no text was produced
      const partsSummary = event.parts.map((p) => ({
        type: p.type,
        // Include preview for text-like parts to understand what the model produced
        preview: "text" in p && typeof p.text === "string" ? p.text.slice(0, 100) : undefined,
      }));
      log.warn("Compaction summary is empty - aborting compaction to prevent corrupted history", {
        workspaceId: this.workspaceId,
        model: event.metadata.model,
        partsCount: event.parts.length,
        parts: partsSummary,
      });
      // Don't mark as processed so user can retry
      if (isIdleCompaction) this.onIdleCompactionOutcome?.(false);
      return false;
    }

    // Self-healing: Reject compaction if summary is just a raw JSON object.
    // This happens when tools are disabled but the model still tries to output a tool call.
    // A valid summary should be prose text, not a JSON blob.
    if (looksLikeRawJsonObject(summary)) {
      log.warn(
        "Compaction summary is a raw JSON object - aborting compaction to prevent corrupted history",
        {
          workspaceId: this.workspaceId,
          summaryPreview: summary.slice(0, 200),
        }
      );
      // Don't mark as processed so user can retry
      if (isIdleCompaction) this.onIdleCompactionOutcome?.(false);
      return false;
    }

    // Extract follow-up content to attach to summary for crash-safe dispatch
    const pendingFollowUp = getCompactionFollowUpContent(muxMeta);

    // Mark as processed before performing compaction
    this.processedCompactionRequestIds.add(compactionRequestMessage.id);

    // Use boundary-aware history so getNextCompactionEpoch sees the prior boundary's epoch.
    // The correlated path already loaded that history to find the exact request.
    let messagesForCompaction = messages;
    if (!compactionRequestMessageId) {
      const boundaryHistoryResult = await this.historyService.getHistoryFromLatestBoundary(
        this.workspaceId
      );
      if (boundaryHistoryResult.success) {
        messagesForCompaction = boundaryHistoryResult.data;
      }
    }

    const result = await this.performCompaction(
      preparation,
      publication,
      summary,
      event.metadata,
      messagesForCompaction,
      event.messageId,
      compactionRequestMessage.id,
      isIdleCompaction,
      pendingFollowUp
    );
    if (!result.success) {
      log.error("Compaction failed:", result.error);
      if (isIdleCompaction) this.onIdleCompactionOutcome?.(false);
      return false;
    }

    const durationSecs =
      typeof event.metadata.duration === "number" ? event.metadata.duration / 1000 : 0;
    const inputTokens =
      event.metadata.contextUsage?.inputTokens ?? event.metadata.usage?.inputTokens ?? 0;
    const outputTokens =
      event.metadata.contextUsage?.outputTokens ?? event.metadata.usage?.outputTokens ?? 0;

    this.telemetryService?.capture({
      event: "compaction_completed",
      properties: {
        model: event.metadata.model,
        duration_b2: roundToBase2(durationSecs),
        input_tokens_b2: roundToBase2(inputTokens ?? 0),
        output_tokens_b2: roundToBase2(outputTokens ?? 0),
        compaction_source: isIdleCompaction ? "idle" : "manual",
      },
    });

    // Notify that compaction completed (clears idle compaction pending state)
    this.onCompactionComplete?.(result.data);

    // Report the idle-compaction success only after the summary is actually persisted,
    // so the idle loop's failure streak is reset on real success (not just stream end).
    if (isIdleCompaction) this.onIdleCompactionOutcome?.(true);

    // Emit a sanitized stream-end so UI can close streaming state without
    // re-introducing stale provider metadata from the pre-compaction row.
    this.emitChatEvent(this.sanitizeCompactionStreamEndEvent(event));
    return true;
  }

  private sanitizeCompactionStreamEndEvent(event: StreamEndEvent): StreamEndEvent {
    // Destructure to truly omit fields — setting undefined would create own
    // properties that overwrite the compacted summary's metadata during the
    // frontend's { ...message.metadata, ...data.metadata } merge.
    const { providerMetadata, contextProviderMetadata, contextUsage, timestamp, ...cleanMetadata } =
      event.metadata;

    // Carry a post-compaction context estimate (system prompt + summary) so the
    // usage meter shows "near empty" after workspace switches instead of vanishing.
    const postCompactionContextEstimate = this.computePostCompactionContextEstimate(
      cleanMetadata.systemMessageTokens,
      cleanMetadata.usage,
      contextUsage,
      providerMetadata,
      contextProviderMetadata
    );

    const sanitizedEvent: StreamEndEvent = {
      ...event,
      metadata: {
        ...cleanMetadata,
        ...(postCompactionContextEstimate && { contextUsage: postCompactionContextEstimate }),
      },
    };

    assert(
      sanitizedEvent.metadata.providerMetadata === undefined &&
        sanitizedEvent.metadata.contextProviderMetadata === undefined,
      "Compaction stream-end event must not carry stale provider metadata"
    );

    return sanitizedEvent;
  }

  /**
   * Approximate context window size after compaction (system prompt + summary).
   * Excludes reasoning tokens because they are not replayed into the next prompt.
   */
  private computePostCompactionContextEstimate(
    systemMessageTokens: number | undefined,
    usage: LanguageModelV2Usage | undefined,
    contextUsage: LanguageModelV2Usage | undefined,
    providerMetadata: Record<string, unknown> | undefined,
    contextProviderMetadata: Record<string, unknown> | undefined
  ): LanguageModelV2Usage | undefined {
    // totalUsage and contextUsage resolve independently with separate timeout/error
    // paths, so usage can be missing while contextUsage is still available.
    const usageForEstimate = usage ?? contextUsage;
    const totalSummaryOutputTokens = usageForEstimate?.outputTokens;
    if (totalSummaryOutputTokens == null || totalSummaryOutputTokens <= 0) {
      return undefined;
    }

    const providerReasoningTokens =
      this.getOpenAIReasoningTokens(contextProviderMetadata) ??
      this.getOpenAIReasoningTokens(providerMetadata) ??
      0;
    const reasoningTokens = usageForEstimate?.reasoningTokens ?? providerReasoningTokens;
    const summaryTokens = Math.max(0, totalSummaryOutputTokens - reasoningTokens);
    if (summaryTokens <= 0) {
      return undefined;
    }

    const systemTokens = systemMessageTokens ?? 0;
    const estimatedInputTokens = systemTokens + summaryTokens;
    return {
      inputTokens: estimatedInputTokens,
      outputTokens: 0,
      totalTokens: estimatedInputTokens,
    };
  }

  private getOpenAIReasoningTokens(
    providerMetadata: Record<string, unknown> | undefined
  ): number | undefined {
    const reasoningTokens = (providerMetadata?.openai as { reasoningTokens?: unknown } | undefined)
      ?.reasoningTokens;
    if (
      typeof reasoningTokens !== "number" ||
      !Number.isFinite(reasoningTokens) ||
      reasoningTokens < 0
    ) {
      return undefined;
    }

    return reasoningTokens;
  }

  private findPersistedStreamSummaryMessage(
    messages: MuxMessage[],
    streamedSummaryMessageId: string
  ): MuxMessage | null {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const candidate = messages[i];
      if (candidate.id !== streamedSummaryMessageId) {
        continue;
      }

      if (candidate.role !== "assistant") {
        // Self-healing read path: persisted message IDs can be corrupted.
        log.warn("Cannot reuse streamed compaction summary with non-assistant role", {
          workspaceId: this.workspaceId,
          messageId: candidate.id,
          role: candidate.role,
        });
        return null;
      }

      const historySequence = candidate.metadata?.historySequence;
      if (!isNonNegativeInteger(historySequence)) {
        // Self-healing read path: invalid sequence means we cannot safely update in-place.
        log.warn("Cannot reuse streamed compaction summary without valid historySequence", {
          workspaceId: this.workspaceId,
          messageId: candidate.id,
          historySequence,
        });
        return null;
      }

      return candidate;
    }

    return null;
  }

  /** The rolling summarizer already paid for this text; applying it must not start another turn. */
  buildContinuousCompactionRows(params: {
    boundaryMessageId?: string;
    messages: MuxMessage[];
    text: string;
    model: string;
    tail: MuxMessage[];
    systemMessageTokens: number;
    attachmentTokens: number;
    pendingFollowUp?: CompactionFollowUpRequest;
  }): { boundary: MuxMessage; copies: MuxMessage[] } {
    assert(params.text.trim().length > 0, "Continuous compaction requires a summary");
    const boundary = createMuxMessage(
      params.boundaryMessageId ?? createCompactionSummaryMessageId(),
      "assistant",
      params.text,
      {
        timestamp: Date.now(),
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: getNextCompactionEpoch(params.messages),
        model: params.model,
        systemMessageTokens: params.systemMessageTokens,
        muxMetadata: {
          type: "compaction-summary",
          strategy: "continuous",
          pendingFollowUp: params.pendingFollowUp,
        },
      }
    );
    const idMap = new Map(params.tail.map((row) => [row.id, createPreservedTailCopyMessageId()]));
    const copies = params.tail.map((row) => {
      const copy = this.buildPreservedTailCopy(row, idMap);
      // Continuous compaction prunes the just-finished answer too. Keep recent pages
      // visible below the boundary while retaining RLM's usage/snapshot sanitizer.
      copy.metadata = { ...copy.metadata, uiVisible: true };
      // User Esc keeps its interrupted marker and next-send continuation sentinel.
      // Only our internal stop has an explicit durable Continue replacing it.
      if (params.pendingFollowUp) delete copy.metadata.partial;
      return copy;
    });
    return { boundary, copies };
  }

  async persistContinuousCompaction(
    params: Parameters<CompactionHandler["buildContinuousCompactionRows"]>[0] & {
      prepared?: { boundary: MuxMessage; copies: MuxMessage[] };
      shouldPersist: (messages: MuxMessage[]) => boolean;
      publication: ContinuousCompactionPublication;
      preparation: CompactionPreparation;
      attachmentMessages: MuxMessage[];
    }
  ): Promise<boolean> {
    const shouldPersist = params.shouldPersist;
    const previousBoundaryHistorySequence = getLatestBoundaryHistorySequence(params.messages);
    const { boundary, copies } = params.prepared
      ? structuredClone(params.prepared)
      : this.buildContinuousCompactionRows(params);
    const inputTokens =
      params.systemMessageTokens +
      params.attachmentTokens +
      estimateMuxMessageTokens(boundary) +
      copies.reduce((sum, row) => sum + estimateMuxMessageTokens(row), 0);
    assert(boundary.metadata !== undefined, "Continuous boundary requires metadata");
    boundary.metadata.contextUsage = {
      inputTokens,
      outputTokens: 0,
      totalTokens: inputTokens,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    };
    const result = await this.publishPreparedBoundary(
      params.preparation,
      params.attachmentMessages,
      {
        summaryMessage: boundary,
        tailCopies: copies,
        updateExisting: false,
        publication: params.publication,
        shouldPersist: (messages, partial) => !partial && shouldPersist(messages),
      }
    );
    if (!result.success) {
      log.warn("[continuous-compaction] persist failed", result.error);
      return false;
    }
    const persisted = result.data.summaryMessage;
    this.emitChatEvent({ ...persisted, type: "message" });
    for (const copy of result.data.tailCopies) this.emitChatEvent({ ...copy, type: "message" });
    const sequence = persisted.metadata?.historySequence;
    const epoch = persisted.metadata?.compactionEpoch;
    assert(isNonNegativeInteger(sequence), "Continuous boundary requires a persisted sequence");
    assert(isPositiveInteger(epoch), "Continuous boundary requires an epoch");
    this.onCompactionComplete?.({
      workspaceId: this.workspaceId,
      summaryMessageId: boundary.id,
      summaryHistorySequence: sequence,
      compactionEpoch: epoch,
      previousBoundaryHistorySequence,
      compactionRequestMessageId: boundary.id,
      preservedTailMessageCount: copies.length,
    });
    return true;
  }

  /**
   * Perform history compaction by persisting a durable summary boundary.
   *
   * Steps:
   * 1. Delete partial state to avoid stale partial replay
   * 2. Persist post-compaction attachment state
   * 3. Prefer updating the streamed summary in-place, otherwise append a fallback summary
   * 4. Emit summary message to frontend
   */
  private async performCompaction(
    preparation: CompactionPreparation,
    publication: ContinuousCompactionPublication,
    summary: string,
    metadata: {
      model: string;
      /** Request-pinned pricing identity from the compaction stream. */
      metadataModel?: string;
      usage?: LanguageModelV2Usage;
      contextUsage?: LanguageModelV2Usage;
      duration?: number;
      providerMetadata?: Record<string, unknown>;
      contextProviderMetadata?: Record<string, unknown>;
      systemMessageTokens?: number;
    },
    messages: MuxMessage[],
    streamedSummaryMessageId: string,
    compactionRequestMessageId: string,
    isIdleCompaction = false,
    pendingFollowUp?: CompactionFollowUpRequest
  ): Promise<Result<CompactionCompletionMetadata, string>> {
    assert(summary.trim().length > 0, "performCompaction requires a non-empty summary");
    assert(metadata.model.trim().length > 0, "Compaction summary requires a model");
    assert(
      streamedSummaryMessageId.trim().length > 0,
      "performCompaction requires streamed summary message ID"
    );

    // Retire only this completed stream's partial before committing its summary boundary.
    await this.retirePartial(preparation, streamedSummaryMessageId);

    const nextCompactionEpoch = getNextCompactionEpoch(messages);
    assert(Number.isInteger(nextCompactionEpoch), "next compaction epoch must be an integer");

    const previousBoundaryHistorySequence = getLatestBoundaryHistorySequence(messages);
    const maxExistingHistorySequence = this.getMaxExistingHistorySequence(messages);

    // For idle compaction, preserve the original recency timestamp so the workspace
    // doesn't appear "recently used" in the sidebar. Use the shared recency utility
    // to ensure consistency with how the sidebar computes recency.
    let timestamp = Date.now();
    if (isIdleCompaction) {
      const recency = computeRecencyFromMessages(messages);
      if (recency !== null) {
        timestamp = recency;
      }
    }

    // Create summary message with metadata.
    // We omit providerMetadata because it contains cacheCreationInputTokens from the
    // pre-compaction context, which inflates context usage display.
    // Note: We no longer store historicalUsage here. Cumulative costs are tracked in
    // session-usage.json, which is updated on every stream-end. If that file is deleted
    // or corrupted, pre-compaction costs are lost - this is acceptable since manual
    // file deletion is out of scope for data recovery.
    //
    // The summary's muxMetadata stores the pending follow-up (if any) for crash-safe dispatch.
    // After compaction, agentSession checks if the last message is a summary with pendingFollowUp
    // and dispatches it. The user message persisted by that dispatch serves as proof of completion.
    const summaryMuxMetadata: CompactionSummaryMetadata = {
      type: "compaction-summary",
      pendingFollowUp,
    };

    // StreamManager persists the final assistant message before stream-end.
    // Prefer updating that streamed summary in-place so append-only mode keeps
    // exactly one durable summary message per /compact cycle.
    const persistedStreamSummary = this.findPersistedStreamSummaryMessage(
      messages,
      streamedSummaryMessageId
    );
    const persistedSummaryHistorySequence = persistedStreamSummary?.metadata?.historySequence;

    const postCompactionContextEstimate = this.computePostCompactionContextEstimate(
      metadata.systemMessageTokens,
      metadata.usage,
      metadata.contextUsage,
      metadata.providerMetadata,
      metadata.contextProviderMetadata
    );

    const summaryMessage = createMuxMessage(
      persistedStreamSummary?.id ?? createCompactionSummaryMessageId(),
      "assistant",
      summary,
      {
        // Do not spread persisted streamed metadata here. Those rows can contain
        // pre-compaction usage/context provider fields that would inflate post-
        // compaction cache/context token displays.
        timestamp,
        compacted: isIdleCompaction ? "idle" : "user",
        compactionEpoch: nextCompactionEpoch,
        compactionBoundary: true,
        model: metadata.model,
        // Preserve the stream's request-pinned pricing identity: session
        // usage rebuilds (missing/corrupt session-usage.json) key coder:
        // rows on the persisted metadataModel, and dropping it here would
        // reprice the compaction request from mutable current metadata.
        ...(metadata.metadataModel != null && { metadataModel: metadata.metadataModel }),
        usage: metadata.usage,
        duration: metadata.duration,
        systemMessageTokens: metadata.systemMessageTokens,
        ...(postCompactionContextEstimate && { contextUsage: postCompactionContextEstimate }),
        muxMetadata: summaryMuxMetadata,
      }
    );
    if (persistedSummaryHistorySequence !== undefined) {
      summaryMessage.metadata = {
        ...(summaryMessage.metadata ?? {}),
        historySequence: persistedSummaryHistorySequence,
      };
    }

    assert(
      summaryMessage.metadata?.compactionBoundary === true,
      "Compaction summary must be marked as a compaction boundary"
    );
    assert(
      summaryMessage.metadata?.compactionEpoch === nextCompactionEpoch,
      "Compaction summary must persist the computed compaction epoch"
    );
    assert(
      summaryMessage.metadata?.providerMetadata === undefined,
      "Compaction summary must not persist stale providerMetadata"
    );
    assert(
      summaryMessage.metadata?.contextProviderMetadata === undefined,
      "Compaction summary must not persist stale contextProviderMetadata"
    );

    // RLM keep-recent floor: sanitized tail copies re-appear verbatim AFTER
    // the boundary so post-compaction requests see [summary, ...tail]. The
    // boundary and every copy must land in ONE atomic history commit: the
    // boundary write seals the previous epoch and the summarizer already
    // excluded the stamped tail rows, so a boundary that became durable
    // without the full tail (crash or failure mid-append) would leave the
    // suffix permanently absent from provider context with no recovery
    // marker. Empty when unstamped (RLM off) — that path stays untouched.
    const preservedTailCopies = this.buildPreservedTailCopies(
      messages,
      compactionRequestMessageId,
      summaryMessage.id
    );

    const fingerprint = exactJson(messages);
    const persistenceResult = await this.publishPreparedBoundary(preparation, messages, {
      summaryMessage,
      tailCopies: preservedTailCopies,
      updateExisting: persistedStreamSummary !== null,
      publication,
      shouldPersist: (current, partial) =>
        !partial &&
        isDeepStrictEqual(
          exactJson(sliceMessagesFromLatestCompactionBoundary(current)),
          fingerprint
        ),
    });
    if (!persistenceResult.success)
      return Err(`Failed to commit compaction boundary: ${persistenceResult.error}`);
    const persisted = persistenceResult.data.summaryMessage;

    const persistedSequence = persisted.metadata?.historySequence;
    assert(
      isNonNegativeInteger(persistedSequence),
      "Compaction summary persistence must produce a non-negative historySequence"
    );
    if (persistedStreamSummary) {
      assert(
        persistedSummaryHistorySequence !== undefined &&
          persistedSequence === persistedSummaryHistorySequence,
        "Compaction summary update must preserve existing historySequence"
      );
    } else if (maxExistingHistorySequence >= 0) {
      assert(
        persistedSequence > maxExistingHistorySequence,
        "Compaction summary historySequence must remain monotonic"
      );
    }

    // Emit summary message to frontend (add type: "message" for discriminated union)
    this.emitChatEvent({ ...persisted, type: "message" });

    // The tail copies were committed atomically with the boundary above;
    // sequences were assigned in place, so the emitted events carry them.
    for (const copy of persistenceResult.data.tailCopies) {
      this.emitChatEvent({ ...copy, type: "message" });
    }

    return Ok({
      workspaceId: this.workspaceId,
      summaryMessageId: summaryMessage.id,
      summaryHistorySequence: persistedSequence,
      compactionEpoch: nextCompactionEpoch,
      previousBoundaryHistorySequence,
      compactionRequestMessageId,
      preservedTailMessageCount: preservedTailCopies.length,
    });
  }

  /**
   * Build sanitized copies of the keep-recent tail for re-appearance after
   * the compaction boundary (RLM mode). The tail is derived purely from the
   * durable stamp on the compaction-request row, so completion agrees
   * byte-for-byte with what the summarization request excluded. Returns []
   * when unstamped — i.e. RLM off — keeping default behavior untouched.
   * Pure build, no I/O: the caller commits the copies atomically WITH the
   * boundary via persistBoundaryWithTailCopies.
   */
  private buildPreservedTailCopies(
    messages: MuxMessage[],
    compactionRequestMessageId: string,
    summaryMessageId: string
  ): MuxMessage[] {
    const requestIndex = messages.findIndex((message) => message.id === compactionRequestMessageId);
    if (requestIndex === -1) {
      return [];
    }

    const startHistorySequence = getKeepRecentTailStartHistorySequence(
      messages[requestIndex].metadata?.muxMetadata
    );
    if (startHistorySequence === undefined) {
      return [];
    }

    // Tail = rows between the stamped start and the compaction request.
    // Older compaction-request rows (failed prior attempts) are summarization
    // prompts, not conversation — never preserve them.
    const tailRows = messages.slice(0, requestIndex).filter((message) => {
      const sequence = message.metadata?.historySequence;
      if (!isNonNegativeInteger(sequence) || sequence < startHistorySequence) {
        return false;
      }
      if (message.id === summaryMessageId) {
        return false;
      }
      return message.metadata?.muxMetadata?.type !== "compaction-request";
    });
    if (tailRows.length === 0) {
      return [];
    }

    // Preassign copy IDs for ALL tail rows before building any copy: MCP
    // snapshot rows precede the user row they expand, so a build-time map
    // would not yet contain the invoking row's copy ID when the snapshot row
    // is copied — the preserved original ID would then be dropped as an
    // orphan by request-time filtering (filterOrphanedMcpPromptSnapshots).
    const idMap = new Map<string, string>();
    for (const row of tailRows) {
      idMap.set(row.id, createPreservedTailCopyMessageId());
    }
    return tailRows.map((row) => this.buildPreservedTailCopy(row, idMap));
  }

  /**
   * Build a sanitized copy of a preserved tail row.
   *
   * Whitelisted metadata only: usage/cost/context fields MUST NOT be copied so
   * session-usage rebuilds never double-count the original row, and boundary
   * markers MUST NOT be copied so a copy can never masquerade as a compaction
   * boundary. Copies are synthetic without uiVisible (UI-hidden) because the
   * original rows remain visible above the boundary; fresh IDs keep UI
   * aggregation from collapsing a hidden copy over its visible original.
   */
  private buildPreservedTailCopy(row: MuxMessage, idMap: Map<string, string>): MuxMessage {
    // IDs are preassigned for the whole tail (see caller) so forward-pointing
    // references (snapshot row → later invoking user row) rewrite correctly.
    const copyId = idMap.get(row.id);
    assert(copyId !== undefined, "buildPreservedTailCopy: row is missing a preassigned copy ID");

    const source = row.metadata;
    // MCP prompt snapshots pair with their invoking user row by message ID;
    // rewrite to the invoking row's copy ID so the pairing survives copying.
    const mcpPromptSnapshot =
      source?.mcpPromptSnapshot?.invokingMessageId !== undefined
        ? {
            ...source.mcpPromptSnapshot,
            invokingMessageId:
              idMap.get(source.mcpPromptSnapshot.invokingMessageId) ??
              source.mcpPromptSnapshot.invokingMessageId,
          }
        : source?.mcpPromptSnapshot;

    return {
      ...row,
      id: copyId,
      metadata: {
        synthetic: true,
        rlmPreservedTailCopy: true,
        ...(source?.timestamp !== undefined ? { timestamp: source.timestamp } : {}),
        ...(source?.model !== undefined ? { model: source.model } : {}),
        ...(source?.thinkingLevel !== undefined ? { thinkingLevel: source.thinkingLevel } : {}),
        ...(source?.agentId !== undefined ? { agentId: source.agentId } : {}),
        ...(source?.stepStartPartIndices !== undefined
          ? { stepStartPartIndices: source.stepStartPartIndices }
          : {}),
        // Preserve partial so interrupted-tool sentinels keep applying.
        ...(source?.partial !== undefined ? { partial: source.partial } : {}),
        // muxMetadata drives provider-side filtering (workflow display rows),
        // so it must ride along verbatim.
        ...(source?.muxMetadata !== undefined ? { muxMetadata: source.muxMetadata } : {}),
        ...(source?.kind !== undefined ? { kind: source.kind } : {}),
        ...(source?.fileAtMentionSnapshot !== undefined
          ? { fileAtMentionSnapshot: source.fileAtMentionSnapshot }
          : {}),
        ...(source?.agentSkillSnapshot !== undefined
          ? { agentSkillSnapshot: source.agentSkillSnapshot }
          : {}),
        ...(mcpPromptSnapshot !== undefined ? { mcpPromptSnapshot } : {}),
      },
    };
  }

  /**
   * Emit chat event through the session's emitter
   */
  private emitChatEvent(message: WorkspaceChatMessage): void {
    this.emitter.emit("chat-event", {
      workspaceId: this.workspaceId,
      message,
    });
  }
}

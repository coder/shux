import {
  HistoryAppendProvenance,
  HISTORY_PROVENANCE_MAX_RECEIPT_BYTES,
  invalidateHistoryAppendProvenance,
} from "./historyAppendProvenance";
import { SESSION_HISTORY_MAX_SCAN_BYTES } from "@/common/constants/contextBudget";
import {
  hasRawResetMarker,
  hasAmbiguousResetKeys,
  isReadableHistoryMessage,
  scanHistoryFilesBounded,
  readProviderHistoryFromLatestBoundary,
  readHistoryControlEvidenceFromLatestBoundary,
  type HistoryControlRow,
  type BoundedHistoryScanOptions,
} from "./historyScanner";
import { getRequestPreludeMessageIds } from "@/common/utils/messages/requestPrelude";
import { createContextBudgetRejectedMessage } from "@/common/utils/messages/contextBudgetRejection";
import * as path from "path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { renameSync } from "node:fs";
import * as fs from "fs/promises";
import { COMPACTION_CANCELLATION_FILE } from "@/common/constants/compactionCancellation";
import {
  CompactionCancellationSchema,
  MalformedCompactionCancellationError,
  matchesCompactionCancellation,
  type CompactionCancellationRecord,
} from "./compactionCancellation";
import { ContinuousCompactionJournalStore } from "./continuousCompactionJournal";
import writeFileAtomic from "write-file-atomic";
import assert from "node:assert";
import type { CompactionCompletionMetadata } from "@/common/types/compaction";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import {
  isCompactionSummaryMetadata,
  isSyntheticSnapshotUserMessage,
  type MuxMessage,
  type MuxMetadata,
} from "@/common/types/message";
import type { WorkspaceSessionLocator } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import type { TaskService } from "@/node/services/taskService";
import { ensurePrivateDir, isErrnoWithCode } from "@/node/utils/fs";
import { isPathInsideDir } from "@/node/utils/pathUtils";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";
import { log } from "./log";
import { getTokenizerForModel } from "@/node/utils/main/tokenizer";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { safeStringifyForCounting } from "@/common/utils/tokens/safeStringifyForCounting";
import { normalizeLegacyMuxMetadata } from "@/node/utils/messages/legacy";
import { CONTEXT_BOUNDARY_KINDS } from "@/common/constants/contextBoundary";
import {
  findLatestContextBoundaryIndex,
  getContextBoundaryKind,
  hasProviderEligibleMessages,
  isDurableCompactedMarker,
  isDurableContextBoundaryMarker,
} from "@/common/utils/messages/compactionBoundary";
import { filterWorkflowDisplayOnlyMessages } from "@/common/utils/workflowRunMessages";
import { CHAT_FILE_NAME, CHAT_ARCHIVE_FILE_NAME } from "@/common/constants/paths";
import { coerceThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";
import {
  readSubagentTranscriptArtifactsFile,
  type SubagentTranscriptArtifactIndexEntry,
} from "@/node/services/subagentTranscriptArtifacts";
import { isRefusalFinishReason } from "@/common/utils/messages/refusalFinishReason";
import { getErrorMessage } from "@/common/utils/errors";
import { isNonNegativeInteger, isPositiveInteger } from "@/common/utils/numbers";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import {
  historyWriteLockPath,
  isWorkspaceRemovalTombstoned,
} from "@/node/services/workspaceRemoval";

/**
 * Generous bound on waiting for a foreign backend's write: legitimate holds
 * are one append or one read+replace of the active file (ms). A timeout
 * fails the mutation visibly instead of corrupting history. The lockfile
 * itself lives OUTSIDE the session directory (r63, historyWriteLockPath) so
 * workspace removal can hold it across its tombstone+delete critical section.
 */
const HISTORY_WRITE_LOCK_TIMEOUT_MS = 10_000;

interface CompactionFollowUpAppendCondition {
  summary?: MuxMessage;
  allowedTailMessageIds: readonly string[];
  isCurrent: () => boolean;
  onSkipped: () => void;
}

interface HistoryTruncateHashes {
  finalArchiveHash: string | null;
  finalChatHash: string | null;
}

interface HistoryTruncateTransaction extends HistoryTruncateHashes {
  rawHashes?: HistoryTruncateHashes & { version: 1 };
}

interface HistoryRewriteRow {
  raw: Buffer;
  message: MuxMessage | undefined;
}

function splitHistoryLines(raw: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  for (let start = 0; start < raw.length; ) {
    const newline = raw.indexOf(10, start);
    const end = newline < 0 ? raw.length : newline + 1;
    lines.push(raw.subarray(start, end));
    start = end;
  }
  return lines;
}

function hasDurableCompactionBoundary(metadata: MuxMetadata | undefined): boolean {
  if (metadata?.compactionBoundary !== true) {
    return false;
  }

  // Self-healing read path: malformed boundary markers should be ignored.
  if (!isDurableCompactedMarker(metadata.compacted)) {
    return false;
  }

  return isPositiveInteger(metadata.compactionEpoch);
}

function prefixCutChangesActiveContext(messages: MuxMessage[], removeCount: number): boolean {
  const boundaryIndex = findLatestContextBoundaryIndex(messages);
  const activeStart =
    boundaryIndex < 0
      ? 0
      : getContextBoundaryKind(messages[boundaryIndex]) === CONTEXT_BOUNDARY_KINDS.RESET
        ? boundaryIndex + 1
        : boundaryIndex;
  return hasProviderEligibleMessages(
    filterWorkflowDisplayOnlyMessages(messages.slice(activeStart, removeCount))
  );
}

function stripContextUsage(message: MuxMessage): MuxMessage {
  if (!message.metadata) {
    return message;
  }
  return {
    ...message,
    metadata: {
      ...message.metadata,
      contextUsage: undefined,
      contextProviderMetadata: undefined,
    },
  };
}

function getCompactionMetadataToPreserve(
  workspaceId: string,
  existingMessage: MuxMessage,
  incomingMessage: MuxMessage
): Partial<MuxMetadata> | null {
  const existingMetadata = existingMessage.metadata;
  if (existingMetadata?.compactionBoundary !== true) {
    return null;
  }

  if (existingMessage.role !== "assistant") {
    // Self-healing read path: boundary metadata on non-assistant rows is invalid.
    log.warn("Skipping malformed persisted compaction boundary during history update", {
      workspaceId,
      messageId: existingMessage.id,
      reason: "compactionBoundary set on non-assistant message",
    });
    return null;
  }

  if (incomingMessage.role !== "assistant") {
    return null;
  }

  if (!hasDurableCompactionBoundary(existingMetadata)) {
    // Self-healing read path: malformed boundary metadata should not be propagated.
    log.warn("Skipping malformed persisted compaction boundary during history update", {
      workspaceId,
      messageId: existingMessage.id,
      reason: "compactionBoundary missing valid compacted+compactionEpoch metadata",
    });
    return null;
  }

  if (hasDurableCompactionBoundary(incomingMessage.metadata)) {
    return null;
  }

  const preserved: Partial<MuxMetadata> = {
    compacted: existingMetadata.compacted,
    compactionBoundary: true,
    compactionEpoch: existingMetadata.compactionEpoch,
  };

  if (
    isCompactionSummaryMetadata(existingMetadata.muxMetadata) &&
    !isCompactionSummaryMetadata(incomingMessage.metadata?.muxMetadata)
  ) {
    preserved.muxMetadata = existingMetadata.muxMetadata;
  }

  return preserved;
}

/**
 * Whether a partial message's parts are durable enough to commit to
 * chat.jsonl. Exported so StreamManager's abort path can apply the SAME
 * predicate commitPartial uses: aborted turns whose partial will be dropped
 * (e.g. only an input-available tool call) must route their billed usage
 * through the headless-usage sidecar instead — exactly one of {chat row,
 * sidecar row} may carry a turn's usage.
 */
export function hasCommitWorthyParts(parts: MuxMessage["parts"] | undefined): boolean {
  return (parts ?? []).some((part) => {
    if (part.type === "text" || part.type === "reasoning") {
      return part.text.trim().length > 0;
    }

    if (part.type === "file") {
      return true;
    }

    if (part.type === "dynamic-tool") {
      // Incomplete tool calls (input-available) are dropped during provider request
      // conversion. Persisting tool-only incomplete partials can brick future requests.
      return part.state === "output-available";
    }

    return false;
  });
}

type HistorySessionLocation = Pick<WorkspaceSessionLocator, "rootDir"> &
  (Pick<WorkspaceSessionLocator, "sessionsDir"> | Pick<WorkspaceSessionLocator, "getSessionDir">);

/**
 * HistoryService - Manages chat history persistence and sequence numbering
 *
 * Responsibilities:
 * - Read/write chat history to disk (JSONL format)
 * - Read/write partial message staging state (partial.json)
 * - Assign sequence numbers to messages (single source of truth)
 * - Track next sequence number per workspace
 *
 * On-disk layout (per session dir):
 * - chat.jsonl         — the ACTIVE epoch: latest durable context boundary onward.
 * - chat-archive.jsonl — sealed pre-boundary history, append-only, oldest→newest.
 * - partial.json       — in-flight assistant message staging.
 *
 * Invariant: full history = chat-archive.jsonl ++ chat.jsonl, and every
 * historySequence in the archive is older than every sequence in chat.jsonl.
 * Rotation (see rotateSealedHistoryUnlocked) moves the sealed prefix of
 * chat.jsonl into the archive whenever a durable boundary lands, so hot-path
 * reads and full-file rewrites (updateHistory on every stream end) scale with
 * the active epoch instead of lifetime history.
 */
interface SubagentTranscriptDependencies {
  taskService: Pick<TaskService, "isDescendantAgentTask" | "listDescendantAgentTasks">;
  aiService: Pick<AIService, "getWorkspaceMetadata">;
}

export class HistoryService {
  private getAppendProvenance(workspaceId: string): HistoryAppendProvenance {
    return new HistoryAppendProvenance(this.getSessionDir(workspaceId));
  }

  /** One bounded page under both history locks; never performs mutation recovery. */
  scanHistoryBounded(workspaceId: string, options: BoundedHistoryScanOptions) {
    assert(workspaceId.trim().length > 0, "history scan requires workspaceId");
    return this.fileLocks.withLock(workspaceId, () =>
      this.withHistoryWriteFileLock(workspaceId, async () => {
        if (await isWorkspaceRemovalTombstoned(this.config.rootDir, workspaceId))
          throw new Error("stale_cursor");
        // Recovery rewrites history and takes the write lock. This read-only tool
        // must instead fail closed while a truncate transaction is unresolved.
        const assertNoTruncate = async () => {
          for (const marker of [
            this.getTruncateTransactionPath(workspaceId),
            `${this.getChatArchivePath(workspaceId)}.truncate`,
          ]) {
            const exists = await fs.stat(marker).then(
              () => true,
              (error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
                return false;
              }
            );
            if (exists) throw new Error("stale_cursor");
          }
        };
        await assertNoTruncate();
        const provenance = this.getAppendProvenance(workspaceId);
        const { receipt, bytesRead } = await provenance.forScan(options.cursor?.provenanceEpoch);
        const result = await scanHistoryFilesBounded(
          {
            chat: this.getChatHistoryPath(workspaceId),
            archive: this.getChatArchivePath(workspaceId),
          },
          options,
          receipt.epoch,
          SESSION_HISTORY_MAX_SCAN_BYTES - 2 * HISTORY_PROVENANCE_MAX_RECEIPT_BYTES
        );
        result.bytesRead += bytesRead + (await provenance.validatePage(receipt));
        await assertNoTruncate();
        return result;
      })
    );
  }

  private readonly CHAT_FILE = CHAT_FILE_NAME;
  private readonly CHAT_ARCHIVE_FILE = CHAT_ARCHIVE_FILE_NAME;
  private readonly PARTIAL_FILE = "partial.json";
  // Track next sequence number per workspace in memory
  private sequenceCounters = new Map<string, number>();
  // Workspaces whose chat.jsonl was already checked for a sealed (pre-boundary)
  // prefix this process. Guards the lazy one-time migration of legacy files;
  // new boundaries rotate eagerly at write time.
  private sealedRotationChecked = new Set<string>();
  // Shared file operation lock across all workspace file services
  // This prevents deadlocks when operations compose while touching the same workspace files.
  private readonly fileLocks = workspaceFileLocks;
  private readonly config: HistorySessionLocation;

  constructor(config: HistorySessionLocation) {
    this.config = config;
  }

  private readonly continuousJournals = new Map<string, ContinuousCompactionJournalStore>();

  getContinuousCompactionJournal(workspaceId: string): ContinuousCompactionJournalStore {
    let journal = this.continuousJournals.get(workspaceId);
    if (!journal) {
      journal = new ContinuousCompactionJournalStore(
        path.join(this.getSessionDir(workspaceId), "continuous-compaction.json"),
        workspaceId
      );
      this.continuousJournals.set(workspaceId, journal);
    }
    return journal;
  }

  async readCompactionCancellation(
    workspaceId: string
  ): Promise<CompactionCancellationRecord | null> {
    let contents: Buffer;
    try {
      contents = await fs.readFile(
        path.join(this.getSessionDir(workspaceId), COMPACTION_CANCELLATION_FILE)
      );
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return null;
      // Access/I/O errors do not prove corruption and must remain fail-closed.
      throw error;
    }
    try {
      return CompactionCancellationSchema.parse(JSON.parse(contents.toString("utf8")));
    } catch {
      throw new MalformedCompactionCancellationError(contents);
    }
  }

  async hasCompactionReplacementWitness(workspaceId: string, nonce: string): Promise<boolean> {
    return this.withRecoveredHistoryLock(workspaceId, () =>
      this.hasCompactionReplacementWitnessUnlocked(workspaceId, nonce)
    );
  }

  private async hasCompactionReplacementWitnessUnlocked(
    workspaceId: string,
    nonce: string,
    active?: MuxMessage[]
  ): Promise<boolean> {
    const matches = (rows: MuxMessage[]) =>
      rows.some((row) => row.metadata?.compactionCancellationNonce === nonce);
    // A later boundary may archive the receipt while ancillary unlink is still
    // unavailable. Its exact nonce continues to distinguish a newer explicit Stop.
    return (
      matches(active ?? (await this.readChatHistory(workspaceId))) ||
      matches(await this.readArchivedHistory(workspaceId))
    );
  }

  async repairCompactionCancellation(
    workspaceId: string,
    isCurrent: () => boolean,
    onRepaired: () => void
  ): Promise<CompactionCancellationRecord | null> {
    return this.fileLocks.withLock(workspaceId, () =>
      this.withCrossProcessWriteLock(workspaceId, async () => {
        if (!isCurrent()) return null;
        let malformed: MalformedCompactionCancellationError;
        try {
          // A newer valid Stop may have replaced the corrupt bytes while we waited.
          return await this.readCompactionCancellation(workspaceId);
        } catch (error) {
          if (!(error instanceof MalformedCompactionCancellationError)) throw error;
          malformed = error;
        }
        if (!isCurrent()) return null;
        const cancellationPath = path.join(
          this.getSessionDir(workspaceId),
          COMPACTION_CANCELLATION_FILE
        );
        // Keep the canonical corrupt file as a fail-closed fence through every
        // repair await/crash. Quarantine is a copy, never a rename-away gap.
        await fs.writeFile(`${cancellationPath}.corrupt.${randomUUID()}`, malformed.contents, {
          mode: 0o600,
          flag: "wx",
        });
        if (!isCurrent()) return null;
        await this.getContinuousCompactionJournal(workspaceId).clear();
        const historyPath = this.getChatHistoryPath(workspaceId);
        const { rows } = await this.readHistoryForRewrite(historyPath);
        let changed = false;
        const sanitized = this.serializeHistoryRewrite(rows, workspaceId, (row) => {
          const metadata = row.metadata?.muxMetadata;
          if (!isCompactionSummaryMetadata(metadata) || !metadata.pendingFollowUp) return row;
          changed = true;
          const { pendingFollowUp: _pendingFollowUp, ...muxMetadata } = metadata;
          return { ...row, metadata: { ...row.metadata, muxMetadata } };
        });
        if (!isCurrent()) return null;
        if (changed) {
          // Repair is a rewrite, so existing history cursors must not remain valid.
          // Preserve raw privacy-boundary bytes exactly, just like other rewrites.
          invalidateHistoryAppendProvenance();
          if (!(await this.writeGuardedHistory(historyPath, sanitized, isCurrent, onRepaired)))
            return null;
        }
        // Both legacy pending markers and the journal must be durably neutralized
        // before absence may authorize normal recovery, including on the next launch.
        if (isCurrent()) {
          if (!changed) onRepaired();
          await fs.rm(cancellationPath, { force: true });
        }
        return null;
      })
    );
  }

  async writeCompactionCancellation(
    workspaceId: string,
    record: CompactionCancellationRecord | null,
    isCurrent: () => boolean,
    retiredNonce?: string
  ): Promise<void> {
    // This file supplements legacy pendingFollowUp removal when transcript I/O
    // fails. Older builds only honor successful cleanup of that legacy marker.
    // It must remain writable when transcript reads/recovery are failing.
    await this.withHistoryWriteFileLock(workspaceId, async () => {
      if (!isCurrent()) return;
      if (await isWorkspaceRemovalTombstoned(this.config.rootDir, workspaceId))
        throw new Error(`workspace ${workspaceId} was removed; refusing cancellation mutation`);
      const cancellationPath = path.join(
        this.getSessionDir(workspaceId),
        COMPACTION_CANCELLATION_FILE
      );
      if (record === null) {
        const current = await this.readCompactionCancellation(workspaceId);
        if (isCurrent() && current?.nonce === retiredNonce)
          await fs.rm(cancellationPath, { force: true });
        return;
      }
      if (record.scope.kind === "summary") {
        const current = await this.readCompactionCancellation(workspaceId);
        if (current?.nonce !== record.nonce) return;
      }
      await ensurePrivateDir(this.getSessionDir(workspaceId));
      const stagedPath = `${cancellationPath}.${randomUUID()}`;
      try {
        await writeFileAtomic(stagedPath, JSON.stringify(record), { mode: 0o600 });
        if (isCurrent()) renameSync(stagedPath, cancellationPath);
      } finally {
        await fs.rm(stagedPath, { force: true });
      }
    });
  }

  private getSessionDir(workspaceId: string): string {
    return "getSessionDir" in this.config
      ? this.config.getSessionDir(workspaceId)
      : path.join(this.config.sessionsDir, workspaceId);
  }

  async getSubagentTranscript(
    input: { taskId: string; requestingWorkspaceId?: string | null },
    dependencies: SubagentTranscriptDependencies
  ): Promise<{ messages: MuxMessage[]; model?: string; thinkingLevel?: ThinkingLevel }> {
    const taskId = input.taskId.trim();
    assert(taskId.length > 0, "workspace.getSubagentTranscript: taskId must be non-empty");
    const trimmedRequestingId = input.requestingWorkspaceId?.trim() ?? "";
    const requestingWorkspaceId = trimmedRequestingId.length > 0 ? trimmedRequestingId : null;
    const tryLoadFromWorkspace = async (
      workspaceId: string
    ): Promise<{
      workspaceId: string;
      entry: SubagentTranscriptArtifactIndexEntry;
    } | null> => {
      const artifacts = await readSubagentTranscriptArtifactsFile(this.getSessionDir(workspaceId));
      const entry = artifacts.artifactsByChildTaskId[taskId] ?? null;
      return entry ? { workspaceId, entry } : null;
    };

    let isDescendant = false;
    if (requestingWorkspaceId) {
      try {
        isDescendant = await dependencies.taskService.isDescendantAgentTask(
          requestingWorkspaceId,
          taskId
        );
      } catch (error: unknown) {
        log.warn("workspace.getSubagentTranscript: descendant check failed", {
          requestingWorkspaceId,
          taskId,
          error: getErrorMessage(error),
        });
      }
    }

    let resolved: {
      workspaceId: string;
      entry: SubagentTranscriptArtifactIndexEntry;
    } | null = null;
    let hasArtifactInRequestingTree = false;

    if (requestingWorkspaceId !== null) {
      resolved = await tryLoadFromWorkspace(requestingWorkspaceId);
      if (!resolved) {
        // Grandchild transcripts may still live in the immediate parent session until cleanup
        // rolls them into the requesting workspace. Prefer shallower owners first.
        const descendants = dependencies.taskService
          .listDescendantAgentTasks(requestingWorkspaceId)
          .sort((a, b) => a.depth - b.depth);
        for (const descendant of descendants) {
          resolved = await tryLoadFromWorkspace(descendant.taskId);
          if (resolved) break;
        }
      }
      hasArtifactInRequestingTree = resolved !== null;
    } else {
      resolved = await this.findSubagentTranscriptByScanningSessions(taskId);
    }

    // Pending artifacts still have a live task session, so read it directly while it exists.
    if (!resolved) {
      if (requestingWorkspaceId && isDescendant) {
        const taskSessionDir = this.getSessionDir(taskId);
        const messages = await this.readTranscriptFromPaths({
          workspaceId: taskId,
          chatPath: path.join(taskSessionDir, CHAT_FILE_NAME),
          chatArchivePath: path.join(taskSessionDir, CHAT_ARCHIVE_FILE_NAME),
          partialPath: path.join(taskSessionDir, this.PARTIAL_FILE),
          logLabel: taskId + "/chat.jsonl",
        });
        const metaResult = await dependencies.aiService.getWorkspaceMetadata(taskId);
        const model =
          metaResult.success &&
          typeof metaResult.data.taskModelString === "string" &&
          metaResult.data.taskModelString.trim().length > 0
            ? metaResult.data.taskModelString.trim()
            : undefined;
        const thinkingLevel = metaResult.success
          ? coerceThinkingLevel(metaResult.data.taskThinkingLevel)
          : undefined;
        return { messages, model, thinkingLevel };
      }

      throw new Error(
        requestingWorkspaceId
          ? "No transcript found for task " + taskId + " in workspace " + requestingWorkspaceId
          : "No transcript found for task " + taskId
      );
    }

    if (requestingWorkspaceId && !isDescendant && !hasArtifactInRequestingTree) {
      throw new Error("Task is not a descendant of this workspace");
    }

    const messages = await this.readTranscriptFromPaths({
      workspaceId: resolved.workspaceId,
      chatPath: resolved.entry.chatPath,
      partialPath: resolved.entry.partialPath,
      logLabel: resolved.workspaceId + "/subagent-transcripts/" + taskId + "/chat.jsonl",
    });
    const model =
      typeof resolved.entry.model === "string" && resolved.entry.model.trim().length > 0
        ? resolved.entry.model.trim()
        : undefined;
    const thinkingLevel = coerceThinkingLevel(resolved.entry.thinkingLevel);
    return { messages, model, thinkingLevel };
  }

  private normalizeTranscriptMessage(value: unknown): MuxMessage | null {
    if (!value || typeof value !== "object") {
      return null;
    }

    const obj = value as { createdAt?: unknown };
    if (typeof obj.createdAt === "string") {
      const parsed = new Date(obj.createdAt);
      if (Number.isFinite(parsed.getTime())) {
        obj.createdAt = parsed;
      } else {
        delete obj.createdAt;
      }
    }

    return normalizeLegacyMuxMetadata(value as MuxMessage);
  }

  private parseMessages(
    data: string,
    logLabel: string,
    normalize: (value: unknown) => MuxMessage | null
  ): MuxMessage[] {
    const lines = data.split("\n").filter((line) => line.trim());
    const messages: MuxMessage[] = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        const message = normalize(JSON.parse(lines[i]) as unknown);
        if (message) messages.push(message);
      } catch (parseError) {
        log.warn(
          "Skipping malformed JSON at line " + (i + 1) + " in " + logLabel + ":",
          getErrorMessage(parseError),
          "\nLine content:",
          lines[i].substring(0, 100) + (lines[i].length > 100 ? "..." : "")
        );
      }
    }
    return messages;
  }

  private async readTranscriptMessages(
    chatPath: string,
    logLabel: string
  ): Promise<MuxMessage[] | null> {
    const data = await this.readExistingFile(chatPath);
    return data === null
      ? null
      : this.parseMessages(data, logLabel, (value) => this.normalizeTranscriptMessage(value));
  }

  private async readTranscriptPartial(partialPath: string): Promise<MuxMessage | null> {
    try {
      const raw = await fs.readFile(partialPath, "utf-8");
      return this.normalizeTranscriptMessage(JSON.parse(raw) as unknown);
    } catch (error: unknown) {
      if (isErrnoWithCode(error, "ENOENT")) return null;
      log.warn("Failed to read partial.json for transcript", {
        partialPath,
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  private mergeTranscriptPartial(messages: MuxMessage[], partial: MuxMessage | null): MuxMessage[] {
    if (!partial) return messages;

    const partialSeq = partial.metadata?.historySequence;
    if (partialSeq === undefined) return [...messages, partial];

    const existingIndex = messages.findIndex(
      (message) => message.metadata?.historySequence === partialSeq
    );
    if (existingIndex >= 0) {
      const existing = messages[existingIndex];
      if ((partial.parts?.length ?? 0) <= (existing.parts?.length ?? 0)) return messages;
      const next = [...messages];
      next[existingIndex] = partial;
      return next;
    }

    const insertIndex = messages.findIndex((message) => {
      const sequence = message.metadata?.historySequence;
      return typeof sequence === "number" && sequence > partialSeq;
    });
    if (insertIndex < 0) return [...messages, partial];

    const next = [...messages];
    next.splice(insertIndex, 0, partial);
    return next;
  }

  private async readTranscriptFromPaths(params: {
    workspaceId: string;
    chatPath?: string;
    chatArchivePath?: string;
    partialPath?: string;
    logLabel: string;
  }): Promise<MuxMessage[]> {
    const workspaceSessionDir = this.getSessionDir(params.workspaceId);
    // Refuse path traversal from a corrupted transcript index.
    if (params.chatPath && !isPathInsideDir(workspaceSessionDir, params.chatPath)) {
      throw new Error("Refusing to read transcript outside workspace session dir");
    }
    if (params.chatArchivePath && !isPathInsideDir(workspaceSessionDir, params.chatArchivePath)) {
      throw new Error("Refusing to read transcript archive outside workspace session dir");
    }
    if (params.partialPath && !isPathInsideDir(workspaceSessionDir, params.partialPath)) {
      throw new Error("Refusing to read partial outside workspace session dir");
    }

    const [archivedMessages, messages, partial] = await Promise.all([
      params.chatArchivePath
        ? this.readTranscriptMessages(params.chatArchivePath, params.logLabel + " (archive)")
        : null,
      params.chatPath ? this.readTranscriptMessages(params.chatPath, params.logLabel) : null,
      params.partialPath ? this.readTranscriptPartial(params.partialPath) : null,
    ]);
    if (!messages && !archivedMessages && !partial) {
      throw new Error("Transcript not found (missing " + params.logLabel + ")");
    }
    return this.mergeTranscriptPartial([...(archivedMessages ?? []), ...(messages ?? [])], partial);
  }

  private async findSubagentTranscriptByScanningSessions(taskId: string): Promise<{
    workspaceId: string;
    entry: SubagentTranscriptArtifactIndexEntry;
  } | null> {
    const sessionsDir = path.join(this.config.rootDir, "sessions");
    let dirents: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      dirents = await fs.readdir(sessionsDir, { withFileTypes: true });
    } catch (error: unknown) {
      if (isErrnoWithCode(error, "ENOENT")) return null;
      throw error;
    }

    let best: { workspaceId: string; entry: SubagentTranscriptArtifactIndexEntry } | null = null;
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || !dirent.name) continue;
      const artifacts = await readSubagentTranscriptArtifactsFile(
        path.join(sessionsDir, dirent.name)
      );
      const entry = artifacts.artifactsByChildTaskId[taskId];
      if (entry && (!best || entry.updatedAtMs > best.entry.updatedAtMs)) {
        best = { workspaceId: dirent.name, entry };
      }
    }
    return best;
  }

  private getChatHistoryPath(workspaceId: string): string {
    return path.join(this.getSessionDir(workspaceId), this.CHAT_FILE);
  }

  private getChatArchivePath(workspaceId: string): string {
    return path.join(this.getSessionDir(workspaceId), this.CHAT_ARCHIVE_FILE);
  }

  private getTruncateTransactionPath(workspaceId: string): string {
    return `${this.getChatArchivePath(workspaceId)}.truncate.json`;
  }

  private async readExistingFile(filePath: string): Promise<string | null> {
    return (await this.readExistingFileBytes(filePath))?.toString("utf8") ?? null;
  }

  private async readExistingFileBytes(filePath: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(filePath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private historyContentsHash(contents: string | Buffer): string {
    return createHash("sha256").update(contents).digest("hex");
  }

  private parseTruncateTransaction(contents: string): HistoryTruncateTransaction | null {
    try {
      const parsed: unknown = JSON.parse(contents);
      if (parsed === null || typeof parsed !== "object") {
        return null;
      }
      const marker = parsed as Record<string, unknown>;
      const finalArchiveHash = marker.finalArchiveHash;
      const finalChatHash = marker.finalChatHash;
      const isHash = (value: unknown): value is string | null =>
        value === null || (typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
      if (!isHash(finalArchiveHash) || !isHash(finalChatHash)) return null;
      const result: HistoryTruncateTransaction = { finalArchiveHash, finalChatHash };
      if ("rawHashes" in marker) {
        const raw = marker.rawHashes;
        // An invalid extension is not a legacy marker: never downgrade its
        // verification to decoded hashes, which can hide changed invalid bytes.
        if (
          !raw ||
          typeof raw !== "object" ||
          !("version" in raw) ||
          raw.version !== 1 ||
          !("finalArchiveHash" in raw) ||
          !isHash(raw.finalArchiveHash) ||
          !("finalChatHash" in raw) ||
          !isHash(raw.finalChatHash)
        )
          return null;
        result.rawHashes = {
          version: 1,
          finalArchiveHash: raw.finalArchiveHash,
          finalChatHash: raw.finalChatHash,
        };
      }
      return result;
    } catch {
      return null;
    }
  }

  private historyContentsMatch(
    contents: Buffer | null,
    hash: string | null,
    rawHash?: string | null
  ): boolean {
    if (hash === null) return contents === null && (rawHash === undefined || rawHash === null);
    return (
      contents !== null &&
      this.historyContentsHash(contents.toString("utf8")) === hash &&
      (rawHash === undefined || this.historyContentsHash(contents) === rawHash)
    );
  }

  private async recoverTruncateTransactionUnlocked(workspaceId: string): Promise<boolean> {
    const archivePath = this.getChatArchivePath(workspaceId);
    const archiveTombstonePath = `${archivePath}.truncate`;
    const tombstoneExists = await fs.stat(archiveTombstonePath).then(
      () => true,
      (error: unknown) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          return false;
        }
        throw error;
      }
    );
    const markerPath = this.getTruncateTransactionPath(workspaceId);
    const markerContents = await this.readExistingFile(markerPath);
    if (markerContents === null) {
      if (!tombstoneExists) {
        return false;
      }
      const archiveExists = (await this.readExistingFileBytes(archivePath)) !== null;
      if (archiveExists) {
        await fs.rm(archiveTombstonePath);
      } else {
        await fs.rename(archiveTombstonePath, archivePath);
      }
      return false;
    }

    const marker = this.parseTruncateTransaction(markerContents);
    if (!tombstoneExists) {
      await fs.rm(markerPath, { force: true });
      if (marker === null) {
        return false;
      }
      const archiveContents = await this.readExistingFileBytes(archivePath);
      const chatContents = await this.readExistingFileBytes(this.getChatHistoryPath(workspaceId));
      return (
        this.historyContentsMatch(
          archiveContents,
          marker.finalArchiveHash,
          marker.rawHashes?.finalArchiveHash
        ) &&
        this.historyContentsMatch(
          chatContents,
          marker.finalChatHash,
          marker.rawHashes?.finalChatHash
        )
      );
    }

    if (marker !== null) {
      const archiveContents = await this.readExistingFileBytes(archivePath);
      const chatContents = await this.readExistingFileBytes(this.getChatHistoryPath(workspaceId));
      const committed =
        this.historyContentsMatch(
          archiveContents,
          marker.finalArchiveHash,
          marker.rawHashes?.finalArchiveHash
        ) &&
        this.historyContentsMatch(
          chatContents,
          marker.finalChatHash,
          marker.rawHashes?.finalChatHash
        );
      if (committed) {
        await fs.rm(archiveTombstonePath);
        await fs.rm(markerPath, { force: true });
        return true;
      }
    }

    await fs.rm(archivePath, { force: true });
    await fs.rename(archiveTombstonePath, archivePath);
    await fs.rm(markerPath, { force: true });
    return false;
  }

  /**
   * Cheap unlocked probe for truncation-recovery artifacts. Recovery only
   * MUTATES files when the marker or the archive tombstone exists, so a
   * clean probe lets read paths stay lock-free (r64).
   */
  private async truncateRecoveryArtifactsPresent(workspaceId: string): Promise<boolean> {
    const exists = (p: string) =>
      fs.stat(p).then(
        () => true,
        (error: unknown) => {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
            return false;
          }
          throw error;
        }
      );
    const [tombstone, marker] = await Promise.all([
      exists(`${this.getChatArchivePath(workspaceId)}.truncate`),
      exists(this.getTruncateTransactionPath(workspaceId)),
    ]);
    return tombstone || marker;
  }

  /**
   * Read-path truncation recovery (r64). Recovery mutates the archive, chat
   * file, and marker — and an UNLOCKED recovery cannot distinguish a crashed
   * truncation from a LIVE rewriteHistoryFilesUnlocked() in another backend
   * (XUM_ALLOW_MULTIPLE_INSTANCES=1): rolling back a live transaction can
   * restore the old archive between the foreign writer's archive and chat
   * writes, letting discarded history reappear with mismatched archive/chat
   * state. Probe without the lock (no artifacts ⇒ nothing to mutate ⇒ reads
   * stay lock-free); when artifacts exist, take the cross-process write lock
   * and re-run recovery inside it — recovery re-stats its inputs, so a live
   * foreign transaction that commits while we wait leaves nothing to do.
   * Skips recovery for removal-tombstoned workspaces: recovery must never
   * resurrect files inside a session directory removal is deleting; the read
   * proceeds against whatever remains.
   */
  private async recoverTruncateTransactionForReads(workspaceId: string): Promise<void> {
    if (!(await this.truncateRecoveryArtifactsPresent(workspaceId))) {
      return;
    }
    await this.withHistoryWriteFileLock(workspaceId, async () => {
      if (await isWorkspaceRemovalTombstoned(this.config.rootDir, workspaceId)) {
        return;
      }
      await this.getAppendProvenance(workspaceId).runMutation(async () => {
        invalidateHistoryAppendProvenance();
        await this.recoverTruncateTransactionUnlocked(workspaceId);
      });
    });
  }

  private async withRecoveredHistoryLock<T>(
    workspaceId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.fileLocks.withLock(workspaceId, async () => {
      await this.recoverTruncateTransactionForReads(workspaceId);
      return operation();
    });
  }

  private async withRecoveredHistoryResultLock<T>(
    workspaceId: string,
    errorPrefix: string,
    operation: () => Promise<Result<T>>
  ): Promise<Result<T>> {
    try {
      return await this.withRecoveredHistoryLock(workspaceId, operation);
    } catch (error) {
      return Err(`${errorPrefix}: ${getErrorMessage(error)}`);
    }
  }

  private async rewriteHistoryFilesUnlocked(
    workspaceId: string,
    finalArchiveContents: Buffer | null,
    finalChatContents: Buffer | null
  ): Promise<void> {
    invalidateHistoryAppendProvenance();
    const archivePath = this.getChatArchivePath(workspaceId);
    const archiveTombstonePath = `${archivePath}.truncate`;
    const markerPath = this.getTruncateTransactionPath(workspaceId);
    const archiveExists = await fs.stat(archivePath).then(
      () => true,
      (error: unknown) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          return false;
        }
        throw error;
      }
    );
    if (!archiveExists) {
      assert(finalArchiveContents === null, "cannot replace a missing history archive");
      if (finalChatContents === null) {
        await fs.rm(this.getChatHistoryPath(workspaceId), { force: true });
      } else {
        await writeFileAtomic(this.getChatHistoryPath(workspaceId), finalChatContents);
      }
      return;
    }

    await writeFileAtomic(
      markerPath,
      JSON.stringify({
        // Older builds hash decoded UTF-8. Keep these fields compatible so a
        // downgrade cannot roll back a committed byte-preserving truncation.
        finalArchiveHash:
          finalArchiveContents === null
            ? null
            : this.historyContentsHash(finalArchiveContents.toString("utf8")),
        finalChatHash:
          finalChatContents === null
            ? null
            : this.historyContentsHash(finalChatContents.toString("utf8")),
        rawHashes: {
          version: 1,
          finalArchiveHash:
            finalArchiveContents === null ? null : this.historyContentsHash(finalArchiveContents),
          finalChatHash:
            finalChatContents === null ? null : this.historyContentsHash(finalChatContents),
        },
      })
    );
    try {
      await fs.rename(archivePath, archiveTombstonePath);
    } catch (error) {
      await fs.rm(markerPath, { force: true });
      throw error;
    }

    try {
      if (finalArchiveContents !== null) {
        await writeFileAtomic(archivePath, finalArchiveContents);
      }
      if (finalChatContents === null) {
        await fs.rm(this.getChatHistoryPath(workspaceId), { force: true });
      } else {
        await writeFileAtomic(this.getChatHistoryPath(workspaceId), finalChatContents);
      }
    } catch (error) {
      let committed = false;
      try {
        committed = await this.recoverTruncateTransactionUnlocked(workspaceId);
      } catch (recoveryError) {
        log.error("Failed to recover history truncation after write failure", {
          workspaceId,
          error: recoveryError,
        });
      }
      if (!committed) {
        throw error;
      }
      return;
    }

    try {
      await fs.rm(archiveTombstonePath);
      await fs.rm(markerPath, { force: true });
    } catch (error) {
      this.sealedRotationChecked.delete(workspaceId);
      log.warn("History truncation cleanup deferred to the next operation", {
        workspaceId,
        error,
      });
    }
  }

  private getPartialPath(workspaceId: string): string {
    return path.join(this.getSessionDir(workspaceId), this.PARTIAL_FILE);
  }

  // ── Reverse-read infrastructure ─────────────────────────────────────────────
  // Reads a history JSONL file from the tail to avoid O(total-history) parsing on
  // hot paths. \n (0x0A) never appears inside multi-byte UTF-8 sequences, so
  // chunked reverse reading is byte-safe. JSON.stringify escapes prevent false
  // positives for the needle inside user-content strings.
  // These helpers take a file path so they work on both chat.jsonl and
  // chat-archive.jsonl.

  /** Size of each chunk when scanning the file in reverse (256KB covers typical post-compaction content). */
  private static readonly REVERSE_READ_CHUNK_SIZE = 256 * 1024;
  /** String-search needles for context boundary lines. */
  private static readonly BOUNDARY_NEEDLES = [
    '"compactionBoundary":true',
    `"contextBoundaryKind":"${CONTEXT_BOUNDARY_KINDS.RESET}"`,
  ] as const;

  /**
   * Scan a history file in reverse to find the byte offset of a durable compaction boundary.
   * Returns `null` when no (matching) boundary exists.
   *
   * @param skip How many boundaries to skip before returning. 0 = last boundary,
   *             1 = second-to-last (penultimate), etc.
   *
   * Byte offsets are computed from raw \n positions in the buffer (not from decoded string
   * lengths) so that chunk boundaries splitting multi-byte UTF-8 sequences don't corrupt
   * the returned offset.
   */
  private async findLastBoundaryByteOffset(filePath: string, skip = 0): Promise<number | null> {
    let fileSize: number;
    try {
      const stat = await fs.stat(filePath);
      fileSize = stat.size;
    } catch {
      return null;
    }
    if (fileSize === 0) return null;

    const fh = await fs.open(filePath, "r");
    try {
      let readEnd = fileSize;
      // Raw bytes of the incomplete first line from the previous (rightward) chunk.
      // Kept as Buffer (not string) so multi-byte chars split at chunk boundaries
      // don't corrupt byte offsets via UTF-8 replacement characters.
      let carryoverBytes = Buffer.alloc(0);
      let skipped = 0;

      while (readEnd > 0) {
        const readStart = Math.max(0, readEnd - HistoryService.REVERSE_READ_CHUNK_SIZE);
        const chunkSize = readEnd - readStart;
        const rawChunk = Buffer.alloc(chunkSize);
        await fh.read(rawChunk, 0, chunkSize, readStart);

        // Combine with carryover (the start of a line whose tail was in the previous chunk).
        // The combined buffer represents contiguous file bytes [readStart, readStart + buffer.length).
        const buffer =
          carryoverBytes.length > 0 ? Buffer.concat([rawChunk, carryoverBytes]) : rawChunk;

        // Find \n byte positions in the raw buffer for accurate byte offsets.
        // 0x0A never appears inside multi-byte UTF-8 sequences, so this is byte-safe
        // even when a chunk boundary splits a multibyte character.
        const newlinePositions: number[] = [];
        for (let b = 0; b < buffer.length; b++) {
          if (buffer[b] === 0x0a) {
            newlinePositions.push(b);
          }
        }

        if (newlinePositions.length === 0) {
          // No newlines — entire buffer is one partial line, carry it all forward
          carryoverBytes = Buffer.from(buffer);
          readEnd = readStart;
          continue;
        }

        // Bytes before the first \n are an incomplete line — carry forward
        carryoverBytes = Buffer.from(buffer.subarray(0, newlinePositions[0]));

        // Scan complete lines in reverse. Each line occupies
        // [newlinePositions[nl] + 1, nextNewline) in the buffer.
        for (let nl = newlinePositions.length - 1; nl >= 0; nl--) {
          const lineStart = newlinePositions[nl] + 1;
          const lineEnd =
            nl < newlinePositions.length - 1 ? newlinePositions[nl + 1] : buffer.length;
          if (lineEnd <= lineStart) continue; // empty line

          const line = buffer.subarray(lineStart, lineEnd).toString("utf-8");
          if (HistoryService.BOUNDARY_NEEDLES.some((needle) => line.includes(needle))) {
            try {
              const msg = JSON.parse(line) as MuxMessage;
              if (isDurableContextBoundaryMarker(msg)) {
                if (skipped < skip) {
                  skipped++;
                } else {
                  return readStart + lineStart;
                }
              }
            } catch {
              // Malformed line — not a real boundary, skip
            }
          }
        }

        readEnd = readStart;
      }

      // Check the very first line (accumulated in carryover)
      if (carryoverBytes.length > 0) {
        const line = carryoverBytes.toString("utf-8");
        if (HistoryService.BOUNDARY_NEEDLES.some((needle) => line.includes(needle))) {
          try {
            const msg = JSON.parse(line) as MuxMessage;
            if (isDurableContextBoundaryMarker(msg)) {
              if (skipped < skip) {
                // Not enough boundaries in the file to satisfy skip
                return null;
              }
              return 0;
            }
          } catch {
            // skip
          }
        }
      }

      return null;
    } finally {
      await fh.close();
    }
  }

  /**
   * Read and parse messages from a byte offset to the end of a history file.
   * Self-healing: skips malformed JSON lines the same way readChatHistory does.
   */
  private async readHistoryFromOffset(filePath: string, byteOffset: number): Promise<MuxMessage[]> {
    const stat = await fs.stat(filePath);
    const tailSize = stat.size - byteOffset;
    if (tailSize <= 0) return [];

    const fh = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(tailSize);
      await fh.read(buffer, 0, tailSize, byteOffset);
      const lines = buffer
        .toString("utf-8")
        .split("\n")
        .filter((l) => l.trim());
      const messages: MuxMessage[] = [];
      for (const line of lines) {
        try {
          messages.push(normalizeLegacyMuxMetadata(JSON.parse(line) as MuxMessage));
        } catch {
          // Skip malformed lines — same self-healing behavior as readChatHistory
        }
      }
      return messages;
    } finally {
      await fh.close();
    }
  }

  /**
   * Read the last N messages from a history file by scanning it in reverse.
   * Much cheaper than a full read when only the tail is needed.
   *
   * Uses raw byte scanning for \n positions (same approach as findLastBoundaryByteOffset)
   * so that chunk boundaries splitting multi-byte UTF-8 sequences don't corrupt lines.
   */
  private async readLastMessagesFromFile(filePath: string, n: number): Promise<MuxMessage[]> {
    let fileSize: number;
    try {
      const stat = await fs.stat(filePath);
      fileSize = stat.size;
    } catch {
      return [];
    }
    if (fileSize === 0) return [];

    const fh = await fs.open(filePath, "r");
    try {
      const collected: MuxMessage[] = [];
      let readEnd = fileSize;
      let carryoverBytes = Buffer.alloc(0);

      while (readEnd > 0 && collected.length < n) {
        const readStart = Math.max(0, readEnd - HistoryService.REVERSE_READ_CHUNK_SIZE);
        const chunkSize = readEnd - readStart;
        const rawChunk = Buffer.alloc(chunkSize);
        await fh.read(rawChunk, 0, chunkSize, readStart);

        const buffer =
          carryoverBytes.length > 0 ? Buffer.concat([rawChunk, carryoverBytes]) : rawChunk;

        const newlinePositions: number[] = [];
        for (let b = 0; b < buffer.length; b++) {
          if (buffer[b] === 0x0a) {
            newlinePositions.push(b);
          }
        }

        if (newlinePositions.length === 0) {
          carryoverBytes = Buffer.from(buffer);
          readEnd = readStart;
          continue;
        }

        carryoverBytes = Buffer.from(buffer.subarray(0, newlinePositions[0]));

        // Parse complete lines in reverse, stopping once we have enough
        for (let nl = newlinePositions.length - 1; nl >= 0 && collected.length < n; nl--) {
          const lineStart = newlinePositions[nl] + 1;
          const lineEnd =
            nl < newlinePositions.length - 1 ? newlinePositions[nl + 1] : buffer.length;
          if (lineEnd <= lineStart) continue;

          const line = buffer.subarray(lineStart, lineEnd).toString("utf-8").trim();
          if (line.length === 0) continue;
          try {
            collected.push(normalizeLegacyMuxMetadata(JSON.parse(line) as MuxMessage));
          } catch {
            // Skip malformed lines
          }
        }

        readEnd = readStart;
      }

      // Check the very first line if we still need more
      if (collected.length < n && carryoverBytes.length > 0) {
        const line = carryoverBytes.toString("utf-8").trim();
        if (line.length > 0) {
          try {
            collected.push(normalizeLegacyMuxMetadata(JSON.parse(line) as MuxMessage));
          } catch {
            // skip
          }
        }
      }

      // Reverse to restore chronological order
      collected.reverse();
      return collected;
    } finally {
      await fh.close();
    }
  }

  /**
   * Read raw messages from a history JSONL file.
   * Returns empty array if the file doesn't exist.
   * Skips malformed JSON lines to prevent data loss from corruption.
   */
  private async readMessagesFromFile(filePath: string, logLabel: string): Promise<MuxMessage[]> {
    const data = await this.readExistingFile(filePath);
    return data === null
      ? []
      : this.parseMessages(data, logLabel, (value) =>
          normalizeLegacyMuxMetadata(value as MuxMessage)
        );
  }

  /**
   * Read raw messages from the active chat.jsonl (does not include partial.json
   * or the sealed archive).
   */
  private async readChatHistory(workspaceId: string): Promise<MuxMessage[]> {
    return this.readMessagesFromFile(
      this.getChatHistoryPath(workspaceId),
      `${workspaceId}/${this.CHAT_FILE}`
    );
  }

  /**
   * Read raw messages from the sealed chat-archive.jsonl (pre-boundary history).
   */
  private async readArchivedHistory(workspaceId: string): Promise<MuxMessage[]> {
    return this.readMessagesFromFile(
      this.getChatArchivePath(workspaceId),
      `${workspaceId}/${this.CHAT_ARCHIVE_FILE}`
    );
  }

  // ── Forward/backward iteration infrastructure ────────────────────────────
  // Chunked iteration over a history JSONL file that yields messages to a
  // visitor callback. Supports early exit (return false) and reduces memory
  // pressure vs. loading the entire file into an array.

  /**
   * Read a history file from start to end in chunks, calling visitor with each
   * batch of parsed messages and the original trimmed lines. Uses raw byte scanning for \n to handle
   * multi-byte UTF-8 safely at chunk boundaries.
   *
   * Returns false when the visitor stopped iteration early, true otherwise —
   * so multi-file iteration (archive + chat.jsonl) can honor early exits.
   */
  private async iterateForward(
    filePath: string,
    visitor: (
      messages: MuxMessage[],
      rawLines: readonly string[],
      rawBytes: Buffer
    ) => boolean | void | Promise<boolean | void>
  ): Promise<boolean> {
    let fileSize: number;
    try {
      const stat = await fs.stat(filePath);
      fileSize = stat.size;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return true; // No history
      }
      throw error;
    }
    if (fileSize === 0) return true;

    const fh = await fs.open(filePath, "r");
    try {
      let readPos = 0;
      // Incomplete last line from the previous chunk, kept as Buffer to
      // preserve split multi-byte UTF-8 sequences.
      let carryoverBytes = Buffer.alloc(0);

      while (readPos < fileSize) {
        const remaining = fileSize - readPos;
        const toRead = Math.min(HistoryService.REVERSE_READ_CHUNK_SIZE, remaining);
        const rawChunk = Buffer.alloc(toRead);
        await fh.read(rawChunk, 0, toRead, readPos);
        readPos += toRead;

        const buffer =
          carryoverBytes.length > 0 ? Buffer.concat([carryoverBytes, rawChunk]) : rawChunk;

        // Find the last \n to split complete lines from the trailing incomplete line.
        // 0x0A is byte-safe (never inside multi-byte UTF-8 sequences).
        let lastNewline = -1;
        for (let b = buffer.length - 1; b >= 0; b--) {
          if (buffer[b] === 0x0a) {
            lastNewline = b;
            break;
          }
        }

        if (lastNewline === -1) {
          // No newline in entire buffer — carry everything forward
          carryoverBytes = Buffer.from(buffer);
          continue;
        }

        // Decode only complete lines (up to and including the last \n)
        const completeText = buffer.subarray(0, lastNewline).toString("utf-8");
        carryoverBytes = Buffer.from(buffer.subarray(lastNewline + 1));

        const messages: MuxMessage[] = [];
        const rawLines = completeText
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        for (const trimmed of rawLines) {
          try {
            messages.push(normalizeLegacyMuxMetadata(JSON.parse(trimmed) as MuxMessage));
          } catch {
            // Skip malformed lines — same self-healing behavior as readChatHistory
          }
        }

        if (messages.length > 0) {
          const shouldContinue = await visitor(
            messages,
            rawLines,
            buffer.subarray(0, lastNewline + 1)
          );
          if (shouldContinue === false) return false;
        }
      }

      // Handle remaining carryover (last line without trailing newline)
      if (carryoverBytes.length > 0) {
        const line = carryoverBytes.toString("utf-8").trim();
        if (line.length > 0) {
          try {
            const msg = normalizeLegacyMuxMetadata(JSON.parse(line) as MuxMessage);
            const shouldContinue = await visitor([msg], [line], carryoverBytes);
            if (shouldContinue === false) return false;
          } catch {
            // Skip malformed line
          }
        }
      }
      return true;
    } finally {
      await fh.close();
    }
  }

  /**
   * Read a history file from end to start in chunks, calling visitor with each
   * batch of parsed messages (newest first within each chunk). Uses the same
   * raw-byte \n scanning as findLastBoundaryByteOffset.
   *
   * Returns false when the visitor stopped iteration early, true otherwise.
   */
  private async iterateBackward(
    filePath: string,
    visitor: (messages: MuxMessage[]) => boolean | void | Promise<boolean | void>
  ): Promise<boolean> {
    let fileSize: number;
    try {
      const stat = await fs.stat(filePath);
      fileSize = stat.size;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return true; // No history
      }
      throw error;
    }
    if (fileSize === 0) return true;

    const fh = await fs.open(filePath, "r");
    try {
      let readEnd = fileSize;
      let carryoverBytes = Buffer.alloc(0);

      while (readEnd > 0) {
        const readStart = Math.max(0, readEnd - HistoryService.REVERSE_READ_CHUNK_SIZE);
        const chunkSize = readEnd - readStart;
        const rawChunk = Buffer.alloc(chunkSize);
        await fh.read(rawChunk, 0, chunkSize, readStart);

        const buffer =
          carryoverBytes.length > 0 ? Buffer.concat([rawChunk, carryoverBytes]) : rawChunk;

        const newlinePositions: number[] = [];
        for (let b = 0; b < buffer.length; b++) {
          if (buffer[b] === 0x0a) {
            newlinePositions.push(b);
          }
        }

        if (newlinePositions.length === 0) {
          carryoverBytes = Buffer.from(buffer);
          readEnd = readStart;
          continue;
        }

        carryoverBytes = Buffer.from(buffer.subarray(0, newlinePositions[0]));

        // Parse complete lines in reverse (newest → oldest for backward iteration)
        const messages: MuxMessage[] = [];
        for (let nl = newlinePositions.length - 1; nl >= 0; nl--) {
          const lineStart = newlinePositions[nl] + 1;
          const lineEnd =
            nl < newlinePositions.length - 1 ? newlinePositions[nl + 1] : buffer.length;
          if (lineEnd <= lineStart) continue;

          const line = buffer.subarray(lineStart, lineEnd).toString("utf-8").trim();
          if (line.length === 0) continue;
          try {
            messages.push(normalizeLegacyMuxMetadata(JSON.parse(line) as MuxMessage));
          } catch {
            // Skip malformed lines
          }
        }

        if (messages.length > 0) {
          const shouldContinue = await visitor(messages);
          if (shouldContinue === false) return false;
        }

        readEnd = readStart;
      }

      // Check the very first line (accumulated in carryover)
      if (carryoverBytes.length > 0) {
        const line = carryoverBytes.toString("utf-8").trim();
        if (line.length > 0) {
          try {
            const msg = normalizeLegacyMuxMetadata(JSON.parse(line) as MuxMessage);
            const shouldContinue = await visitor([msg]);
            if (shouldContinue === false) return false;
          } catch {
            // Skip malformed line
          }
        }
      }
      return true;
    } finally {
      await fh.close();
    }
  }

  /**
   * Iterate over ALL messages in history (sealed archive + active chat.jsonl) —
   * O(total-history) I/O + parse.
   *
   * ⚠️  Prefer targeted alternatives for hot paths:
   *   - getHistoryFromLatestBoundary() — for provider-request assembly
   *   - getLastMessages(n)            — when only the tail matters
   *   - hasHistory()                  — for emptiness checks
   *
   * Yields chunks of parsed messages to the visitor callback. The visitor may
   * return `false` to stop iteration early (e.g., after finding a target message).
   *
   * @param direction - 'forward' reads oldest→newest, 'backward' reads newest→oldest
   * @param visitor - Called with each chunk of messages. Return false to stop early.
   */
  async iterateFullHistory(
    workspaceId: string,
    direction: "forward" | "backward",
    visitor: (messages: MuxMessage[]) => boolean | void | Promise<boolean | void>
  ): Promise<Result<void>> {
    return this.withRecoveredHistoryResultLock(workspaceId, "Failed to iterate history", () =>
      this.iterateFullHistoryUnlocked(workspaceId, direction, visitor)
    );
  }

  /**
   * Call only while holding workspaceFileLocks for this workspace (and NOT
   * the cross-process history write lock — recovery acquires it on demand).
   */
  async iterateFullHistoryUnderLock(
    workspaceId: string,
    direction: "forward" | "backward",
    visitor: (messages: MuxMessage[]) => boolean | void | Promise<boolean | void>
  ): Promise<Result<void>> {
    try {
      await this.recoverTruncateTransactionForReads(workspaceId);
      return await this.iterateFullHistoryUnlocked(workspaceId, direction, visitor);
    } catch (error) {
      return Err(`Failed to iterate history: ${getErrorMessage(error)}`);
    }
  }

  async copyHistorySnapshotToNewWorkspace(
    sourceWorkspaceId: string,
    targetWorkspaceId: string
  ): Promise<Result<void>> {
    assert(
      sourceWorkspaceId !== targetWorkspaceId,
      "history snapshot target must be a new workspace"
    );
    const snapshot = await this.withRecoveredHistoryWriteResultLock(
      sourceWorkspaceId,
      "Failed to read history snapshot",
      async () =>
        Ok({
          archive: await this.readExistingFile(this.getChatArchivePath(sourceWorkspaceId)),
          chat: await this.readExistingFile(this.getChatHistoryPath(sourceWorkspaceId)),
        })
    );
    if (!snapshot.success) {
      return snapshot;
    }

    return this.withRecoveredHistoryWriteResultLock(
      targetWorkspaceId,
      "Failed to copy history snapshot",
      async () => {
        invalidateHistoryAppendProvenance();
        for (const [targetPath, contents] of [
          [this.getChatArchivePath(targetWorkspaceId), snapshot.data.archive],
          [this.getChatHistoryPath(targetWorkspaceId), snapshot.data.chat],
        ] as const) {
          if (contents === null) {
            await fs.rm(targetPath, { force: true });
          } else {
            await writeFileAtomic(targetPath, contents);
          }
        }
        return Ok(undefined);
      }
    );
  }

  private async iterateFullHistoryUnlocked(
    workspaceId: string,
    direction: "forward" | "backward",
    visitor: (messages: MuxMessage[]) => boolean | void | Promise<boolean | void>
  ): Promise<Result<void>> {
    const chatPath = this.getChatHistoryPath(workspaceId);
    const archivePath = this.getChatArchivePath(workspaceId);
    try {
      if (direction === "forward") {
        // Archived rows are strictly older than active rows.
        const completed = await this.iterateForward(archivePath, visitor);
        if (completed) {
          await this.iterateForward(chatPath, visitor);
        }
      } else {
        const completed = await this.iterateBackward(chatPath, visitor);
        if (completed) {
          await this.iterateBackward(archivePath, visitor);
        }
      }
      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to iterate history: ${message}`);
    }
  }

  private getOldestHistorySequence(messages: readonly MuxMessage[]): number | undefined {
    let oldest: number | undefined;

    for (const message of messages) {
      const sequence = message.metadata?.historySequence;
      if (!isNonNegativeInteger(sequence)) {
        continue;
      }

      if (oldest === undefined || sequence < oldest) {
        oldest = sequence;
      }
    }

    return oldest;
  }

  private getNewestHistorySequence(messages: readonly MuxMessage[]): number | undefined {
    let newest: number | undefined;

    for (const message of messages) {
      const sequence = message.metadata?.historySequence;
      if (!isNonNegativeInteger(sequence)) {
        continue;
      }

      if (newest === undefined || sequence > newest) {
        newest = sequence;
      }
    }

    return newest;
  }

  private async getMaxHistorySequence(workspaceId: string): Promise<number> {
    let maxSequence = -1;

    // Full scan of the active file (cheap post-rotation; see getNextHistorySequence
    // for why we don't trust the tail alone).
    await this.iterateForward(this.getChatHistoryPath(workspaceId), (messages) => {
      const newest = this.getNewestHistorySequence(messages);
      if (newest !== undefined && newest > maxSequence) {
        maxSequence = newest;
      }
    });

    // The archive holds strictly-older sequences than chat.jsonl, so it only
    // decides the counter when chat.jsonl is missing/hand-edited.
    const archiveMax = await this.getArchiveTailMaxSequence(workspaceId);

    return Math.max(maxSequence, archiveMax);
  }

  /**
   * Newest sequenced row in the sealed archive, or -1 when none. Scans the
   * archive tail until a sequenced row is found instead of parsing the whole
   * file (archived appends are sequence-ordered).
   */
  private async getArchiveTailMaxSequence(workspaceId: string): Promise<number> {
    let archiveMax = -1;
    await this.iterateBackward(this.getChatArchivePath(workspaceId), (messages) => {
      const newest = this.getNewestHistorySequence(messages);
      if (newest !== undefined && newest > archiveMax) {
        archiveMax = newest;
      }
      return archiveMax === -1; // keep scanning until any sequence is found
    });
    return archiveMax;
  }

  async hasHistoryBeforeSequence(
    workspaceId: string,
    beforeHistorySequence: number
  ): Promise<boolean> {
    assert(
      typeof workspaceId === "string" && workspaceId.trim().length > 0,
      "workspaceId is required"
    );
    assert(
      isNonNegativeInteger(beforeHistorySequence),
      "hasHistoryBeforeSequence requires a non-negative integer"
    );

    return this.withRecoveredHistoryLock(workspaceId, () =>
      this.hasHistoryBeforeSequenceUnlocked(workspaceId, beforeHistorySequence)
    );
  }

  private async hasHistoryBeforeSequenceUnlocked(
    workspaceId: string,
    beforeHistorySequence: number
  ): Promise<boolean> {
    let hasOlder = false;
    const visitor = (messages: MuxMessage[]): boolean | void => {
      for (const message of messages) {
        const sequence = message.metadata?.historySequence;
        if (!isNonNegativeInteger(sequence)) {
          continue;
        }

        if (sequence < beforeHistorySequence) {
          hasOlder = true;
          return false;
        }
      }
    };

    const completed = await this.iterateBackward(this.getChatHistoryPath(workspaceId), visitor);
    if (completed && !hasOlder) {
      await this.iterateBackward(this.getChatArchivePath(workspaceId), visitor);
    }

    return hasOlder;
  }

  /**
   * Read one compaction-epoch history window older than `beforeHistorySequence`.
   *
   * Returns messages whose historySequence is strictly less than `beforeHistorySequence`
   * and belong to the nearest-older boundary window.
   */
  async getHistoryBoundaryWindow(
    workspaceId: string,
    beforeHistorySequence: number
  ): Promise<Result<{ messages: MuxMessage[]; hasOlder: boolean }>> {
    assert(
      typeof workspaceId === "string" && workspaceId.trim().length > 0,
      "workspaceId is required"
    );
    assert(
      isNonNegativeInteger(beforeHistorySequence),
      "getHistoryBoundaryWindow requires beforeHistorySequence to be a non-negative integer"
    );

    const operation = async (): Promise<Result<{ messages: MuxMessage[]; hasOlder: boolean }>> => {
      // Scan boundaries newest→oldest and pick the first window that has rows older
      // than the cursor. Boundaries newer than the rotation point live in chat.jsonl;
      // older ones live in the sealed archive.
      for (const filePath of [
        this.getChatHistoryPath(workspaceId),
        this.getChatArchivePath(workspaceId),
      ]) {
        for (let skip = 0; ; skip++) {
          const boundaryOffset = await this.findLastBoundaryByteOffset(filePath, skip);
          if (boundaryOffset === null) {
            break;
          }

          const tailMessages = await this.readHistoryFromOffset(filePath, boundaryOffset);
          const windowMessages = tailMessages.filter((message) => {
            const sequence = message.metadata?.historySequence;
            return isNonNegativeInteger(sequence) && sequence < beforeHistorySequence;
          });

          if (windowMessages.length === 0) {
            continue;
          }

          const oldestWindowSequence = this.getOldestHistorySequence(windowMessages);
          assert(
            oldestWindowSequence !== undefined,
            "window messages filtered by historySequence must include a sequence"
          );

          const hasOlder = await this.hasHistoryBeforeSequenceUnlocked(
            workspaceId,
            oldestWindowSequence
          );
          return Ok({ messages: windowMessages, hasOlder });
        }
      }

      // No older boundary window found. Fall back to pre-boundary rows (or empty on uncompacted history).
      const allMessages = [
        ...(await this.readArchivedHistory(workspaceId)),
        ...(await this.readChatHistory(workspaceId)),
      ];
      const preBoundaryMessages = allMessages.filter((message) => {
        const sequence = message.metadata?.historySequence;
        return isNonNegativeInteger(sequence) && sequence < beforeHistorySequence;
      });

      if (preBoundaryMessages.length === 0) {
        return Ok({ messages: [], hasOlder: false });
      }

      const oldestWindowSequence = this.getOldestHistorySequence(preBoundaryMessages);
      assert(
        oldestWindowSequence !== undefined,
        "pre-boundary messages filtered by historySequence must include a sequence"
      );

      const hasOlder = await this.hasHistoryBeforeSequenceUnlocked(
        workspaceId,
        oldestWindowSequence
      );
      return Ok({ messages: preBoundaryMessages, hasOlder });
    };

    try {
      return await this.withRecoveredHistoryLock(workspaceId, operation);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to read history boundary window: ${message}`);
    }
  }

  async getMessagesForCompactionEpoch(
    workspaceId: string,
    metadata: CompactionCompletionMetadata
  ): Promise<Result<{ messages: MuxMessage[]; summary: MuxMessage }>> {
    assert(
      typeof workspaceId === "string" && workspaceId.trim().length > 0,
      "workspaceId is required"
    );
    assert(
      metadata.workspaceId === workspaceId,
      "compaction metadata workspace must match request"
    );
    assert(
      isNonNegativeInteger(metadata.summaryHistorySequence),
      "summaryHistorySequence must be a non-negative integer"
    );

    try {
      const messages: MuxMessage[] = [];
      let summary: MuxMessage | undefined;
      const lowerBound = metadata.previousBoundaryHistorySequence;
      const seenHistorySequences = new Set<number>();

      // The just-compacted epoch can straddle chat-archive.jsonl and chat.jsonl after
      // sealed-history rotation, so scan the full logical history under the workspace
      // lock; otherwise a concurrent boundary rotation can move rows between files mid-scan.
      const iteration = await this.withRecoveredHistoryLock(workspaceId, () =>
        this.iterateFullHistoryUnlocked(workspaceId, "forward", (chunk) => {
          for (const message of chunk) {
            const sequence = message.metadata?.historySequence;
            if (!isNonNegativeInteger(sequence)) continue;
            if (seenHistorySequences.has(sequence)) continue;
            seenHistorySequences.add(sequence);

            if (
              sequence === metadata.summaryHistorySequence &&
              message.id === metadata.summaryMessageId
            ) {
              summary = message;
              continue;
            }

            if (sequence >= metadata.summaryHistorySequence) continue;
            if (lowerBound !== undefined && sequence <= lowerBound) continue;
            if (message.id === metadata.compactionRequestMessageId) continue;
            if (isDurableContextBoundaryMarker(message)) continue;
            messages.push(message);
          }
        })
      );
      if (!iteration.success) {
        return Err(`Failed to read compaction epoch messages: ${iteration.error}`);
      }

      if (summary === undefined) {
        return Err(`Compaction summary not found: ${metadata.summaryMessageId}`);
      }

      return Ok({ messages, summary });
    } catch (error) {
      return Err(`Failed to read compaction epoch messages: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Read messages from a compaction boundary onward.
   * Falls back to full history if no boundary exists (new/uncompacted workspace).
   * Unreadable reset evidence is a provider privacy floor that skip/fallback cannot cross.
   *
   * @param skip How many boundaries to skip (counting from the latest, across
   *             chat.jsonl and the sealed archive). 0 = read from the latest
   *             boundary, 1 = from the penultimate, etc. When the requested
   *             boundary doesn't exist, falls back to the next-available
   *             boundary, then to full history.
   *
   * Prefer this over iterateFullHistory() for provider-request assembly and any path
   * that only needs the active compaction epoch.
   */
  async getHistoryFromLatestBoundary(workspaceId: string, skip = 0): Promise<Result<MuxMessage[]>> {
    try {
      return await this.withRecoveredHistoryLock(workspaceId, () =>
        this.getHistoryFromLatestBoundaryUnlocked(workspaceId, skip)
      );
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to read history from boundary: ${message}`);
    }
  }

  /** Lifecycle decisions retain malformed IDs/parts without bypassing the raw privacy floor. */
  async getControlEvidenceFromLatestBoundary(
    workspaceId: string
  ): Promise<Result<HistoryControlRow[]>> {
    return this.withRecoveredHistoryResultLock(
      workspaceId,
      "Failed to read history control evidence",
      async () => {
        await this.ensureSealedHistoryRotatedUnlocked(workspaceId);
        return Ok(
          await readHistoryControlEvidenceFromLatestBoundary(
            {
              chat: this.getChatHistoryPath(workspaceId),
              archive: this.getChatArchivePath(workspaceId),
            },
            0
          )
        );
      }
    );
  }

  private async getHistoryFromLatestBoundaryUnlocked(
    workspaceId: string,
    skip: number
  ): Promise<Result<MuxMessage[]>> {
    // One-time lazy migration: seal any pre-boundary prefix left in chat.jsonl
    // by older builds so this read (and every later one) stays O(active epoch).
    await this.ensureSealedHistoryRotatedUnlocked(workspaceId);

    // Provider and control-evidence reads share raw privacy floors. UI browsing
    // and archival rotation keep the durable-boundary locator and the full log.
    return Ok(
      await readProviderHistoryFromLatestBoundary(
        {
          chat: this.getChatHistoryPath(workspaceId),
          archive: this.getChatArchivePath(workspaceId),
        },
        skip
      )
    );
  }

  // ── Sealed-history rotation ─────────────────────────────────────────────
  // Compaction (and /clear --soft) appends a durable context boundary but, by
  // itself, never shrinks chat.jsonl. Rotation moves the sealed prefix —
  // everything before the latest durable boundary — into chat-archive.jsonl so
  // hot-path reads and the per-turn updateHistory rewrite stay O(active epoch).
  // Pre-boundary history remains fully accessible (Load More, exports, usage
  // rebuilds) through the archive-aware read paths above.

  /**
   * One-time-per-process check that seals any pre-boundary prefix left in
   * chat.jsonl. Newly written boundaries rotate eagerly at write time; this
   * lazily migrates files produced before rotation existed (or by crashes
   * between boundary write and rotation).
   */
  private async ensureSealedHistoryRotatedUnlocked(workspaceId: string): Promise<void> {
    if (this.sealedRotationChecked.has(workspaceId)) {
      return;
    }

    try {
      const provenance = this.getAppendProvenance(workspaceId);
      if (!provenance.inTransaction()) {
        await this.withHistoryWriteFileLock(workspaceId, async () => {
          if (await isWorkspaceRemovalTombstoned(this.config.rootDir, workspaceId)) return;
          await ensurePrivateDir(this.getSessionDir(workspaceId));
          await provenance.runMutation(() => this.ensureSealedHistoryRotatedUnlocked(workspaceId));
        });
        return;
      }
      const offset = await this.findLastBoundaryByteOffset(this.getChatHistoryPath(workspaceId));
      if (offset !== null && offset !== 0) {
        await this.rotateSealedHistoryUnlocked(workspaceId);
      }
      this.sealedRotationChecked.add(workspaceId);
    } catch (error) {
      this.sealedRotationChecked.delete(workspaceId);
      // Rotation is an optimization — reads remain correct on unrotated files.
      log.warn("Failed to rotate sealed chat history", {
        workspaceId,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Move the sealed prefix of chat.jsonl (everything before the latest durable
   * context boundary) into chat-archive.jsonl. Must be called while holding the
   * workspace file lock.
   *
   * Crash safety: archived lines are fsynced before chat.jsonl is rewritten, so
   * a crash in between leaves duplicated rows in archive + chat.jsonl. The next
   * rotation deduplicates sequence-covered prefix rows only after verifying
   * that the archive contains the same complete row identity.
   */
  private async rotateSealedHistoryUnlocked(workspaceId: string): Promise<void> {
    const chatPath = this.getChatHistoryPath(workspaceId);
    const archivePath = this.getChatArchivePath(workspaceId);

    const boundaryOffset = await this.findLastBoundaryByteOffset(chatPath);
    if (boundaryOffset === null || boundaryOffset === 0) {
      return; // Nothing sealed — boundary already starts the file (or no boundary).
    }

    invalidateHistoryAppendProvenance();
    const fileBuffer = await fs.readFile(chatPath);
    const sealedPrefix = fileBuffer.subarray(0, boundaryOffset);
    const activeTail = fileBuffer.subarray(boundaryOffset);

    // Sequence coverage only identifies possible crash-replay copies. A repaired
    // row (especially a reset) may reuse an old sequence without being archived.
    const archivedMaxSequence = await this.getArchiveTailMaxSequence(workspaceId);
    const candidates = new Set<string>();
    // Parsed equality loses duplicate-key reset markers. Compare exact bytes,
    // including whitespace and invalid UTF-8, before discarding a replayed row.
    const fingerprint = (line: Buffer) => createHash("sha256").update(line).digest("hex");
    const prefixRows = splitHistoryLines(sealedPrefix).map((line) => {
      try {
        const message = JSON.parse(line.toString("utf8")) as MuxMessage;
        const sequence = message.metadata?.historySequence;
        if (isNonNegativeInteger(sequence) && sequence <= archivedMaxSequence) {
          const key = fingerprint(line);
          candidates.add(key);
          return { line, fingerprint: key };
        }
      } catch {
        // Malformed reset fragments must survive rotation byte-for-byte.
      }
      return { line, fingerprint: undefined };
    });
    const verifiedCopies = new Set<string>();
    if (candidates.size > 0) {
      await this.iterateForward(archivePath, (_messages, _rawLines, rawBytes) => {
        for (const line of splitHistoryLines(rawBytes)) {
          const key = fingerprint(line);
          if (candidates.delete(key)) verifiedCopies.add(key);
        }
        return candidates.size > 0;
      });
    }
    const linesToArchive = prefixRows
      .filter((row) => row.fingerprint === undefined || !verifiedCopies.has(row.fingerprint))
      .map((row) => row.line);

    if (linesToArchive.length > 0) {
      // Append + fsync BEFORE rewriting chat.jsonl: a crash must never lose
      // sealed rows, only (at worst) duplicate them, which the dedupe above heals.
      const fh = await fs.open(archivePath, "a+");
      try {
        // A failed archive write can leave a torn tail while chat still contains
        // the complete rows. Delimit that evidence before replaying those rows.
        const { size } = await fh.stat();
        if (size > 0) {
          const tail = Buffer.alloc(1);
          const read = await fh.read(tail, 0, 1, size - 1);
          assert(read.bytesRead === 1, "archive tail must remain readable under the history lock");
          if (tail[0] !== 10) await fh.writeFile("\n");
        }
        await fh.writeFile(Buffer.concat(linesToArchive));
        await fh.sync();
      } finally {
        await fh.close();
      }
    }

    await writeFileAtomic(chatPath, activeTail);

    log.debug("Rotated sealed chat history into archive", {
      workspaceId,
      sealedBytes: boundaryOffset,
      archivedLines: linesToArchive.length,
    });
  }

  /**
   * Read the last N messages from history by reading files in reverse.
   * Much cheaper than iterateFullHistory() when only the tail is needed.
   * Continues into the sealed archive when the active epoch has fewer than N rows.
   */
  async getLastMessages(workspaceId: string, n: number): Promise<Result<MuxMessage[]>> {
    return this.withRecoveredHistoryResultLock(
      workspaceId,
      `Failed to read last ${n} messages`,
      async () => {
        try {
          const messages = await this.readLastMessagesFromFile(
            this.getChatHistoryPath(workspaceId),
            n
          );
          if (messages.length < n) {
            const archived = await this.readLastMessagesFromFile(
              this.getChatArchivePath(workspaceId),
              n - messages.length
            );
            return Ok([...archived, ...messages]);
          }
          return Ok(messages);
        } catch (error) {
          const message = getErrorMessage(error);
          return Err(`Failed to read last ${n} messages: ${message}`);
        }
      }
    );
  }

  /**
   * Check if a workspace has any chat history without parsing the files.
   * Much cheaper than iterateFullHistory() when only an emptiness check is needed.
   */
  async hasHistory(workspaceId: string): Promise<boolean> {
    return this.withRecoveredHistoryLock(workspaceId, async () => {
      for (const filePath of [
        this.getChatHistoryPath(workspaceId),
        this.getChatArchivePath(workspaceId),
      ]) {
        try {
          const stat = await fs.stat(filePath);
          if (stat.size > 0) {
            return true;
          }
        } catch {
          // Missing file — keep checking.
        }
      }
      return false;
    });
  }

  /**
   * Read the partial message for a workspace, if it exists.
   */
  async readPartial(workspaceId: string): Promise<MuxMessage | null> {
    try {
      const partialPath = this.getPartialPath(workspaceId);
      const data = await fs.readFile(partialPath, "utf-8");
      const message = JSON.parse(data) as MuxMessage;
      return normalizeLegacyMuxMetadata(message);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return null;
      }

      log.error("Error reading partial:", error);
      return null;
    }
  }

  /**
   * Write a partial message to disk.
   */
  async writePartial(workspaceId: string, message: MuxMessage): Promise<Result<void>> {
    return this.fileLocks.withLock(workspaceId, () =>
      this.writePartialUnlocked(workspaceId, message)
    );
  }

  /**
   * Read-modify-write the partial while it still belongs to `messageId`. Returns false (writing
   * nothing) when the partial is missing, belongs to another message, or `updater` declines.
   * Callers that assembled an update from an earlier read use this so a stream started in
   * between (commit of that partial, then a new one under the fresh message id) is never
   * resurrected or overwritten. The read and the write happen under the workspace mutex AND the
   * cross-process history write lock, the same pair commitPartial holds for its whole
   * transaction, so neither this process nor a foreign backend can commit the partial between
   * them.
   */
  async updatePartialIfMessageIdMatches(
    workspaceId: string,
    messageId: string,
    updater: (current: MuxMessage) => MuxMessage | null
  ): Promise<Result<boolean>> {
    try {
      return await this.fileLocks.withLock(workspaceId, () =>
        this.withHistoryWriteFileLock(workspaceId, async () => {
          const current = await this.readPartial(workspaceId);
          if (current?.id !== messageId) {
            return Ok(false);
          }
          const updated = updater(current);
          if (updated == null) {
            return Ok(false);
          }
          const writeResult = await this.writePartialUnderWriteLock(workspaceId, updated);
          return writeResult.success ? Ok(true) : writeResult;
        })
      );
    } catch (error) {
      return Err(`Failed to update partial: ${getErrorMessage(error)}`);
    }
  }

  private async writePartialUnlocked(
    workspaceId: string,
    message: MuxMessage
  ): Promise<Result<void>> {
    try {
      // r66: partial flushes ride the cross-process history lock with an
      // in-lock removal-tombstone gate — a foreign backend's active stream
      // survives the remover's process-local cancellation, and its next
      // delta's ensurePrivateDir would otherwise recreate the deleted
      // session directory (removal holds this same lock across its
      // tombstone+delete critical section). Truncation recovery is skipped:
      // partial.json is not part of the archive/chat transaction.
      return await this.withHistoryWriteFileLock(workspaceId, () =>
        this.writePartialUnderWriteLock(workspaceId, message)
      );
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      return Err(`Failed to write partial: ${errorMessage}`);
    }
  }

  private async writePartialUnderWriteLock(
    workspaceId: string,
    message: MuxMessage
  ): Promise<Result<void>> {
    if (await isWorkspaceRemovalTombstoned(this.config.rootDir, workspaceId)) {
      return Err(`workspace ${workspaceId} was removed; refusing partial write`);
    }
    const workspaceDir = this.getSessionDir(workspaceId);
    await ensurePrivateDir(workspaceDir);
    const partialPath = this.getPartialPath(workspaceId);

    const partialMessage: MuxMessage = {
      ...message,
      metadata: {
        ...message.metadata,
        partial: true,
      },
    };

    // Atomic write: writes to temp file then renames, preventing corruption
    // if app crashes mid-write (prevents "Unexpected end of JSON input" on read)
    await writeFileAtomic(partialPath, JSON.stringify(partialMessage, null, 2));
    return Ok(undefined);
  }

  /**
   * Delete the partial message file for a workspace.
   */
  async deletePartial(workspaceId: string): Promise<Result<void>> {
    return this.fileLocks.withLock(workspaceId, () => this.deletePartialUnlocked(workspaceId));
  }

  private async deletePartialUnlocked(workspaceId: string): Promise<Result<void>> {
    try {
      const partialPath = this.getPartialPath(workspaceId);
      await fs.unlink(partialPath);
      return Ok(undefined);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return Ok(undefined);
      }
      const errorMessage = getErrorMessage(error);
      return Err(`Failed to delete partial: ${errorMessage}`);
    }
  }

  /**
   * Delete the partial message file only when it still belongs to the expected message.
   * Returns true when a matching partial was deleted, false when the partial was missing
   * or belonged to a different message.
   */
  async deletePartialIfMessageIdMatches(
    workspaceId: string,
    messageId: string
  ): Promise<Result<boolean>> {
    return this.fileLocks.withLock(workspaceId, async () => {
      try {
        const partialPath = this.getPartialPath(workspaceId);
        const data = await fs.readFile(partialPath, "utf-8");
        const partialMessage = normalizeLegacyMuxMetadata(JSON.parse(data) as MuxMessage);
        if (partialMessage.id !== messageId) {
          return Ok(false);
        }
        await fs.unlink(partialPath);
        return Ok(true);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          return Ok(false);
        }
        const errorMessage = getErrorMessage(error);
        return Err(`Failed to delete matching partial: ${errorMessage}`);
      }
    });
  }

  /**
   * Commit any existing partial message to chat history and delete partial.json.
   *
   * This is idempotent:
   * - If the partial has already been finalized in history, it is not committed again.
   * - After committing (or if already finalized), partial.json is deleted.
   *
   * Snapshot, history append/update/delete, and partial delete run as ONE transaction under the
   * workspace mutex and the cross-process history write lock: a partial write landing between
   * the snapshot and the delete (updatePartialIfMessageIdMatches here, or a foreign backend's
   * commit of the same partial) would otherwise be appended pre-update and then dropped, or
   * resurrect an already committed partial.
   */
  async commitPartial(workspaceId: string, expectedMessageId?: string): Promise<Result<void>> {
    // Lock-free probe: most stream starts have no partial to commit, and a reader observes either
    // the old or the new atomically written file, never a torn one.
    if ((await this.readPartial(workspaceId)) == null) {
      return Ok(undefined);
    }
    return this.withRecoveredHistoryWriteResultLock(workspaceId, "Failed to commit partial", () =>
      this.commitPartialUnderWriteLock(workspaceId, expectedMessageId)
    );
  }

  private async commitPartialUnderWriteLock(
    workspaceId: string,
    expectedMessageId?: string
  ): Promise<Result<void>> {
    try {
      let partial = await this.readPartial(workspaceId);
      if (!partial) {
        return Ok(undefined);
      }
      // Attempt finalization must not commit a replacement's partial. Check inside the
      // same transaction as the history write and deletion, never in a caller-side probe.
      if (expectedMessageId != null && partial.id !== expectedMessageId) return Ok(undefined);

      const hadErrorMetadata = partial.metadata?.error != null;

      // Strip transient error metadata, but persist accumulated content.
      if (partial.metadata?.error) {
        const { error, errorType, ...cleanMetadata } = partial.metadata;
        partial = { ...partial, metadata: cleanMetadata };
      }

      const partialSeq = partial.metadata?.historySequence;
      if (partialSeq === undefined) {
        return Err("Partial message has no historySequence");
      }

      const historyResult = await this.getHistoryFromLatestBoundaryUnlocked(workspaceId, 0);
      if (!historyResult.success) {
        return Err(`Failed to read history: ${historyResult.error}`);
      }

      const existingMessages = historyResult.data;
      const maxExistingSequence = this.getNewestHistorySequence(existingMessages);

      const commitWorthy = hasCommitWorthyParts(partial.parts);

      // Refusal errors can be durable even with zero assistant-visible parts:
      // finishReason lets the UI show a refusal row after error/errorType are
      // stripped on commit, and usage/toolModelUsages may be absent if the
      // provider omitted usage or metadata reads timed out.
      const hasDurableRefusalMetadata =
        hadErrorMetadata && isRefusalFinishReason(partial.metadata?.finishReason);

      const existingMessage = existingMessages.find(
        (message) => message.metadata?.historySequence === partialSeq
      );

      if (
        !existingMessage &&
        maxExistingSequence !== undefined &&
        partialSeq <= maxExistingSequence
      ) {
        // User rationale: stale partial.json files from older compaction epochs used to append
        // old historySequence values at the tail. That made the next live send look like a
        // mid-history edit and the renderer truncated the visible chat at an odd position.
        log.warn("Deleting stale partial with non-tail historySequence", {
          workspaceId,
          messageId: partial.id,
          partialSeq,
          maxExistingSequence,
        });
        return this.deletePartialUnlocked(workspaceId);
      }

      const shouldCommit =
        (!existingMessage ||
          (partial.parts?.length ?? 0) > (existingMessage.parts?.length ?? 0) ||
          hasDurableRefusalMetadata) &&
        (commitWorthy || hasDurableRefusalMetadata);

      const shouldDeleteErroredPlaceholder =
        hadErrorMetadata &&
        !commitWorthy &&
        !hasDurableRefusalMetadata &&
        existingMessage?.id === partial.id &&
        (existingMessage.parts?.length ?? 0) === 0;

      if (shouldCommit) {
        if (existingMessage) {
          const updateResult = await this.updateHistoryUnderWriteLock(workspaceId, partial);
          if (!updateResult.success) {
            return updateResult;
          }
        } else {
          const appendResult = await this.appendToHistoryUnderWriteLock(workspaceId, partial);
          if (!appendResult.success) {
            return appendResult;
          }
        }
      } else if (shouldDeleteErroredPlaceholder) {
        const deleteMessageResult = await this.deleteMessageUnderWriteLock(workspaceId, partial.id);
        if (
          !deleteMessageResult.success &&
          !deleteMessageResult.error.includes("not found in history")
        ) {
          return deleteMessageResult;
        }
      }

      return this.deletePartialUnlocked(workspaceId);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      return Err(`Failed to commit partial: ${errorMessage}`);
    }
  }

  /**
   * Get or initialize the next history sequence number for a workspace.
   */
  private async getNextHistorySequence(workspaceId: string): Promise<number> {
    // Check if we already have it in memory.
    const cachedCounter = this.sequenceCounters.get(workspaceId);
    if (cachedCounter !== undefined) {
      return cachedCounter;
    }

    // User rationale: a stale partial or hand-edited chat.jsonl can leave an old
    // historySequence at the tail. Initializing from the tail would make the next
    // live message look like an edit/truncation to the renderer, so scan for max.
    const nextSeqNum = (await this.getMaxHistorySequence(workspaceId)) + 1;
    assert(
      isNonNegativeInteger(nextSeqNum),
      "next history sequence counter must be a non-negative integer"
    );
    this.sequenceCounters.set(workspaceId, nextSeqNum);
    return nextSeqNum;
  }

  /**
   * Internal helper for appending to history without acquiring lock.
   */
  private async _appendToHistoryUnlocked(
    workspaceId: string,
    message: MuxMessage
  ): Promise<Result<void>> {
    try {
      const workspaceDir = this.getSessionDir(workspaceId);
      await ensurePrivateDir(workspaceDir);

      // DEBUG: Log message append with caller stack trace
      const stack = new Error().stack?.split("\n").slice(2, 6).join("\n") ?? "no stack";
      log.debug(
        `[HISTORY APPEND] workspaceId=${workspaceId} role=${message.role} id=${message.id}`
      );
      log.debug(`[HISTORY APPEND] Call stack:\n${stack}`);

      // Ensure message has a history sequence number
      if (!message.metadata) {
        // Create metadata with history sequence
        const nextSeqNum = await this.getNextHistorySequence(workspaceId);
        assert(
          isNonNegativeInteger(nextSeqNum),
          "getNextHistorySequence must return a non-negative integer"
        );
        message.metadata = {
          historySequence: nextSeqNum,
        };
        this.sequenceCounters.set(workspaceId, nextSeqNum + 1);
      } else {
        // Message already has metadata, but may need historySequence assigned
        const existingSeqNum = message.metadata.historySequence;
        if (existingSeqNum !== undefined) {
          assert(
            isNonNegativeInteger(existingSeqNum),
            "appendToHistory requires historySequence to be a non-negative integer when provided"
          );

          // Already has a history sequence. Initialize from persisted max first so a stale
          // recovered row cannot regress the counter and make the next live append look like
          // a user edit/truncation in the renderer.
          const currentCounter = await this.getNextHistorySequence(workspaceId);
          assert(
            isNonNegativeInteger(currentCounter),
            "history sequence counter must remain a non-negative integer"
          );
          if (existingSeqNum < currentCounter) {
            return Err(
              `Refusing to append stale historySequence ${existingSeqNum}; next sequence is ${currentCounter}`
            );
          }
          this.sequenceCounters.set(workspaceId, existingSeqNum + 1);
        } else {
          // Has metadata but no historySequence, assign one
          const nextSeqNum = await this.getNextHistorySequence(workspaceId);
          assert(
            isNonNegativeInteger(nextSeqNum),
            "getNextHistorySequence must return a non-negative integer"
          );
          message.metadata = {
            ...message.metadata,
            historySequence: nextSeqNum,
          };
          this.sequenceCounters.set(workspaceId, nextSeqNum + 1);
        }
      }

      // Store the message with workspace context
      const historyEntry = {
        ...message,
        workspaceId,
      };

      // DEBUG: Log assigned sequence number
      log.debug(
        `[HISTORY APPEND] Assigned historySequence=${message.metadata.historySequence ?? "unknown"} role=${message.role}`
      );

      await this.getAppendProvenance(workspaceId).appendChat(
        Buffer.from(JSON.stringify(historyEntry) + "\n")
      );
      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to append to history: ${message}`);
    }
  }

  /** Serialize messages as JSONL rows tagged with workspace context. */
  private serializeHistoryEntries(messages: readonly MuxMessage[], workspaceId: string): string {
    return messages.map((msg) => JSON.stringify({ ...msg, workspaceId }) + "\n").join("");
  }

  private async readHistoryForRewrite(filePath: string): Promise<{
    rows: HistoryRewriteRow[];
    messages: MuxMessage[];
  }> {
    const raw = (await this.readExistingFileBytes(filePath)) ?? Buffer.alloc(0);
    const rows = splitHistoryLines(raw).map((line) => {
      const text = line.toString("utf8");
      return {
        raw: line,
        message: this.parseMessages(text, filePath, (value) =>
          isReadableHistoryMessage(value) &&
          !(hasRawResetMarker(text) && hasAmbiguousResetKeys(text))
            ? normalizeLegacyMuxMetadata(value)
            : null
        )[0],
      };
    });
    return { rows, messages: rows.flatMap((row) => (row.message ? [row.message] : [])) };
  }

  private serializeHistoryRewrite(
    rows: readonly HistoryRewriteRow[],
    workspaceId: string,
    transform: (message: MuxMessage, raw: Buffer) => MuxMessage | null,
    appended: readonly MuxMessage[] = []
  ): Buffer {
    // Automatic rewrites must not erase unreadable reset evidence, including
    // invalid UTF-8, duplicate keys, and markers split across malformed rows.
    const contents = rows.flatMap((row) => {
      if (!row.message) return [row.raw];
      const updated = transform(row.message, row.raw);
      if (updated === row.message) return [row.raw];
      if (updated === null) {
        if (
          hasRawResetMarker(row.raw.toString("utf8")) &&
          (!isReadableHistoryMessage(row.message) ||
            !hasRawResetMarker(JSON.stringify(row.message)))
        ) {
          throw new Error("History cleanup would erase unreadable reset evidence");
        }
        return [];
      }
      const serialized = this.serializeHistoryEntries([updated], workspaceId);
      // Unreadable/ambiguous rows stay raw above. For readable rows, payload
      // data cannot establish or stand in for a real top-level reset boundary.
      if (
        row.message.metadata?.contextBoundaryKind === CONTEXT_BOUNDARY_KINDS.RESET &&
        updated.metadata?.contextBoundaryKind !== CONTEXT_BOUNDARY_KINDS.RESET
      ) {
        throw new Error("History update would erase reset evidence");
      }
      return [Buffer.from(serialized)];
    });
    // Future appends must start a new row even when a preserved corrupt tail
    // lacked its final newline. Add only a delimiter; retain every original byte.
    const last = contents.at(-1);
    if (last && last.at(-1) !== 10) contents.push(Buffer.from("\n"));
    if (appended.length > 0) {
      contents.push(Buffer.from(this.serializeHistoryEntries(appended, workspaceId)));
    }
    return Buffer.concat(contents);
  }

  private serializeHistoryTruncation(
    rows: readonly HistoryRewriteRow[],
    workspaceId: string,
    retainedMessages: readonly MuxMessage[],
    sanitize: (message: MuxMessage) => MuxMessage = (message) => message
  ): Buffer {
    const retained = new Set(retainedMessages);
    // Partial cuts are not full clears: unreadable fragments may jointly form a
    // reset floor, even beyond the cut or in the other history file. Keep them
    // byte-for-byte, including standalone JSON strings that parse as non-messages.
    return this.serializeHistoryRewrite(rows, workspaceId, (message) =>
      !isReadableHistoryMessage(message)
        ? message
        : retained.has(message)
          ? sanitize(message)
          : null
    );
  }

  /**
   * Best-effort rotation after a durable boundary lands via append/update.
   * Failures are non-fatal: reads remain correct on unrotated files and the
   * lazy per-process check retries later.
   */
  private async rotateAfterBoundaryWriteUnlocked(
    workspaceId: string,
    message: MuxMessage
  ): Promise<void> {
    if (!isDurableContextBoundaryMarker(message)) {
      return;
    }
    try {
      await this.rotateSealedHistoryUnlocked(workspaceId);
    } catch (error) {
      log.warn("Failed to rotate sealed chat history after boundary write", {
        workspaceId,
        messageId: message.id,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Serialize history WRITES across backend processes (r50/r51). The
   * in-process history mutex cannot exclude a second backend
   * (XUM_ALLOW_MULTIPLE_INSTANCES=1) writing the same chat.jsonl: plain
   * appends are O_APPEND and never delete foreign rows, but every
   * read-modify-write that atomically replaces the file — the family-message
   * batch, updateHistory's row finalization, deletes, truncations, boundary
   * persistence — would silently revert or delete a foreign row landing
   * between its read and its replace. ALL mutation paths therefore hold this
   * session-dir lock for their whole read+replace (via
   * withRecoveredHistoryWriteResultLock); reads stay lock-free because
   * writeFileAtomic's rename means a reader observes either the old or the
   * new file, never a torn one. Always nested INSIDE the in-process history
   * mutex, so lock order is fixed and re-entry is impossible.
   */
  private async withCrossProcessWriteLock<T>(
    workspaceId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const sessionDir = this.getSessionDir(workspaceId);
    // Lock BEFORE any directory creation (r63): the lockfile lives outside
    // the session dir, and removal holds this same lock while it tombstones
    // and deletes — so a mutation serializes with removal instead of racing
    // its own ensurePrivateDir against the deletion.
    return this.withHistoryWriteFileLock(workspaceId, async () => {
      // Removal gate (r63), checked IN-LOCK: a foreign backend's in-flight
      // stream survives the remover's process-local cancellation entirely; its
      // late append would otherwise recreate the deleted session directory via
      // ensurePrivateDir below. Throwing here surfaces as a normal Err through
      // withRecoveredHistoryWriteResultLock.
      if (await isWorkspaceRemovalTombstoned(this.config.rootDir, workspaceId)) {
        throw new Error(`workspace ${workspaceId} was removed; refusing history mutation`);
      }
      // Create the session dir with private permissions only for a live
      // workspace (writeFileAtomic and appends assume the parent exists).
      await ensurePrivateDir(sessionDir);
      // Truncation recovery runs IN-LOCK (r64): recovery mutates the
      // archive/chat/marker files, and outside the lock it cannot tell a
      // crashed transaction from another backend's live rewrite — rolling
      // back a live transaction mid-flight resurrects discarded history with
      // mismatched archive/chat state.
      return this.getAppendProvenance(workspaceId).runMutation(async () => {
        if (await this.truncateRecoveryArtifactsPresent(workspaceId))
          invalidateHistoryAppendProvenance();
        await this.recoverTruncateTransactionUnlocked(workspaceId);
        return operation();
      });
    });
  }

  /** Bare cross-process history file lock; see withCrossProcessWriteLock. */
  private async withHistoryWriteFileLock<T>(
    workspaceId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    await using _lock = await acquireProcessFileLock({
      lockPath: historyWriteLockPath(this.config.rootDir, workspaceId),
      timeoutMs: HISTORY_WRITE_LOCK_TIMEOUT_MS,
      label: "history write lock",
    });
    return await operation();
  }

  /**
   * Advance the cached sequence counter from durable history (r51). Call
   * FIRST inside the write lock from every path that ASSIGNS new sequences
   * from the cached counter (the append family): the cache can be stale once
   * the lock lands — a foreign backend may have appended rows with higher
   * sequences since this process last looked — and a stale assignment would
   * duplicate a foreign row's sequence (updateHistory() replaces the first
   * row matching a sequence, so a duplicate lets a later stream finalization
   * overwrite an unrelated foreign row). Advance-only: delete/truncate flows
   * recompute their own counters from the post-mutation file under this same
   * lock and may deliberately allow removed sequences to be reused, so they
   * must not be pre-seeded here. Same cost class as the recovery scan that
   * precedes every operation (active file is bounded by rotation).
   */
  private async refreshSequenceCounterUnderWriteLock(workspaceId: string): Promise<void> {
    const persistedNext = (await this.getMaxHistorySequence(workspaceId)) + 1;
    const cached = this.sequenceCounters.get(workspaceId);
    if (cached === undefined || persistedNext > cached) {
      this.sequenceCounters.set(workspaceId, persistedNext);
    }
  }

  /**
   * Write-path variant of withRecoveredHistoryResultLock: additionally holds
   * the cross-process write lock (and refreshes the sequence counter under
   * it). Every method that appends to or atomically replaces chat.jsonl must
   * use this wrapper; read-only methods stay on the mutex-only variant.
   */
  private async withRecoveredHistoryWriteResultLock<T>(
    workspaceId: string,
    errorPrefix: string,
    operation: () => Promise<Result<T>>
  ): Promise<Result<T>> {
    // Not composed from withRecoveredHistoryLock: recovery for write paths
    // runs INSIDE withCrossProcessWriteLock (r64); the read-side conditional
    // recovery would redundantly acquire and release the same file lock.
    try {
      return await this.fileLocks.withLock(workspaceId, () =>
        this.withCrossProcessWriteLock(workspaceId, async () => {
          const result = await operation();
          if (!result.success) invalidateHistoryAppendProvenance();
          return result;
        })
      );
    } catch (error) {
      return Err(`${errorPrefix}: ${getErrorMessage(error)}`);
    }
  }

  async appendToHistory(
    workspaceId: string,
    message: MuxMessage,
    compactionCondition?: CompactionFollowUpAppendCondition
  ): Promise<Result<void>> {
    return this.withRecoveredHistoryWriteResultLock(
      workspaceId,
      "Failed to append history",
      async () => {
        if (
          compactionCondition &&
          !(await this.canAppendCompactionFollowUpUnlocked(workspaceId, compactionCondition))
        ) {
          compactionCondition.onSkipped();
          return Ok(undefined);
        }
        return this.appendToHistoryUnderWriteLock(workspaceId, message);
      }
    );
  }

  private async canAppendCompactionFollowUpUnlocked(
    workspaceId: string,
    condition: CompactionFollowUpAppendCondition
  ): Promise<boolean> {
    // Another backend can consume/repair this summary while send preparation
    // awaits. Validate its exact intent under the same lock as the new row.
    const rows = await this.readChatHistory(workspaceId);
    const expected = condition.summary;
    if (expected) {
      // Parsed UI rows omit malformed reset fences. Admission must also respect
      // the provider's raw privacy floor without reacquiring this write lock.
      const providerRows = await readProviderHistoryFromLatestBoundary(
        {
          chat: this.getChatHistoryPath(workspaceId),
          archive: this.getChatArchivePath(workspaceId),
        },
        0
      );
      const expectedMeta = expected.metadata?.muxMetadata;
      const index = rows.findIndex(
        (row) =>
          row.id === expected.id &&
          row.metadata?.historySequence === expected.metadata?.historySequence
      );
      const current = rows[index];
      const currentMeta = current?.metadata?.muxMetadata;
      const matches =
        isNonNegativeInteger(expected.metadata?.historySequence) &&
        providerRows.some(
          (row) =>
            row.id === expected.id &&
            row.metadata?.historySequence === expected.metadata?.historySequence
        ) &&
        current?.role === "assistant" &&
        isCompactionSummaryMetadata(expectedMeta) &&
        expectedMeta.pendingFollowUp != null &&
        isCompactionSummaryMetadata(currentMeta) &&
        isDeepStrictEqual(currentMeta.pendingFollowUp, expectedMeta.pendingFollowUp) &&
        rows
          .slice(index + 1)
          .every(
            (row) =>
              row.metadata?.rlmPreservedTailCopy === true ||
              condition.allowedTailMessageIds.includes(row.id)
          );
      if (!matches || !condition.isCurrent()) {
        return false;
      }
    }
    // Raw reads only: malformed/access failures must not authorize an append,
    // and repair would reacquire this lock. Without a source identity, even
    // a narrowed Stop must veto the handoff until a replacement is witnessed.
    const cancellation = await this.readCompactionCancellation(workspaceId);
    if (
      !condition.isCurrent() ||
      (cancellation &&
        !(await this.hasCompactionReplacementWitnessUnlocked(
          workspaceId,
          cancellation.nonce,
          rows
        )) &&
        (!expected || matchesCompactionCancellation(cancellation, expected)))
    ) {
      return false;
    }
    return true;
  }

  private async appendToHistoryUnderWriteLock(
    workspaceId: string,
    message: MuxMessage
  ): Promise<Result<void>> {
    await this.refreshSequenceCounterUnderWriteLock(workspaceId);
    const result = await this._appendToHistoryUnlocked(workspaceId, message);
    if (result.success) {
      // A new durable boundary seals the previous epoch — rotate it out of
      // chat.jsonl so subsequent reads/rewrites stay O(active epoch).
      await this.rotateAfterBoundaryWriteUnlocked(workspaceId, message);
    }
    return result;
  }

  /**
   * Append several messages as ONE durable write (a single JSONL append).
   * Family-message delivery persists its payload row(s) and the trigger's
   * user row atomically so a crash between separate appends cannot strand a
   * payload without the turn that delivers it (r32) — in-process rollback
   * cannot repair that window. Sequences are assigned in array order under
   * the same per-workspace lock every other history mutation takes. Messages
   * must not carry pre-assigned historySequence values.
   */
  async appendManyToHistory(
    workspaceId: string,
    messages: MuxMessage[],
    compactionCondition?: CompactionFollowUpAppendCondition
  ): Promise<Result<void>> {
    assert(messages.length > 0, "appendManyToHistory requires at least one message");
    return this.withRecoveredHistoryWriteResultLock(
      workspaceId,
      "Failed to append history",
      async () => {
        try {
          if (
            compactionCondition &&
            !(await this.canAppendCompactionFollowUpUnlocked(workspaceId, compactionCondition))
          ) {
            compactionCondition.onSkipped();
            return Ok(undefined);
          }
          await this.refreshSequenceCounterUnderWriteLock(workspaceId);
          const workspaceDir = this.getSessionDir(workspaceId);
          await ensurePrivateDir(workspaceDir);
          for (const message of messages) {
            assert(
              message.metadata?.historySequence === undefined,
              "appendManyToHistory messages must not carry pre-assigned historySequence values"
            );
            const nextSeqNum = await this.getNextHistorySequence(workspaceId);
            assert(
              isNonNegativeInteger(nextSeqNum),
              "getNextHistorySequence must return a non-negative integer"
            );
            message.metadata = { ...message.metadata, historySequence: nextSeqNum };
            this.sequenceCounters.set(workspaceId, nextSeqNum + 1);
          }
          // Atomic all-or-nothing commit (r48): fs.appendFile is not
          // transactional — an ENOSPC or crash mid-write could persist the
          // payload line without the trigger line, and the caller registers
          // rollback IDs only after this returns, so the torn prefix would
          // survive as an undelivered assistant row in future provider
          // requests. Rewrite the whole file through the same
          // temp-and-rename helper the other history mutations use, under the
          // cross-process append lock (r50) so a foreign backend's row cannot
          // land between this read and the replace and be silently deleted.
          await this.getAppendProvenance(workspaceId).appendChat(
            Buffer.from(this.serializeHistoryEntries(messages, workspaceId)),
            true
          );
          // Publish the entire batch before sealing its previous epoch. Rotation
          // is best-effort: a storage failure must not invite a duplicate batch.
          const boundary = messages.findLast(isDurableContextBoundaryMarker);
          if (boundary) await this.rotateAfterBoundaryWriteUnlocked(workspaceId, boundary);
          return Ok(undefined);
        } catch (error) {
          return Err(`Failed to append to history: ${getErrorMessage(error)}`);
        }
      }
    );
  }

  /**
   * Compare-and-append: append `message` only if the workspace's current tail
   * message id still equals `expectedTailMessageId`, checked atomically under
   * the same per-workspace lock every other history mutation takes. Used by
   * background writers (abandoned-branch summaries) that must never land
   * after unrelated rows: if anything else was appended (or history was
   * rewritten) since the caller observed the tail, the append is skipped and
   * `"tail-mismatch"` is returned instead of an error — losing the race is an
   * expected outcome, not a failure.
   */
  async appendToHistoryIfTailMatches(
    workspaceId: string,
    message: MuxMessage,
    expectedTailMessageId: string
  ): Promise<Result<"appended" | "tail-mismatch">> {
    assert(
      expectedTailMessageId.length > 0,
      "appendToHistoryIfTailMatches requires a non-empty expected tail id"
    );
    return this.withRecoveredHistoryWriteResultLock<"appended" | "tail-mismatch">(
      workspaceId,
      "Failed to append history",
      async () => {
        await this.refreshSequenceCounterUnderWriteLock(workspaceId);
        // Tail check + append under the cross-process lock (r50) so a foreign
        // backend's append cannot land between the check and this write.
        const tail = await this.readLastMessagesFromFile(this.getChatHistoryPath(workspaceId), 1);
        if (tail.length === 0 || tail[0].id !== expectedTailMessageId) {
          return Ok("tail-mismatch");
        }
        const result = await this._appendToHistoryUnlocked(workspaceId, message);
        if (!result.success) {
          return Err(result.error);
        }
        await this.rotateAfterBoundaryWriteUnlocked(workspaceId, message);
        return Ok("appended");
      }
    );
  }

  /**
   * Update an existing message in history by historySequence
   * Reads the active chat.jsonl, replaces the matching message, and rewrites the file.
   *
   * This runs on every stream end, so it must stay O(active epoch): targets are
   * always in the active epoch (stream placeholders, compaction summaries),
   * never in the sealed archive.
   */
  // Optional ownership predicates are synchronous/pure and may run twice (under
  // the lock and immediately before rename). Losing ownership or the target is a successful no-op.
  // An optional transform derives field edits from the locked row instead of a stale snapshot.
  async updateHistory(
    workspaceId: string,
    message: MuxMessage,
    shouldUpdate?: (current: MuxMessage) => boolean,
    updateFromCurrent?: (current: MuxMessage) => MuxMessage,
    onCommitted?: () => void
  ): Promise<Result<void>> {
    assert(!onCommitted || shouldUpdate, "Update commit observers require a conditional mutation");
    return this.withRecoveredHistoryWriteResultLock(workspaceId, "Failed to update history", () =>
      this.updateHistoryUnderWriteLock(
        workspaceId,
        message,
        shouldUpdate,
        updateFromCurrent,
        onCommitted
      )
    );
  }

  async acceptResumeCancellation(
    workspaceId: string,
    message: MuxMessage,
    expectedNonce: string | null,
    shouldUpdate: (current: MuxMessage) => boolean,
    onCommitted: () => void
  ): Promise<Result<void>> {
    return this.withRecoveredHistoryWriteResultLock(
      workspaceId,
      "Failed to accept resume",
      async () => {
        // Retry must not stamp an obsolete receipt over a foreign Stop that arrived
        // during preparation. Compare shared identity and commit under one lock.
        const current = await this.readCompactionCancellation(workspaceId);
        // Semantic absence can retain a physical file when witnessed unlink failed.
        if (
          (current?.nonce ?? null) !== expectedNonce &&
          !(
            expectedNonce === null &&
            current &&
            (await this.hasCompactionReplacementWitnessUnlocked(workspaceId, current.nonce))
          )
        )
          return Ok(undefined);
        return this.updateHistoryUnderWriteLock(
          workspaceId,
          message,
          shouldUpdate,
          (row) =>
            expectedNonce === null
              ? row
              : {
                  ...row,
                  metadata: { ...row.metadata, compactionCancellationNonce: expectedNonce },
                },
          onCommitted
        );
      }
    );
  }

  /** Reject a request and its owned preludes in one commit, never leaving replayable orphan payloads. */
  async rejectContextBudgetRequest(
    workspaceId: string,
    trigger: MuxMessage
  ): Promise<Result<MuxMessage[]>> {
    assert(
      trigger.role === "user" || trigger.metadata?.contextBudgetRejected === true,
      "context-budget rejection requires a user trigger or rejected capsule"
    );
    assert(
      isNonNegativeInteger(trigger.metadata?.historySequence),
      "rejected trigger must be persisted"
    );
    return this.withRecoveredHistoryWriteResultLock(
      workspaceId,
      "Failed to reject context-budget request",
      async () => {
        invalidateHistoryAppendProvenance();
        const historyPath = this.getChatHistoryPath(workspaceId);
        const { rows, messages } = await this.readHistoryForRewrite(historyPath);
        // Match request assembly's newest identity when repaired history reuses an id/sequence.
        const triggerIndex = messages.findLastIndex(
          (row) =>
            row?.id === trigger.id &&
            row.metadata?.historySequence === trigger.metadata?.historySequence
        );
        const persisted = messages[triggerIndex];
        if (!persisted || (persisted.role !== "user" && !persisted.metadata?.contextBudgetRejected))
          return Err("Rejected request no longer exists");
        const preludeIds = new Set(
          getRequestPreludeMessageIds(
            persisted.metadata?.contextBudgetRejectedMessage?.metadata?.requestPreludeMessageIds ??
              persisted.metadata?.requestPreludeMessageIds
          )
        );
        const rejected: MuxMessage[] = [];
        const earlier = new Set(messages.slice(0, triggerIndex));
        const updated = this.serializeHistoryRewrite(rows, workspaceId, (row) => {
          const ownedPrelude =
            earlier.has(row) &&
            preludeIds.has(row.id) &&
            !isDurableContextBoundaryMarker(row) &&
            (isSyntheticSnapshotUserMessage(row) ||
              (row.role === "assistant" && row.metadata?.synthetic === true));
          if (row !== persisted && !ownedPrelude) return row;
          const marked = createContextBudgetRejectedMessage(row);
          rejected.push(marked);
          return marked;
        });
        await writeFileAtomic(historyPath, updated);
        return Ok(rejected);
      }
    );
  }

  private async updateHistoryUnderWriteLock(
    workspaceId: string,
    message: MuxMessage,
    shouldUpdate?: (current: MuxMessage) => boolean,
    updateFromCurrent?: (current: MuxMessage) => MuxMessage,
    onCommitted?: () => void
  ): Promise<Result<void>> {
    invalidateHistoryAppendProvenance();
    try {
      const historyPath = this.getChatHistoryPath(workspaceId);

      // Read the active epoch — structural rewrite requires full file content
      const { rows, messages } = await this.readHistoryForRewrite(historyPath);
      const updates = new Map<MuxMessage, MuxMessage>();
      const targetSequence = message.metadata?.historySequence;

      if (targetSequence === undefined) {
        return Err("Cannot update message without historySequence");
      }

      assert(
        isNonNegativeInteger(targetSequence),
        "updateHistory requires historySequence to be a non-negative integer"
      );

      // Find and replace the message with matching historySequence
      let found = false;
      let persistedMessage: MuxMessage | undefined;
      let sourceMessage: MuxMessage | undefined;
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].metadata?.historySequence === targetSequence) {
          const existingMessage = messages[i];
          assert(existingMessage, "updateHistory matched message must exist");
          if (shouldUpdate && !shouldUpdate(existingMessage)) return Ok(undefined);
          sourceMessage = existingMessage;
          // Conditional field edits must preserve unrelated late writes. Derive the
          // replacement from the row read under this same cross-process write lock.
          const updatedMessage = updateFromCurrent?.(existingMessage) ?? message;

          // Preserve compaction boundary metadata during late in-place rewrites.
          // Compaction may update an assistant row first, then a late stream rewrite can
          // update that same historySequence and accidentally drop compaction markers.
          const preservedCompactionMetadata = getCompactionMetadataToPreserve(
            workspaceId,
            existingMessage,
            updatedMessage
          );

          // Preserve the historySequence, update everything else.
          messages[i] = {
            ...updatedMessage,
            metadata: {
              ...updatedMessage.metadata,
              ...(preservedCompactionMetadata ?? {}),
              historySequence: targetSequence,
            },
          };
          persistedMessage = messages[i];
          updates.set(existingMessage, persistedMessage);
          found = true;
          break;
        }
      }

      if (!found || !persistedMessage) {
        // Conditional cleanup is already settled when its exact target was removed.
        // It must not chase a replacement row with the same ID in another sequence.
        return shouldUpdate
          ? Ok(undefined)
          : Err(`No message found with historySequence ${targetSequence}`);
      }

      // Rewrite entire file
      const historyEntries = this.serializeHistoryRewrite(
        rows,
        workspaceId,
        (row) => updates.get(row) ?? row
      );

      // Atomic write prevents corruption if app crashes mid-write
      if (shouldUpdate && sourceMessage) {
        const source = sourceMessage;
        if (
          !(await this.writeGuardedHistory(
            historyPath,
            historyEntries,
            () => shouldUpdate(source),
            onCommitted
          ))
        )
          return Ok(undefined);
      } else await writeFileAtomic(historyPath, historyEntries);

      // Compaction updates the streamed summary row in-place with boundary
      // metadata — seal the previous epoch once that lands. Check the persisted
      // row (not the incoming message) so preserved boundary metadata counts.
      await this.rotateAfterBoundaryWriteUnlocked(workspaceId, persistedMessage);

      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to update history: ${message}`);
    }
  }

  /** The ownership check, rename and commit publication never yield to new admission. */
  private async writeGuardedHistory(
    historyPath: string,
    serialized: string | Buffer,
    isCurrent: () => boolean,
    onCommitted?: () => void
  ): Promise<boolean> {
    const stagedPath = `${historyPath}.continuous-${randomUUID()}`;
    try {
      await writeFileAtomic(stagedPath, serialized, { mode: 0o600 });
      if (!isCurrent()) return false;
      renameSync(stagedPath, historyPath);
      try {
        onCommitted?.();
      } catch (error) {
        // Observer failure cannot turn an already committed rewrite into a
        // reported write failure. Filesystem cleanup errors still propagate.
        log.error("Committed history rewrite publication failed", {
          error: getErrorMessage(error),
        });
      }
      return true;
    } finally {
      await fs.rm(stagedPath, { force: true });
    }
  }

  /**
   * Atomically persist a compaction boundary together with its preserved
   * keep-recent tail copies (RLM keep-recent floor) in ONE file commit.
   *
   * Why one commit: the boundary write seals the previous epoch — request
   * assembly starts at the new boundary and the summarizer already excluded
   * the stamped tail rows from the summary. If the boundary became durable
   * while the copies were appended row-by-row, a crash or failure between
   * the two would leave the tail suffix permanently absent from provider
   * context with no recovery marker. A single writeFileAtomic (temp+rename,
   * the same primitive updateHistory relies on) commits the boundary and
   * every copy together: either all of them land or none do.
   *
   * `updateExisting` selects update semantics for the summary row (streamed
   * summaries already occupy their historySequence in the active epoch) vs
   * append semantics; tail copies are always appended after the boundary so
   * sealed-epoch rotation keeps them in the active file.
   */
  async persistBoundaryWithTailCopies(
    workspaceId: string,
    summaryMessage: MuxMessage,
    tailCopies: readonly MuxMessage[],
    updateExisting: boolean,
    shouldPersist?: (messages: MuxMessage[]) => boolean
  ): Promise<Result<void>> {
    // Continuous compaction may intentionally keep no tail when no complete turn fits.
    return this.withRecoveredHistoryWriteResultLock(
      workspaceId,
      "Failed to persist compaction boundary with tail copies",
      async () => {
        invalidateHistoryAppendProvenance();
        try {
          // r52: this path assigns fresh sequences (appended summary + every
          // preserved tail copy) from the cached counter, so it needs the
          // same in-lock refresh as the append family — a stale cache would
          // duplicate a foreign backend's sequences and let a later
          // updateHistory() replace an unrelated row.
          await this.refreshSequenceCounterUnderWriteLock(workspaceId);
          await ensurePrivateDir(this.getSessionDir(workspaceId));
          const historyPath = this.getChatHistoryPath(workspaceId);
          const { rows, messages } = await this.readHistoryForRewrite(historyPath);
          const updates = new Map<MuxMessage, MuxMessage>();

          // Rolling summaries are prepared outside this lock. Edits, resets, and
          // newly appended rows must win over a stale prepared boundary.
          if (shouldPersist && !shouldPersist(messages)) return Err("Compaction snapshot changed");
          const sourceMessages = messages.slice();
          let persistedSummary: MuxMessage | undefined;
          if (updateExisting) {
            // Same replace semantics as updateHistory: match by sequence and
            // preserve boundary metadata already persisted on the row.
            const targetSequence = summaryMessage.metadata?.historySequence;
            if (targetSequence === undefined) {
              return Err("Cannot update message without historySequence");
            }
            assert(
              isNonNegativeInteger(targetSequence),
              "persistBoundaryWithTailCopies requires a non-negative historySequence"
            );
            for (let i = 0; i < messages.length; i++) {
              if (messages[i].metadata?.historySequence !== targetSequence) {
                continue;
              }
              const preservedCompactionMetadata = getCompactionMetadataToPreserve(
                workspaceId,
                messages[i],
                summaryMessage
              );
              messages[i] = {
                ...summaryMessage,
                metadata: {
                  ...summaryMessage.metadata,
                  ...(preservedCompactionMetadata ?? {}),
                  historySequence: targetSequence,
                },
              };
              persistedSummary = messages[i];
              updates.set(sourceMessages[i], persistedSummary);
              break;
            }
            if (persistedSummary === undefined) {
              return Err(`No message found with historySequence ${targetSequence}`);
            }
          } else {
            // Append semantics: assign the next sequence in place so callers
            // observe it, exactly like appendToHistory does.
            assert(
              summaryMessage.metadata?.historySequence === undefined,
              "persistBoundaryWithTailCopies append expects an unsequenced summary"
            );
            const nextSeqNum = await this.getNextHistorySequence(workspaceId);
            summaryMessage.metadata = {
              ...summaryMessage.metadata,
              historySequence: nextSeqNum,
            };
            this.sequenceCounters.set(workspaceId, nextSeqNum + 1);
            persistedSummary = summaryMessage;
            messages.push(summaryMessage);
          }

          for (const copy of tailCopies) {
            assert(
              copy.metadata?.historySequence === undefined,
              "persistBoundaryWithTailCopies expects unsequenced tail copies"
            );
            const seq = await this.getNextHistorySequence(workspaceId);
            copy.metadata = { ...copy.metadata, historySequence: seq };
            this.sequenceCounters.set(workspaceId, seq + 1);
            messages.push(copy);
          }

          const serialized = this.serializeHistoryRewrite(
            rows,
            workspaceId,
            (row) => updates.get(row) ?? row,
            messages.slice(sourceMessages.length)
          );
          if (shouldPersist) {
            if (
              !(await this.writeGuardedHistory(historyPath, serialized, () =>
                shouldPersist(sourceMessages)
              ))
            )
              return Err("Compaction snapshot changed");
          } else {
            await writeFileAtomic(historyPath, serialized);
          }

          // Seal the previous epoch only after boundary + tail are durable.
          await this.rotateAfterBoundaryWriteUnlocked(workspaceId, persistedSummary);
          return Ok(undefined);
        } catch (error) {
          return Err(`Failed to persist boundary with tail copies: ${getErrorMessage(error)}`);
        }
      }
    );
  }

  /**
   * Atomically delete a set of recent active-history messages by ID while preserving later rows.
   * Used to roll back a not-yet-accepted turn without truncating concurrent non-session writers.
   */
  async deleteMessages(workspaceId: string, messageIds: readonly string[]): Promise<Result<void>> {
    assert(messageIds.length > 0, "deleteMessages requires at least one message ID");
    const ids = new Set(messageIds);
    assert(ids.size === messageIds.length, "deleteMessages requires unique message IDs");

    return this.withRecoveredHistoryWriteResultLock(
      workspaceId,
      "Failed to delete messages",
      async () => {
        invalidateHistoryAppendProvenance();
        try {
          const { rows, messages } = await this.readHistoryForRewrite(
            this.getChatHistoryPath(workspaceId)
          );
          const foundIds = new Set(
            messages.filter((message) => ids.has(message.id)).map((message) => message.id)
          );
          const missingIds = messageIds.filter((messageId) => !foundIds.has(messageId));
          if (missingIds.length > 0) {
            return Err(`Messages not found in active history: ${missingIds.join(", ")}`);
          }

          const filteredMessages = messages.filter((message) => !ids.has(message.id));
          await writeFileAtomic(
            this.getChatHistoryPath(workspaceId),
            this.serializeHistoryRewrite(rows, workspaceId, (row) => (ids.has(row.id) ? null : row))
          );

          const maxSeq = filteredMessages.reduce((max, message) => {
            const sequence = message.metadata?.historySequence;
            if (sequence === undefined) return max;
            if (!isNonNegativeInteger(sequence)) {
              log.warn(
                "Ignoring malformed persisted historySequence while updating sequence counter after batch delete",
                {
                  workspaceId,
                  messageId: message.id,
                  historySequence: sequence,
                }
              );
              return max;
            }
            return sequence > max ? sequence : max;
          }, -1);
          const archiveMaxSeq = await this.getArchiveTailMaxSequence(workspaceId);
          const nextSeq = Math.max(maxSeq, archiveMaxSeq) + 1;
          assert(
            isNonNegativeInteger(nextSeq),
            "next history sequence counter after batch delete must be a non-negative integer"
          );
          const currentCounter = this.sequenceCounters.get(workspaceId);
          if (currentCounter === undefined || currentCounter < nextSeq) {
            this.sequenceCounters.set(workspaceId, nextSeq);
          }

          return Ok(undefined);
        } catch (error) {
          return Err(`Failed to delete messages: ${getErrorMessage(error)}`);
        }
      }
    );
  }

  /**
   * Delete a single message by ID while preserving the rest of the history.
   *
   * This is safer than truncateAfterMessage for cleanup paths where subsequent
   * messages may already have been appended.
   * A conditional cleanup uses a synchronous/pure predicate under the lock and
   * before rename; false returns Ok without changing history.
   * Its optional commit observer runs synchronously after rename, before any
   * cleanup await. It must not await or reenter the history write lock.
   */
  async deleteMessage(
    workspaceId: string,
    messageId: string,
    shouldDelete?: (messages: MuxMessage[]) => boolean,
    onCommitted?: () => void,
    onAlreadyAbsent?: (remaining: MuxMessage[]) => void
  ): Promise<Result<void>> {
    assert(
      !(onCommitted ?? onAlreadyAbsent) || shouldDelete,
      "Delete observers require a conditional cleanup"
    );
    return this.withRecoveredHistoryWriteResultLock(workspaceId, "Failed to delete message", () =>
      this.deleteMessageUnderWriteLock(
        workspaceId,
        messageId,
        shouldDelete,
        onCommitted,
        onAlreadyAbsent
      )
    );
  }

  private async deleteMessageUnderWriteLock(
    workspaceId: string,
    messageId: string,
    shouldDelete?: (messages: MuxMessage[]) => boolean,
    onCommitted?: () => void,
    onAlreadyAbsent?: (remaining: MuxMessage[]) => void
  ): Promise<Result<void>> {
    invalidateHistoryAppendProvenance();
    try {
      // Structural rewrite requires full file content
      const { rows, messages } = await this.readHistoryForRewrite(
        this.getChatHistoryPath(workspaceId)
      );
      // Conditional cleanup is scoped to the observed active context, never its archive.
      if (shouldDelete && !shouldDelete(messages)) return Ok(undefined);
      const filteredMessages = messages.filter((msg) => msg.id !== messageId);

      if (filteredMessages.length === messages.length) {
        if (shouldDelete) {
          // Another backend may already have deleted this exact active target.
          // An archived row is a replaced context, never an invitation to restore it.
          const archived = onAlreadyAbsent ? await this.readArchivedHistory(workspaceId) : [];
          if (
            onAlreadyAbsent &&
            !archived.some((row) => row.id === messageId) &&
            shouldDelete(messages)
          ) {
            try {
              onAlreadyAbsent([...archived, ...messages]);
            } catch (error) {
              log.error("Absent history cleanup publication failed", {
                error: getErrorMessage(error),
              });
            }
          }
          return Ok(undefined);
        }
        // Not in the active epoch — the row may live in the sealed archive
        // (rare: cleanup paths almost always target recent rows).
        const { rows: archiveRows, messages: archiveMessages } = await this.readHistoryForRewrite(
          this.getChatArchivePath(workspaceId)
        );
        const filteredArchive = archiveMessages.filter((msg) => msg.id !== messageId);
        if (filteredArchive.length === archiveMessages.length) {
          return Err(`Message with ID ${messageId} not found in history`);
        }

        // Archived rows are strictly older than active rows, so deleting one
        // can never affect the sequence counter.
        await writeFileAtomic(
          this.getChatArchivePath(workspaceId),
          this.serializeHistoryRewrite(archiveRows, workspaceId, (row) =>
            row.id === messageId ? null : row
          )
        );
        return Ok(undefined);
      }

      const historyPath = this.getChatHistoryPath(workspaceId);
      const historyEntries = this.serializeHistoryRewrite(rows, workspaceId, (row) =>
        row.id === messageId ? null : row
      );

      // Atomic write prevents corruption if app crashes mid-write
      if (shouldDelete) {
        if (
          !(await this.writeGuardedHistory(
            historyPath,
            historyEntries,
            () => shouldDelete(messages),
            onCommitted
          ))
        )
          return Ok(undefined);
      } else await writeFileAtomic(historyPath, historyEntries);

      // Keep the in-memory sequence counter monotonic. It's okay to reuse deleted sequence
      // numbers on restart, but we must not regress within a running process.
      const maxSeq = filteredMessages.reduce((max, msg) => {
        const seq = msg.metadata?.historySequence;
        if (seq === undefined) {
          return max;
        }

        if (!isNonNegativeInteger(seq)) {
          log.warn(
            "Ignoring malformed persisted historySequence while updating sequence counter after delete",
            {
              workspaceId,
              messageId: msg.id,
              historySequence: seq,
            }
          );
          return max;
        }

        return seq > max ? seq : max;
      }, -1);
      // Sealed archive rows keep their sequences across active-file deletes.
      // Without this floor, deleting the last sequenced active row in a fresh
      // process would cache a counter below archived rows and reuse their
      // historySequence values on the next append.
      const archiveMaxSeq = await this.getArchiveTailMaxSequence(workspaceId);
      const nextSeq = Math.max(maxSeq, archiveMaxSeq) + 1;
      assert(
        isNonNegativeInteger(nextSeq),
        "next history sequence counter after delete must be a non-negative integer"
      );
      const currentCounter = this.sequenceCounters.get(workspaceId);
      if (currentCounter === undefined || currentCounter < nextSeq) {
        this.sequenceCounters.set(workspaceId, nextSeq);
      }

      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to delete message: ${message}`);
    }
  }

  /**
   * Truncate history after a specific message ID.
   *
   * By default this removes the target message and all subsequent messages. Callers can retain the
   * target message when branching a new workspace from a specific reply.
   *
   * Returns the removed tail (in history order) so branch-point callers (fork,
   * edit-resend) can summarize the abandoned segment; computed under the
   * history lock so it exactly matches what was cut.
   */
  async truncateAfterMessage(
    workspaceId: string,
    messageId: string,
    options?: { keepTargetMessage?: boolean }
  ): Promise<Result<{ removedMessages: MuxMessage[] }>> {
    return this.withRecoveredHistoryWriteResultLock(
      workspaceId,
      "Failed to truncate history",
      async () => {
        invalidateHistoryAppendProvenance();
        try {
          // Structural rewrite requires full file content
          const { rows, messages } = await this.readHistoryForRewrite(
            this.getChatHistoryPath(workspaceId)
          );
          const messageIndex = messages.findIndex((msg) => msg.id === messageId);

          const keepTargetMessage = options?.keepTargetMessage === true;

          if (messageIndex === -1) {
            // Editing/forking from a pre-boundary message: the target lives in the
            // sealed archive. Everything after the cut (the archive tail AND the
            // entire active epoch) is discarded, so collapse the remainder back
            // into chat.jsonl and drop the archive.
            return this.truncateAfterArchivedMessageUnlocked(
              workspaceId,
              messageId,
              keepTargetMessage,
              messages,
              rows
            );
          }

          // Response-level forks branch from the selected assistant turn, so they retain the target
          // message while discarding anything that came after it.
          const cutIndex = keepTargetMessage ? messageIndex + 1 : messageIndex;
          const truncatedMessages = messages.slice(0, cutIndex);
          const removedMessages = messages.slice(cutIndex);

          // Rewrite the history file with truncated messages
          const historyPath = this.getChatHistoryPath(workspaceId);
          const historyEntries = this.serializeHistoryTruncation(
            rows,
            workspaceId,
            truncatedMessages
          );

          const archiveMaxSeq = await this.getArchiveTailMaxSequence(workspaceId);

          // Atomic write prevents corruption if app crashes mid-write
          await writeFileAtomic(historyPath, historyEntries);

          // Update sequence counter to continue from where we truncated.
          // Self-healing read path: skip malformed persisted historySequence values.
          const maxTruncatedSeq = truncatedMessages.reduce((max, msg) => {
            const seq = msg.metadata?.historySequence;
            if (seq === undefined) {
              return max;
            }

            if (!isNonNegativeInteger(seq)) {
              log.warn(
                "Ignoring malformed persisted historySequence while updating sequence counter after truncation",
                {
                  workspaceId,
                  messageId: msg.id,
                  historySequence: seq,
                }
              );
              return max;
            }

            return seq > max ? seq : max;
          }, -1);
          // Sealed archive rows keep their sequences across an active-epoch
          // truncation. When the truncation empties the active file, floor the
          // counter with the archive max so new appends can never reuse archived
          // sequence numbers.
          const nextSeq = Math.max(maxTruncatedSeq, archiveMaxSeq) + 1;
          assert(
            isNonNegativeInteger(nextSeq),
            "next history sequence counter after truncation must be a non-negative integer"
          );
          this.sequenceCounters.set(workspaceId, nextSeq);

          return Ok({ removedMessages });
        } catch (error) {
          const message = getErrorMessage(error);
          return Err(`Failed to truncate history: ${message}`);
        }
      }
    );
  }

  /**
   * Truncation branch for targets in the sealed archive. The truncated remainder
   * becomes the new chat.jsonl (it may contain old boundaries; a later boundary
   * write re-seals it) and the archive is removed. Must be called while holding
   * the workspace file lock.
   */
  private async truncateAfterArchivedMessageUnlocked(
    workspaceId: string,
    messageId: string,
    keepTargetMessage: boolean,
    /** Active-epoch messages already read by the caller; all of them are discarded on this branch. */
    activeEpochMessages: MuxMessage[],
    activeEpochRows: HistoryRewriteRow[]
  ): Promise<Result<{ removedMessages: MuxMessage[] }>> {
    try {
      const { rows: archiveRows, messages: archiveMessages } = await this.readHistoryForRewrite(
        this.getChatArchivePath(workspaceId)
      );
      const messageIndex = archiveMessages.findIndex((msg) => msg.id === messageId);

      if (messageIndex === -1) {
        return Err(`Message with ID ${messageId} not found in history`);
      }

      const cutIndex = keepTargetMessage ? messageIndex + 1 : messageIndex;
      const truncatedMessages = archiveMessages.slice(0, cutIndex);
      // The removed tail spans the archive remainder plus the whole active epoch.
      const removedMessages = [...archiveMessages.slice(cutIndex), ...activeEpochMessages];

      // The files were separate JSONL streams. Do not glue an unterminated kept
      // archive row to a preserved active reset fragment when collapsing them.
      const lastArchiveRow = archiveRows.at(-1);
      if (lastArchiveRow && lastArchiveRow.raw.at(-1) !== 10 && activeEpochRows.length > 0) {
        archiveRows.push({ raw: Buffer.from("\n"), message: undefined });
      }
      await this.rewriteHistoryFilesUnlocked(
        workspaceId,
        null,
        this.serializeHistoryTruncation(
          [...archiveRows, ...activeEpochRows],
          workspaceId,
          truncatedMessages
        )
      );
      // chat.jsonl may contain sealed epochs again — allow the lazy check to re-run.
      this.sealedRotationChecked.delete(workspaceId);

      // Update sequence counter to continue from where we truncated.
      // Self-healing read path: skip malformed persisted historySequence values.
      const maxTruncatedSeq = truncatedMessages.reduce((max, msg) => {
        const seq = msg.metadata?.historySequence;
        if (seq === undefined) {
          return max;
        }

        if (!isNonNegativeInteger(seq)) {
          log.warn(
            "Ignoring malformed persisted historySequence while updating sequence counter after archived truncation",
            {
              workspaceId,
              messageId: msg.id,
              historySequence: seq,
            }
          );
          return max;
        }

        return seq > max ? seq : max;
      }, -1);
      const nextSeq = maxTruncatedSeq + 1;
      assert(
        isNonNegativeInteger(nextSeq),
        "next history sequence counter after archived truncation must be a non-negative integer"
      );
      this.sequenceCounters.set(workspaceId, nextSeq);

      return Ok({ removedMessages });
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to truncate history: ${message}`);
    }
  }

  /**
   * Truncate history by removing approximately the given percentage of tokens from the beginning
   * @param workspaceId The workspace ID
   * @param percentage Percentage to truncate (0.0 to 1.0). 1.0 = delete all
   * @returns Result containing array of deleted historySequence numbers
   */
  /**
   * Token-proportional prefix length that truncateHistory removes at this percentage. Messages
   * are stringified whole for counting; only relative weights matter.
   */
  private async computeTruncationRemoveCount(
    messages: MuxMessage[],
    percentage: number
  ): Promise<number> {
    const tokenizer = await getTokenizerForModel(KNOWN_MODELS.SONNET.id);
    const messageTokens = await Promise.all(
      messages.map((msg) => tokenizer.countTokens(safeStringifyForCounting(msg)))
    );
    const totalTokens = messageTokens.reduce((sum, tokens) => sum + tokens, 0);
    const tokensToRemove = Math.floor(totalTokens * percentage);
    let tokensRemoved = 0;
    let removeCount = 0;
    for (const tokens of messageTokens) {
      if (tokensRemoved >= tokensToRemove) {
        break;
      }
      tokensRemoved += tokens;
      removeCount++;
    }
    return removeCount;
  }

  /**
   * Preflight for truncateHistory: whether this percentage removes no rows, a proper prefix,
   * or every message (the full-delete fast path). The requested percentage alone cannot
   * distinguish these, and callers that must apply per-scope semantics before the rewrite
   * commits (workspaceService retires kernel workflow run references only when rows will
   * actually be removed, and applies full-clear guards when everything will) need the answer
   * up front.
   */
  async classifyTruncationRemoval(
    workspaceId: string,
    percentage: number
  ): Promise<"none" | "partial" | "all"> {
    if (percentage >= 1.0) {
      return "all";
    }
    if (percentage <= 0) {
      return "none";
    }
    const archivedMessages = await this.readArchivedHistory(workspaceId);
    const chatMessages = await this.readChatHistory(workspaceId);
    const messages = [...archivedMessages, ...chatMessages];
    if (messages.length === 0) {
      return "none";
    }
    const removeCount = await this.computeTruncationRemoveCount(messages, percentage);
    if (removeCount === 0) {
      return "none";
    }
    return removeCount >= messages.length ? "all" : "partial";
  }

  async truncateHistory(
    workspaceId: string,
    percentage: number,
    options?: {
      refuseFullDelete?: boolean;
      refuseRowRemoval?: boolean;
      requireFullDelete?: boolean;
    }
  ): Promise<Result<number[], string>> {
    return this.withRecoveredHistoryWriteResultLock(
      workspaceId,
      "Failed to truncate history",
      async () => {
        invalidateHistoryAppendProvenance();
        try {
          const { rows: archiveRows, messages: archivedMessages } =
            await this.readHistoryForRewrite(this.getChatArchivePath(workspaceId));
          const { rows: chatRows, messages: chatMessages } = await this.readHistoryForRewrite(
            this.getChatHistoryPath(workspaceId)
          );
          const messages = [...archivedMessages, ...chatMessages];
          const allSequences = messages
            .map((msg) => msg.metadata?.historySequence)
            .filter((s): s is number => isNonNegativeInteger(s));

          if (percentage >= 1.0) {
            await this.rewriteHistoryFilesUnlocked(workspaceId, null, null);
            this.sequenceCounters.set(workspaceId, 0);
            return Ok(allSequences);
          }

          // Structural rewrite requires full history content (oldest rows live in
          // the sealed archive). Percentage truncation is a rare recovery path
          // (compaction-failure retry), so the O(total-history) read is acceptable.
          if (messages.length === 0) {
            return Ok([]); // Nothing to truncate
          }

          const removeCount = await this.computeTruncationRemoveCount(messages, percentage);

          // Mirror of refuseFullDelete for the opposite drift direction: the caller
          // classified this request as a no-op (and so skipped its row-removal guards, e.g.
          // kernel workflow reference retirement), but history grew enough between that
          // unserialized read and this locked rewrite for the budget to reach real rows.
          // Refuse instead of removing them unguarded; a retry re-classifies.
          if (options?.refuseRowRemoval === true && removeCount > 0) {
            return Err(
              "Truncation classified as a no-op would remove messages; retry to re-run it."
            );
          }

          // Third drift direction: the caller classified this request as emptying (and will
          // apply full-clear-only side effects after the rewrite: context epoch advance,
          // goal/plan/retry discards), but history grew between that unserialized read and
          // this locked rewrite so rows would survive. Refuse instead of leaving survivors
          // behind a "full clear"; a retry re-classifies.
          if (options?.requireFullDelete === true && removeCount < messages.length) {
            return Err(
              "Truncation classified as a full clear would leave messages; retry to re-run it."
            );
          }

          // No-op truncation (percentage 0 or rounding to zero tokens) must not
          // rewrite anything — collapsing the archive back into chat.jsonl would
          // undo rotation and put lifetime history back on the hot path.
          if (removeCount === 0) {
            return Ok([]);
          }

          // If we're removing all messages, use fast path
          if (removeCount >= messages.length) {
            // Serialized revalidation of the caller's emptiness preflight: an overlapping
            // truncation can shrink history between that unserialized read and this locked
            // rewrite, turning a partial-classified request into a full delete that skipped
            // the caller's full-clear guards (most critically kernel workflow reference
            // retirement). Refuse instead of emptying; a retry re-runs the preflight against
            // the settled history and routes through the full-clear path.
            if (options?.refuseFullDelete === true) {
              return Err(
                "Truncation would remove every remaining message; retry to run it as a full clear."
              );
            }
            await this.rewriteHistoryFilesUnlocked(workspaceId, null, null);
            this.sequenceCounters.set(workspaceId, 0);
            return Ok(allSequences);
          }

          const activeContextChanged = prefixCutChangesActiveContext(messages, removeCount);
          const sanitize = activeContextChanged
            ? stripContextUsage
            : (message: MuxMessage) => message;
          const retainedMessages = messages.slice(removeCount);
          const remainingMessages = retainedMessages.map(sanitize);
          const deletedMessages = messages.slice(0, removeCount);
          const deletedSequences = deletedMessages
            .map((msg) => msg.metadata?.historySequence)
            .filter((s): s is number => isNonNegativeInteger(s));
          const remainingArchive = this.serializeHistoryTruncation(
            archiveRows,
            workspaceId,
            retainedMessages,
            sanitize
          );
          const remainingChat = this.serializeHistoryTruncation(
            chatRows,
            workspaceId,
            retainedMessages,
            sanitize
          );
          await this.rewriteHistoryFilesUnlocked(
            workspaceId,
            remainingArchive.length > 0 ? remainingArchive : null,
            remainingChat
          );
          this.sealedRotationChecked.delete(workspaceId);

          // Update sequence counter to continue from where we are.
          // Self-healing read path: skip malformed persisted historySequence values.
          const maxRemainingSeq = remainingMessages.reduce((max, msg) => {
            const seq = msg.metadata?.historySequence;
            if (seq === undefined) {
              return max;
            }

            if (!isNonNegativeInteger(seq)) {
              log.warn(
                "Ignoring malformed persisted historySequence while updating sequence counter after truncateHistory",
                {
                  workspaceId,
                  messageId: msg.id,
                  historySequence: seq,
                }
              );
              return max;
            }

            return seq > max ? seq : max;
          }, -1);
          const nextSeq = maxRemainingSeq + 1;
          assert(
            isNonNegativeInteger(nextSeq),
            "next history sequence counter after truncateHistory must be a non-negative integer"
          );
          this.sequenceCounters.set(workspaceId, nextSeq);

          return Ok(deletedSequences);
        } catch (error) {
          const message = getErrorMessage(error);
          return Err(`Failed to truncate history: ${message}`);
        }
      }
    );
  }

  async clearHistory(workspaceId: string): Promise<Result<number[], string>> {
    const result = await this.truncateHistory(workspaceId, 1.0);
    if (!result.success) {
      return Err(result.error);
    }
    return Ok(result.data);
  }

  /**
   * Migrate all messages in chat.jsonl to use a new workspace ID
   * This is used during workspace rename to update the workspaceId field in all historical messages
   * IMPORTANT: Should be called AFTER the session directory has been renamed
   */
  async migrateWorkspaceId(oldWorkspaceId: string, newWorkspaceId: string): Promise<Result<void>> {
    // Safe to hold the cross-process write lock: the session directory was
    // already renamed, so the lockfile lives (and is released) at the new
    // path.
    return this.withRecoveredHistoryWriteResultLock(
      newWorkspaceId,
      "Failed to migrate workspace history",
      async () => {
        invalidateHistoryAppendProvenance();
        try {
          // Migrate the sealed archive first so a crash mid-migration never leaves
          // the active file pointing at a stale-ID archive.
          const migrate = (message: MuxMessage, raw: Buffer): MuxMessage => {
            // A duplicate-key reset can parse as an ordinary message. Preserve
            // that damaged row rather than normalizing away its privacy floor.
            if (
              !isReadableHistoryMessage(message) ||
              (hasRawResetMarker(raw.toString("utf8")) &&
                !hasRawResetMarker(JSON.stringify(message)))
            )
              return message;
            return { ...message };
          };
          const { rows: archiveRows, messages: archiveMessages } = await this.readHistoryForRewrite(
            this.getChatArchivePath(newWorkspaceId)
          );
          if (archiveMessages.length > 0) {
            await writeFileAtomic(
              this.getChatArchivePath(newWorkspaceId),
              this.serializeHistoryRewrite(archiveRows, newWorkspaceId, migrate)
            );
          }

          // Read messages from the NEW workspace location (directory was already renamed).
          // Structural rewrite requires full file content.
          const { rows, messages } = await this.readHistoryForRewrite(
            this.getChatHistoryPath(newWorkspaceId)
          );
          if (messages.length === 0) {
            // No active messages to migrate, just transfer the sequence counter.
            // Floor it with the archive max: an archive-only session (active file
            // deleted/truncated) renamed in a fresh process has no cached counter,
            // and seeding 0 would reuse archived historySequence values.
            const oldCounter = this.sequenceCounters.get(oldWorkspaceId) ?? 0;
            const archiveFloor = (await this.getArchiveTailMaxSequence(newWorkspaceId)) + 1;
            this.sequenceCounters.set(newWorkspaceId, Math.max(oldCounter, archiveFloor));
            this.sequenceCounters.delete(oldWorkspaceId);
            return Ok(undefined);
          }

          // Rewrite all messages with new workspace ID
          const newHistoryPath = this.getChatHistoryPath(newWorkspaceId);
          const historyEntries = this.serializeHistoryRewrite(rows, newWorkspaceId, migrate);

          // Atomic write prevents corruption if app crashes mid-write
          await writeFileAtomic(newHistoryPath, historyEntries);

          // Transfer sequence counter to new workspace ID
          const oldCounter = this.sequenceCounters.get(oldWorkspaceId) ?? 0;
          this.sequenceCounters.set(newWorkspaceId, oldCounter);
          this.sequenceCounters.delete(oldWorkspaceId);

          log.debug(
            `Migrated ${messages.length} messages from ${oldWorkspaceId} to ${newWorkspaceId}`
          );

          return Ok(undefined);
        } catch (error) {
          const message = getErrorMessage(error);
          return Err(`Failed to migrate workspace ID: ${message}`);
        }
      }
    );
  }
}

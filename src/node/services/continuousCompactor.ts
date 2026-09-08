import { injectPostCompactionAttachments } from "@/browser/utils/messages/modelMessageTransform";
import type { ModelMessage } from "ai";
import type { PostCompactionAttachment } from "@/common/types/attachment";
import type { ContinuousCompactionJournal } from "@/common/orpc/schemas/continuousCompaction";
import {
  exactJson,
  rebuildContinuousPrefix,
  type ContinuousPrefixSwap,
} from "./continuousCompactionJournal";
import { z } from "zod";
import { createHash } from "node:crypto";
import assert from "@/common/utils/assert";
import { FORCE_COMPACTION_BUFFER_PERCENT } from "@/common/constants/ui";
import { EAGER_LEAD_PERCENT } from "@/constants/continuousCompaction";
import {
  createMuxMessage,
  type CompactionFollowUpRequest,
  type MuxMessage,
} from "@/common/types/message";
import { selectRollingCut, type RollingCut } from "@/common/utils/compaction/rollingCut";
import { estimateMuxMessageTokens } from "@/common/utils/messages/keepRecentTail";
import {
  isDurableContextBoundaryMarker,
  sliceMessagesFromLatestCompactionBoundary,
} from "@/common/utils/messages/compactionBoundary";
import type { HistoryService } from "./historyService";
import type { CompactionHandler } from "./compactionHandler";
import { log } from "./log";

export interface ContinuousCompactionContext {
  enabled: boolean;
  model: string;
  contextWindowTokens: number;
  thresholdPercent: number;
  systemMessageTokens?: number;
  attachmentTokens?: number;
}

type Phase = "on-send" | "mid-stream" | "stream-end";
type Verdict = "none" | "applied" | "fallback";
interface StreamSnapshot {
  messageId: string;
  parts: MuxMessage["parts"];
  stepStartIndices: readonly number[];
  currentStepStartIndex: number;
}
interface Dependencies {
  workspaceId: string;
  enterExecution?(): Disposable;
  historyService: HistoryService;
  compactionHandler: CompactionHandler;
  streamManager: {
    getStreamInfo(workspaceId: string): StreamSnapshot | undefined;
    isStreaming(workspaceId: string): boolean;
    setPrefixSwap?(workspaceId: string, swap: ContinuousPrefixSwap): boolean;
    clearPrefixSwap?(workspaceId: string): void;
    getPrefixSwapState?(workspaceId: string): "none" | "pending" | "consumed" | "invalidated";
  };
  prepare(): Promise<void>;
  estimateAttachmentTokens?(head: MuxMessage[]): Promise<number>;
  prepareSwap?(head: MuxMessage[]): Promise<{
    preparation: ContinuousCompactionJournal["preparation"];
    systemPrefix: ModelMessage[];
    requestProviderOptions?: Record<string, unknown>;
    attachments: PostCompactionAttachment[];
    cacheEnabled: boolean;
  } | null>;
  // Includes usage recording: the generation fence must be AFTER the last await.
  summarize(
    head: MuxMessage[],
    signal: AbortSignal,
    context: ContinuousCompactionContext
  ): Promise<{ text: string; model: string } | null>;
  fastApply(
    apply: (pendingFollowUp?: CompactionFollowUpRequest) => Promise<boolean>
  ): Promise<boolean>;
}
interface StagedSummary {
  publicationGeneration: string | undefined;
  generation: number;
  epoch: number;
  boundarySequence?: number;
  headEnd: { id: string; sequence: number };
  cut: RollingCut;
  headFingerprint: string;
  text: string;
  model: string;
  attachmentTokens: number;
}

/** Only durable request-affecting metadata participates: committing a partial is not an edit. */
function fingerprint(rows: MuxMessage[]): string {
  const hash = createHash("sha256");
  for (const row of rows) {
    const metadata = row.metadata;
    const muxMetadata = metadata?.muxMetadata && { ...metadata.muxMetadata };
    if (muxMetadata) {
      delete muxMetadata.requestedModel;
      delete muxMetadata.transcriptAnchor;
      if (muxMetadata.type === "compaction-request") delete muxMetadata.displayStatus;
      if (muxMetadata.type === "compaction-summary") delete muxMetadata.pendingFollowUp;
    }
    hash.update(
      JSON.stringify({
        id: row.id,
        sequence: metadata?.historySequence,
        role: row.role,
        parts: row.parts,
        synthetic: metadata?.synthetic,
        uiVisible: metadata?.uiVisible,
        kind: metadata?.kind,
        fileAtMentionSnapshot: metadata?.fileAtMentionSnapshot,
        agentSkillSnapshot: metadata?.agentSkillSnapshot,
        mcpPromptSnapshot: metadata?.mcpPromptSnapshot,
        muxMetadata,
      })
    );
  }
  return hash.digest("hex").slice(0, 32);
}

function boundaryIdentity(rows: MuxMessage[]): { epoch: number; boundarySequence?: number } {
  const boundary = rows.findLast(isDurableContextBoundaryMarker);
  return {
    epoch: boundary?.metadata?.compactionEpoch ?? 0,
    boundarySequence: boundary?.metadata?.historySequence,
  };
}

/** Background summary + recent pages. Only the short apply is serialized with the turn. */
export class ContinuousCompactor {
  private generation = 0;
  private staged: StagedSummary | null = null;
  private job: { generation: number; abort: AbortController; done: Promise<void> } | null = null;
  private applying: Promise<Verdict> | null = null;
  private swapAttempted: StagedSummary | null = null;
  private activeSwap: ContinuousPrefixSwap | null = null;
  private ownedJournal: ContinuousCompactionJournal | undefined;

  constructor(private readonly deps: Dependencies) {
    assert(deps.workspaceId.length > 0, "ContinuousCompactor requires a workspace");
  }

  reset(reason: string): void {
    const settingsOnly =
      reason === "disabled" || reason === "threshold-changed" || reason === "context-changed";
    // Once consumed, the journal describes an actual model request. Disabling
    // future compaction cannot undo it or invalidate an in-progress durable fold.
    if (settingsOnly && this.hasConsumedSwap()) return;
    // Hydrating settings must not erase a previous process's journal before recovery.
    // It also keeps the disabled hot path free of journal I/O when no swap ever activated.
    const discardJournal = !settingsOnly || this.activeSwap !== null || this.swapAttempted !== null;
    const journal = this.ownedJournal ?? this.activeSwap?.journal;
    this.generation++;
    this.job?.abort.abort();
    this.job = null;
    this.staged = null;
    this.swapAttempted = null;
    this.activeSwap = null;
    this.ownedJournal = undefined;
    this.deps.streamManager.clearPrefixSwap?.(this.deps.workspaceId);
    // Shutdown retains recovery. Successful apply already performed exact cleanup;
    // clearing again here could erase a successor published after that lock released.
    if (discardJournal && reason !== "shutdown" && reason !== "applied") {
      const store = this.deps.historyService.getContinuousCompactionJournal(this.deps.workspaceId);
      // Preserve legacy explicit reset authority until durable invalidation is added.
      // Failed apply, fallback and settings changes only own their captured journal.
      const explicitReset = [
        "user-interrupt",
        "edit",
        "context-mutation",
        "compaction-request",
      ].includes(reason);
      const clearing = explicitReset ? store.clearForReset() : store.clear(journal);
      clearing.catch((error: unknown) =>
        log.warn("[continuous-compaction] journal clear failed", error)
      );
    }
    log.debug("[continuous-compaction] reset", { workspaceId: this.deps.workspaceId, reason });
  }

  hasConsumedSwap(): boolean {
    return this.activeSwap?.consumed === true;
  }

  isApplying(): boolean {
    return this.applying !== null;
  }

  async waitForIdle(): Promise<void> {
    await this.applying;
  }

  observe(
    usagePercent: number,
    context: ContinuousCompactionContext & { phase: Phase }
  ): Promise<Verdict> {
    if ((!context.enabled || context.thresholdPercent >= 100) && !this.hasConsumedSwap()) {
      this.reset("disabled");
      return Promise.resolve("none");
    }
    if (
      !this.activeSwap &&
      (!Number.isFinite(usagePercent) ||
        !Number.isFinite(context.contextWindowTokens) ||
        context.contextWindowTokens <= 0)
    ) {
      return Promise.resolve("none");
    }
    if (this.applying) return this.applying;
    // Install the latch before any read or callback can synchronously re-enter observe.
    const generation = this.generation;
    const applying = Promise.resolve().then(() =>
      generation === this.generation
        ? this.observeUnlocked(usagePercent, context)
        : ("none" as const)
    );
    this.applying = applying;
    return applying.finally(() => {
      if (this.applying === applying) this.applying = null;
    });
  }

  private async observeUnlocked(
    usagePercent: number,
    context: ContinuousCompactionContext & { phase: Phase }
  ): Promise<Verdict> {
    const generation = this.generation;
    if (this.activeSwap) {
      const state = this.deps.streamManager.getPrefixSwapState?.(this.deps.workspaceId);
      if (state === "invalidated") {
        return (await this.deps.fastApply((followUp) => this.finalizeJournal(followUp)))
          ? "applied"
          : "none";
      }
      if (context.phase !== "mid-stream") {
        if (await this.finalizeJournal()) return "applied";
        // A transient history failure must remain recoverable even when future
        // compaction is disabled; only a discarded/invalid journal releases this latch.
        if (this.hasConsumedSwap()) return "none";
        this.activeSwap = null;
      } else if (state === "pending" || state === "consumed") {
        return "none";
      } else if (!this.deps.streamManager.isStreaming(this.deps.workspaceId)) {
        // The engine can retire its tracker before AgentSession receives stream-end.
        // Late usage must leave the journal for terminal folding, not initiate a stop.
        return "none";
      } else {
        this.activeSwap = null;
      }
    }
    if (!context.enabled || context.thresholdPercent >= 100) return "none";
    if (usagePercent >= context.thresholdPercent && this.staged) {
      const staged = this.staged;
      const rows = await this.readSnapshot();
      if (rows && this.isValid(staged, rows) && this.wouldFit(staged, rows, context)) {
        if (context.phase === "mid-stream" && (await this.activateSwap(staged, rows, context)))
          return "none";
        const applied =
          context.phase === "mid-stream"
            ? await this.deps.fastApply((pendingFollowUp) =>
                this.applyDurably(staged, context, pendingFollowUp)
              )
            : await this.applyDurably(staged, context);
        if (applied) return "applied";
      }
      if (this.staged === staged) this.staged = null;
    }
    if (generation !== this.generation) return "none";
    if (
      usagePercent >= Math.max(0, context.thresholdPercent - EAGER_LEAD_PERCENT) &&
      !this.staged &&
      !this.job
    ) {
      const job = {
        generation: this.generation,
        abort: new AbortController(),
        done: Promise.resolve(),
      };
      this.job = job;
      // Reset may retire this job before non-cooperative preparation or summary I/O settles.
      // Keep physical ownership on the original Promise, independent of semantic job identity.
      const execution = this.deps.enterExecution?.();
      job.done = this.startEagerJob(job, context)
        .catch((error: unknown) => {
          if (!job.abort.signal.aborted)
            log.warn("[continuous-compaction] summarizer failed", error);
        })
        .finally(() => {
          if (this.job === job) this.job = null;
          execution?.[Symbol.dispose]();
        });
    }
    return usagePercent >= context.thresholdPercent + FORCE_COMPACTION_BUFFER_PERCENT
      ? "fallback"
      : "none";
  }

  private async readSnapshot(): Promise<MuxMessage[] | null> {
    const result = await this.deps.historyService.getHistoryFromLatestBoundary(
      this.deps.workspaceId
    );
    if (!result.success) {
      log.warn("[continuous-compaction] history unavailable", result.error);
      return null;
    }
    const rows = result.data;
    const live = this.deps.streamManager.getStreamInfo(this.deps.workspaceId);
    if (live) {
      const index = rows.findIndex((row) => row.id === live.messageId);
      if (index < 0) return null;
      rows[index] = {
        ...rows[index],
        parts: structuredClone(live.parts),
        metadata: { ...rows[index].metadata, stepStartPartIndices: [...live.stepStartIndices] },
      };
    }
    return rows;
  }

  private async startEagerJob(
    job: NonNullable<ContinuousCompactor["job"]>,
    context: ContinuousCompactionContext
  ): Promise<void> {
    const publicationGeneration = await this.deps.historyService
      .getContinuousCompactionJournal(this.deps.workspaceId)
      .captureGeneration();
    if (job.generation !== this.generation) return;
    await this.deps.prepare();
    if (job.generation !== this.generation) return;
    const rows = await this.readSnapshot();
    if (!rows || job.generation !== this.generation) return;
    const live = this.deps.streamManager.getStreamInfo(this.deps.workspaceId);
    if (live) {
      const completedEnd = live.currentStepStartIndex;
      // Until one exact completed step exists there is no safe mandatory tail.
      if (completedEnd === 0) return;
      const index = rows.findIndex((row) => row.id === live.messageId);
      if (index < 0) return;
      rows[index] = { ...rows[index], parts: structuredClone(live.parts.slice(0, completedEnd)) };
    }
    context = await this.withAttachmentEstimate(rows, context);
    if (job.generation !== this.generation) return;
    const cut = selectRollingCut(rows, live ?? null, {
      contextWindowTokens: context.contextWindowTokens,
      // Before the model call only the system/attachment cost is known. Reject
      // provably oversized tails now, then check the actual summary before staging.
      summaryTokens: context.systemMessageTokens ?? 0,
      attachmentTokens: context.attachmentTokens ?? 0,
      forceThresholdTokens:
        (context.contextWindowTokens *
          (context.thresholdPercent + FORCE_COMPACTION_BUFFER_PERCENT)) /
        100,
    });
    if (!cut) return;
    const headEnd = cut.head.at(-1);
    assert(
      headEnd?.metadata?.historySequence !== undefined,
      "Rolling head must have a durable sequence"
    );
    const stagedBase = {
      publicationGeneration,
      generation: job.generation,
      ...boundaryIdentity(rows),
      cut,
      headEnd: { id: headEnd.id, sequence: headEnd.metadata.historySequence },
      headFingerprint: fingerprint(cut.head),
    };
    const summary = await this.deps.summarize(cut.head, job.abort.signal, context);
    if (!summary || job.generation !== this.generation || job.abort.signal.aborted) return;
    assert(summary.text.trim().length > 0, "Continuous summarizer returned empty text");
    const staged = { ...stagedBase, ...summary, attachmentTokens: context.attachmentTokens ?? 0 };
    if (!this.wouldFit(staged, rows, context)) return;
    this.staged = staged;
    log.debug("[continuous-compaction] staged", {
      workspaceId: this.deps.workspaceId,
      headTokens: cut.headTokens,
      tailTokens: cut.tailTokens,
    });
  }

  private headFromRows(staged: StagedSummary, rows: MuxMessage[]): MuxMessage[] | null {
    const end = rows.findIndex(
      (row) =>
        row.id === staged.headEnd.id && row.metadata?.historySequence === staged.headEnd.sequence
    );
    if (end < 0) return null;
    const head = rows.slice(0, end + 1);
    if (staged.cut.stepCut) {
      const { messageId, partIndex } = staged.cut.stepCut;
      const row = rows.find((message) => message.id === messageId);
      if (!row || row.parts.length < partIndex) return null;
      if (partIndex > 0) {
        if (head[end].id !== messageId) return null;
        head[end] = { ...row, parts: row.parts.slice(0, partIndex) };
      }
    }
    return head;
  }

  private isValid(staged: StagedSummary, rows: MuxMessage[]): boolean {
    if (staged.generation !== this.generation) return false;
    const identity = boundaryIdentity(rows);
    if (identity.epoch !== staged.epoch || identity.boundarySequence !== staged.boundarySequence)
      return false;
    const head = this.headFromRows(staged, rows);
    return head !== null && fingerprint(head) === staged.headFingerprint;
  }

  private materializeTail(staged: StagedSummary, rows: MuxMessage[]): MuxMessage[] {
    const end = rows.findIndex((row) => row.id === staged.headEnd.id);
    const copiedCluster = new Set(staged.cut.tail.map((row) => row.id));
    return rows.flatMap((row, index) => {
      if (staged.cut.stepCut?.messageId === row.id) {
        const partIndex = staged.cut.stepCut.partIndex;
        return [
          {
            ...row,
            parts: row.parts.slice(partIndex),
            metadata: {
              ...row.metadata,
              stepStartPartIndices: row.metadata?.stepStartPartIndices
                ?.filter((start) => start >= partIndex && start < row.parts.length)
                .map((start) => start - partIndex),
            },
          },
        ];
      }
      return index > end || copiedCluster.has(row.id) ? [row] : [];
    });
  }

  private async withAttachmentEstimate(
    head: MuxMessage[],
    context: ContinuousCompactionContext
  ): Promise<ContinuousCompactionContext> {
    if (!this.deps.estimateAttachmentTokens) return context;
    const attachmentTokens = await this.deps.estimateAttachmentTokens(head);
    assert(
      Number.isFinite(attachmentTokens) && attachmentTokens >= 0,
      "Invalid attachment token estimate"
    );
    return { ...context, attachmentTokens };
  }

  private wouldFit(
    staged: StagedSummary,
    rows: MuxMessage[],
    context: ContinuousCompactionContext
  ): boolean {
    const tail = this.materializeTail(staged, rows);
    const summaryTokens = estimateMuxMessageTokens(
      createMuxMessage("estimate", "assistant", staged.text)
    );
    const tokens =
      summaryTokens +
      (context.systemMessageTokens ?? 0) +
      Math.max(context.attachmentTokens ?? 0, staged.attachmentTokens) +
      tail.reduce((sum, row) => sum + estimateMuxMessageTokens(row), 0);
    return (
      tokens <
      (context.contextWindowTokens * (context.thresholdPercent + FORCE_COMPACTION_BUFFER_PERCENT)) /
        100
    );
  }

  private async activateSwap(
    staged: StagedSummary,
    rows: MuxMessage[],
    context: ContinuousCompactionContext
  ): Promise<boolean> {
    if (
      this.swapAttempted === staged ||
      !this.deps.prepareSwap ||
      !this.deps.streamManager.setPrefixSwap
    )
      return false;
    this.swapAttempted = staged;
    const live = this.deps.streamManager.getStreamInfo(this.deps.workspaceId);
    const source = rows.at(-1);
    if (!live || source?.id !== live.messageId || source.metadata?.historySequence == null)
      return false;
    const tail = this.materializeTail(staged, rows);
    const retainedLive = tail.at(-1);
    // Rebuild all committed context in the prefix: persisted rows can combine
    // consecutive tool-only steps. Only the current live step supplies a wire anchor.
    const firstStepEnd =
      retainedLive?.metadata?.stepStartPartIndices?.[1] ?? retainedLive?.parts.length;
    const tool = retainedLive?.parts
      .slice(0, firstStepEnd)
      .find((part) => part.type === "dynamic-tool");
    if (
      retainedLive?.id !== live.messageId ||
      retainedLive.role !== "assistant" ||
      retainedLive.metadata?.stepStartPartIndices?.[0] !== 0 ||
      tool?.type !== "dynamic-tool"
    )
      return false;
    const prepared = await this.deps.prepareSwap(staged.cut.head);
    if (!prepared || !this.isValid(staged, rows)) return false;
    const { boundary, copies } = this.deps.compactionHandler.buildContinuousCompactionRows({
      messages: rows,
      text: staged.text,
      model: staged.model,
      tail,
      systemMessageTokens: context.systemMessageTokens ?? 0,
      attachmentTokens: staged.attachmentTokens,
    });
    const staticCopies = copies.slice(0, -1);
    const liveCopy = copies.at(-1);
    assert(liveCopy && tail.at(-1)?.id === live.messageId, "Live tail must be final");
    // A live template must never replay costs, boundary/error flags, or stale partial state.
    if (liveCopy.metadata) delete liveCopy.metadata.partial;
    const partIndex =
      staged.cut.stepCut?.messageId === live.messageId ? staged.cut.stepCut.partIndex : 0;
    try {
      const journal: ContinuousCompactionJournal = {
        version: 1,
        publicationGeneration: staged.publicationGeneration,
        boundary,
        staticCopies,
        liveTailCopySpec: {
          sourceMessageId: live.messageId,
          sourceHistorySequence: source.metadata.historySequence,
          copyId: liveCopy.id,
          partIndex,
          metadataTemplate: liveCopy.metadata,
        },
        prefixSourceRows: [boundary, ...staticCopies],
        systemPrefix: z.array(z.json()).parse(exactJson(prepared.systemPrefix)),
        cacheEnabled: prepared.cacheEnabled,
        sourceFingerprint: fingerprint([
          ...rows.slice(0, -1),
          { ...source, parts: source.parts.slice(0, partIndex) },
        ]),
        postCompactionAttachments: prepared.attachments,
        preparation: prepared.preparation,
        requestProviderOptions:
          prepared.requestProviderOptions == null
            ? undefined
            : exactJson(prepared.requestProviderOptions),
        providerFamily: prepared.preparation.providerForMessages,
        parentModel: context.model,
        summaryModel: staged.model,
        headFingerprint: staged.headFingerprint,
        headEnd: staged.headEnd,
        headPartIndex:
          staged.cut.stepCut && staged.cut.stepCut.partIndex > 0
            ? staged.cut.stepCut.partIndex
            : undefined,
        epoch: staged.epoch,
        boundarySequence: staged.boundarySequence,
        streamMessageId: live.messageId,
        streamHistorySequence: source.metadata.historySequence,
        stepNumber: 0,
        firstTailToolCallId: tool.toolCallId,
      };
      const prefix = await rebuildContinuousPrefix(journal, this.deps.workspaceId);
      if (!this.isValid(staged, rows)) return false;
      const swap: ContinuousPrefixSwap = { prefix, firstTailToolCallId: tool.toolCallId, journal };
      if (!this.deps.streamManager.setPrefixSwap(this.deps.workspaceId, swap)) return false;
      this.activeSwap = swap;
      return true;
    } catch (error) {
      log.warn("[continuous-compaction] prefix preparation failed", error);
      return false;
    }
  }

  /** Runs before startup retry/send admission; ordinary partial commit precedes journal recovery. */
  async recover(): Promise<boolean> {
    if (this.deps.streamManager.isStreaming(this.deps.workspaceId)) return false;
    if (this.applying) return (await this.applying) === "applied";
    const generation = this.generation;
    const applying = Promise.resolve().then(async () => {
      // Probe without parsing: ordinary partial recovery must precede journal validation.
      const store = this.deps.historyService.getContinuousCompactionJournal(this.deps.workspaceId);
      if (!(await store.exists()) || generation !== this.generation) return "none" as const;
      const committed = await this.deps.historyService.commitPartial(this.deps.workspaceId);
      if (!committed.success || generation !== this.generation) return "none" as const;
      return (await this.finalizeJournal()) ? ("applied" as const) : ("none" as const);
    });
    this.applying = applying;
    try {
      return (await applying) === "applied";
    } finally {
      if (this.applying === applying) this.applying = null;
    }
  }

  private async finalizeJournal(pendingFollowUp?: CompactionFollowUpRequest): Promise<boolean> {
    const generation = this.generation;
    const store = this.deps.historyService.getContinuousCompactionJournal(this.deps.workspaceId);
    const journal = await store.read(
      () => generation === this.generation,
      (read) => {
        this.ownedJournal = read;
      }
    );
    if (generation !== this.generation) return false;
    if (!journal) {
      this.activeSwap = null;
      return false;
    }
    assert(!this.deps.streamManager.isStreaming(this.deps.workspaceId), "Cannot fold a live swap");
    const committed = await this.deps.historyService.commitPartial(this.deps.workspaceId);
    if (!committed.success) return false;
    const rows = await this.readSnapshot();
    if (!rows || generation !== this.generation) return false;
    const copiesPresent =
      journal.staticCopies.every((copy) => rows.some((row) => row.id === copy.id)) &&
      rows.some((row) => row.id === journal.liveTailCopySpec.copyId);
    if (rows.some((row) => row.id === journal.boundary.id) && copiesPresent) {
      await store.clear(journal);
      if (generation !== this.generation) return false;
      this.ownedJournal = undefined;
      this.activeSwap = null;
      return true;
    }
    const spec = journal.liveTailCopySpec;
    const source = rows.at(-1);
    const identity = boundaryIdentity(rows);
    const headEnd = rows.findIndex(
      (row) =>
        row.id === journal.headEnd.id && row.metadata?.historySequence === journal.headEnd.sequence
    );
    const head = rows.slice(0, headEnd + 1);
    if (journal.headPartIndex != null && head.length)
      head[head.length - 1] = {
        ...head[head.length - 1],
        parts: head[head.length - 1].parts.slice(0, journal.headPartIndex),
      };
    if (
      !source ||
      source.id !== spec.sourceMessageId ||
      source.metadata?.historySequence !== spec.sourceHistorySequence ||
      source.parts.length < spec.partIndex ||
      journal.streamMessageId !== spec.sourceMessageId ||
      journal.streamHistorySequence !== spec.sourceHistorySequence ||
      identity.epoch !== journal.epoch ||
      identity.boundarySequence !== journal.boundarySequence ||
      headEnd < 0 ||
      fingerprint(head) !== journal.headFingerprint ||
      fingerprint([
        ...rows.slice(0, -1),
        { ...source, parts: source.parts.slice(0, spec.partIndex) },
      ]) !== journal.sourceFingerprint
    ) {
      log.warn("[continuous-compaction] discarded mismatched journal", {
        workspaceId: this.deps.workspaceId,
      });
      await store.clear(journal);
      if (generation !== this.generation) return false;
      this.ownedJournal = undefined;
      this.activeSwap = null;
      return false;
    }
    const snapshot = fingerprint(rows);
    const liveCopy: MuxMessage = {
      id: spec.copyId,
      role: "assistant",
      parts: source.parts.slice(spec.partIndex),
      metadata: {
        ...spec.metadataTemplate,
        stepStartPartIndices: source.metadata?.stepStartPartIndices
          ?.filter((index) => index >= spec.partIndex && index < source.parts.length)
          .map((index) => index - spec.partIndex),
        // Preserve user-Esc continuation semantics, but not the internal stop's marker.
        ...(!pendingFollowUp && source.metadata?.partial ? { partial: true } : {}),
      },
    };
    const boundary = structuredClone(journal.boundary);
    if (pendingFollowUp && boundary.metadata?.muxMetadata?.type === "compaction-summary")
      boundary.metadata.muxMetadata.pendingFollowUp = pendingFollowUp;
    const applied = await this.deps.compactionHandler.withContinuousPendingState(
      head,
      async (_boundaryMessageId, onCommitted) => {
        if (
          generation !== this.generation ||
          this.deps.streamManager.isStreaming(this.deps.workspaceId)
        )
          return false;
        return this.deps.compactionHandler.persistContinuousCompaction({
          messages: rows,
          text: boundary.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
          model: journal.summaryModel,
          tail: [],
          systemMessageTokens: boundary.metadata?.systemMessageTokens ?? 0,
          attachmentTokens: injectPostCompactionAttachments(
            [],
            journal.postCompactionAttachments
          ).reduce((sum, row) => sum + estimateMuxMessageTokens(row), 0),
          // Sequence assignment must not mutate the exact journal receipt used by cleanup.
          prepared: { boundary, copies: [...structuredClone(journal.staticCopies), liveCopy] },
          publication: { generation: journal.publicationGeneration, journal },
          onCommitted,
          shouldPersist: (current) =>
            generation === this.generation &&
            !this.deps.streamManager.isStreaming(this.deps.workspaceId) &&
            fingerprint(sliceMessagesFromLatestCompactionBoundary(current)) === snapshot,
        });
      },
      boundary.id
    );
    if (applied && generation === this.generation) {
      await store.clear(journal);
      if (generation === this.generation) {
        this.ownedJournal = undefined;
        this.reset("applied");
      }
    }
    return applied;
  }

  private async applyDurably(
    staged: StagedSummary,
    context: ContinuousCompactionContext,
    pendingFollowUp?: CompactionFollowUpRequest
  ): Promise<boolean> {
    assert(
      !this.deps.streamManager.isStreaming(this.deps.workspaceId),
      "Cannot apply a boundary while a stream is active"
    );
    let rows = await this.readSnapshot();
    if (!rows || !this.isValid(staged, rows)) return false;
    const head = this.headFromRows(staged, rows);
    assert(head !== null, "Validated rolling head disappeared");
    context = await this.withAttachmentEstimate(head, context);
    if (staged.generation !== this.generation) return false;
    return this.deps.compactionHandler.withContinuousPendingState(
      head,
      async (boundaryMessageId, onCommitted) => {
        // Pending-state persistence yields; a reset/edit during it must still invalidate this job.
        rows = await this.readSnapshot();
        if (!rows || !this.isValid(staged, rows)) return false;
        assert(
          !this.deps.streamManager.isStreaming(this.deps.workspaceId),
          "Stream started during continuous apply"
        );
        const partial = await this.deps.historyService.readPartial(this.deps.workspaceId);
        assert(!partial, "Continuous apply requires the partial to be committed first");
        if (staged.generation !== this.generation) return false;
        if (!this.wouldFit(staged, rows, context)) return false;
        const tail = this.materializeTail(staged, rows);
        const snapshotFingerprint = fingerprint(rows);
        const applied = await this.deps.compactionHandler.persistContinuousCompaction({
          boundaryMessageId,
          publication: { generation: staged.publicationGeneration },
          onCommitted,
          shouldPersist: (currentRows) => {
            const current = sliceMessagesFromLatestCompactionBoundary(currentRows);
            return (
              staged.generation === this.generation &&
              !this.deps.streamManager.isStreaming(this.deps.workspaceId) &&
              this.isValid(staged, current) &&
              fingerprint(current) === snapshotFingerprint
            );
          },
          messages: rows,
          text: staged.text,
          model: staged.model,
          tail,
          systemMessageTokens: context.systemMessageTokens ?? 0,
          attachmentTokens: context.attachmentTokens ?? 0,
          pendingFollowUp,
        });
        if (applied && staged.generation === this.generation) this.reset("applied");
        return applied;
      }
    );
  }
}

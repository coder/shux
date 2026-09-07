import type { GoalSyntheticMessageKind } from "@/constants/goals";
import assert from "@/common/utils/assert";
import type { FilePart, SendMessageOptions } from "@/common/orpc/types";
import { AGENT_PEER_MESSAGE_DEDUPE_PREFIX } from "@/constants/agentMessaging";
import { getValidAgentPeerTriggerMeta } from "@/common/utils/agentMessageEnvelope";
import type { SendMessageError } from "@/common/types/errors";
import type { MuxMessage } from "@/common/types/message";
import type { ReviewNoteData } from "@/common/types/review";

// Type guard for compaction request metadata (for display text)
interface CompactionMetadata {
  type: "compaction-request";
  rawCommand: string;
}

// Type guard for agent skill metadata (for display + batching constraints)
interface AgentSkillMetadata {
  type: "agent-skill";
  rawCommand: string;
  skillName: string;
  scope: "project" | "global" | "built-in";
}

function isAgentSkillMetadata(meta: unknown): meta is AgentSkillMetadata {
  if (typeof meta !== "object" || meta === null) return false;
  const obj = meta as Record<string, unknown>;
  if (obj.type !== "agent-skill") return false;
  if (typeof obj.rawCommand !== "string") return false;
  if (typeof obj.skillName !== "string") return false;
  if (obj.scope !== "project" && obj.scope !== "global" && obj.scope !== "built-in") return false;
  return true;
}

// MCP prompt and inline skill refs ride on type "normal" metadata but are
// consumed only from an entry's first muxMetadata, so batching them into an
// existing entry would silently skip snapshot materialization at dispatch.
function hasSnapshotRefs(meta: unknown): boolean {
  if (typeof meta !== "object" || meta === null) return false;
  const obj = meta as Record<string, unknown>;
  return (
    (Array.isArray(obj.mcpPromptRefs) && obj.mcpPromptRefs.length > 0) ||
    (Array.isArray(obj.agentSkillRefs) && obj.agentSkillRefs.length > 0)
  );
}

function isCompactionMetadata(meta: unknown): meta is CompactionMetadata {
  if (typeof meta !== "object" || meta === null) return false;
  const obj = meta as Record<string, unknown>;
  return obj.type === "compaction-request" && typeof obj.rawCommand === "string";
}

// Workspace-turn task metadata must stay attached to exactly one queued entry;
// otherwise a batched follow-up would leave one durable task handle with no matching stream-end.
interface WorkspaceTurnMetadata {
  type: "workspace-turn-task";
  taskHandleId: string;
  ownerWorkspaceId: string;
  turnId: string;
  /** Peer attribution nested on correlated peer triggers (see MuxMessageMetadata). */
  agentPeerMessageTrigger?: unknown;
}

function isWorkspaceTurnMetadata(meta: unknown): meta is WorkspaceTurnMetadata {
  if (typeof meta !== "object" || meta === null) return false;
  const obj = meta as Record<string, unknown>;
  return (
    obj.type === "workspace-turn-task" &&
    typeof obj.taskHandleId === "string" &&
    typeof obj.ownerWorkspaceId === "string" &&
    typeof obj.turnId === "string"
  );
}

// Peer messages are sealed single-message entries (their sends use removable dedupe keys), so
// counting entries by this metadata type is an exact count of queued peer messages.
function isAgentPeerMessageMetadata(meta: unknown): boolean {
  if (typeof meta !== "object" || meta === null) return false;
  const obj = meta as Record<string, unknown>;
  return obj.type === "agent-peer-message" && typeof obj.fromWorkspaceId === "string";
}

// Type guard for metadata with reviews
interface MetadataWithReviews {
  reviews?: ReviewNoteData[];
}

function hasReviews(meta: unknown): meta is MetadataWithReviews {
  if (typeof meta !== "object" || meta === null) return false;
  const obj = meta as Record<string, unknown>;
  return Array.isArray(obj.reviews);
}

type GoalInterventionPolicy = NonNullable<SendMessageOptions["goalInterventionPolicy"]>;

// Derive from the Zod schema (SendMessageOptions) to stay in sync automatically.
export type QueueDispatchMode = NonNullable<SendMessageOptions["queueDispatchMode"]>;

/** onCanceled text for a send whose cancel signal fired before the turn was accepted. */
export function cancelReasonBeforeAcceptance(signal: AbortSignal): string {
  return typeof signal.reason === "string"
    ? signal.reason
    : "Queued message canceled before acceptance.";
}

/**
 * Input poised to take over a session at a queue cut (see
 * AgentSession.getQueueCutCutter). Engaged stages win over the queue head; an
 * engaged stage is reported even when its metadata is undefined (manual
 * message) so callers cannot misattribute the cut to an entry queued behind
 * the engaged one.
 */
export type QueueCutCutter =
  | { stage: "preparing"; muxMetadata: unknown }
  | { stage: "dispatching"; muxMetadata: unknown }
  | { stage: "queued"; muxMetadata: unknown; dispatchMode: QueueDispatchMode };

interface QueuedMessageInternalOptions {
  goalKind?: GoalSyntheticMessageKind;
  goalId?: string;
  synthetic?: boolean;
  agentInitiated?: boolean;
  /**
   * When the sender authored this message (request entry), before any send
   * preflight awaits (pricing gate, settings persistence). Goal safety
   * compares the authoring time against goal creation, so sampling at
   * enqueue time would misclassify a message authored before a goal became
   * visible as an intervention against it (Codex P2 PRRT_kwDOPxxmWM6b-orA).
   */
  authoredAtMs?: number;
  /** True only for a report that continues an existing workspace turn. */
  workspaceTurnContinuation?: boolean;
  /** Keep this queued add isolated so its dedupe key can be removed without affecting siblings. */
  sealed?: boolean;
  /** Dedupe-keyed maintenance sends are removable by prefix without changing global queue rules. */
  removableDedupeKey?: boolean;
  /**
   * Enqueue this tool-end entry ahead of hidden (non-user-authored) turn-end entries queued
   * before it. Only the FIFO head's mode can cut the active stream, so a background turn-end
   * predecessor (e.g. a child's ancestor-bound peer message) would otherwise hold a tool-end
   * sub-agent progress report until the turn ends naturally. A user-authored turn-end entry
   * still governs: the user's visible "wait for turn end" choice is never pulled forward.
   */
  promoteAheadOfHiddenTurnEnd?: boolean;
  onAccepted?: () => Promise<void> | void;
  onAcceptedPreStreamFailure?: (error: SendMessageError) => Promise<void> | void;
  onCanceled?: (reason: string) => Promise<void> | void;
  /** Mutable dispatch outcome shared with sendQueuedMessages. */
  cancelState?: { canceledBeforeAcceptance: boolean };
  /** Cancels a queued entry even after it has been dequeued into PREPARING. */
  cancelSignal?: AbortSignal;
  /**
   * Synthetic rows persisted by AgentSession.sendMessage immediately before the
   * turn's user row (family-message payloads). Deferring them with the trigger
   * keeps them out of another turn's PREPARING window, where a direct history
   * append could land between that turn's user row and its assistant response.
   */
  preTurnMessages?: MuxMessage[];
  /** r54: fired once pre-turn rows cross the rollback horizon at dispatch. */
  onPreTurnRowsPersisted?: () => void;
  /**
   * Caller staleness probe re-emitted at dispatch and re-checked by the session's
   * turn-admission gates. Peer agent sends use it so a Stop/task_stop landing after
   * dequeue — where queue clearing can no longer see the entry — still refuses the turn.
   */
  admissionStale?: () => boolean;
}

type QueueClearCallbacks = Pick<
  QueuedMessageInternalOptions,
  "onCanceled" | "onAcceptedPreStreamFailure"
>;

/**
 * One dispatchable unit in the queue. Plain follow-up messages batch into a single
 * entry (joined text, accumulated file parts); "special" sends (compaction requests,
 * agent-skill invocations, workspace-turn follow-ups, callback-carrying internal
 * sends) always start their own entry so their metadata/callbacks stay attached to
 * exactly one dispatch.
 */
interface QueueEntry {
  goalKind?: GoalSyntheticMessageKind;
  goalId?: string;
  messages: string[];
  /** First muxMetadata added to this entry (never overwritten by later batched adds). */
  muxMetadata?: unknown;
  latestOptions?: SendMessageOptions;
  fileParts: FilePart[];
  /** Dedupe keys registered by addOnce for adds that landed in this entry. */
  dedupeKeys: Set<string>;
  goalInterventionPolicy?: GoalInterventionPolicy;
  dispatchMode: QueueDispatchMode;
  /**
   * Sealed entries never accept later batched messages: their callbacks/metadata
   * correlate to exactly one turn (workspace-turn follow-ups, agent skills).
   * Later messages queue as a new entry behind them instead.
   */
  sealed: boolean;
  /** User-originated entries are the only ones exposed to/restored into the composer. */
  userAuthored: boolean;
  /** True only for a report that continues an existing workspace turn. */
  workspaceTurnContinuation: boolean;
  addCount: number;
  syntheticCount: number;
  agentInitiatedCount: number;
  /**
   * Timestamp of the latest add batched into this entry. Dispatch exposes it so
   * goal safety can tell messages typed before a goal existed (queued while the
   * goal-creating turn was still streaming) from genuine interventions against
   * a goal the user has already seen.
   */
  lastAddedAtMs: number;
  onCanceled?: (reason: string) => Promise<void> | void;
  onAccepted?: () => Promise<void> | void;
  onAcceptedPreStreamFailure?: (error: SendMessageError) => Promise<void> | void;
  cancelState?: { canceledBeforeAcceptance: boolean };
  cancelSignal?: AbortSignal;
  /** Pre-turn rows delivered with this entry (entries carrying them are sealed). */
  preTurnMessages?: MuxMessage[];
  /** r54: fired once this entry's pre-turn rows cross the rollback horizon. */
  onPreTurnRowsPersisted?: () => void;
  /** Caller staleness probe re-checked at this entry's dispatch admission (entries carrying it are sealed). */
  admissionStale?: () => boolean;
}

/**
 * FIFO queue of messages sent during active streaming.
 *
 * The queue holds ordered entries that dispatch one at a time (see dequeueNext):
 * - Plain messages batch into the newest open entry (texts joined, file parts
 *   accumulated, first muxMetadata preserved, latest options win).
 * - Compaction requests, agent-skill invocations, workspace-turn follow-ups, and
 *   callback-carrying internal sends each start their own entry, so queueing one
 *   never blocks later sends — they simply dispatch after it (no enqueue errors).
 * - Agent-skill / workspace-turn / callback entries are sealed: later messages
 *   start a new entry instead of adopting their metadata or callbacks.
 * - User-authored and background/agent-initiated messages never share an entry,
 *   so renderer/restoration projections can omit background work precisely.
 * - Compaction entries stay open: a follow-up typed behind a pending /compact
 *   batches under the compaction request (long-standing behavior).
 * - Only the FIFO head's dispatch mode can cut the active stream. Tool-end sends flagged
 *   promoteAheadOfHiddenTurnEnd (sub-agent progress reports) therefore enqueue ahead of
 *   hidden turn-end predecessors, never ahead of a user-authored entry.
 *
 * Display logic:
 * - A single-message compaction or agent-skill entry shows its rawCommand
 *   (e.g. /compact, /{skill}); otherwise entries show their actual message texts.
 */
export class MessageQueue {
  private entries: QueueEntry[] = [];

  /**
   * Check if the queue currently contains a compaction request.
   */
  hasCompactionRequest(): boolean {
    return this.entries.some((entry) => isCompactionMetadata(entry.muxMetadata));
  }

  hasWorkspaceTurn(handleId: string): boolean {
    return (
      handleId.length > 0 &&
      this.entries.some(
        (entry) =>
          isWorkspaceTurnMetadata(entry.muxMetadata) && entry.muxMetadata.taskHandleId === handleId
      )
    );
  }

  /** Queued intra-tree agent peer messages (sealed entries, one message each). */
  countAgentPeerMessageEntries(): number {
    // The dedupe-key prefix also matches triggers whose muxMetadata was replaced by a
    // workspace-turn correlation (upward sends into a delegated turn keep the peer count).
    return this.entries.filter(
      (entry) =>
        isAgentPeerMessageMetadata(entry.muxMetadata) ||
        [...entry.dedupeKeys].some((key) => key.startsWith(AGENT_PEER_MESSAGE_DEDUPE_PREFIX))
    ).length;
  }

  private getDispatchMode(entries: readonly QueueEntry[]): QueueDispatchMode {
    if (entries.length === 0) {
      return "tool-end";
    }
    return entries.some((entry) => entry.dispatchMode === "tool-end") ? "tool-end" : "turn-end";
  }

  /** Dispatch boundary for the FIFO head entry — the only entry the next drain can send. */
  getNextQueueDispatchMode(): QueueDispatchMode {
    return this.entries[0]?.dispatchMode ?? "tool-end";
  }

  /**
   * Dispatch mode of the first entry whose cancel signal has not fired, or undefined
   * when none remains. Aborted entries still drain FIFO (as no-ops that fire
   * onCanceled), but they are not pending work and must not arm a tool-end stop.
   */
  getNextDispatchableMode(): QueueDispatchMode | undefined {
    return this.entries.find((entry) => entry.cancelSignal?.aborted !== true)?.dispatchMode;
  }

  /**
   * Whether every queued entry continues the exact workspace turn correlation.
   *
   * The caller uses this for a new continuation that has not entered the queue.
   * An unrelated entry anywhere ahead of it supersedes the correlation.
   */
  hasAllWorkspaceTurnContinuations(
    taskHandleId: string,
    ownerWorkspaceId: string,
    turnId: string
  ): boolean {
    return (
      this.entries.length > 0 &&
      this.entries.every((entry) => {
        const metadata = entry.muxMetadata;
        return (
          isWorkspaceTurnMetadata(metadata) &&
          metadata.taskHandleId === taskHandleId &&
          metadata.ownerWorkspaceId === ownerWorkspaceId &&
          metadata.turnId === turnId
        );
      })
    );
  }

  /**
   * hasAllWorkspaceTurnContinuations for a tool-end entry about to be enqueued with
   * promoteAheadOfHiddenTurnEnd: the trailing hidden turn-end entries it will overtake are not
   * its predecessors, so only the entries that stay ahead of it must share the correlation
   * (vacuously true when none do). Without this, WorkspaceService would strip the promoted
   * entry's correlation for an entry it never dispatches behind, and its tool-end cut would
   * then supersede the delegated turn it was meant to continue.
   */
  hasAllWorkspaceTurnContinuationsAheadOfPromotedToolEnd(
    taskHandleId: string,
    ownerWorkspaceId: string,
    turnId: string
  ): boolean {
    return this.entries.slice(0, this.trailingHiddenTurnEndRunStart()).every((entry) => {
      const metadata = entry.muxMetadata;
      return (
        isWorkspaceTurnMetadata(metadata) &&
        metadata.taskHandleId === taskHandleId &&
        metadata.ownerWorkspaceId === ownerWorkspaceId &&
        metadata.turnId === turnId
      );
    });
  }

  /**
   * Index where the trailing run of hidden (non-user-authored) turn-end entries begins — the
   * entries a promoteAheadOfHiddenTurnEnd add overtakes. Equals entries.length when the tail is
   * user-authored or tool-end (nothing to overtake).
   */
  private trailingHiddenTurnEndRunStart(): number {
    let start = this.entries.length;
    while (start > 0) {
      const predecessor = this.entries[start - 1];
      if (predecessor.userAuthored || predecessor.dispatchMode !== "turn-end") {
        break;
      }
      start -= 1;
    }
    return start;
  }

  /**
   * Whether the next entry continues the exact workspace turn correlation.
   */
  hasNextWorkspaceTurnContinuation(
    taskHandleId: string,
    ownerWorkspaceId: string,
    turnId: string
  ): boolean {
    const metadata = this.entries[0]?.muxMetadata;
    return (
      isWorkspaceTurnMetadata(metadata) &&
      metadata.taskHandleId === taskHandleId &&
      metadata.ownerWorkspaceId === ownerWorkspaceId &&
      metadata.turnId === turnId
    );
  }

  /**
   * FIFO head entry's cut-attribution view: its first muxMetadata plus dispatch mode.
   *
   * Soundness of metadata-based cut attribution rests on the sealing invariant
   * (see class docblock): workspace-turn entries are sealed at add time and
   * batching additionally requires matching userAuthored, so a manual user
   * message can never hide inside an entry whose muxMetadata is workspace-turn
   * metadata.
   */
  getNextQueueCutCandidate():
    | { muxMetadata: unknown; dispatchMode: QueueDispatchMode }
    | undefined {
    const head = this.entries[0];
    if (head == null) {
      return undefined;
    }
    return { muxMetadata: head.muxMetadata, dispatchMode: head.dispatchMode };
  }

  /**
   * Whether the next entry to dispatch is a bash-monitor wake. Wake sends are
   * the only queued input that continues an open delegated workspace turn
   * (see AgentSession.inheritOpenWorkspaceTurnMetadata); any other head entry
   * supersedes the turn when it dispatches.
   */
  isNextEntryBashMonitorWake(): boolean {
    const muxMetadata = this.entries[0]?.muxMetadata;
    if (typeof muxMetadata !== "object" || muxMetadata === null) return false;
    return (muxMetadata as Record<string, unknown>).type === "bash-monitor-wake";
  }

  /**
   * Effective dispatch mode across pending entries: any entry queued for tool-end
   * makes the whole queue dispatch at tool-end (sticky, matching pre-entry behavior),
   * otherwise turn-end. Empty queue reports the tool-end default.
   */
  getQueueDispatchMode(): QueueDispatchMode {
    return this.getDispatchMode(this.entries);
  }

  /**
   * Dispatch mode for user-visible entries only. Backend-initiated maintenance/wake
   * messages should not change the queue badge shown beside the user's own follow-up.
   */
  getVisibleQueueDispatchMode(): QueueDispatchMode {
    return this.getVisibleEntries().length > 0 ? this.getNextQueueDispatchMode() : "tool-end";
  }

  /**
   * Remove workspace-turn metadata from entries that now follow an unrelated predecessor.
   *
   * Queue reordering can move user input ahead of a report after the report was enqueued.
   * Clear the correlation callbacks with the metadata so the stale report cannot settle
   * the superseded workspace turn when it later dispatches.
   */
  private revalidateWorkspaceTurnCorrelations(): void {
    let hasUnrelatedPredecessor = false;
    let priorCorrelation: WorkspaceTurnMetadata | undefined;

    for (const entry of this.entries) {
      const metadata = isWorkspaceTurnMetadata(entry.muxMetadata) ? entry.muxMetadata : undefined;
      const matchesPriorCorrelation =
        metadata != null &&
        !hasUnrelatedPredecessor &&
        (priorCorrelation == null ||
          (metadata.taskHandleId === priorCorrelation.taskHandleId &&
            metadata.ownerWorkspaceId === priorCorrelation.ownerWorkspaceId &&
            metadata.turnId === priorCorrelation.turnId));

      if (metadata == null) {
        hasUnrelatedPredecessor = true;
      } else if (!matchesPriorCorrelation) {
        hasUnrelatedPredecessor = true;
        if (entry.workspaceTurnContinuation) {
          // Mirror WorkspaceService.stripWorkspaceTurnCorrelation for entries whose correlation
          // goes stale while QUEUED: a peer trigger keeps its machine-notification identity
          // (downgraded to plain peer attribution) plus its onCanceled AND
          // onAcceptedPreStreamFailure — both carry the sender's budget refund, tied to this
          // entry rather than the superseded owner handle. Owner handle-settling callbacks are
          // still dropped.
          const peerTrigger = getValidAgentPeerTriggerMeta(metadata.agentPeerMessageTrigger);
          entry.muxMetadata =
            peerTrigger != null ? { type: "agent-peer-message", ...peerTrigger } : undefined;
          if (peerTrigger == null) {
            entry.onCanceled = undefined;
            entry.onAcceptedPreStreamFailure = undefined;
          }
        }
      } else {
        priorCorrelation ??= metadata;
      }
    }
  }

  /**
   * Update the dispatch boundary for every user-visible queued entry represented by the
   * aggregate queued-message card. Hidden synthetic/background entries keep their own mode.
   */
  setVisibleQueueDispatchMode(mode: QueueDispatchMode): boolean {
    const visibleEntries: QueueEntry[] = [];
    const hiddenEntries: QueueEntry[] = [];
    for (const entry of this.entries) {
      if (entry.userAuthored) {
        entry.dispatchMode = mode;
        visibleEntries.push(entry);
      } else {
        hiddenEntries.push(entry);
      }
    }
    if (visibleEntries.length === 0) {
      return false;
    }

    // The user explicitly chose when the aggregate visible card should dispatch. Keep those
    // entries together at the FIFO head so a hidden predecessor cannot contradict that choice.
    this.entries = [...visibleEntries, ...hiddenEntries];
    this.revalidateWorkspaceTurnCorrelations();
    return true;
  }

  /**
   * Add a message to the queue. Plain messages batch into the newest open entry;
   * special sends start their own entry (see class docblock). Never throws.
   */
  add(
    message: string,
    options?: SendMessageOptions & { fileParts?: FilePart[] },
    internal?: QueuedMessageInternalOptions
  ): boolean {
    return this.addInternal(message, options, internal) != null;
  }

  /**
   * Whether a message queued via {@link addOnce} with this dedupe key is still pending.
   * Keys release when their entry dispatches or the queue is cleared.
   */
  hasDedupeKey(dedupeKey: string): boolean {
    return this.entries.some((entry) => entry.dedupeKeys.has(dedupeKey));
  }

  /**
   * Whether the queue's only content is the single message queued under this dedupe key.
   * Used to supersede low-value scheduled entries (heartbeats): a later real message must
   * not batch behind them, because batching would adopt the first entry's muxMetadata.
   */
  holdsOnlyDedupeKey(dedupeKey: string): boolean {
    return (
      this.entries.length === 1 &&
      this.entries[0].addCount === 1 &&
      this.entries[0].dedupeKeys.has(dedupeKey)
    );
  }

  /**
   * Add a message to the queue once, keyed by dedupeKey.
   * Returns true if the message was queued.
   */
  addOnce(
    message: string,
    options?: SendMessageOptions & { fileParts?: FilePart[] },
    dedupeKey?: string,
    internal?: QueuedMessageInternalOptions
  ): boolean {
    if (dedupeKey !== undefined && this.hasDedupeKey(dedupeKey)) {
      return false;
    }

    const entry = this.addInternal(message, options, internal);
    if (entry != null && dedupeKey !== undefined) {
      entry.dedupeKeys.add(dedupeKey);
    }
    return entry != null;
  }

  /** Returns the entry the message landed in, or undefined when nothing was queued. */
  private addInternal(
    message: string,
    options?: SendMessageOptions & { fileParts?: FilePart[] },
    internal?: QueuedMessageInternalOptions
  ): QueueEntry | undefined {
    const trimmedMessage = message.trim();
    const hasFiles = options?.fileParts && options.fileParts.length > 0;

    // Reject if both text and file parts are empty
    if (trimmedMessage.length === 0 && !hasFiles) {
      return undefined;
    }

    const incomingHasAcceptedCallbacks =
      internal?.onAccepted != null ||
      internal?.onAcceptedPreStreamFailure != null ||
      internal?.onCanceled != null ||
      internal?.cancelSignal != null;
    const incomingIsUserAuthored =
      internal?.synthetic !== true && internal?.agentInitiated !== true;
    // Sealed entries must own their turn end-to-end: workspace-turn metadata and
    // internal callbacks correlate to exactly one dispatch, and agent-skill metadata
    // must not leak onto batched follow-ups.
    const incomingIsSealed =
      internal?.sealed === true ||
      internal?.removableDedupeKey === true ||
      isAgentSkillMetadata(options?.muxMetadata) ||
      isWorkspaceTurnMetadata(options?.muxMetadata) ||
      hasSnapshotRefs(options?.muxMetadata) ||
      // Pre-turn rows must stay 1:1 with their triggering text: batching two
      // family sends would join their triggers while both payload rows pile
      // onto one entry, and the payloads would then persist adjacently.
      (internal?.preTurnMessages?.length ?? 0) > 0 ||
      // A staleness probe gates exactly one dispatch; batching would let one
      // sender's stop-refusal veto unrelated queued messages.
      internal?.admissionStale != null ||
      internal?.goalKind != null ||
      incomingHasAcceptedCallbacks;
    // Compaction starts its own entry (its metadata must not adopt earlier batched
    // texts), but stays open so a follow-up typed behind a pending /compact batches
    // under the compaction request, preserving long-standing behavior.
    const incomingStartsNewEntry = incomingIsSealed || isCompactionMetadata(options?.muxMetadata);
    const incomingMode = options?.queueDispatchMode ?? "tool-end";

    const tail = this.entries[this.entries.length - 1];
    let entry: QueueEntry;
    if (
      tail !== undefined &&
      !tail.sealed &&
      !incomingStartsNewEntry &&
      tail.userAuthored === incomingIsUserAuthored
    ) {
      entry = tail;
      // tool-end is sticky within an entry; turn-end never downgrades an entry
      // that something already queued for tool-end dispatch.
      if (incomingMode === "tool-end") {
        entry.dispatchMode = "tool-end";
      }
    } else {
      entry = {
        messages: [],
        fileParts: [],
        dedupeKeys: new Set<string>(),
        dispatchMode: incomingMode,
        sealed: incomingIsSealed,
        userAuthored: incomingIsUserAuthored,
        workspaceTurnContinuation: internal?.workspaceTurnContinuation === true,
        goalKind: internal?.goalKind,
        goalId: internal?.goalId,
        addCount: 0,
        syntheticCount: 0,
        agentInitiatedCount: 0,
        // 0, not Date.now(): every add (including the entry-creating one)
        // folds its authoring time in below via max(); seeding with the
        // creation wall clock would swallow an authoredAtMs captured before
        // slow send preflight, defeating the pre-goal queue-race guard.
        lastAddedAtMs: 0,
      };
      this.entries.push(entry);
    }
    const createdNewEntry = entry !== tail;

    if (internal?.preTurnMessages != null && internal.preTurnMessages.length > 0) {
      entry.preTurnMessages = [...(entry.preTurnMessages ?? []), ...internal.preTurnMessages];
    }

    // Explicit pause is sticky within an entry (a batched steer must not unpause).
    entry.goalInterventionPolicy =
      entry.goalInterventionPolicy === "pause" || options?.goalInterventionPolicy === "pause"
        ? "pause"
        : (options?.goalInterventionPolicy ?? entry.goalInterventionPolicy);

    // Add text message if non-empty
    if (trimmedMessage.length > 0) {
      entry.messages.push(trimmedMessage);
    }

    if (options) {
      const { fileParts, ...restOptions } = options;

      // Preserve first muxMetadata per entry (see class docblock for rationale)
      if (options.muxMetadata !== undefined && entry.muxMetadata === undefined) {
        entry.muxMetadata = options.muxMetadata;
      }
      entry.latestOptions = restOptions;

      if (fileParts && fileParts.length > 0) {
        entry.fileParts.push(...fileParts);
      }
    }
    if (internal?.onCanceled != null) {
      entry.onCanceled = internal.onCanceled;
    }
    if (internal?.onAccepted != null) {
      entry.onAccepted = internal.onAccepted;
    }
    if (internal?.onAcceptedPreStreamFailure != null) {
      entry.onAcceptedPreStreamFailure = internal.onAcceptedPreStreamFailure;
    }
    if (internal?.onPreTurnRowsPersisted != null) {
      // Callback-carrying sends seal their entries, but pre-turn batches can
      // in principle concatenate — chain instead of overwrite so no
      // producer's persistence signal is dropped (r54).
      const previous = entry.onPreTurnRowsPersisted;
      const next = internal.onPreTurnRowsPersisted;
      entry.onPreTurnRowsPersisted =
        previous == null
          ? next
          : () => {
              previous();
              next();
            };
    }

    if (internal?.cancelState != null) {
      entry.cancelState = internal.cancelState;
    }
    if (internal?.cancelSignal != null) {
      entry.cancelSignal = internal.cancelSignal;
    }
    if (internal?.admissionStale != null) {
      entry.admissionStale = internal.admissionStale;
    }

    entry.addCount += 1;
    // Codex security P2 (PRRT_kwDOPxxmWM6b_OS9): batched sends can finish
    // preflight out of authoring order. Keep the NEWEST authoring time for
    // the entry — a plain overwrite would let an older pre-goal message mask
    // a later post-goal stop/correction, satisfying the pre-goal guard and
    // granting the agent another autonomous turn despite the intervention.
    entry.lastAddedAtMs = Math.max(entry.lastAddedAtMs, internal?.authoredAtMs ?? Date.now());
    if (internal?.synthetic === true) {
      entry.syntheticCount += 1;
    }
    if (internal?.agentInitiated === true) {
      entry.agentInitiatedCount += 1;
    }

    // Reorder only after muxMetadata/callbacks are populated: correlation revalidation must see
    // the promoted entry's own workspace-turn metadata, or skipped same-turn continuations would
    // be stripped as if an unrelated message had overtaken them.
    if (
      createdNewEntry &&
      internal?.promoteAheadOfHiddenTurnEnd === true &&
      entry.dispatchMode === "tool-end"
    ) {
      this.promoteAheadOfHiddenTurnEndPredecessors(entry);
    }

    return entry;
  }

  /**
   * Move a freshly pushed tool-end entry ahead of the hidden turn-end entries immediately
   * before it (see QueuedMessageInternalOptions.promoteAheadOfHiddenTurnEnd). Stops at the
   * first user-authored or tool-end predecessor, so FIFO order is preserved among entries
   * that either carry the user's explicit choice or would already cut at a step boundary.
   */
  private promoteAheadOfHiddenTurnEndPredecessors(entry: QueueEntry): void {
    const currentIndex = this.entries.length - 1;
    assert(
      this.entries[currentIndex] === entry && entry.dispatchMode === "tool-end",
      "promoteAheadOfHiddenTurnEndPredecessors requires the tool-end tail entry"
    );
    // The new entry is the tail, so the trailing run is measured over its predecessors.
    this.entries.pop();
    const insertIndex = this.trailingHiddenTurnEndRunStart();
    this.entries.splice(insertIndex, 0, entry);
    if (insertIndex === currentIndex) {
      return;
    }
    // The skipped entries now follow an unrelated predecessor (same as prioritizeNextUserEntry).
    this.revalidateWorkspaceTurnCorrelations();
  }

  /**
   * Entries containing user-originated input. Fully synthetic entries (background
   * monitor wakes, scheduled maintenance, internal follow-ups) remain dispatchable
   * but must not appear in or restore over the user's composer.
   */
  private getVisibleEntries(): QueueEntry[] {
    return this.entries.filter((entry) => entry.userAuthored);
  }

  private getMessagesForEntries(entries: readonly QueueEntry[]): string[] {
    return entries.flatMap((entry) => entry.messages);
  }

  private getDisplayTextForEntries(entries: readonly QueueEntry[]): string {
    return entries
      .map((entry) => {
        if (
          entry.messages.length <= 1 &&
          (isCompactionMetadata(entry.muxMetadata) || isAgentSkillMetadata(entry.muxMetadata))
        ) {
          return entry.muxMetadata.rawCommand;
        }
        return entry.messages.join("\n");
      })
      .filter((text) => text.length > 0)
      .join("\n");
  }

  private getFilePartsForEntries(entries: readonly QueueEntry[]): FilePart[] {
    return entries.flatMap((entry) => entry.fileParts);
  }

  private getReviewsForEntries(entries: readonly QueueEntry[]): ReviewNoteData[] | undefined {
    const reviews = entries.flatMap((entry) =>
      hasReviews(entry.muxMetadata) ? (entry.muxMetadata.reviews ?? []) : []
    );
    return reviews.length > 0 ? reviews : undefined;
  }

  /** Get all queued message texts across entries (including synthetic entries). */
  getMessages(): string[] {
    return this.getMessagesForEntries(this.entries);
  }

  /** Get user-visible queued message texts for the renderer/composer. */
  getVisibleMessages(): string[] {
    return this.getMessagesForEntries(this.getVisibleEntries());
  }

  /**
   * Get display text for queued messages.
   * - A single-message compaction/agent-skill entry shows its rawCommand (/compact, /{skill})
   * - Otherwise entries show their actual message texts, joined with newlines
   */
  getDisplayText(): string {
    return this.getDisplayTextForEntries(this.entries);
  }

  /** Get display text for user-visible entries only. */
  getVisibleDisplayText(): string {
    return this.getDisplayTextForEntries(this.getVisibleEntries());
  }

  /** Get accumulated file parts across all entries. */
  getFileParts(): FilePart[] {
    return this.getFilePartsForEntries(this.entries);
  }

  /** Get accumulated file parts for user-visible entries only. */
  getVisibleFileParts(): FilePart[] {
    return this.getFilePartsForEntries(this.getVisibleEntries());
  }

  /** Get reviews across user-visible entries' metadata only. */
  getVisibleReviews(): ReviewNoteData[] | undefined {
    return this.getReviewsForEntries(this.getVisibleEntries());
  }

  /** Whether a user-visible queued entry is a compaction request. */
  hasVisibleCompactionRequest(): boolean {
    return this.getVisibleEntries().some((entry) => isCompactionMetadata(entry.muxMetadata));
  }

  /**
   * Cancellation callbacks for every pending entry, in queue order.
   * Callers must notify each one when clearing the queue.
   */
  getClearCallbacks(): QueueClearCallbacks[] {
    return this.entries
      .filter((entry) => entry.onCanceled != null || entry.onAcceptedPreStreamFailure != null)
      .map((entry) => ({
        ...(entry.onCanceled != null ? { onCanceled: entry.onCanceled } : {}),
        ...(entry.onAcceptedPreStreamFailure != null
          ? { onAcceptedPreStreamFailure: entry.onAcceptedPreStreamFailure }
          : {}),
      }));
  }

  /**
   * Remove only the entry pinned to this workspace-turn handle, leaving unrelated
   * queued messages intact (interrupting a queued turn must not drop user input).
   * Returns the removed entry's cancellation callbacks, or null when no entry matches.
   */
  removeWorkspaceTurn(handleId: string): QueueClearCallbacks | null {
    if (handleId.length === 0) {
      return null;
    }
    const index = this.entries.findIndex(
      (entry) =>
        isWorkspaceTurnMetadata(entry.muxMetadata) && entry.muxMetadata.taskHandleId === handleId
    );
    if (index === -1) {
      return null;
    }
    const [entry] = this.entries.splice(index, 1);
    return {
      ...(entry.onCanceled != null ? { onCanceled: entry.onCanceled } : {}),
      ...(entry.onAcceptedPreStreamFailure != null
        ? { onAcceptedPreStreamFailure: entry.onAcceptedPreStreamFailure }
        : {}),
    };
  }

  /** Remove queued entries carrying a dedupe key with the given prefix. */
  removeByDedupeKeyPrefix(prefix: string): {
    removedCount: number;
    callbacks: QueueClearCallbacks[];
  } {
    if (prefix.length === 0) {
      return { removedCount: 0, callbacks: [] };
    }
    let removedCount = 0;
    const removedCallbacks: QueueClearCallbacks[] = [];
    this.entries = this.entries.flatMap((entry) => {
      const matchingKeys = [...entry.dedupeKeys].filter((dedupeKey) =>
        dedupeKey.startsWith(prefix)
      );
      if (matchingKeys.length === 0) {
        return [entry];
      }
      removedCount += matchingKeys.length;
      // Dedupe-keyed progress sends are agent-initiated and therefore isolated from user entries,
      // but multiple progress sends can still batch together. Remove only the matched messages and
      // preserve unrelated keys/messages that share the same entry.
      const matchingKeySet = new Set(matchingKeys);
      const keptMessages = entry.messages.filter((_message, index) => {
        const key = [...entry.dedupeKeys][index];
        return key == null || !matchingKeySet.has(key);
      });
      if (keptMessages.length > 0) {
        entry.messages = keptMessages;
        for (const key of matchingKeys) {
          entry.dedupeKeys.delete(key);
        }
        entry.addCount -= matchingKeys.length;
        entry.syntheticCount = Math.min(entry.syntheticCount, entry.addCount);
        entry.agentInitiatedCount = Math.min(entry.agentInitiatedCount, entry.addCount);
        return [entry];
      }
      if (entry.onCanceled != null || entry.onAcceptedPreStreamFailure != null) {
        removedCallbacks.push({
          ...(entry.onCanceled != null ? { onCanceled: entry.onCanceled } : {}),
          ...(entry.onAcceptedPreStreamFailure != null
            ? { onAcceptedPreStreamFailure: entry.onAcceptedPreStreamFailure }
            : {}),
        });
      }
      return [];
    });
    return { removedCount, callbacks: removedCallbacks };
  }

  /**
   * Move the oldest user-authored entry to the head so an explicit user "Send now"
   * action cannot be blocked by hidden synthetic/background work queued before it.
   * Returns false when no user-authored entry is pending.
   */
  prioritizeNextUserEntry(): boolean {
    const index = this.entries.findIndex((entry) => entry.userAuthored);
    if (index === -1) {
      return false;
    }
    if (index > 0) {
      const [entry] = this.entries.splice(index, 1);
      this.entries.unshift(entry);
      this.revalidateWorkspaceTurnCorrelations();
    }
    return true;
  }

  /** Capture before admission publication; observers may remove or reorder the head. */
  peekNext(): { identity: object; muxMetadata: unknown } | undefined {
    const entry = this.entries[0];
    return entry ? { identity: entry, muxMetadata: entry.muxMetadata } : undefined;
  }

  /**
   * Remove the first entry and return its combined message and options for sending.
   * Later entries stay queued and dispatch on subsequent drains (FIFO).
   * Caller must check {@link isEmpty} first.
   */
  dequeueNext(): {
    message: string;
    options?: SendMessageOptions & { fileParts?: FilePart[] };
    internal?: QueuedMessageInternalOptions;
    /** Timestamp of the latest add batched into this entry (see QueueEntry.lastAddedAtMs). */
    enqueuedAtMs?: number;
  } {
    const entry = this.entries.shift();
    if (entry === undefined) {
      return { message: "" };
    }

    const joinedMessages = entry.messages.join("\n");
    const options = entry.latestOptions
      ? (() => {
          const restOptions: SendMessageOptions = { ...entry.latestOptions };
          delete restOptions.queueDispatchMode;
          if (entry.goalInterventionPolicy != null) {
            restOptions.goalInterventionPolicy = entry.goalInterventionPolicy;
          }
          return {
            ...restOptions,
            // First metadata takes precedence (preserves compaction + agent-skill invocations)
            muxMetadata: entry.muxMetadata,
            fileParts: entry.fileParts.length > 0 ? entry.fileParts : undefined,
          };
        })()
      : undefined;

    const allAddsAreSynthetic = entry.addCount > 0 && entry.syntheticCount === entry.addCount;
    const allAddsAreAgentInitiated =
      entry.addCount > 0 && entry.agentInitiatedCount === entry.addCount;
    const hasInternalOptions =
      allAddsAreSynthetic ||
      allAddsAreAgentInitiated ||
      entry.onAccepted != null ||
      entry.onAcceptedPreStreamFailure != null ||
      entry.onCanceled != null ||
      entry.cancelSignal != null ||
      entry.admissionStale != null ||
      (entry.preTurnMessages?.length ?? 0) > 0;
    const internal = hasInternalOptions
      ? {
          ...(allAddsAreSynthetic ? { synthetic: true } : {}),
          ...(allAddsAreAgentInitiated ? { agentInitiated: true } : {}),
          ...(entry.goalKind != null ? { goalKind: entry.goalKind, goalId: entry.goalId } : {}),
          ...(entry.onCanceled != null ? { onCanceled: entry.onCanceled } : {}),
          ...(entry.cancelState != null ? { cancelState: entry.cancelState } : {}),
          ...(entry.cancelSignal != null ? { cancelSignal: entry.cancelSignal } : {}),
          ...(entry.onAccepted != null ? { onAccepted: entry.onAccepted } : {}),
          ...(entry.onAcceptedPreStreamFailure != null
            ? { onAcceptedPreStreamFailure: entry.onAcceptedPreStreamFailure }
            : {}),
          ...(entry.preTurnMessages != null && entry.preTurnMessages.length > 0
            ? { preTurnMessages: entry.preTurnMessages }
            : {}),
          ...(entry.onPreTurnRowsPersisted != null
            ? { onPreTurnRowsPersisted: entry.onPreTurnRowsPersisted }
            : {}),
          ...(entry.admissionStale != null ? { admissionStale: entry.admissionStale } : {}),
        }
      : undefined;

    return { message: joinedMessages, options, internal, enqueuedAtMs: entry.lastAddedAtMs };
  }

  /**
   * Clear all queued entries. Callers that need to notify canceled entries must
   * capture {@link getClearCallbacks} beforehand.
   */
  clear(): void {
    this.entries = [];
  }

  /**
   * Check if queue is empty (no pending entries).
   */
  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /**
   * Number of pending entries, including synthetic/internal ones. Archive admission uses
   * this to compare the queue against the delegated turns it is about to interrupt, so it
   * must count every entry — a "visible" count could hide user work behind synthetic
   * entries.
   */
  entryCount(): number {
    return this.entries.length;
  }
}

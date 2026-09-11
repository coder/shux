import type { MuxMessage } from "@/common/types/message";
import { Err, Ok, type Result } from "@/common/types/result";
import type {
  CompactionPendingAttachments,
  CompactionPendingBoundary,
  CompactionPendingBoundaryWrite,
  CompactionPendingObservation,
  CompactionPendingReceipt,
  CompactionPendingRetention,
  CompactionPendingState,
} from "./compactionPendingState";
import { log } from "./log";

export interface CompactionPreparation {
  readonly isCurrent: () => boolean;
}

export type CompactionPreparationSnapshot = Readonly<CompactionPendingAttachments>;
type BoundaryInput = CompactionPendingBoundaryWrite & { attachments: CompactionPendingAttachments };
type BoundaryRows = Pick<CompactionPendingBoundaryWrite, "summaryMessage" | "tailCopies">;
type Consumption = "ack" | "discard";

interface Facts {
  rolledBack: boolean;
  consumed?: Consumption;
  // Retiring a restored fallback must not discard unrelated acknowledged warmth.
  pendingRetired?: boolean;
}
interface OwnerFacts {
  facts: Facts;
  generation: string | undefined;
  summaryId?: string;
  // Read failure proves no exact file identity. This fence suppresses locally but never deletes.
  suppressedBoundary?: CompactionPendingBoundary;
  suppressedPublicationId?: string;
  attachments: CompactionPendingAttachments;
}
interface ReceiptOwner extends OwnerFacts {
  kind: "receipt";
  receipt: CompactionPendingReceipt;
}
interface PublicationOwner extends OwnerFacts {
  kind: "publication";
  sequence?: number;
  publicationId?: string;
  historyOnly: boolean;
  surviving?: ReceiptOwner;
}

type Owner = ReceiptOwner | PublicationOwner;

/** Local ownership facts; disk admission and all serialization belong to the pending store. */
export class CompactionPreparationLifecycle {
  private epoch = {};
  private consumptionEpoch = {};
  private current?: Owner;
  // Retain canonical facts over the physically rollbackable history horizon, not a fixed
  // predecessor depth. Request snapshots keep their facts independently after pruning.
  private readonly receipts = new Set<ReceiptOwner>();
  private readonly publications = new Set<PublicationOwner>();
  private readonly preparations = new WeakMap<
    CompactionPreparation,
    { used: boolean; done: boolean }
  >();
  private readonly snapshots = new WeakMap<CompactionPreparationSnapshot, Owner>();

  constructor(private readonly store: CompactionPendingState) {}

  begin(isCurrent: () => boolean): CompactionPreparation {
    const epoch = {};
    const state = { used: false, done: false };
    if (isCurrent()) this.epoch = epoch;
    const preparation = { isCurrent: () => this.epoch === epoch && !state.done && isCurrent() };
    this.preparations.set(preparation, state);
    return preparation;
  }

  private canonical(
    receipt: CompactionPendingReceipt,
    retention: CompactionPendingRetention,
    summaryId = retention.boundary.kind === "identified" ? retention.boundary.messageId : undefined,
    facts: Facts = { rolledBack: false }
  ): ReceiptOwner {
    const known = [...this.receipts].find((owner) =>
      this.store.isSameReceipt(owner.receipt, receipt)
    );
    if (known) return known;
    const owner: ReceiptOwner = {
      kind: "receipt",
      receipt,
      generation: retention.generation,
      summaryId,
      facts,
      attachments: structuredClone(receipt.attachments),
    };
    this.receipts.add(owner);
    return owner;
  }

  private prune(retention: CompactionPendingRetention) {
    const reachable = (id: string | undefined) => retention.reachableBoundaryIds?.has(id) ?? true;
    const retain = (owner: Owner) =>
      owner.generation === retention.generation &&
      (reachable(owner.summaryId) ||
        (owner.suppressedBoundary &&
          owner.suppressedBoundary.kind !== "unreadable-reset" &&
          reachable(
            owner.suppressedBoundary.kind === "identified"
              ? owner.suppressedBoundary.messageId
              : undefined
          )));
    for (const owner of this.receipts) if (!retain(owner)) this.receipts.delete(owner);
    for (const owner of this.publications) if (!retain(owner)) this.publications.delete(owner);
    if (this.current && !retain(this.current)) this.current = undefined;
  }

  private matchesSuppression(owner: Owner, retention: CompactionPendingRetention) {
    const suppressed = owner.suppressedBoundary;
    const boundary = retention.boundary;
    return (
      owner.generation === retention.generation &&
      suppressed?.kind === boundary.kind &&
      (boundary.kind === "none" ||
        (owner.suppressedPublicationId !== undefined &&
          owner.suppressedPublicationId === retention.boundaryPublicationId)) &&
      (suppressed?.kind === "none" ||
        (suppressed?.kind === "identified" &&
          boundary.kind === "identified" &&
          suppressed.messageId === boundary.messageId))
    );
  }

  private warmth() {
    return [...this.receipts]
      .filter((owner) => owner.facts.consumed === "ack" && !owner.facts.rolledBack)
      .map((owner) => owner.receipt);
  }

  private adopt(observation: CompactionPendingObservation) {
    this.prune(observation.retention);
    const receipt = observation.pending ?? observation.warmth;
    const boundary = observation.retention.boundary;
    this.current = receipt
      ? this.canonical(receipt, observation.retention)
      : [...this.publications].findLast(
          (owner) =>
            owner.historyOnly &&
            !owner.facts.rolledBack &&
            boundary.kind === "identified" &&
            owner.summaryId === boundary.messageId &&
            owner.publicationId !== undefined &&
            owner.publicationId === observation.retention.boundaryPublicationId
        );
  }

  private snapshot(owner: Owner, scope: "pending" | "carryover") {
    if (
      owner.facts.rolledBack ||
      owner.facts.consumed === "discard" ||
      (scope === "pending" && (owner.facts.consumed || owner.facts.pendingRetired)) ||
      (owner.facts.pendingRetired && owner.facts.consumed !== "ack")
    )
      return;
    const snapshot = structuredClone(owner.attachments);
    if (scope === "carryover") snapshot.diffs = [];
    this.snapshots.set(snapshot, owner);
    return snapshot;
  }

  async capture(
    scope: "pending" | "carryover"
  ): Promise<CompactionPreparationSnapshot | undefined> {
    const epoch = this.epoch;
    const isCurrent = () => this.epoch === epoch;
    try {
      // One held-lock observation qualifies both the exact disk owner and absent-file warmth.
      const observation = await this.store.observe(
        this.warmth(),
        isCurrent,
        this.receipts.size === 0 && this.publications.size === 0
      );
      if (!observation || !isCurrent()) return;
      this.adopt(observation);
      if (
        this.current &&
        !(
          this.current.facts.consumed !== "ack" &&
          [...this.receipts, ...this.publications].some((owner) =>
            this.matchesSuppression(owner, observation.retention)
          )
        )
      )
        return this.snapshot(this.current, scope);
    } catch (error) {
      log.warn("Pending attachment capture unavailable", error);
    }
  }

  async publish(
    preparation: CompactionPreparation,
    input: BoundaryInput
  ): Promise<Result<BoundaryRows>> {
    const state = this.preparations.get(preparation);
    if (!state || state.used || !preparation.isCurrent())
      return Err("Compaction preparation was replaced");
    state.used = true;
    // History assigns sequences. Private copies protect caller snapshots even on delayed returns.
    const summaryMessage = structuredClone(input.summaryMessage);
    const tailCopies = structuredClone(input.tailCopies);
    const publication = structuredClone(input.publication);
    const attachments = structuredClone(input.attachments);
    const owner: PublicationOwner = {
      kind: "publication",
      historyOnly: true,
      generation: publication.generation,
      summaryId: summaryMessage.id,
      facts: { rolledBack: false },
      attachments: { diffs: [], loadedSkills: [], readFiles: [] },
    };
    let committed = false;
    try {
      const result = await this.store.publishBoundary({
        summaryMessage,
        tailCopies,
        publication,
        attachments,
        shouldPersist: input.shouldPersist,
        updateExisting: input.updateExisting,
        isCurrent: preparation.isCurrent,
        onCommitted: (receipt, previous, retention) => {
          committed = true;
          owner.historyOnly = !receipt;
          // Earlier queued captures have adopted their observations by this held-lock commit.
          // Keep their exact survivor if enrichment could not read it, before pruning/resetting
          // current; choosing before queue entry can miss a receipt still being observed.
          const current = this.current;
          const surviving = current?.kind === "receipt" ? current : current?.surviving;
          owner.surviving =
            surviving &&
            !surviving.facts.consumed &&
            !surviving.facts.pendingRetired &&
            !surviving.facts.rolledBack
              ? surviving
              : undefined;
          // Prune the pre-commit registry against its starting horizon before adding this
          // publication; reusing an ID cannot retain an already rolled-back occurrence.
          this.prune(retention);
          owner.sequence = summaryMessage.metadata?.historySequence;
          owner.publicationId = summaryMessage.metadata?.compactionPublicationId;
          if (previous) owner.surviving = this.canonical(previous, retention);
          this.publications.add(owner);
          this.current = receipt
            ? this.canonical(receipt, retention, summaryMessage.id, owner.facts)
            : owner;
          // Successful writes own their fallback through the store; only history-only tokens
          // retain an exact physical survivor for late request consumption.
          if (receipt) owner.surviving = undefined;
        },
      });
      if (committed) return Ok({ summaryMessage, tailCopies });
      return result.success ? Err("Compaction boundary did not commit") : result;
    } finally {
      state.done = true;
    }
  }

  async consume(snapshot: CompactionPreparationSnapshot, disposition: Consumption): Promise<void> {
    const owner = this.snapshots.get(snapshot);
    if (!owner) return;
    this.consumptionEpoch = {};
    const file = owner.kind === "receipt" ? owner : owner.surviving;
    if (disposition === "discard" || !owner.facts.consumed) owner.facts.consumed = disposition;
    if (file && file !== owner) {
      // The empty token did not deliver its survivor. Retire pending authority without
      // granting acknowledgment; independently earned warmth keeps its existing ack fact.
      file.facts.pendingRetired = true;
    }
    if (file)
      try {
        await this.store.consume(file.receipt);
      } catch (error) {
        log.warn("Pending attachment consumption unavailable", error);
      }
  }

  async rollbackHeartbeat(summaryMessage: MuxMessage, isCurrent: () => boolean) {
    const epoch = {};
    const consumptionEpoch = this.consumptionEpoch;
    const target = [...this.publications].findLast(
      (owner) =>
        owner.summaryId === summaryMessage.id &&
        owner.sequence === summaryMessage.metadata?.historySequence &&
        owner.publicationId === summaryMessage.metadata?.compactionPublicationId
    );
    let removedOwner: ReceiptOwner | undefined;
    let removedWasRolledBack = false;
    const alreadyRolledBack = target?.facts.rolledBack;
    if (isCurrent()) this.epoch = epoch;
    const retired = (owner: Owner | undefined) =>
      !!owner && (!!owner.facts.consumed || !!owner.facts.pendingRetired || owner.facts.rolledBack);
    const knownReceipt = (receipt: CompactionPendingReceipt | undefined) =>
      receipt &&
      [...this.receipts].find((owner) => this.store.isSameReceipt(owner.receipt, receipt));
    return this.store.rollbackHeartbeat({
      summaryMessage,
      // Consumption after the retirement checkpoint requires a new checkpoint, not an
      // unguarded history commit while its newly forbidden fallback remains on disk.
      isCurrent: () =>
        this.epoch === epoch && this.consumptionEpoch === consumptionEpoch && isCurrent(),
      warmth: this.warmth(),
      canRestorePrevious: () => true,
      isRetiredBeforeRollback: [...this.receipts, ...this.publications].some(retired)
        ? (receipt, restoredContext, retention, removed) =>
            retired(knownReceipt(receipt)) ||
            (restoredContext &&
              ((target?.generation === retention.generation && retired(target)) ||
                retired(knownReceipt(removed))))
        : undefined,
      isRetired: (receipt, restoredContext, retention, removed) => {
        if (removed && !removedOwner) {
          // Boundary IDs can be reused: loaded facts require the exact removed write identity.
          removedOwner = [...this.receipts].find((owner) =>
            this.store.isSameReceipt(owner.receipt, removed)
          );
          if (removedOwner) {
            removedWasRolledBack =
              removedOwner.facts === target?.facts
                ? !!alreadyRolledBack
                : removedOwner.facts.rolledBack;
            removedOwner.facts.rolledBack = true;
          }
        }
        // Canonicalize before attempting cleanup so unlink failure cannot mint fresh facts.
        const known = this.canonical(receipt, retention);
        if (
          restoredContext &&
          ((target?.generation === retention.generation &&
            (target?.facts.consumed || alreadyRolledBack)) ||
            removedOwner?.facts.consumed ||
            removedOwner?.facts.pendingRetired ||
            removedWasRolledBack)
        ) {
          known.facts.pendingRetired = true;
          return true;
        }
        return (
          known.facts.consumed !== undefined ||
          known.facts.pendingRetired === true ||
          known.facts.rolledBack
        );
      },
      onCommitted: () => {
        if (target) target.facts.rolledBack = true;
        if (this.current?.summaryId === summaryMessage.id) this.current = undefined;
      },
      onRestored: () => undefined,
      onReconciled: (observation, removedCurrentBoundary) => {
        if (
          !observation.readable &&
          removedCurrentBoundary &&
          target?.facts.consumed &&
          target.generation === observation.retention.generation &&
          observation.retention.boundary.kind !== "unreadable-reset"
        ) {
          // Keep one unresolved fence per reachable boundary, even through deeper heartbeats.
          // Restart cannot recover this intent while reads remain unavailable; it is not a disk receipt.
          for (const owner of [...this.receipts, ...this.publications])
            if (this.matchesSuppression(owner, observation.retention))
              owner.suppressedBoundary = undefined;
          target.suppressedBoundary = observation.retention.boundary;
          target.suppressedPublicationId = observation.retention.boundaryPublicationId;
        }
        if (this.epoch === epoch) this.adopt(observation);
      },
    });
  }

  async discardAfterBoundary(): Promise<void> {
    this.epoch = {};
    for (const owner of [...this.receipts, ...this.publications]) owner.facts.consumed = "discard";
    this.receipts.clear();
    this.publications.clear();
    this.current = undefined;
    await this.store.discardAfterBoundary();
  }
}

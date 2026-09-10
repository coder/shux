import { basename, dirname, join } from "path";
import { randomUUID } from "crypto";
import {
  mkdir,
  readFile,
  readdir,
  access,
  rename,
  link,
  unlink,
  copyFile,
  writeFile,
  stat,
} from "fs/promises";
import { constants } from "fs";
import writeFileAtomic from "write-file-atomic";
import {
  coerceAgentStatus,
  coerceExtensionMetadata,
  coerceStatusUrl,
  toWorkspaceActivitySnapshot,
  type ExtensionAgentStatus,
  type ExtensionMetadata,
  type ExtensionMetadataFile,
} from "@/node/utils/extensionMetadata";
import { getXumExtensionMetadataPath } from "@/common/constants/paths";
import type { WorkspaceActivitySnapshot } from "@/common/types/workspace";
import type { GoalSnapshot } from "@/common/types/goal";
import { log } from "@/node/services/log";

/**
 * Identity of one quarantine-sidecar generation: with multiple processes
 * recovering the fixed `.corrupt` path, consumption must be scoped to
 * exactly the file generation a recovery read (see consumeQuarantineSidecar).
 */
interface QuarantineSidecarToken {
  ino: bigint;
  mtimeNs: bigint;
  size: bigint;
}

/**
 * Marker code for "file written by a newer schema version" load failures.
 * Shaped like an errno code so the corruption/quarantine classification
 * (isDeterministicCorruption: errors WITH a code are not quarantinable)
 * treats downgrade encounters as retryable, never as resettable corruption.
 */
const UNSUPPORTED_METADATA_VERSION_CODE = "XUM_UNSUPPORTED_METADATA_VERSION";

/**
 * Stateless service for managing workspace metadata used by VS Code extension integration.
 *
 * This service tracks:
 * - recency: Unix timestamp (ms) of last user interaction
 * - streaming: Boolean indicating if workspace has an active stream
 * - streamingGeneration: Monotonic stream counter used to detect newer background turns
 * - lastModel: Last model used in this workspace
 * - lastThinkingLevel: Last thinking/reasoning level used in this workspace
 * - displayStatus: Current non-todo status payload for transient system-driven progress
 * - todoStatus: Status derived from the current todo list (preferred sidebar progress surface)
 * - hasTodos: Whether the workspace still had todos when streaming last stopped
 *
 * File location: ~/.xum/extensionMetadata.json
 *
 * Design:
 * - Stateless: reads from disk on every operation, no in-memory cache
 * - Atomic writes: uses write-file-atomic to prevent corruption
 * - Read-heavy workload: extension reads, main app writes on user interactions
 */

export interface ExtensionMetadataStreamingUpdate {
  model?: string;
  thinkingLevel?: ExtensionMetadata["lastThinkingLevel"];
  todoStatus?: ExtensionAgentStatus | null;
  hasTodos?: boolean;
  generation?: number;
}

export class ExtensionMetadataService {
  private readonly filePath: string;

  /**
   * Name infix for per-consume claim files
   * (`<main><infix><ino>-<mtimeNs>-<size>-<pid>-<uuid>`). Unique names keep
   * concurrent recoveries from replacing or clearing each other's live
   * claims, and the embedded identity token makes every crash point
   * replay-safe: the consumer only calls consume AFTER merging the
   * generation identified by the token, so a stranded claim whose file
   * identity MATCHES its embedded token is proven represented at the main
   * path (rename preserves ino/mtime/size) and is deleted by discovery —
   * replaying it would re-fill fields another backend explicitly cleared
   * to null (the null-fill merge is not idempotent across clears). A
   * mismatched or unparseable claim holds a foreign generation nobody
   * merged and is replayed.
   */
  private static readonly CLAIM_INFIX = ".corrupt-claim-";
  /**
   * Prefix (after the main file name) for uniquely named in-flight
   * moved-aside mains AND the scan claims that consume them when stranded.
   * The trailing dash keeps the bounded fixed-name `.recreated` leftover
   * (finalized, proven-superseded bytes) out of the stranded-file scan.
   */
  private static readonly RECREATED_INFIX = ".recreated-";

  /** Parse the identity token embedded in a claim file name; null when the
   * name does not carry one (fail toward replay — the pre-token behavior). */
  private static parseClaimToken(claimName: string): QuarantineSidecarToken | null {
    const match = /\.corrupt-claim-(\d+)-(\d+)-(\d+)-/.exec(claimName);
    if (match == null) {
      return null;
    }
    return { ino: BigInt(match[1]), mtimeNs: BigInt(match[2]), size: BigInt(match[3]) };
  }

  private static tokensMatch(a: QuarantineSidecarToken, b: QuarantineSidecarToken): boolean {
    return a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.size === b.size;
  }
  private mutationQueue: Promise<void> = Promise.resolve();
  /**
   * Per-process write tombstones for removed workspaces. Workspace removal
   * cannot drain every in-flight metadata producer (e.g. a stream-abort's
   * fire-and-forget stop-status handler that is still reading todos when the
   * entry is deleted), so late writers would silently recreate entries for
   * removed workspaces and re-leak stale keys until the next process-start
   * prune. Ids are added synchronously in deleteWorkspace/prune, so combined
   * with the FIFO mutation queue there is no gap: a writer enqueued before
   * the delete lands first and its entry is deleted; one enqueued after
   * no-ops on this set. Workspace ids are never reused (generateStableId),
   * so a tombstone never blocks a legitimate new workspace; recreations of
   * legacy fixed-id workspaces happen in a different (downgraded) process.
   */
  // Map value is the tombstone's GENERATION (monotonic per process):
  // clearing paths that await between reading registration evidence and
  // deleting must only clear the exact tombstone the evidence preceded — a
  // same-process removal republishing the tombstone mid-probe must survive
  // the stale positive (see recheckTombstonedRegistration).
  private readonly deletedWorkspaceIds = new Map<string, number>();
  private tombstoneGeneration = 0;

  private publishTombstone(workspaceId: string): number {
    const generation = ++this.tombstoneGeneration;
    this.deletedWorkspaceIds.set(workspaceId, generation);
    return generation;
  }

  /**
   * In-memory suppression for a CROSS-PROCESS removal proven by the
   * activity list's config-corroborated guards. The foreign backend's
   * removal cannot publish a tombstone in this process, so without one a
   * late local producer (workflow-run or bash-monitor completion) would
   * repopulate the just-evicted caches and emitWorkspaceActivity — whose
   * isWorkspaceDeleted check only knows local removals — would broadcast
   * the removed incarnation's activity right after an authoritative list
   * dropped it. Reuses the standard tombstone lifecycle, so suppression
   * ends exactly on fresh registration evidence: writes re-probe via
   * recheckTombstonedRegistration and later lists clear it via
   * clearTombstonesForRegisteredIds when the id is genuinely re-registered.
   */
  suppressForeignRemoval(workspaceId: string): void {
    this.publishTombstone(workspaceId);
  }

  /**
   * Single exit point for clearing a tombstone (re-registration revival).
   * Notifies the owner so process-local activity caches bootstrapped for the
   * REMOVED incarnation (active workflow-run ids, bash-monitor seen set) are
   * evicted — workspace removal never evicts them, and the revived
   * incarnation's session state on disk may differ, so a stale cache would
   * otherwise show ghost activity counts indefinitely.
   */
  private liftTombstone(workspaceId: string): void {
    this.deletedWorkspaceIds.delete(workspaceId);
    try {
      this.tombstoneClearedListener?.(workspaceId);
    } catch {
      // Listener failures must not break the clearing path.
    }
  }

  private tombstoneClearedListener: ((workspaceId: string) => void) | null = null;

  setTombstoneClearedListener(listener: (workspaceId: string) => void): void {
    this.tombstoneClearedListener = listener;
  }

  /**
   * Optional registration probe for writes hitting a tombstoned id (see
   * recheckTombstonedRegistration). Wired by the owner that can read the
   * shared config (coreServices); absent in bare constructions, where
   * tombstones stay strictly write-suppressing. Must answer with CURRENT
   * registration evidence or throw — a stale positive would resurrect a
   * removed workspace's entry.
   */
  private registrationProbe: ((workspaceId: string) => Promise<boolean>) | null = null;

  setRegistrationProbe(probe: (workspaceId: string) => Promise<boolean>): void {
    this.registrationProbe = probe;
  }

  /**
   * Serialize all mutating operations on the shared metadata file.
   * Prevents cross-workspace read-modify-write races since all workspaces
   * share a single extensionMetadata.json file.
   */
  private async withSerializedMutation<T>(fn: () => Promise<T>): Promise<T> {
    let result!: T;
    const run = async () => {
      result = await fn();
    };
    const next = this.mutationQueue.catch(() => undefined).then(run);
    this.mutationQueue = next;
    await next;
    return result;
  }

  private getOrCreateWorkspaceEntry(
    data: ExtensionMetadataFile,
    workspaceId: string,
    recency: number
  ): ExtensionMetadata {
    const normalized = coerceExtensionMetadata(data.workspaces[workspaceId]);
    if (normalized) {
      data.workspaces[workspaceId] = normalized;
      return normalized;
    }

    // Self-heal malformed persisted workspace entries instead of crashing future metadata writes.
    const created: ExtensionMetadata = {
      recency,
      streaming: false,
      lastModel: null,
      lastThinkingLevel: null,
      agentStatus: null,
      displayStatus: null,
      lastStatusUrl: null,
      goal: null,
    };
    data.workspaces[workspaceId] = created;
    return created;
  }

  private toSnapshot(entry: unknown): WorkspaceActivitySnapshot | null {
    const normalized = coerceExtensionMetadata(entry);
    return normalized ? toWorkspaceActivitySnapshot(normalized) : null;
  }

  /**
   * Late write for a removed workspace: compute the snapshot for the caller
   * but never persist it, so the deleted entry cannot be resurrected.
   */
  private buildTransientSnapshot(
    workspaceId: string,
    recency: number,
    mutate: (workspace: ExtensionMetadata) => void
  ): WorkspaceActivitySnapshot {
    const transient = this.getOrCreateWorkspaceEntry(
      { version: 1, workspaces: {} },
      workspaceId,
      recency
    );
    mutate(transient);
    return toWorkspaceActivitySnapshot(transient);
  }

  /**
   * A write arrived for a tombstoned id: decide whether the tombstone is
   * stale. Tombstones are process-local removal knowledge and the shared
   * config is the authority — a downgraded concurrent backend can
   * legitimately re-register a deterministic legacy id this process pruned,
   * and the renderer only calls the activity bootstrap (which also clears
   * stale tombstones) when its subscription needs repair, so a healthy
   * long-lived process would otherwise suppress the revived workspace's
   * writes and broadcasts indefinitely. The probe reads registration
   * evidence NOW, strictly after the tombstone was published, so clearing on
   * a positive answer is sound (same ordering contract as
   * clearTombstonesForRegisteredIds). A negative, missing, or failing probe
   * keeps the tombstone: suppression self-heals on a later successful probe
   * or bootstrap, while a wrongly persisted write would resurrect a removed
   * workspace's entry on disk.
   */
  private async recheckTombstonedRegistration(workspaceId: string): Promise<boolean> {
    if (this.registrationProbe == null) {
      return false;
    }
    // Capture the tombstone's generation before the probe: a same-process
    // removal can republish the tombstone while the probe awaits, and a
    // probe that read config just before that deregistration returns a
    // stale positive that must not clear the NEWER tombstone (the removal's
    // queued deletion may run before the caller's queued write, which would
    // then recreate the removed entry).
    const generationBefore = this.deletedWorkspaceIds.get(workspaceId);
    let probeRegistered = false;
    try {
      probeRegistered = await this.registrationProbe(workspaceId);
    } catch {
      probeRegistered = false;
    }
    const generationAfter = this.deletedWorkspaceIds.get(workspaceId);
    if (generationAfter === undefined) {
      // Another path (activity bootstrap, reconcile) lifted the tombstone
      // while the probe was in flight, on registration evidence that
      // postdates the tombstone. The write must PERSIST regardless of THIS
      // probe's outcome (negative and failing probes included): once the
      // tombstone is gone, broadcasts are un-suppressed and every later
      // write persists normally — suppressing only this in-flight write
      // would hand the caller an unpersisted transient snapshot that
      // WorkspaceService still broadcasts, leaving renderer recency/goal/
      // status ahead of disk until restart. A genuinely newer same-process
      // removal republishes a tombstone, which the caller's in-queue
      // re-check still honors.
      return true;
    }
    if (!probeRegistered) {
      // Negative or failing probe with the tombstone still standing: keep
      // suppressing. Emits stay suppressed by the same tombstone, so no
      // transient state can reach the renderer.
      return false;
    }
    if (generationAfter !== generationBefore) {
      // Republished mid-probe: a newer same-process removal wins.
      return false;
    }
    this.liftTombstone(workspaceId);
    return true;
  }

  private async mutateWorkspaceSnapshot(
    workspaceId: string,
    recency: number,
    mutate: (workspace: ExtensionMetadata) => void
  ): Promise<WorkspaceActivitySnapshot> {
    if (
      this.deletedWorkspaceIds.has(workspaceId) &&
      !(await this.recheckTombstonedRegistration(workspaceId))
    ) {
      return this.buildTransientSnapshot(workspaceId, recency, mutate);
    }
    // Write-produced snapshots are broadcast by WorkspaceService: reconcile a
    // crash-stranded sidecar BEFORE mutating (outside the queue — the resume
    // path serializes itself). Without this, a valid partial main next to a
    // healthy full sidecar is saved and EMITTED, clearing goal/status in the
    // renderer until some read triggers recovery. Failure propagates:
    // failing one write beats persisting and broadcasting the partial view
    // (same tradeoff as the unprobeable-sidecar contract in
    // probeQuarantineSidecar).
    await this.reconcileLeftoverSidecarIfPresent();
    return this.withSerializedMutation(async () => {
      // Re-check inside the queue: pruneMissingWorkspaces publishes its
      // tombstones only while its queued mutation runs, so a writer that
      // passed the pre-queue check and enqueued behind the prune must not
      // recreate an entry the prune just reclaimed.
      if (
        this.deletedWorkspaceIds.has(workspaceId) &&
        !(await this.recheckTombstonedRegistration(workspaceId))
      ) {
        return this.buildTransientSnapshot(workspaceId, recency, mutate);
      }
      const data = await this.load();
      const workspace = this.getOrCreateWorkspaceEntry(data, workspaceId, recency);
      mutate(workspace);
      // Every persisted mutation advances the write generation: `recency`
      // is a user-interaction timestamp (status/goal/streaming writers
      // deliberately preserve it), so recovery merges cannot order metadata
      // copies by recency alone — see recoverStrandedRecreatedLeftover.
      workspace.writeGeneration = ExtensionMetadataService.nextWriteGeneration(workspace);
      // (The stamp is epoch-ms so the stranded-leftover merge can order a
      // generation-carrying entry against a generation-LESS copy via the
      // stranded file's mtime — see nextWriteGeneration.)
      await this.save(data);
      return toWorkspaceActivitySnapshot(workspace);
    });
  }

  /**
   * Next per-entry write stamp: wall-clock epoch milliseconds, floored to
   * strictly exceed the previous stamp (same-millisecond mutations and
   * backward clock steps stay monotonic per entry). A plain counter would
   * order two generation-carrying copies just as well, but the stranded-
   * leftover merge must also order a generation-carrying entry against a
   * generation-LESS copy (written by a pre-generation or downgraded build):
   * with a wall-clock stamp it can compare the entry's last write time
   * against the stranded FILE's mtime — same host, same clock — and prove
   * the generation-carrying write postdates every byte of the stranded
   * snapshot. See recoverStrandedRecreatedLeftover's ordering comment.
   */
  private static nextWriteGeneration(entry: ExtensionMetadata): number {
    const previous =
      typeof entry.writeGeneration === "number" && Number.isFinite(entry.writeGeneration)
        ? entry.writeGeneration
        : 0;
    return Math.max(Date.now(), previous + 1);
  }

  constructor(filePath?: string) {
    this.filePath = filePath ?? getXumExtensionMetadataPath();
  }

  /**
   * Initialize the service by ensuring directory exists and clearing stale
   * streaming flags. Call once on app startup.
   *
   * Per AGENTS.md ("Startup-time initialization must never crash the app")
   * disk failures here are logged and swallowed; save() itself throws so
   * strict callers (e.g. AgentStatusService) can react.
   */
  async initialize(): Promise<void> {
    // Ensure directory exists
    const dir = dirname(this.filePath);
    try {
      await access(dir, constants.F_OK);
    } catch {
      try {
        await mkdir(dir, { recursive: true });
      } catch (error) {
        log.error("ExtensionMetadataService: failed to create metadata dir at startup", { error });
        return;
      }
    }

    // Clear stale streaming flags (from crashes)
    try {
      await this.clearStaleStreaming();
    } catch (error) {
      log.error("ExtensionMetadataService: failed to clear stale streaming at startup", { error });
    }
  }

  /**
   * Consume the quarantine sidecar once every surviving entry is represented
   * at the main path. ENOENT means a concurrent recovery already consumed
   * it; any other failure must propagate (retryable) — reporting success
   * with the sidecar still present would let a later process reconcile the
   * stale sidecar again after the main file has moved on, repeatedly
   * re-merging entries that pruning or removal already reclaimed.
   *
   * Claim-then-verify: with multiple processes recovering the fixed sidecar
   * path, another backend can consume the generation this caller read and
   * quarantine a NEW snapshot at the same path — a stat-compare followed by
   * a path unlink would leave a window in which that unreconciled newer
   * generation is destroyed. The rename below atomically takes exactly one
   * generation off the shared path first; identity is then verified on the
   * claimed file. The claim name is UNIQUE per consume (pid + uuid): a fixed
   * name would let a concurrent consumer's claim land on (POSIX rename
   * replaces) or clear (its own leftover pass) another recovery's live
   * claim, re-opening the destroyed-generation window this claim exists to
   * close — and a fresh unique destination also never collides on Windows,
   * where rename onto an existing file is not reliably a replace. A claimed
   * FOREIGN generation (identity mismatch) is reconciled into the main file
   * rather than deleted. Invariant: a claim file whose identity matched its
   * consumer's token holds already-reconciled bytes (callers merge/restore
   * before consuming), so only a crash between a MISMATCH claim and its
   * reconcile strands unconsumed data at a claim name —
   * reconcileLeftoverSidecarIfPresent discovers stranded claims by prefix
   * and resumes the merge on the next authoritative read.
   */
  private async consumeQuarantineSidecar(
    quarantinePath: string,
    token: QuarantineSidecarToken | null
  ): Promise<void> {
    if (token == null) {
      // The caller never observed a sidecar identity (it read the file only
      // after a successful probe, so this is unreachable in practice) —
      // fail closed by leaving the file rather than unlinking blind.
      return;
    }
    // The claim name embeds the token of the generation the caller just
    // merged (see CLAIM_INFIX): a crash at ANY later point leaves a claim
    // discovery can classify by identity — matching bytes were merged
    // (delete), anything else is a foreign generation (replay).
    const claimPath = `${this.filePath}${ExtensionMetadataService.CLAIM_INFIX}${token.ino}-${token.mtimeNs}-${token.size}-${process.pid}-${randomUUID()}`;
    try {
      await rename(quarantinePath, claimPath);
    } catch (renameError) {
      if (ExtensionMetadataService.isErrnoCode(renameError, "ENOENT")) {
        return; // Already consumed by a concurrent recovery.
      }
      throw renameError;
    }
    // Identity check on the CLAIMED file (nothing else references the
    // unique name except the stranded-claim discovery, which reconciles
    // rather than destroys): non-ENOENT probe failures propagate
    // (retryable) with the claim left for that discovery — reporting
    // success would let the caller proceed, e.g. the one-time prune deletes
    // stale entries, a later read re-merges them from a retained sidecar,
    // and with the prune latch already set the resurrected entries stay
    // indefinitely.
    const current = await ExtensionMetadataService.statQuarantineToken(claimPath);
    if (current == null) {
      return; // Claim vanished (concurrent discovery consumed it).
    }
    if (!ExtensionMetadataService.tokensMatch(current, token)) {
      // The claim took a NEWER generation another process installed after
      // consuming ours: merge it into the main file instead of destroying
      // it. The reconcile consumes the claim itself on success; a corrupt
      // foreign generation stays at the claim name until the discovery
      // pass's reconcile classifies it (bounded: one file per crashed or
      // failed recovery, consumed on the next successful pass).
      log.debug("Claimed a replaced quarantine sidecar generation; reconciling it", {
        quarantinePath,
      });
      await this.reconcileRecreatedMainWithSidecar(claimPath);
      return;
    }
    // Matched: the claim's bytes are proven represented at the main path,
    // and its name says so (the embedded token matches the file), so a
    // crash before this unlink strands a file discovery deletes rather
    // than replays.
    try {
      await unlink(claimPath);
    } catch (unlinkError) {
      if (!ExtensionMetadataService.isErrnoCode(unlinkError, "ENOENT")) {
        throw unlinkError;
      }
    }
  }

  /**
   * Identity of one sidecar generation (inode + mtime + size), captured when
   * a recovery reads the sidecar and required by consumeQuarantineSidecar so
   * consumption is scoped to exactly the generation that was reconciled.
   * Resolves null on ENOENT; other stat failures propagate (retryable).
   */
  private static async statQuarantineToken(
    quarantinePath: string
  ): Promise<QuarantineSidecarToken | null> {
    try {
      const stats = await stat(quarantinePath, { bigint: true });
      return { ino: stats.ino, mtimeNs: stats.mtimeNs, size: stats.size };
    } catch (statError) {
      if (ExtensionMetadataService.isErrnoCode(statError, "ENOENT")) {
        return null;
      }
      throw statError;
    }
  }

  /**
   * Shared leftover-sidecar recovery for the read paths (authoritative list
   * and per-workspace snapshot reads): probe the fixed sidecar path and run
   * the resumable recovery when one exists. Returns true when a sidecar was
   * found (callers should re-read). Failures propagate; each caller decides
   * whether its read contract is strict (list) or best-effort (live
   * emissions).
   */
  private async reconcileLeftoverSidecarIfPresent(): Promise<boolean> {
    let reconciledSidecar = false;
    if (await this.probeQuarantineSidecar()) {
      await this.resumeQuarantineRecovery();
      reconciledSidecar = true;
    }
    // A crash between consumeQuarantineSidecar's mismatch claim and its
    // reconcile strands an unreconciled foreign generation at a unique
    // claim name, which the sidecar probe above cannot see. Discover
    // stranded claims by prefix (one readdir next to the full-file read the
    // caller already does); an unreadable directory propagates so the read
    // stays retryable rather than vouching for a possibly partial main.
    // Runs even when the fixed sidecar was just processed: a
    // deterministically corrupt sidecar is intentionally RETAINED by its
    // reconcile, and returning early on it would starve stranded-claim
    // recovery indefinitely (recency/goal/status hidden in the claim).
    const dirNames = await readdir(dirname(this.filePath));
    const claimNames = dirNames.filter((name) =>
      name.startsWith(`${basename(this.filePath)}${ExtensionMetadataService.CLAIM_INFIX}`)
    );
    // Crash-stranded in-flight moved-aside mains (see
    // moveMainAsideAsRecreatedLeftover): their unique names make them
    // invisible to every fixed-path probe, so without this scan an owner
    // crash before revalidation would orphan a raced healthy main's only
    // copy forever while the next recovery restores the OLDER sidecar. A
    // live owner's file listed here is gone again by the time the queue
    // slot below runs its claim rename (ENOENT — see
    // recoverStrandedRecreatedLeftover for the steal semantics).
    const strandedRecreatedNames = dirNames.filter((name) =>
      name.startsWith(`${basename(this.filePath)}${ExtensionMetadataService.RECREATED_INFIX}`)
    );
    if (claimNames.length === 0 && strandedRecreatedNames.length === 0) {
      return reconciledSidecar;
    }
    await this.withSerializedMutation(async () => {
      for (const strandedName of strandedRecreatedNames) {
        await this.recoverStrandedRecreatedLeftover(join(dirname(this.filePath), strandedName));
      }
      for (const claimName of claimNames) {
        const claimPath = join(dirname(this.filePath), claimName);
        // Re-probe inside the queue: a concurrent recovery's discovery (or
        // the claim's own consume) may have taken the file while this
        // caller waited. Only a verified ENOENT skips — an unprobeable
        // claim propagates, same contract as the sidecar probe: reporting
        // success would let a strict read accept and emit a possibly
        // partial main while recoverable fields sit in the claim.
        const current = await ExtensionMetadataService.statQuarantineToken(claimPath);
        if (current == null) {
          continue;
        }
        // Identity classification (see CLAIM_INFIX): a claim whose file
        // matches its embedded token holds bytes its consumer had already
        // merged before claiming — delete, never replay (a re-merge would
        // re-fill fields another backend explicitly cleared to null
        // since). Mismatched or token-less claims hold a foreign
        // generation nobody merged: replay it.
        const expected = ExtensionMetadataService.parseClaimToken(claimName);
        if (expected != null && ExtensionMetadataService.tokensMatch(current, expected)) {
          try {
            await unlink(claimPath);
          } catch (unlinkError) {
            if (!ExtensionMetadataService.isErrnoCode(unlinkError, "ENOENT")) {
              throw unlinkError;
            }
          }
          continue;
        }
        await this.reconcileRecreatedMainWithSidecar(claimPath);
      }
    });
    return true;
  }

  /**
   * Seam for load()'s missing-main handling (and deterministic TOCTOU tests):
   * reports whether the quarantine sidecar currently exists.
   */
  private probeQuarantineSidecar(): Promise<boolean> {
    return access(`${this.filePath}.corrupt`).then(
      () => true,
      (error: unknown) => {
        if (ExtensionMetadataService.isErrnoCode(error, "ENOENT")) {
          return false;
        }
        // EACCES/EIO/...: the sidecar's existence is unknowable, and only a
        // verified absence may let an ENOENT main read resolve as a healthy
        // empty file — recoverable metadata may sit in the unprobeable
        // sidecar. Propagate so the read stays a retryable failure for
        // strict readers and fails the mutation for lenient writers (same
        // tradeoff as the in-window recovery: failing one operation beats
        // clobbering the sidecar's data with a partial save).
        throw error;
      }
    );
  }

  private async load(options?: { throwOnError?: boolean }): Promise<ExtensionMetadataFile> {
    // Bounded because the ENOENT branch below re-reads: each retry only
    // happens after a fresh ENOENT, so the loop converges.
    const MAX_READ_ATTEMPTS = 3;
    let lastError: unknown;
    // True when the final failed attempt hit the mid-quarantine window
    // (main missing, sidecar present). That failure must never resolve as
    // an empty file, even leniently — see the sidecar branch below.
    let blockedByQuarantineWindow = false;
    for (let attempt = 1; attempt <= MAX_READ_ATTEMPTS; attempt++) {
      try {
        const content = await readFile(this.filePath, "utf-8");
        const parsed = JSON.parse(content) as ExtensionMetadataFile;

        // A syntactically valid file whose version is not 1 was written by a
        // build with a newer schema — NOT corruption. It must never be
        // quarantined/reset (upgrading back would find the canonical file
        // empty and lose all activity state) and never self-healed to {} by
        // a lenient writer (saving version-1 bytes over it is the same data
        // loss). Both read modes propagate; see the catch below.
        if (ExtensionMetadataService.isUnsupportedVersion(parsed)) {
          throw ExtensionMetadataService.unsupportedVersionError();
        }

        // Validate structure, including the workspaces container: a parseable
        // file with e.g. an array or primitive `workspaces` would otherwise
        // enumerate as zero entries and masquerade as an authoritative empty
        // state in strict reads.
        if (!ExtensionMetadataService.isValidMetadataFileShape(parsed)) {
          throw new Error("Invalid extension metadata file structure");
        }

        return parsed;
      } catch (error) {
        // Only a genuinely missing file is a healthy empty state. Other read
        // failures (EACCES/ENOTDIR/EIO, parse or structure errors) must not
        // masquerade as one: throwOnError lets read paths distinguish them
        // from an authoritative empty state, while the default self-heals so
        // writers can always make progress.
        lastError = error;
        blockedByQuarantineWindow = false;
        if (!ExtensionMetadataService.isErrnoCode(error, "ENOENT")) {
          break;
        }
        // A missing main file WITH the quarantine sidecar present is not a
        // healthy empty state: it is the (rare) window where quarantine
        // moved the file aside and has not yet written the empty
        // replacement — the moved bytes may even be a concurrent writer's
        // healthy repair awaiting restore. Resolving this window as an
        // empty file is never safe, lenient or strict: a lenient WRITER
        // would mutate {} and save, recreating the main path — and the
        // pending restore (deliberately no-overwrite) would then strand
        // every other workspace's metadata in the sidecar for good.
        if (await this.probeQuarantineSidecar()) {
          blockedByQuarantineWindow = true;
          if (options?.throwOnError) {
            // Strict readers surface a retryable failure (ENOENT carries an
            // errno code, so callers classify it as transient) and
            // getAllSnapshots resumes the recovery through the mutation
            // queue — never an authoritative {} that a subsequent restore
            // cannot retract.
            break;
          }
          // Lenient callers complete the recovery INLINE and re-read.
          // Inline (unqueued) is deliberate: most lenient loads run inside
          // withSerializedMutation, whose promise-chain queue is not
          // reentrant — enqueueing resumeQuarantineRecovery here would
          // deadlock. Racing a concurrent recovery is safe because every
          // step is no-overwrite (link/COPYFILE_EXCL) and idempotent. A
          // recovery failure propagates: failing one mutation in this
          // pathological window beats destroying the sidecar's data.
          await this.completeQuarantineRecovery(`${this.filePath}.corrupt`);
          continue;
        }
        // No sidecar either. With multiple instances the failed read may
        // have raced another process's COMPLETED recovery — main restored
        // (or reset to empty) and the sidecar already consumed — so the
        // absent sidecar proves nothing about the earlier ENOENT. Re-read
        // the main path instead of trusting the stale failure; only a file
        // still missing on the final attempt is a healthy empty state.
        if (attempt === MAX_READ_ATTEMPTS) {
          return { version: 1, workspaces: {} };
        }
      }
    }
    if (
      options?.throwOnError ||
      blockedByQuarantineWindow ||
      ExtensionMetadataService.isErrnoCode(lastError, UNSUPPORTED_METADATA_VERSION_CODE)
    ) {
      throw lastError;
    }
    log.error("Failed to load metadata:", lastError);
    return { version: 1, workspaces: {} };
  }

  private async save(data: ExtensionMetadataFile): Promise<void> {
    // Throws on failure so callers that need to know whether the write
    // actually happened (e.g. AgentStatusService dedup) can react.
    // emitWorkspaceActivityUpdate (the historical wrapper used elsewhere)
    // downgrades throws to logged warnings for log-and-continue paths.
    try {
      const content = JSON.stringify(data, null, 2);
      await writeFileAtomic(this.filePath, content, "utf-8");
    } catch (error) {
      log.error("Failed to save metadata:", error);
      throw error;
    }
  }

  /**
   * Update the recency timestamp for a workspace.
   * Call this on user messages or other interactions.
   */
  async updateRecency(
    workspaceId: string,
    timestamp: number = Date.now()
  ): Promise<WorkspaceActivitySnapshot> {
    return this.mutateWorkspaceSnapshot(workspaceId, timestamp, (workspace) => {
      workspace.recency = timestamp;
    });
  }

  /**
   * Set the streaming status for a workspace.
   * Call this when streams start/end.
   */
  async setStreaming(
    workspaceId: string,
    streaming: boolean,
    update: ExtensionMetadataStreamingUpdate = {}
  ): Promise<WorkspaceActivitySnapshot> {
    return this.mutateWorkspaceSnapshot(workspaceId, Date.now(), (workspace) => {
      workspace.streaming = streaming;
      if (update.generation !== undefined) {
        workspace.streamingGeneration = update.generation;
      }
      if (update.model) {
        workspace.lastModel = update.model;
      }
      if (update.thinkingLevel !== undefined) {
        workspace.lastThinkingLevel = update.thinkingLevel;
      }
      if (update.todoStatus !== undefined) {
        if (update.todoStatus) {
          workspace.todoStatus = update.todoStatus;
        } else {
          delete workspace.todoStatus;
        }
      }
      if (update.hasTodos !== undefined) {
        workspace.hasTodos = update.hasTodos;
      }
    });
  }

  /**
   * Update the todo-derived status payload for a workspace.
   */
  async setTodoStatus(
    workspaceId: string,
    todoStatus: ExtensionAgentStatus | null,
    hasTodos: boolean
  ): Promise<WorkspaceActivitySnapshot> {
    return this.mutateWorkspaceSnapshot(workspaceId, Date.now(), (workspace) => {
      if (todoStatus) {
        workspace.todoStatus = todoStatus;
      } else {
        delete workspace.todoStatus;
      }
      workspace.hasTodos = hasTodos;
    });
  }

  /**
   * AgentStatusService writes its AI-generated payload into the same
   * `todoStatus` field used by the todo-derived path. Passing `null` clears
   * the slot.
   *
   * Unlike `setTodoStatus`, this writer:
   * - Never advances `recency`. Background regeneration must not promote
   *   idle workspaces in the sidebar or mark them unread. Existing entries
   *   keep their user-interaction recency; brand-new entries (rare: chat
   *   exists but no metadata yet) are seeded with `recency=0` until the
   *   next real user interaction.
   * - Doesn't touch `hasTodos`. The todo-derivation path owns that flag.
   * - Persists `inputHash` (AgentStatusService's dedup key for the input
   *   that produced `status`) atomically with the status so a restarted
   *   process can skip regenerating unchanged chats. A skipped write records
   *   nothing; clearing the status clears the hash.
   */
  async setSidebarStatus(
    workspaceId: string,
    status: ExtensionAgentStatus | null,
    options: { skipIfRecencyAdvancedSince?: number | null; inputHash?: string | null } = {}
  ): Promise<WorkspaceActivitySnapshot | null> {
    // See deletedWorkspaceIds: never resurrect a removed workspace's entry.
    // A stale tombstone (id re-registered by a concurrent backend) is
    // cleared via the registration recheck, same as mutateWorkspaceSnapshot.
    if (
      this.deletedWorkspaceIds.has(workspaceId) &&
      !(await this.recheckTombstonedRegistration(workspaceId))
    ) {
      return null;
    }
    // Same pre-mutation sidecar reconcile as mutateWorkspaceSnapshot: this
    // path also saves and returns a snapshot the caller broadcasts.
    await this.reconcileLeftoverSidecarIfPresent();
    return this.withSerializedMutation(async () => {
      // Re-check inside the queue (see mutateWorkspaceSnapshot): tombstones
      // published by an already-enqueued prune must be honored here too.
      if (
        this.deletedWorkspaceIds.has(workspaceId) &&
        !(await this.recheckTombstonedRegistration(workspaceId))
      ) {
        return null;
      }
      const data = await this.load();
      const existing = coerceExtensionMetadata(data.workspaces[workspaceId]);
      const workspace: ExtensionMetadata = existing ?? {
        recency: 0,
        streaming: false,
        lastModel: null,
        lastThinkingLevel: null,
        agentStatus: null,
        displayStatus: null,
        lastStatusUrl: null,
      };
      if (
        options.skipIfRecencyAdvancedSince !== undefined &&
        existing &&
        (options.skipIfRecencyAdvancedSince === null ||
          existing.recency > options.skipIfRecencyAdvancedSince)
      ) {
        return null;
      }
      if (status) {
        workspace.todoStatus = status;
        // The hash must describe exactly the input that produced the
        // persisted status; a write without a hash invalidates any stale one.
        workspace.sidebarStatusInputHash = options.inputHash ?? null;
      } else {
        delete workspace.todoStatus;
        delete workspace.sidebarStatusInputHash;
      }
      // Same write-generation contract as mutateWorkspaceSnapshot: this
      // writer persists a mutation while deliberately preserving recency.
      workspace.writeGeneration = ExtensionMetadataService.nextWriteGeneration(workspace);
      data.workspaces[workspaceId] = workspace;
      await this.save(data);
      return toWorkspaceActivitySnapshot(workspace);
    });
  }

  /**
   * Backend-only reader for the dedup hash persisted by setSidebarStatus.
   * Deliberately not part of getSnapshot()/getAllSnapshots():
   * WorkspaceActivitySnapshot is an IPC shape and must not grow
   * backend-only fields.
   */
  async getSidebarStatusInputHash(workspaceId: string): Promise<string | null> {
    const data = await this.load();
    const entry = coerceExtensionMetadata(data.workspaces[workspaceId]);
    // Codex review: other writers (setTodoStatus, setStreaming) clear or
    // replace the shared todoStatus slot without touching the hash. A hash
    // with no live status behind it is orphaned and must read as absent —
    // otherwise a restart would dedup an unchanged transcript against a
    // cleared slot and leave the sidebar blank until the transcript changed.
    if (!entry?.todoStatus) return null;
    return entry.sidebarStatusInputHash ?? null;
  }

  /**
   * Update the latest transient non-todo status payload for a workspace.
   */
  async setAgentStatus(
    workspaceId: string,
    agentStatus: ExtensionAgentStatus | null
  ): Promise<WorkspaceActivitySnapshot> {
    return this.mutateWorkspaceSnapshot(workspaceId, Date.now(), (workspace) => {
      const previousUrl =
        coerceAgentStatus(workspace.displayStatus)?.url ??
        coerceStatusUrl(workspace.lastStatusUrl) ??
        null;

      if (agentStatus) {
        const carriedUrl = agentStatus.url ?? previousUrl ?? undefined;
        workspace.displayStatus =
          carriedUrl !== undefined
            ? {
                ...agentStatus,
                url: carriedUrl,
              }
            : agentStatus;
        workspace.lastStatusUrl = carriedUrl ?? null;
      } else {
        workspace.displayStatus = null;
        // Once a transient display status clears, also clear any legacy status payload so
        // upgraded workspaces do not resurface stale pre-todo progress on the next snapshot.
        workspace.agentStatus = null;
        // Keep lastStatusUrl across clears so the next transient status without `url`
        // can still reuse the previous deep link.
        workspace.lastStatusUrl = previousUrl;
      }
    });
  }

  async setGoal(
    workspaceId: string,
    goal: GoalSnapshot | null
  ): Promise<WorkspaceActivitySnapshot> {
    return this.mutateWorkspaceSnapshot(workspaceId, Date.now(), (workspace) => {
      workspace.goal = goal;
    });
  }

  async getSnapshot(
    workspaceId: string,
    options?: { throwOnError?: boolean }
  ): Promise<WorkspaceActivitySnapshot | null> {
    // Same leftover-sidecar reconcile as getAllSnapshots (see the comment
    // there): live emissions read through this path after the subscription
    // bootstraps, so without it a recreated partial main would feed emitted
    // snapshots (clearing goal/status in the renderer) while the healthy
    // subscription never triggers another list read.
    // Strict callers (the emit paths) must also propagate a FAILED
    // reconcile instead of reading through it: with a sidecar present the
    // main file is suspect (typically a partial recreation), and emitting
    // it would clear goal/status in the renderer with no guaranteed
    // strict-list retry to repair — skipping the emit retains the
    // renderer's last-known snapshot until the reconcile succeeds. Lenient
    // callers (settings/eligibility readers) keep availability: a stranded
    // sidecar must never block message sending or heartbeats.
    try {
      await this.reconcileLeftoverSidecarIfPresent();
    } catch (error) {
      if (options?.throwOnError) {
        throw error;
      }
      log.debug("Leftover sidecar reconcile failed during snapshot read", { error });
    }
    const data = await this.loadWithCorruptionRecovery(options);
    return this.toSnapshot(data.workspaces[workspaceId]);
  }

  /**
   * Whether this process removed the workspace's entry (see
   * deletedWorkspaceIds). Lets emit paths suppress late activity broadcasts
   * whose disk writes the tombstone already blocked.
   */
  isWorkspaceDeleted(workspaceId: string): boolean {
    return this.deletedWorkspaceIds.has(workspaceId);
  }

  /**
   * Drop write tombstones for ids a fresh config view proves are registered.
   * Tombstones are process-local removal knowledge and the shared config is
   * the authority: with XUM_ALLOW_MULTIPLE_INSTANCES a downgraded concurrent
   * backend can legitimately re-register a deterministic legacy id this
   * process pruned earlier, and without this hook the stale tombstone would
   * suppress every one of the revived workspace's metadata writes (and
   * filter it from activity lists) until restart. Called from the activity
   * bootstrap with fresh config-derived id sets only — never with snapshot
   * or in-memory cache keys, which do not prove registration.
   *
   * `eligibleIds` must be a getTombstonedIds() snapshot captured BEFORE the
   * registration evidence was gathered: clearing is sound only when the
   * evidence postdates the tombstone. A tombstone published while the
   * evidence reads were in flight (same-process removal during the activity
   * list's authoritative enumeration await) would otherwise be cleared by a
   * stale pre-removal view, un-suppressing late writers and letting the
   * removed entry ride back into the renderer.
   */
  clearTombstonesForRegisteredIds(
    registeredIds: ReadonlySet<string>,
    eligibleIds: ReadonlyMap<string, number>
  ): void {
    for (const [workspaceId, generation] of eligibleIds) {
      // Generation compare (see recheckTombstonedRegistration): a same-
      // process removal can republish the tombstone while the caller's
      // registration evidence was being gathered — the stale positive must
      // clear only the exact tombstone the snapshot captured, never the
      // newer removal's.
      if (
        registeredIds.has(workspaceId) &&
        this.deletedWorkspaceIds.get(workspaceId) === generation
      ) {
        this.liftTombstone(workspaceId);
      }
    }
  }

  /**
   * Snapshot of the ids currently write-tombstoned in this process, with
   * their generations. Capture it before gathering registration evidence and
   * pass it back to clearTombstonesForRegisteredIds as the set of clearable
   * tombstones — the generation lets the clear skip tombstones republished
   * after the snapshot.
   */
  getTombstonedIds(): ReadonlyMap<string, number> {
    return new Map(this.deletedWorkspaceIds);
  }

  /**
   * Delete metadata for a workspace.
   * Call this when a workspace is deleted.
   */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    // Synchronously, before the queued mutation: any writer enqueued from now
    // on must see the tombstone (see deletedWorkspaceIds).
    const publishedGeneration = this.publishTombstone(workspaceId);
    // Reconcile a crash-stranded sidecar BEFORE the queued deletion (outside
    // the queue — the resume path serializes itself), same as the emitting
    // write entry points: deleting from a recreated PARTIAL main would skip
    // the removed workspace's complete entry sitting in the sidecar, and a
    // concurrent backend without this process-local tombstone could later
    // reconcile that sidecar and restore the removed entry (visible
    // immediately on unscoped builds; inherited as stale goal/status by a
    // deterministic legacy-id re-registration). A failing reconcile
    // propagates: the tombstone stays (fail closed, writes suppressed) and
    // the disk entry remains recoverable for a retried removal or the
    // process-start prune.
    await this.reconcileLeftoverSidecarIfPresent();
    await this.withSerializedMutation(async () => {
      const data = await this.load();
      // In-queue registration revalidation, strictly AFTER the load (same
      // ordering as the prune): a workspace is durably registered before its
      // first metadata write, so any entry visible in the loaded snapshot
      // was persisted before the load — a post-load probe reporting
      // "unregistered" therefore postdates that write and proves the entry
      // belongs to the removed incarnation. A downgraded backend
      // re-registering a deterministic legacy id (after the caller's
      // deregistration checks, or while this deletion waited in the queue)
      // keeps its fresh snapshot: the probe-confirmed registration aborts
      // the deletion and lifts the tombstone THIS call published
      // (generation-guarded — a newer removal's tombstone stays). An
      // unknowable probe keeps the tombstone and skips the disk deletion: a
      // stale entry is recoverable (filtered by the tombstone now, reclaimed
      // by a later removal or process-start prune), destroyed re-registered
      // data is not. Without a probe the caller's own deregistration
      // evidence stands.
      if (this.registrationProbe != null) {
        let registered: boolean;
        try {
          registered = await this.registrationProbe(workspaceId);
        } catch {
          return;
        }
        if (registered) {
          if (this.deletedWorkspaceIds.get(workspaceId) === publishedGeneration) {
            this.liftTombstone(workspaceId);
          }
          return;
        }
      }
      // Key presence, not truthiness: malformed falsy persisted entries
      // (e.g. null) must be deleted too, or removal leaves a stale key
      // behind until the next process-start prune.
      if (workspaceId in data.workspaces) {
        delete data.workspaces[workspaceId];
        await this.save(data);
      }
    });
  }

  /**
   * Remove entries whose workspace no longer exists. Removed workspaces and
   * sub-agents were historically never pruned here, so long-lived deployments
   * accumulate thousands of stale entries that inflate every read and rewrite
   * of this file (issue #3959 measured 13,895 entries for 1,513 known
   * workspaces). Called once per process; `deleteWorkspace` keeps the file
   * bounded afterwards.
   *
   * Loss safety: `getKnownWorkspaceIds` is invoked INSIDE the serialized
   * mutation and strictly AFTER the file is loaded, and the callback reads
   * config fresh from disk. A workspace is durably registered in config
   * before its first metadata write, so every entry visible in the loaded
   * file belongs to a workspace whose registration is already on disk — the
   * post-load fetch therefore always includes live entries' ids, even for
   * workspaces created concurrently by another backend process
   * (XUM_ALLOW_MULTIPLE_INSTANCES). Fetching before the load would leave a
   * window where another process registers + writes a fresh entry that the
   * stale known-ids set misclassifies as prunable.
   *
   * Cross-process writers (XUM_ALLOW_MULTIPLE_INSTANCES) are not serialized
   * by the in-process queue, so this pass never rewrites its own working
   * snapshot: it computes the stale-id set from the first load, then re-loads
   * a FRESH snapshot and applies only those deletions before saving. A fresh
   * entry another backend wrote between the two loads is preserved (its id
   * was not in the first snapshot, so it is never classified stale), and
   * since workspace ids are never reused, a stale id cannot have become live
   * in between. The residual window (a foreign write landing during the
   * final stringify+atomic-write) is the same lost-update window every
   * existing writer of this file already has.
   *
   * Upgrade↔downgrade safety: surviving entries are round-tripped verbatim
   * (no coercion), so fields written by other builds are preserved and the
   * on-disk format is unchanged.
   */
  async pruneMissingWorkspaces(
    getKnownWorkspaceIds: () => Promise<ReadonlySet<string>>,
    // Optional cheaper view for the mid-prune re-registration recheck: it
    // only needs to answer "is this stale-classified id registered NOW", so
    // callers whose full enumeration is expensive (per-workspace filesystem
    // walks) can substitute an equally-complete but cheaper read. It must be
    // COMPLETE (contain every currently registered id) or throw — resolving
    // with a lossy set would let the prune delete a re-registered
    // workspace's data. Defaults to getKnownWorkspaceIds.
    recheckKnownWorkspaceIds?: () => Promise<ReadonlySet<string>>
  ): Promise<number> {
    // Reconcile a crash-stranded sidecar FIRST (outside the mutation queue —
    // the resume path serializes itself): the prune classifies stale ids
    // against the file it loads, so sidecar-only entries would dodge the
    // one-time deletion set and merge back into the main file on the very
    // next read — with the prune latched, exactly the stale entries this
    // cleanup exists to remove would keep inflating every read and rewrite
    // until restart. A failing reconcile propagates so the caller's
    // fail-closed abort applies instead of pruning against a partial view.
    await this.reconcileLeftoverSidecarIfPresent();
    return this.withSerializedMutation(async () => {
      const data = await this.load();
      const knownWorkspaceIds = await getKnownWorkspaceIds();
      const staleWorkspaceIds = Object.keys(data.workspaces).filter(
        (workspaceId) => !knownWorkspaceIds.has(workspaceId)
      );
      const staleTombstoneGenerations = new Map<string, number>();
      for (const workspaceId of staleWorkspaceIds) {
        // Same guard as deleteWorkspace: a late in-process writer must not
        // resurrect an entry this pass reclaims. The generation scopes the
        // re-registration spare below to THIS prune's tombstone.
        staleTombstoneGenerations.set(workspaceId, this.publishTombstone(workspaceId));
      }
      if (staleWorkspaceIds.length === 0) {
        return 0;
      }
      // Re-registration recheck: with multiple instances a downgraded
      // backend can re-register a deterministic legacy id (and write new
      // activity for it) between the enumeration above and here. Deleting
      // on the stale classification would destroy that new entry's
      // recency/goal/status — clearing the tombstone later cannot restore
      // data. A re-registered id is dropped from the deletion set and its
      // write tombstone lifted. If the recheck fails, abort the prune (throw
      // to the caller's catch) rather than deleting on stale knowledge.
      const recheckedKnownIds = await (recheckKnownWorkspaceIds ?? getKnownWorkspaceIds)();
      // Deletion-only merge against a fresh snapshot loaded strictly AFTER
      // the recheck — the LAST await before the save below. The recheck can
      // perform a full legacy enumeration, and any recency/goal/status
      // another backend writes during that await would be absent from a
      // pre-recheck snapshot: save() would silently roll it back while
      // deleting the stale keys. The inverse race (an id re-registered
      // after the recheck read but before this load) is covered by the
      // unchanged-bytes guard below, which is strictly narrower than the
      // enumeration-wide window this ordering closes.
      const fresh = await this.load();
      let prunedCount = 0;
      for (const workspaceId of staleWorkspaceIds) {
        if (recheckedKnownIds.has(workspaceId)) {
          // Generation-guarded (see clearTombstonesForRegisteredIds): the
          // recheck enumeration awaited disk, and a same-process removal can
          // republish this tombstone mid-await — the enumeration's
          // pre-removal positive must clear only the prune's own tombstone,
          // never the newer removal's (a late writer would otherwise pass
          // its in-queue check and recreate the removed entry).
          if (
            this.deletedWorkspaceIds.get(workspaceId) === staleTombstoneGenerations.get(workspaceId)
          ) {
            this.liftTombstone(workspaceId);
          }
          continue;
        }
        if (!(workspaceId in fresh.workspaces)) {
          continue;
        }
        // Fail-closed bytes guard: the registration evidence above predates
        // this load, so an id re-registered in that gap says "unregistered"
        // while a concurrent backend may already have written fresh
        // activity for it. A stale-classified entry whose bytes CHANGED
        // between the two loads proves such a writer — spare it (the entry
        // is re-evaluated on the next process start; the write tombstone
        // stays until fresh registration evidence clears it through the
        // normal revival paths).
        if (
          JSON.stringify(fresh.workspaces[workspaceId]) !==
          JSON.stringify(data.workspaces[workspaceId])
        ) {
          continue;
        }
        delete fresh.workspaces[workspaceId];
        prunedCount++;
      }
      if (prunedCount > 0) {
        await this.save(fresh);
      }
      return prunedCount;
    });
  }

  /**
   * Clear all streaming flags.
   * Call this on app startup to clean up stale streaming states from crashes.
   */
  async clearStaleStreaming(): Promise<void> {
    await this.withSerializedMutation(async () => {
      const data = await this.load();
      let modified = false;

      for (const [workspaceId, entry] of Object.entries(data.workspaces)) {
        const normalized = coerceExtensionMetadata(entry);
        if (!normalized?.streaming) {
          continue;
        }

        normalized.streaming = false;
        data.workspaces[workspaceId] = normalized;
        modified = true;
      }

      if (modified) {
        await this.save(data);
      }
    });
  }

  /**
   * fs errors carry an errno `code` and may be transient (EACCES/EIO/...);
   * anything readFile's content produced afterwards (JSON parse or structure
   * validation errors) fails identically for the same bytes on every retry.
   */
  private static isDeterministicCorruption(error: unknown): boolean {
    return !(typeof error === "object" && error != null && "code" in error);
  }

  private static isErrnoCode(error: unknown, code: string): boolean {
    return typeof error === "object" && error != null && "code" in error && error.code === code;
  }

  /**
   * A structurally sound file whose version is not 1: written by a newer
   * schema, not corrupt. Carries the marker code so isDeterministicCorruption
   * classifies it as non-quarantinable and load() refuses to self-heal it.
   */
  private static isUnsupportedVersion(parsed: unknown): boolean {
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return false;
    }
    const version = (parsed as { version?: unknown }).version;
    // Only a structurally PLAUSIBLE forward version (an integer greater
    // than 1) earns the non-destructive preservation path. A malformed value
    // (null, string, object, or a numeric no schema lineage can produce —
    // 0, -1, 2.5) must classify as deterministic corruption instead:
    // preserving it would leave every strict read and lenient writer failing
    // forever on a file no build can ever read, rather than quarantining and
    // self-healing.
    return typeof version === "number" && Number.isInteger(version) && version > 1;
  }

  private static unsupportedVersionError(): NodeJS.ErrnoException {
    const error = new Error(
      "Unsupported extension metadata file version (written by a newer build)"
    ) as NodeJS.ErrnoException;
    error.code = UNSUPPORTED_METADATA_VERSION_CODE;
    return error;
  }

  private static isValidMetadataFileShape(parsed: unknown): parsed is ExtensionMetadataFile {
    if (typeof parsed !== "object" || parsed === null) {
      return false;
    }
    const candidate = parsed as { version?: unknown; workspaces?: unknown };
    return (
      candidate.version === 1 &&
      typeof candidate.workspaces === "object" &&
      candidate.workspaces !== null &&
      !Array.isArray(candidate.workspaces)
    );
  }

  /**
   * Move a deterministically corrupt metadata file aside so strict readers
   * stop failing on every retry across process restarts (nothing else
   * repairs the file until some unrelated writer happens to replace it).
   * The original bytes are preserved at a fixed `.corrupt` path for
   * inspection rather than deleted; the fixed name keeps quarantine bounded.
   * Serialized with writers, and corruption is re-verified inside the queue
   * so a concurrently repaired (just-saved) file is never quarantined.
   */
  private async quarantineCorruptFile(): Promise<boolean> {
    return this.withSerializedMutation(async () => {
      try {
        await this.load({ throwOnError: true });
        return false; // Healed concurrently (or transiently unreadable before).
      } catch (error) {
        if (!ExtensionMetadataService.isDeterministicCorruption(error)) {
          return false;
        }
      }
      const quarantinePath = `${this.filePath}.corrupt`;
      // A crash-stranded sidecar may already occupy the quarantine path —
      // typically the full healthy snapshot, with the corrupt main being a
      // later re-corruption of a recreated file. On POSIX, rename() would
      // silently REPLACE those bytes, and recovery would then reset the
      // canonical file to empty, permanently destroying the recoverable
      // data. Move the corrupt main aside as the bounded fixed-name
      // leftover instead (same name the newer-schema swap uses; keeps the
      // latest superseded file) and complete the EXISTING sidecar's
      // recovery: healthy bytes restore to the canonical path, corrupt
      // sidecar bytes reset it to empty exactly as before. A failing probe
      // propagates so the read stays retryable on unknowable evidence.
      if (await this.probeQuarantineSidecar()) {
        const inflightLeftoverPath = await this.moveMainAsideAsRecreatedLeftover();
        // Same cross-process race completeQuarantineRecovery closes for the
        // rename-to-.corrupt branch: another backend's atomic save can land
        // a NEWER healthy main between the in-queue corruption check above
        // and the move — nothing ever reads the leftover, so the newer
        // update would be silently lost while the OLDER sidecar restores.
        // Re-validate what actually got moved; when it turns out healthy
        // (or a preserved newer schema), restore it to the vacant main path
        // and merge the existing sidecar into it via the recreated-main
        // reconcile. Transient read failures propagate (retryable) with the
        // in-flight file left in place — finalizing UNVERIFIED bytes could
        // bury a raced healthy save as the superseded leftover. Only
        // deterministic corruption proceeds to the sidecar-restore path.
        let movedRaw: unknown;
        let movedParses = true;
        try {
          movedRaw = JSON.parse(await readFile(inflightLeftoverPath, "utf-8")) as unknown;
        } catch (readError) {
          if (!ExtensionMetadataService.isDeterministicCorruption(readError)) {
            throw readError;
          }
          movedParses = false;
        }
        if (
          movedParses &&
          (ExtensionMetadataService.isValidMetadataFileShape(movedRaw) ||
            ExtensionMetadataService.isUnsupportedVersion(movedRaw))
        ) {
          // Restore without overwriting a file yet another writer re-created
          // at the main path (EEXIST): the reconcile below merges the
          // sidecar into whichever file now owns the path.
          let restored = true;
          try {
            await link(inflightLeftoverPath, this.filePath);
          } catch (linkError) {
            if (ExtensionMetadataService.isErrnoCode(linkError, "EEXIST")) {
              restored = false;
            } else {
              try {
                await copyFile(inflightLeftoverPath, this.filePath, constants.COPYFILE_EXCL);
              } catch (copyError) {
                if (!ExtensionMetadataService.isErrnoCode(copyError, "EEXIST")) {
                  // Main path missing with the raced bytes only in the
                  // in-flight file: rethrow (retryable) rather than letting
                  // the sidecar restore over the vacant path and orphan them.
                  throw copyError;
                }
                restored = false;
              }
            }
          }
          if (restored) {
            // Restored to the main path: the in-flight file is a duplicate
            // hard link of the live main, not a superseded leftover — drop
            // it. Non-ENOENT failures propagate (retryable); the retried
            // read finds the main healthy and at worst strands the
            // harmless duplicate.
            try {
              await unlink(inflightLeftoverPath);
            } catch (unlinkError) {
              if (!ExtensionMetadataService.isErrnoCode(unlinkError, "ENOENT")) {
                throw unlinkError;
              }
            }
          }
          // EEXIST (restored === false) does NOT prove the main-path owner
          // is newer than the moved bytes: a competing recovery can restore
          // the OLDER sidecar to the vacant main path first (and consume
          // the sidecar, making the reconcile below a no-op). Finalizing
          // the valid moved bytes to the fixed leftover would exclude them
          // from stranded-file discovery and silently drop the newer
          // recency/goal/status — leave them at the unique in-flight name
          // instead: the stranded-leftover scan merges them by write
          // generation/recency against whatever now owns the main path.
          return this.reconcileRecreatedMainWithSidecar(quarantinePath);
        }
        // Deterministically corrupt moved bytes: proven superseded — keep
        // them as the bounded fixed-name leftover.
        await this.finalizeRecreatedLeftover(inflightLeftoverPath);
        return this.completeQuarantineRecovery(quarantinePath);
      }
      await rename(this.filePath, quarantinePath);
      return this.completeQuarantineRecovery(quarantinePath);
    });
  }

  /**
   * Move the current main file aside to an in-flight uniquely named
   * `.recreated-<pid>-<uuid>` path and return that path. In-flight
   * moved-aside bytes must never live at the shared fixed-name `.recreated`
   * leftover: the mutation queue is process-local, so two backends can both
   * pass the corrupt-main validation for the same sidecar, and if process A
   * had moved a concurrently saved HEALTHY main to the fixed name, process
   * B's finalize would unlink A's only copy before A could re-validate and
   * restore it — both recoveries would then restore the OLDER sidecar,
   * permanently losing the newer update. Callers finalize via
   * finalizeRecreatedLeftover once the moved bytes are proven superseded,
   * or unlink the in-flight file once they are restored. A crash (or a
   * transient revalidation failure) can strand the file mid-recovery —
   * possibly holding a raced healthy save's ONLY copy — so the leftover
   * scan discovers stranded files by prefix and recovers them (see
   * recoverStrandedRecreatedLeftover); the fixed name still never holds
   * unverified bytes another recovery could destroy.
   */
  private async moveMainAsideAsRecreatedLeftover(): Promise<string> {
    const inflightPath = `${this.filePath}${ExtensionMetadataService.RECREATED_INFIX}${process.pid}-${randomUUID()}`;
    await rename(this.filePath, inflightPath);
    return inflightPath;
  }

  /**
   * Install proven-superseded moved-aside bytes as the bounded fixed-name
   * `.recreated` leftover ("keeps the latest superseded file"). Replacing
   * the fixed name is safe: with every in-flight move under a unique name
   * (see moveMainAsideAsRecreatedLeftover), the fixed name only ever holds
   * FINALIZED superseded bytes that no recovery will re-read. The prior
   * leftover is unlinked first because Windows rename onto an existing file
   * is not reliably a replace (it can fail with EPERM/EEXIST), which would
   * fail every strict activity read's recovery until the user removed the
   * leftover by hand. A crash between the unlink and the rename only loses
   * the OLDER finalized leftover. Non-ENOENT unlink failures propagate
   * (retryable) — the rename would fail on the occupied destination anyway.
   */
  private async finalizeRecreatedLeftover(inflightPath: string): Promise<void> {
    const leftoverPath = `${this.filePath}.recreated`;
    try {
      await unlink(leftoverPath);
    } catch (unlinkError) {
      if (!ExtensionMetadataService.isErrnoCode(unlinkError, "ENOENT")) {
        throw unlinkError;
      }
    }
    await rename(inflightPath, leftoverPath);
  }

  /**
   * Recover one stranded in-flight moved-aside main (unique RECREATED_INFIX
   * name). The owner recovery's rename is its commit point — revalidation
   * happens AFTER the move — so an owner crash (or transient revalidation
   * failure) can strand a raced healthy save's ONLY copy at the unique
   * name, where no fixed-path probe ever finds it; the next recovery would
   * then restore the OLDER sidecar and orphan the newer
   * recency/goal/status forever. Claiming may steal a LIVE owner's
   * in-flight file: that is deliberate and data-preserving — the owner's
   * revalidation read fails with a retryable ENOENT (never reported as
   * success) while the bytes are merged or finalized here, so no copy is
   * destroyed unmerged and no process-liveness probing is needed. Runs
   * inside withSerializedMutation.
   */
  private async recoverStrandedRecreatedLeftover(strandedPath: string): Promise<void> {
    // Claim to a fresh unique name under the same scanned prefix first:
    // concurrent scanners race on the rename (ENOENT = already
    // claimed/consumed) and a crash after the claim leaves the claim itself
    // rediscoverable by the same prefix scan. No identity token in the name
    // (unlike CLAIM_INFIX, whose claims hold VALID bytes whose
    // already-merged vs foreign-generation identity is undecidable by
    // parsing): here parsing decides everything — corrupt bytes are proven
    // superseded, and valid bytes merge idempotently under the
    // strictly-newer recency gate below, so replaying a claim after a crash
    // between merge and unlink is a no-op rather than a resurrection.
    const claimPath = `${this.filePath}${ExtensionMetadataService.RECREATED_INFIX}claim-${process.pid}-${randomUUID()}`;
    try {
      await rename(strandedPath, claimPath);
    } catch (renameError) {
      if (ExtensionMetadataService.isErrnoCode(renameError, "ENOENT")) {
        return;
      }
      throw renameError;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(claimPath, "utf-8")) as unknown;
    } catch (readError) {
      // The claim path is process-unique, so any read failure other than
      // deterministic parse corruption is transient: propagate (retryable;
      // the claim stays discoverable). Corrupt bytes are exactly the
      // validated-corrupt main the owner moved aside — keep them as the
      // bounded fixed-name leftover, the same terminal state the owner
      // itself would have chosen.
      if (!ExtensionMetadataService.isDeterministicCorruption(readError)) {
        throw readError;
      }
      await this.finalizeRecreatedLeftover(claimPath);
      return;
    }
    if (ExtensionMetadataService.isUnsupportedVersion(parsed)) {
      // A newer build's main stranded mid-recovery: same upgrade-
      // preservation swap as an unsupported sidecar (the reconcile treats
      // the claim path as its sidecar argument and consumes it).
      await this.reconcileRecreatedMainWithSidecar(claimPath);
      return;
    }
    if (!ExtensionMetadataService.isValidMetadataFileShape(parsed)) {
      // Parseable but not a metadata file: proven superseded garbage.
      await this.finalizeRecreatedLeftover(claimPath);
      return;
    }
    // Upper bound on the write time of EVERY entry in the stranded
    // snapshot: rename() preserves mtime, so the claim file still carries
    // the owner's last save time. The equal-recency ordering below compares
    // generation-carrying entries (epoch-ms stamps) against it. Stat
    // failures on the process-unique claim are transient: propagate
    // (retryable; the claim stays discoverable).
    const strandedMtimeMs = (await stat(claimPath)).mtimeMs;
    // Tombstone revalidation for candidate ids, following the sidecar
    // reconcile's lift-or-suppress generation contract. Safe to sample
    // before the main read below: lifts only update the in-memory
    // suppression map (never the file), and the merge re-checks live
    // tombstone state per entry.
    if (this.registrationProbe != null) {
      for (const workspaceId of Object.keys(parsed.workspaces)) {
        if (!this.deletedWorkspaceIds.has(workspaceId)) {
          continue;
        }
        const generationBefore = this.deletedWorkspaceIds.get(workspaceId);
        const registered = await this.registrationProbe(workspaceId);
        if (registered && this.deletedWorkspaceIds.get(workspaceId) === generationBefore) {
          this.liftTombstone(workspaceId);
        }
      }
    }
    let main: ExtensionMetadataFile;
    try {
      const mainParsed = JSON.parse(await readFile(this.filePath, "utf-8")) as unknown;
      if (!ExtensionMetadataService.isValidMetadataFileShape(mainParsed)) {
        // Corrupt or newer-schema main: leave the claim for a later pass
        // (it stays under the scanned prefix) rather than merging across
        // schemas.
        return;
      }
      main = mainParsed;
    } catch (readError) {
      if (ExtensionMetadataService.isErrnoCode(readError, "ENOENT")) {
        // Missing-main window: the resumable sidecar recovery owns the
        // path right now; the claim stays discoverable for the next pass.
        return;
      }
      if (!ExtensionMetadataService.isDeterministicCorruption(readError)) {
        throw readError;
      }
      return;
    }
    // Adoption evidence for candidates MISSING from the loaded main,
    // gathered strictly AFTER the load (the concurrency contract's
    // post-load evidence rule for destructive/resurrecting decisions): the
    // stranded snapshot predates the current main, so a missing entry may
    // mean another backend REMOVED the workspace — and a positive probe
    // sampled BEFORE the load can go stale when that removal lands during
    // the probe awaits, letting the stale positive adopt (resurrect) the
    // removed workspace's goal/status indefinitely (an unscoped older
    // build exposes it, and a re-registered deterministic legacy id would
    // inherit it). These awaits hold the loaded snapshot across config
    // reads, widening the window in which the save below clobbers a
    // concurrent backend's write — that window exists on every load→save
    // slot here and is the contract's documented out-of-scope gap, while
    // stale-evidence resurrection is exactly the harm the probe exists to
    // prevent, so evidence freshness wins. Without a wired probe,
    // missing-target adoption stays fail-open (the sidecar reconcile's
    // sidecar-only adoption contract; dropping is destructive and
    // production always wires the probe). A FAILING probe propagates
    // (claim retained, retryable) rather than consuming the stranded bytes
    // on unknowable evidence.
    const registrationEvidence = new Map<string, boolean>();
    for (const workspaceId of Object.keys(parsed.workspaces)) {
      if (this.deletedWorkspaceIds.has(workspaceId) || workspaceId in main.workspaces) {
        // Tombstoned ids are skipped by the merge below; existing targets
        // are ordered newest-wins, which needs no registration evidence.
        continue;
      }
      if (this.registrationProbe == null) {
        registrationEvidence.set(workspaceId, true);
        continue;
      }
      registrationEvidence.set(workspaceId, await this.registrationProbe(workspaceId));
    }
    let modified = false;
    for (const [workspaceId, entry] of Object.entries(parsed.workspaces)) {
      if (this.deletedWorkspaceIds.has(workspaceId)) {
        // Still tombstoned after the revalidation pass above: the local
        // removal knowledge stands.
        continue;
      }
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const candidateRecency = (entry as { recency?: unknown }).recency;
      if (typeof candidateRecency !== "number") {
        // Unorderable candidate: keep the main entry (fail closed).
        continue;
      }
      if (!(workspaceId in main.workspaces)) {
        const registered = registrationEvidence.get(workspaceId);
        if (registered === undefined) {
          // No post-load evidence for this missing target: its tombstone
          // was lifted between the evidence pass above and this check
          // (writers' pre-queue rechecks run outside this queue slot).
          // Abort without saving or consuming: the claim stays
          // discoverable and the next scan probes the id afresh. Earlier
          // candidates' merges replay idempotently.
          return;
        }
        if (!registered) {
          // Proven removed: do not resurrect the deleted entry.
          continue;
        }
      }
      const target: unknown = main.workspaces[workspaceId];
      const targetIsObject =
        target !== null && typeof target === "object" && !Array.isArray(target);
      const targetRecency = targetIsObject ? (target as { recency?: unknown }).recency : undefined;
      const targetGeneration = targetIsObject
        ? (target as { writeGeneration?: unknown }).writeGeneration
        : undefined;
      const candidateGeneration = (entry as { writeGeneration?: unknown }).writeGeneration;
      // Entry-level newest-wins, NOT the sidecar reconcile's main-wins
      // field merge: the stranded bytes are a complete healthy main
      // snapshot whose age relative to the CURRENT main is unknowable per
      // field (the current main may be an older sidecar restore plus newer
      // writes). Ordering, in precedence order:
      // - per-entry writeGeneration when both copies carry distinct ones
      //   (advanced by EVERY persisted mutation — recency alone cannot
      //   order metadata changes because status/goal/streaming writers
      //   deliberately preserve it);
      // - strict recency otherwise;
      // - at EQUAL recency with a generation-carrying TARGET facing a
      //   generation-LESS candidate, the stranded file's mtime decides: the
      //   stamp is epoch-ms (see nextWriteGeneration) and rename preserves
      //   mtime, so a target stamp strictly above strandedMtimeMs proves
      //   the target's write postdates every byte of the stranded snapshot
      //   (e.g. this build mutated goal/status AFTER a pre-generation main
      //   was stranded) — keep the target; no later mutation is guaranteed
      //   to repair a wrong overwrite. Otherwise the order is genuinely
      //   unknowable and the generation-less candidate wins: a downgraded
      //   build's writers drop writeGeneration from the entry they mutate,
      //   so the candidate may be that build's LATER goal/status write
      //   whose only surviving copy is here — dropping it (and unlinking
      //   the claim) would lose the downgrade's update permanently
      //   (upgrade↔downgrade preservation), while wrongly preferring an
      //   ancient copy only resurrects stale metadata that the next status
      //   write or regeneration self-heals. Coarse-mtime filesystems only
      //   widen the ambiguous branch, never the destructive one. A
      //   generation-less TARGET keeps against a generation-carrying
      //   candidate for the same downgrade-preservation reason (the main
      //   path is also the actively-written copy the next local mutation
      //   lands on). Ties with no generation information keep the target,
      //   so crash replay of an already-merged claim stays a no-op (after
      //   adopting a generation-less candidate the main entry is
      //   generation-less too); the replay window can re-adopt over an
      //   interleaved same-recency local write, but it is bounded by the
      //   claim's lifetime (crash between merge and unlink) and self-heals
      //   like any stale status.
      const candidateNewer =
        typeof candidateGeneration === "number" &&
        typeof targetGeneration === "number" &&
        candidateGeneration !== targetGeneration
          ? candidateGeneration > targetGeneration
          : typeof targetRecency !== "number"
            ? true
            : targetRecency !== candidateRecency
              ? candidateRecency > targetRecency
              : typeof targetGeneration === "number" &&
                typeof candidateGeneration !== "number" &&
                targetGeneration <= strandedMtimeMs;
      if (!candidateNewer) {
        continue;
      }
      // Cross-process crash leftover rule (same as sidecar-only entries): a
      // truthy streaming flag from a stranded file must not pin the
      // workspace "streaming" forever; a genuinely streaming workspace
      // re-asserts the flag with its next write.
      main.workspaces[workspaceId] =
        (entry as { streaming?: unknown }).streaming === true
          ? { ...entry, streaming: false }
          : entry;
      modified = true;
    }
    if (modified) {
      await this.save(main);
    }
    // The claim path is process-unique: nothing else consumes it, so a
    // plain unlink suffices (no token verification needed — see the claim
    // comment above for why replay is idempotent anyway).
    try {
      await unlink(claimPath);
    } catch (unlinkError) {
      if (!ExtensionMetadataService.isErrnoCode(unlinkError, "ENOENT")) {
        throw unlinkError;
      }
    }
  }

  /**
   * Finish a quarantine whose main file was already moved to the sidecar:
   * restore the sidecar to the main path when its bytes turn out healthy,
   * otherwise leave the corrupt bytes quarantined and reset the main path to
   * a valid empty file. Factored out of quarantineCorruptFile so a recovery
   * interrupted by a crash between the rename and this completion can be
   * RESUMED on the next strict read (see resumeQuarantineRecovery) instead
   * of leaving strict reads failing until an unrelated writer saves.
   * Must run inside withSerializedMutation.
   */
  private async completeQuarantineRecovery(quarantinePath: string): Promise<boolean> {
    // The mutation queue is process-local: another backend's atomic save
    // can land a healthy file between the validation above and the rename,
    // and the rename would move THAT file aside. Re-validate the bytes that
    // actually got moved and undo the move when they turn out healthy.
    // Only deterministic parse corruption is the expected quarantine
    // outcome here; a transient failure reading the sidecar means the
    // moved bytes cannot be verified, so it propagates (retryable) rather
    // than reporting a successful reset over possibly-healthy data.
    // Generation identity captured before the read: consumption below is
    // scoped to exactly these bytes (see consumeQuarantineSidecar).
    const sidecarToken = await ExtensionMetadataService.statQuarantineToken(quarantinePath);
    let moved: unknown;
    let movedParses = true;
    try {
      moved = JSON.parse(await readFile(quarantinePath, "utf-8")) as unknown;
      // Bind the token to the bytes just read (same contract as
      // reconcileRecreatedMainWithSidecar): another recovery can consume
      // the captured generation and install a newer one between the stat
      // and the read. Restoring the new bytes under the OLD token would
      // double-apply them — the consume claims the new generation, sees
      // the mismatch, and replays it, re-filling fields another backend
      // explicitly cleared to null in between. On mismatch leave the file
      // for its own recovery pass (the retried read resumes with a fresh
      // token).
      const postReadToken = await ExtensionMetadataService.statQuarantineToken(quarantinePath);
      if (
        sidecarToken == null ||
        postReadToken == null ||
        !ExtensionMetadataService.tokensMatch(sidecarToken, postReadToken)
      ) {
        return false;
      }
    } catch (readError) {
      if (!ExtensionMetadataService.isDeterministicCorruption(readError)) {
        throw readError;
      }
      movedParses = false;
    }
    if (
      movedParses &&
      (ExtensionMetadataService.isValidMetadataFileShape(moved) ||
        // A newer build's schema stranded in the sidecar (crash-interrupted
        // quarantine on a downgraded install, or a newer backend saving the
        // main file between the in-queue corruption check and the rename) is
        // preserved data, not corruption: restore it instead of falling
        // through to the empty-reset below, which would hand the newer build
        // an empty canonical file. The subsequent re-read then fails with
        // the non-destructive unsupported-version signal.
        ExtensionMetadataService.isUnsupportedVersion(moved))
    ) {
      // Restore without ever overwriting a newer file yet another writer
      // may have re-created at the main path: link and COPYFILE_EXCL both
      // fail with EEXIST in that case. EEXIST is NOT a successful recovery
      // though — the re-created file may be a PARTIAL snapshot an older
      // backend self-healed from the missing-main window (older builds read
      // ENOENT as empty and save their one mutated entry), so the sidecar's
      // other entries must be reconciled into it rather than abandoned.
      try {
        await link(quarantinePath, this.filePath);
      } catch (linkError) {
        if (ExtensionMetadataService.isErrnoCode(linkError, "EEXIST")) {
          return this.reconcileRecreatedMainWithSidecar(quarantinePath);
        }
        try {
          // Filesystems without hard-link support (or EPERM): copy-based
          // restore with the same EEXIST no-overwrite guarantee.
          await copyFile(quarantinePath, this.filePath, constants.COPYFILE_EXCL);
        } catch (copyError) {
          if (ExtensionMetadataService.isErrnoCode(copyError, "EEXIST")) {
            return this.reconcileRecreatedMainWithSidecar(quarantinePath);
          }
          // Restore failed with the main path missing: rethrow so the
          // strict reader propagates a retryable failure instead of
          // reading ENOENT as an authoritative empty state while the
          // healthy bytes sit in the sidecar.
          throw copyError;
        }
      }
      await this.consumeQuarantineSidecar(quarantinePath, sidecarToken);
      return false;
    }
    // Replace the quarantined main file with a valid EMPTY file instead of
    // leaving the path missing: between the rename above and here, strict
    // readers (this or another process) would otherwise observe ENOENT.
    // A missing-main window is dangerous because load() treats plain
    // ENOENT as a healthy empty state — combined with a concurrent writer
    // repairing the file right before the rename, a reader in the gap
    // could return an authoritative {} that a later restore cannot
    // retract. With a real empty file the corrupt→empty transition is
    // atomic (link/COPYFILE_EXCL below never overwrite a file a
    // concurrent writer re-created first), and load()'s sidecar check
    // turns any remaining missing-main window into a retryable failure
    // instead of an empty read.
    // Process-unique temp path: with a fixed shared name, a concurrent
    // recovery's writeFile could truncate the inode right after this one
    // links it into the canonical path (the shared temp path then aliases
    // the canonical file, so the truncate empties BOTH and strict readers
    // observe empty/partial JSON), or its cleanup unlink could remove the
    // temp between this writeFile and link, failing a recovery whose
    // sidecar is still recoverable. Crash leftovers are inert: the suffix
    // matches no probe or scan prefix, each crashed recovery leaves at most
    // one tiny file, and no sweeper may reclaim them (unlinking another
    // process's in-flight temp is exactly the race this name prevents).
    const emptyTmpPath = `${this.filePath}.empty-${process.pid}-${randomUUID()}.tmp`;
    await writeFile(
      emptyTmpPath,
      JSON.stringify({ version: 1, workspaces: {} } satisfies ExtensionMetadataFile, null, 2),
      "utf-8"
    );
    try {
      try {
        await link(emptyTmpPath, this.filePath);
      } catch (linkError) {
        if (!ExtensionMetadataService.isErrnoCode(linkError, "EEXIST")) {
          try {
            await copyFile(emptyTmpPath, this.filePath, constants.COPYFILE_EXCL);
          } catch (copyError) {
            if (!ExtensionMetadataService.isErrnoCode(copyError, "EEXIST")) {
              // Main path still missing: rethrow (retryable) so the caller's
              // re-read hits the sidecar guard instead of reading ENOENT.
              throw copyError;
            }
          }
        }
      }
    } finally {
      // Caller-owned path only; best-effort on every exit so throw paths do
      // not strand the temp.
      await unlink(emptyTmpPath).catch(() => undefined);
    }
    log.error(
      `Extension metadata file was corrupt; moved it to ${quarantinePath} and reset to empty`
    );
    return true;
  }

  /**
   * Resume a quarantine that a crash interrupted between quarantineCorruptFile's
   * rename and its completion: the main file is missing while the sidecar still
   * holds the moved bytes. Without this, every strict read rethrows the ENOENT
   * (load()'s sidecar guard classifies it retryable) until an unrelated writer
   * happens to save — activity hydration would retry forever on an idle
   * process. No-op when the main file reappeared or no sidecar exists.
   */
  private async resumeQuarantineRecovery(): Promise<void> {
    await this.withSerializedMutation(async () => {
      // Re-check inside the queue: a concurrent writer save or a sibling
      // strict read may already have recovered the main path. Probe with
      // ENOENT-only absence semantics: a transiently unprobeable sidecar
      // (EACCES/EIO) must propagate — reporting it absent would let the
      // caller accept a recreated partial main and (for the once-per-process
      // getAllSnapshots check) never look at the sidecar again.
      const quarantinePath = `${this.filePath}.corrupt`;
      if (!(await this.probeQuarantineSidecar())) {
        return;
      }
      const mainExists = await access(this.filePath).then(
        () => true,
        () => false
      );
      if (mainExists) {
        // Main was recreated during the crash window — possibly a PARTIAL
        // file another backend self-healed from the missing-main state.
        // Merge the sidecar's other entries back instead of abandoning them.
        await this.reconcileRecreatedMainWithSidecar(quarantinePath);
        return;
      }
      await this.completeQuarantineRecovery(quarantinePath);
    });
  }

  /**
   * A restore found the main path already re-created (EEXIST), or a resumed
   * recovery found both files present. The re-created file may be a PARTIAL
   * snapshot an older backend self-healed from the missing-main window;
   * treating it as authoritative would permanently hide every other
   * workspace's recency/goal/status while the full data sits in the sidecar.
   * Merge sidecar entries into the main file (per FIELD: main wins fields it
   * carries non-null values for — its writes are newer — while null/absent
   * fields fill from the sidecar's complete pre-crash entry; ids this
   * process write-tombstoned stay out) and consume the sidecar. Only
   * same-schema (version 1) sidecars can be merged: a
   * corrupt sidecar is left as the bounded fixed-name leftover, while a
   * newer-schema sidecar is restored to the canonical path (superseding the
   * recreated file, preserved as its own leftover). Must run inside
   * withSerializedMutation. Returns false (no empty reset happened).
   */
  private async reconcileRecreatedMainWithSidecar(quarantinePath: string): Promise<boolean> {
    // Generation identity captured before the read: consumption below is
    // scoped to exactly these bytes (see consumeQuarantineSidecar).
    const sidecarToken = await ExtensionMetadataService.statQuarantineToken(quarantinePath);
    let sidecarParsed: unknown;
    try {
      sidecarParsed = JSON.parse(await readFile(quarantinePath, "utf-8")) as unknown;
      // Bind the token to the bytes just read: another recovery can consume
      // the captured generation and install a NEWER one at the fixed path
      // between the stat and the read. Proceeding would merge the new bytes
      // under the OLD token — the consume then claims the new generation,
      // sees the token mismatch, and replays the same bytes a second time,
      // re-filling fields another backend explicitly cleared to null in
      // between (the null-fill merge is not idempotent across clears).
      // On mismatch leave the file for its own recovery pass (next read).
      const postReadToken = await ExtensionMetadataService.statQuarantineToken(quarantinePath);
      if (
        sidecarToken == null ||
        postReadToken == null ||
        !ExtensionMetadataService.tokensMatch(sidecarToken, postReadToken)
      ) {
        return false;
      }
    } catch (readError) {
      // Sidecar gone: a concurrent recovery consumed it and the recreated
      // main is all there is — nothing left to reconcile.
      if (ExtensionMetadataService.isErrnoCode(readError, "ENOENT")) {
        return false;
      }
      // Transient I/O failure (EACCES/EIO/...): the sidecar cannot be
      // verified, and reporting success would make the caller accept the
      // possibly-partial recreated main while the healthy sidecar is never
      // inspected again (loads stop probing it once the main path exists).
      // Propagate so the strict read stays retryable; only deterministic
      // parse corruption below stays as the bounded fixed-name leftover.
      if (!ExtensionMetadataService.isDeterministicCorruption(readError)) {
        throw readError;
      }
      return false;
    }
    if (ExtensionMetadataService.isUnsupportedVersion(sidecarParsed)) {
      // A newer build's schema stranded in the sidecar while an older-schema
      // backend re-created the main path (usually a partial ENOENT self-heal
      // holding one freshly mutated entry). Accepting the recreated file
      // would lose the newer data permanently: nothing re-inspects the
      // sidecar once the main path exists, so even re-upgrading reads the
      // partial file — and a later quarantine's rename would destroy the
      // sidecar bytes. Restore the newer bytes to the canonical path
      // (upgrade↔downgrade preservation; this build's readers then see the
      // same non-destructive retryable unsupported-version signal as any
      // downgrade overlap) and preserve the recreated file as a bounded
      // fixed-name leftover. A crash between any of the steps leaves the
      // resumable missing-main + sidecar state, which restores the
      // unsupported sidecar via completeQuarantineRecovery.
      //
      // Inspect the canonical bytes FIRST: during multi-version overlap the
      // canonical path may itself hold an unsupported file whose version is
      // same-or-newer than the sidecar's (e.g. a v3 writer recreated it
      // while a v2 sidecar remained). This build cannot order or merge
      // foreign schemas beyond their version numbers, so swapping blindly
      // would park the possibly-newer canonical copy at the unscanned
      // fixed leftover and restore older data over it. Keep the canonical
      // file in place and RETAIN the sidecar for a build that understands
      // both schemas (same retention precedent as a deterministically
      // corrupt sidecar: one no-op reconcile per read while the overlap
      // lasts). A transiently unreadable canonical propagates (retryable);
      // a missing or corrupt canonical proceeds with the swap exactly as
      // before.
      let canonicalParsed: unknown = null;
      try {
        canonicalParsed = JSON.parse(await readFile(this.filePath, "utf-8")) as unknown;
      } catch (canonicalReadError) {
        if (
          !ExtensionMetadataService.isErrnoCode(canonicalReadError, "ENOENT") &&
          !ExtensionMetadataService.isDeterministicCorruption(canonicalReadError)
        ) {
          throw canonicalReadError;
        }
      }
      if (
        ExtensionMetadataService.isUnsupportedVersion(canonicalParsed) &&
        (canonicalParsed as { version: number }).version >=
          (sidecarParsed as { version: number }).version
      ) {
        return false;
      }
      // The moved bytes are superseded BY DECISION (the newer schema wins),
      // so they finalize to the fixed leftover name immediately — no
      // re-validation pass ever re-reads them.
      const inflightLeftoverPath = await this.moveMainAsideAsRecreatedLeftover();
      await this.finalizeRecreatedLeftover(inflightLeftoverPath);
      try {
        await link(quarantinePath, this.filePath);
      } catch (linkError) {
        if (ExtensionMetadataService.isErrnoCode(linkError, "EEXIST")) {
          // Yet another writer re-created the main path mid-swap: re-enter
          // with the new file (the leftover keeps the latest superseded one).
          return this.reconcileRecreatedMainWithSidecar(quarantinePath);
        }
        try {
          await copyFile(quarantinePath, this.filePath, constants.COPYFILE_EXCL);
        } catch (copyError) {
          if (ExtensionMetadataService.isErrnoCode(copyError, "EEXIST")) {
            return this.reconcileRecreatedMainWithSidecar(quarantinePath);
          }
          // Main path missing with the newer bytes still in the sidecar:
          // rethrow (retryable) — the resumed recovery restores them.
          throw copyError;
        }
      }
      await this.consumeQuarantineSidecar(quarantinePath, sidecarToken);
      return false;
    }
    if (!ExtensionMetadataService.isValidMetadataFileShape(sidecarParsed)) {
      return false;
    }
    // Resolve tombstone revalidations BEFORE reading the main file: the
    // probes await config, and holding a pre-probe main snapshot across
    // those awaits would let the save below write stale data over a
    // concurrent backend's newer write. The tombstone may be stale (a
    // downgraded backend can re-register a deterministic legacy id after
    // this process pruned it), and the sidecar may hold that workspace's
    // ONLY copy — consumed below, so a wrong drop is permanent, unlike
    // write suppression, which self-heals. Without a probe the local
    // removal knowledge stands; a FAILING probe aborts the reconcile
    // (retryable) rather than consuming the sidecar on unknowable evidence.
    // Same generation contract as recheckTombstonedRegistration: a
    // tombstone republished mid-probe survives the stale positive.
    for (const workspaceId of Object.keys(sidecarParsed.workspaces)) {
      if (!this.deletedWorkspaceIds.has(workspaceId) || this.registrationProbe == null) {
        continue;
      }
      const generationBefore = this.deletedWorkspaceIds.get(workspaceId);
      const registered = await this.registrationProbe(workspaceId);
      if (registered && this.deletedWorkspaceIds.get(workspaceId) === generationBefore) {
        this.liftTombstone(workspaceId);
      }
    }
    let main: ExtensionMetadataFile;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf-8")) as unknown;
      if (!ExtensionMetadataService.isValidMetadataFileShape(parsed)) {
        // Corrupt/newer-schema main: leave both files for the normal read
        // classification paths rather than merging across schemas.
        return false;
      }
      main = parsed;
    } catch (readError) {
      // Main vanished again mid-reconcile: back to the resumable
      // missing-main state the normal read paths already handle.
      if (ExtensionMetadataService.isErrnoCode(readError, "ENOENT")) {
        return false;
      }
      // Same transient-I/O contract as the sidecar read above: an
      // unverifiable main must stay retryable, not report success.
      if (!ExtensionMetadataService.isDeterministicCorruption(readError)) {
        throw readError;
      }
      return false;
    }
    let modified = false;
    for (const [workspaceId, entry] of Object.entries(sidecarParsed.workspaces)) {
      if (this.deletedWorkspaceIds.has(workspaceId)) {
        // Still tombstoned after the (pre-main-read) revalidation pass:
        // the local removal knowledge stands.
        continue;
      }
      if (!(workspaceId in main.workspaces)) {
        // Sidecar-only entry: by definition no writer touched it since the
        // quarantine (a live workspace's writes land in the recreated main),
        // so a truthy streaming flag is a crash leftover. initialize()'s
        // clearStaleStreaming already ran against the main file before this
        // reconcile, so merging the flag verbatim would leave the workspace
        // "streaming" forever; a genuinely streaming workspace re-asserts
        // the flag with its next write.
        main.workspaces[workspaceId] =
          entry !== null &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          (entry as { streaming?: unknown }).streaming === true
            ? { ...entry, streaming: false }
            : entry;
        modified = true;
        continue;
      }
      // Same id on both sides: the recreated main entry is commonly a
      // PARTIAL self-heal (e.g. a recency write initializes every other
      // field to its default), so treating it as wholly authoritative would
      // discard the sidecar entry's goal/status/model fields. Field-level
      // merge instead: main wins every field it carries a non-null value
      // for (its writes are newer); null/absent fields fill from the
      // sidecar. An explicit pre-crash clear (null) can be re-filled with a
      // stale value — the lesser loss than dropping every unaffected field
      // (upgrade↔downgrade data preservation). `streaming` is never filled
      // from the sidecar for the crash-leftover reason above.
      const target: unknown = main.workspaces[workspaceId];
      const sidecarEntry: unknown = entry;
      if (
        sidecarEntry !== null &&
        typeof sidecarEntry === "object" &&
        !Array.isArray(sidecarEntry) &&
        (target === null || typeof target !== "object" || Array.isArray(target))
      ) {
        // Uncoercible main entry (null/primitive/array) shadowing a healthy
        // sidecar entry: no field merge is possible, and the sidecar is
        // consumed below — leaving the malformed value would permanently
        // lose the only valid copy. Restore the sidecar entry (streaming
        // cleared, same crash-leftover rule as sidecar-only entries).
        main.workspaces[workspaceId] =
          (sidecarEntry as { streaming?: unknown }).streaming === true
            ? { ...entry, streaming: false }
            : entry;
        modified = true;
        continue;
      }
      if (
        target !== null &&
        typeof target === "object" &&
        !Array.isArray(target) &&
        sidecarEntry !== null &&
        typeof sidecarEntry === "object" &&
        !Array.isArray(sidecarEntry)
      ) {
        const targetRecord = target as Record<string, unknown>;
        for (const [field, value] of Object.entries(sidecarEntry)) {
          if (field === "streaming" || value == null) {
            continue;
          }
          if (targetRecord[field] == null) {
            targetRecord[field] = value;
            modified = true;
          }
        }
      }
    }
    if (modified) {
      await this.save(main);
    }
    // Consumed either way: every surviving sidecar entry is now represented
    // at the main path.
    await this.consumeQuarantineSidecar(quarantinePath, sidecarToken);
    return false;
  }

  /**
   * load() with self-healing for deterministic corruption. Strict reads must
   * propagate transient failures (renderer keeps last-known state and
   * retries), but deterministic corruption would fail every retry forever on
   * an idle process — no subsequent list read or metadata writer is
   * guaranteed to repair the file. Quarantine the corrupt bytes and re-read:
   * the post-quarantine state is authoritative. Shared by getAllSnapshots
   * and getSnapshot so per-workspace emit reads (workflow-run/bash-monitor
   * handlers, which drop their emissions on error) self-heal the same way
   * instead of leaving a workflow-only workspace's stale activity pinned in
   * the renderer indefinitely.
   */
  private async loadWithCorruptionRecovery(options?: {
    throwOnError?: boolean;
  }): Promise<ExtensionMetadataFile> {
    try {
      return await this.load(options);
    } catch (error) {
      if (ExtensionMetadataService.isDeterministicCorruption(error)) {
        try {
          await this.quarantineCorruptFile();
        } catch (quarantineError) {
          // ENOENT means the file vanished between validation and rename
          // (another process moved it) — the re-read below decides the
          // outcome. Anything else (rename denied, sidecar unverifiable,
          // restore failed) must stay a retryable failure: an ENOENT re-read
          // would masquerade as authoritative empty while the moved bytes may
          // hold healthy data.
          if (!ExtensionMetadataService.isErrnoCode(quarantineError, "ENOENT")) {
            throw quarantineError;
          }
        }
      } else if (ExtensionMetadataService.isErrnoCode(error, "ENOENT")) {
        // load() only propagates ENOENT while the quarantine sidecar exists:
        // a crash between quarantine's rename and its completion left the
        // recovery half-done, and nothing else finishes it (lenient writer
        // reads self-heal in memory without saving). Resume it here so
        // strict reads stop failing on every retry across restarts.
        await this.resumeQuarantineRecovery();
      } else {
        throw error;
      }
      return this.load(options);
    }
  }

  async getAllSnapshots(options?: {
    throwOnError?: boolean;
  }): Promise<Map<string, WorkspaceActivitySnapshot>> {
    let data: ExtensionMetadataFile = await this.loadWithCorruptionRecovery(options);
    // A crash between quarantineCorruptFile's rename and its completion can
    // strand the full snapshot in the sidecar while another backend
    // recreates a VALID (typically partial, single-entry) main file from
    // the missing-main window — leaving no ENOENT or corruption for the
    // other recovery triggers. Quarantines are cross-process, so this can
    // happen at ANY point in this process's lifetime, not just before
    // startup: probe the fixed sidecar path on every authoritative read (a
    // process-lifetime latch would hide a sidecar stranded after its first
    // read until restart). The probe is one access() syscall next to the
    // full-file read this method already does; the reconcile only runs when
    // a sidecar actually exists. Failures propagate so the read stays
    // retryable rather than presenting a partial file as authoritative. A
    // deterministically corrupt leftover (kept for inspection by design)
    // costs one no-op reconcile per read while it exists — corruption
    // incidents are rare and the leftover is consumed by the next
    // quarantine or manual cleanup.
    if (await this.reconcileLeftoverSidecarIfPresent()) {
      data = await this.load(options);
    }
    const map = new Map<string, WorkspaceActivitySnapshot>();
    for (const [workspaceId, entry] of Object.entries(data.workspaces)) {
      const snapshot = this.toSnapshot(entry);
      if (snapshot) {
        map.set(workspaceId, snapshot);
      }
    }
    return map;
  }
}

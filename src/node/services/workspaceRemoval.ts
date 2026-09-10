/**
 * Workspace-removal durability (r61).
 *
 * Process-local cancellation (abort controllers + bounded drains) cannot
 * reach two writers: follow-on consolidation runs registered after the
 * cancel loop, and dream/harvest runs executing in OTHER backend processes
 * (multi-instance mode). Two cooperating pieces close the remaining "late
 * memory write recreates a removed session directory" races:
 *
 * - A durable removal TOMBSTONE under `<xumHome>/locks/`, published while
 *   the memory target locks are held, immediately before the session
 *   directory is deleted. MemoryService re-checks it inside those same
 *   locks at every mutation commit point, so any backend observes removal
 *   at commit time even when the remover could not abort its in-flight run.
 * - Session-directory deletion SERIALIZED with the memory target mutation
 *   locks (the workspace store root plus the coarse global/project memory
 *   root, whose mutations journal into this session directory): a write
 *   already inside its critical section either commits before the deletion
 *   (and is deleted with the directory) or acquires the lock afterwards and
 *   refuses on the tombstone. Lock acquisition stays FAIL-CLOSED (the
 *   target-lock 2s timeout): refusing to delete under a wedged writer beats
 *   deleting the directory out from under a write that would recreate it —
 *   the caller keeps the session directory as a recoverable orphan instead.
 *
 * Tombstones are retained after successful removal: workspace IDs are
 * unique and never reused, the files are tiny, and retention is what lets a
 * foreign backend's still-running consolidation refuse arbitrarily late.
 */

import crypto from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import writeFileAtomic from "write-file-atomic";

import assert from "@/common/utils/assert";
import { log } from "@/node/services/log";
import {
  memoryMutationLockKey,
  withTargetMutationLocks,
} from "@/node/services/refinement/targetMutationLocks";
import { hasErrorCode } from "@/node/services/tools/skillFileUtils";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";

/**
 * Removal failed WITHOUT a durable tombstone (r63). Callers must abort
 * workspace deregistration in this case: without the marker, a foreign
 * backend's consolidation would keep mutating and journaling into the
 * retained session directory forever once the transient failure (e.g.
 * ENOSPC) clears — while the workspace no longer exists anywhere else.
 * Keeping the workspace registered keeps removal retryable instead.
 */
export class TombstoneNotDurableError extends Error {
  constructor(workspaceId: string, options?: ErrorOptions) {
    super(
      `Removal tombstone for workspace ${workspaceId} could not be made durable; aborting removal`,
      options
    );
    this.name = "TombstoneNotDurableError";
  }
}

/**
 * Cross-process history write lock path (r63) — OUTSIDE the session
 * directory. The lock used to live at `<sessionDir>/history.lock`, which
 * removal deletes with the directory: a foreign backend's in-flight append
 * would resume against a vanished lock and recreate the session directory
 * via its own ensurePrivateDir. External placement lets removal acquire the
 * SAME lock before deleting, and lets the post-acquisition tombstone gate in
 * HistoryService refuse late appends. (Mixed-version fleets briefly lose
 * cross-process append serialization during a rolling upgrade; multi-instance
 * mode is an experimental env flag, and single-instance safety is unaffected
 * because the in-process history mutex still serializes.)
 */
export function historyWriteLockPath(rootDir: string, workspaceId: string): string {
  assert(workspaceId.length > 0, "historyWriteLockPath requires a workspace id");
  const digest = crypto.createHash("sha256").update(workspaceId).digest("hex").slice(0, 32);
  return path.join(rootDir, "locks", `history-${digest}.lock`);
}

/** Durable tombstone path for one removed workspace (hashed: IDs are user-influenced). */
export function workspaceRemovalTombstonePath(rootDir: string, workspaceId: string): string {
  assert(workspaceId.length > 0, "workspaceRemovalTombstonePath requires a workspace id");
  const digest = crypto.createHash("sha256").update(workspaceId).digest("hex").slice(0, 32);
  return path.join(rootDir, "locks", `workspace-removed-${digest}.json`);
}

/**
 * Cross-process refine serialization lock path (r66) — OUTSIDE the session
 * directory, for the same reason as historyWriteLockPath (r63): the lock
 * used to live at `<sessionDir>/refine-apply.lock`, and acquireProcessFileLock
 * mkdirs the lock's parent — so a foreign backend's /refine (or a
 * context-discard serialization) landing after removal would RECREATE the
 * deleted session directory just by acquiring the lock. External placement
 * lets removal hold this same lock across its tombstone+delete critical
 * section, serializing with a foreign apply's staged-set/progress writes.
 * (Same mixed-version rolling-upgrade caveat as the history lock; the
 * multi-instance mode this protects is an experimental env flag.)
 */
export function refineApplyLockPath(rootDir: string, workspaceId: string): string {
  assert(workspaceId.length > 0, "refineApplyLockPath requires a workspace id");
  const digest = crypto.createHash("sha256").update(workspaceId).digest("hex").slice(0, 32);
  return path.join(rootDir, "locks", `refine-apply-${digest}.lock`);
}

/**
 * True when a durable removal tombstone exists for this workspace. This is
 * the authoritative pre-commit gate for memory/usage writers, so it FAILS
 * CLOSED (r62): only a provable ENOENT means "not removed" — any other
 * access failure (transient I/O error, broken locks dir) reports removal so
 * a writer never commits into a possibly-deleted session directory it
 * cannot verify. Callers surface the refusal as a retryable error.
 */
export async function isWorkspaceRemovalTombstoned(
  rootDir: string,
  workspaceId: string
): Promise<boolean> {
  try {
    await fsPromises.access(workspaceRemovalTombstonePath(rootDir, workspaceId));
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ENOENT");
  }
}

/**
 * Delete a workspace's session directory serialized with the memory target
 * mutation locks, publishing the durable removal tombstone inside the same
 * critical section (see module doc). Throws when a lock cannot be acquired
 * (fail-closed) or the tombstone cannot be published; the session directory
 * is only ever deleted after the tombstone is durable.
 */
export async function removeSessionDirUnderMemoryLocks(args: {
  rootDir: string;
  sessionDir: string;
  workspaceId: string;
  /**
   * Unique ID of THIS removal attempt, stamped into the tombstone (r66).
   * The caller's compensating rollback deletes the marker only while it
   * still carries this attempt's ID (see rollbackRemovalTombstoneIfOwned):
   * with two backends removing the same workspace concurrently, an
   * unconditional rollback rm would delete the marker the OTHER (possibly
   * succeeding or still-active) attempt relies on.
   */
  attemptId: string;
}): Promise<void> {
  assert(args.sessionDir.length > 0, "removeSessionDirUnderMemoryLocks requires a session dir");
  // Crash clearly on a malformed config (test stubs, future refactors): an
  // undefined rootDir would otherwise surface as an obscure path.resolve
  // TypeError from deep inside the lock-key derivation.
  assert(
    typeof args.rootDir === "string" && args.rootDir.length > 0,
    "removeSessionDirUnderMemoryLocks requires a rootDir"
  );
  // Same key derivations as MemoryService.storeLockKey: the workspace store
  // root lives inside the session directory; global/project mutations hold
  // the coarse `<rootDir>/memory` key while journaling into this session dir.
  const workspaceMemoryKey = memoryMutationLockKey(
    args.rootDir,
    path.join(args.sessionDir, "memory")
  );
  const sharedMemoryKey = memoryMutationLockKey(args.rootDir, path.join(args.rootDir, "memory"));
  // The session dir itself is a third target key (r63): session-scoped
  // sidecar writers (headless usage) serialize their tombstone check +
  // commit against this same key, closing their check→write window.
  const sessionDirKey = path.resolve(args.sessionDir);
  assert(args.attemptId.length > 0, "removeSessionDirUnderMemoryLocks requires an attemptId");
  const publishTombstone = async (): Promise<void> => {
    const tombstonePath = workspaceRemovalTombstonePath(args.rootDir, args.workspaceId);
    await fsPromises.mkdir(path.dirname(tombstonePath), { recursive: true });
    await writeFileAtomic(
      tombstonePath,
      JSON.stringify({
        workspaceId: args.workspaceId,
        removedAt: Date.now(),
        attemptId: args.attemptId,
      })
    );
  };
  try {
    // Refine serialization (r66) — acquired FIRST (r67): a /refine apply in
    // ANOTHER backend is untouched by the remover's process-local
    // cancellation and holds this same (session-dir-external) lock across
    // its staged-set loads, per-edit progress rewrites, and skill/journal
    // commits. An admitted apply acquires the refine lock and THEN needs the
    // memory-target and history locks (per-edit mutations + the audit-row
    // append); if removal took those inner locks before contending on the
    // refine lock, the two paths would wait in opposite order until timeout,
    // and an apply that already mutated memory could lose its audit/rollback
    // record when removal then deletes the retained staged state and session
    // journal. Refine lock first means admitted applies deterministically
    // drain before teardown takes the inner locks; an apply starting after
    // this acquisition refuses on the in-lock tombstone gate in
    // RefineService. Fail-closed like the other locks: a long apply blocks
    // removal into the orphan path rather than having the directory deleted
    // out from under its writes.
    await using _refineLock = await acquireProcessFileLock({
      lockPath: refineApplyLockPath(args.rootDir, args.workspaceId),
      timeoutMs: 10_000,
      label: "refine serialization lock (removal)",
    });
    await withTargetMutationLocks(
      args.rootDir,
      [sessionDirKey, workspaceMemoryKey, sharedMemoryKey],
      async () => {
        // History append serialization (r63): a foreign backend's in-flight
        // stream can be mid-append under the history write lock; acquiring
        // that same (session-dir-external) lock here means the append either
        // commits before the deletion below or starts afterwards and hits
        // HistoryService's in-lock tombstone gate.
        await using _historyLock = await acquireProcessFileLock({
          lockPath: historyWriteLockPath(args.rootDir, args.workspaceId),
          timeoutMs: 10_000,
          label: "history write lock (removal)",
        });
        // Tombstone BEFORE rm: once the locks release, any waiting writer
        // re-checks it pre-commit (inside its own lock) and refuses, so the
        // deleted directory cannot be recreated by a late mutation or
        // journal append.
        await publishTombstone();
        await fsPromises.rm(args.sessionDir, { recursive: true, force: true });
      }
    );
  } catch (error) {
    // Fail-closed orphan path (r62): a wedged writer blocks the deletion,
    // but the caller proceeds to deregister the workspace regardless — so
    // the terminal marker must still become durable or a foreign backend
    // would keep mutating memory and journaling into the retained orphan
    // forever. Publishing outside the locks is safe on THIS path precisely
    // because the directory is not deleted: a writer mid-commit lands in
    // the orphan, and every later mutation observes the tombstone.
    try {
      await publishTombstone();
    } catch (publishError) {
      // No durable marker could be written at all (r63, e.g. ENOSPC):
      // deregistering now would leave the orphan writable again the moment
      // the transient failure clears. Signal the caller to ABORT the
      // removal so the workspace stays registered and retryable.
      throw new TombstoneNotDurableError(args.workspaceId, { cause: publishError });
    }
    throw error;
  }
}

/**
 * Compensating tombstone rollback for a removal whose config deregistration
 * failed (r66). Deletes the marker ONLY while it still records this
 * attempt's ID and the workspace is still registered: with
 * XUM_ALLOW_MULTIPLE_INSTANCES=1 two backends can remove the same workspace
 * concurrently (removingWorkspaces is process-local), and an unconditional
 * rm here would delete the marker a CONCURRENT attempt republished (its
 * removal may be mid-flight or already deregistered) — leaving a completed
 * removal without its durable gate, so late foreign writers could recreate
 * the deleted session directory. Runs under the sessionDir target mutation
 * lock so the read→verify→delete cannot interleave with a concurrent
 * attempt's locked republication. Fails closed: an unreadable or foreign
 * marker is retained (the age-gated startup self-heal reclaims true
 * residue). Returns true when the marker was deleted.
 */
export async function rollbackRemovalTombstoneIfOwned(args: {
  rootDir: string;
  sessionDir: string;
  workspaceId: string;
  attemptId: string;
  workspaceStillRegistered: () => boolean;
}): Promise<boolean> {
  const tombstonePath = workspaceRemovalTombstonePath(args.rootDir, args.workspaceId);
  return await withTargetMutationLocks(args.rootDir, [path.resolve(args.sessionDir)], async () => {
    let parsed: { attemptId?: unknown };
    try {
      parsed = JSON.parse(await fsPromises.readFile(tombstonePath, "utf-8")) as {
        attemptId?: unknown;
      };
    } catch (error) {
      // Missing marker: nothing to roll back. Unreadable: keep it.
      if (!hasErrorCode(error, "ENOENT")) {
        log.warn("Removal tombstone unreadable during rollback; retaining it", {
          workspaceId: args.workspaceId,
        });
      }
      return false;
    }
    if (parsed.attemptId !== args.attemptId) {
      return false;
    }
    // A concurrent attempt that already DEREGISTERED the workspace relies
    // on this marker as its terminal state even if it never republished
    // (it may have reused our marker's window); only restore usability
    // when the workspace is provably still registered.
    if (!args.workspaceStillRegistered()) {
      return false;
    }
    await fsPromises.rm(tombstonePath, { force: true });
    return true;
  });
}

/**
 * Minimum tombstone age before the startup self-heal below may reclaim it.
 * A FRESH tombstone for a still-registered workspace is normal: removal
 * publishes the marker before config deregistration lands, so another
 * backend's in-flight removal looks exactly like the failure residue for a
 * few seconds. Only markers old enough that no healthy removal could still
 * be between those two steps are healed.
 */
export const REMOVAL_TOMBSTONE_HEAL_MIN_AGE_MS = 10 * 60_000;

/**
 * Keep a just-published removal tombstone visibly ALIVE while the removal
 * that published it is still running (r65). Marker age alone cannot
 * distinguish "removal wedged between session deletion and config
 * deregistration for longer than the guard window" (e.g. a hung MCP server
 * close) from "removal crashed leaving rollback residue" — both present an
 * old tombstone plus a still-registered workspace, and healing a LIVE
 * removal's marker would let foreign history/sidecar writers pass their
 * durable removal gate and recreate the session directory before
 * deregistration lands. The remover renews the marker's mtime on an unref'd
 * timer until the removal settles, and the self-heal ages tombstones by
 * MTIME: a live (even wedged) removal keeps its marker fresh, while a
 * crashed one stops renewing and ages into healable residue. A late tick
 * after the compensating rollback deleted the marker is harmless — utimes
 * never recreates the file.
 */
export function startRemovalTombstoneLease(rootDir: string, workspaceId: string): Disposable {
  const tombstonePath = workspaceRemovalTombstonePath(rootDir, workspaceId);
  const timer = setInterval(() => {
    const now = new Date();
    void fsPromises.utimes(tombstonePath, now, now).catch(() => undefined);
  }, REMOVAL_TOMBSTONE_HEAL_MIN_AGE_MS / 4);
  timer.unref();
  return {
    [Symbol.dispose]: () => clearInterval(timer),
  };
}

/**
 * Startup self-heal (r63): a REGISTERED workspace with an old removal
 * tombstone is the residue of a removal whose config deregistration failed
 * AND whose compensating tombstone rollback also failed — without healing,
 * every memory/history/usage mutation for that workspace stays refused
 * across restarts (permanently bricked). Deleting the marker restores the
 * workspace; the user can retry removal. Tombstones for workspaces absent
 * from config (the normal terminal state) are retained forever. Never
 * throws: startup initialization must not crash the app.
 */
export async function healRemovalTombstonesForRegisteredWorkspaces(config: {
  rootDir: string;
  findWorkspace(workspaceId: string): unknown;
}): Promise<void> {
  let entries: string[];
  try {
    entries = await fsPromises.readdir(path.join(config.rootDir, "locks"));
  } catch {
    return; // No locks dir: nothing to heal.
  }
  for (const entry of entries) {
    if (!entry.startsWith("workspace-removed-") || !entry.endsWith(".json")) continue;
    const filePath = path.join(config.rootDir, "locks", entry);
    try {
      const parsed = JSON.parse(await fsPromises.readFile(filePath, "utf-8")) as {
        workspaceId?: unknown;
        removedAt?: unknown;
      };
      if (typeof parsed.workspaceId !== "string" || typeof parsed.removedAt !== "number") continue;
      // Age by MTIME, not the immutable removedAt payload (r65): a removal
      // that is merely SLOW keeps renewing its marker's mtime through
      // startRemovalTombstoneLease, so it never looks like residue here no
      // matter how long deregistration takes; only a removal whose process
      // died stops renewing and ages past the guard window.
      const stat = await fsPromises.stat(filePath);
      if (Date.now() - stat.mtimeMs < REMOVAL_TOMBSTONE_HEAL_MIN_AGE_MS) continue;
      if (config.findWorkspace(parsed.workspaceId) == null) continue;
      await fsPromises.rm(filePath, { force: true });
      log.warn(
        "Healed a removal tombstone for a still-registered workspace (previous removal failed mid-flight)",
        { workspaceId: parsed.workspaceId }
      );
    } catch (error) {
      // Per-entry isolation: one unreadable marker must not stop the sweep.
      log.debug("Skipping unreadable removal tombstone during self-heal", { entry, error });
    }
  }
}

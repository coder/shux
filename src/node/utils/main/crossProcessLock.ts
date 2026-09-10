import { randomBytes } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { hasErrorCode } from "@/node/services/tools/skillFileUtils";

/**
 * Cross-process advisory file lock.
 *
 * In-process Promise queues serialize only one service instance; two
 * processes sharing the same Xum home (ALLOW_MULTIPLE_INSTANCES, a desktop
 * app alongside `xum server`) each have their own queue, so their
 * read-modify-write transactions on shared files can interleave and the last
 * writer silently drops the other's changes. Holders record `{pid, token,
 * acquiredAt}`.
 *
 * Publication is ATOMIC-WITH-CONTENT: the holder record is written to a temp
 * file and hard-linked into place. link() is exclusive (EEXIST when the path
 * exists) and the linked file carries its complete content the instant it
 * appears, so no observer can ever read a partially written lock and misjudge
 * it corrupt — the failure mode of exclusive-create-then-write.
 *
 * STALE RECLAMATION and RELEASE both serialize through a short-lived mkdir
 * mutex and never make the lock path absent while any competitor could act
 * on it: reclaimers take ownership by atomically REPLACING the lock content
 * in place (temp + rename-over), and release performs its verify-then-unlink
 * inside the same mutex so a delayed unlink can never destroy a successor's
 * confirmed lock. See reclaimStaleLock / acquireCrossProcessLock.
 */
export interface CrossProcessLockOptions {
  /** Absolute path of the lock file. Its parent directory must exist. */
  lockPath: string;
  /** How long an acquire waits on a live holder before failing. */
  acquireTimeoutMs: number;
  /**
   * Pid-reuse guard: holders older than this are reclaimable even when a
   * process with the recorded pid is alive. Choose comfortably above the
   * longest legitimate hold time.
   */
  staleMs: number;
  /** Error message thrown when the acquire timeout elapses. */
  timeoutMessage: string;
}

export interface LockHolder {
  pid: number;
  token: string;
  acquiredAt: number;
}

/** Tolerate tiny wall-clock adjustments, but reject locks that could stay live indefinitely. */
const MAX_LOCK_FUTURE_SKEW_MS = 60_000;

/** Parse the lock file; undefined when missing/unreadable/corrupt. */
async function readLockHolder(lockPath: string): Promise<LockHolder | undefined> {
  try {
    const parsed = JSON.parse(await fsPromises.readFile(lockPath, "utf-8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const { pid, token, acquiredAt } = parsed as Record<string, unknown>;
    if (
      typeof pid !== "number" ||
      !Number.isInteger(pid) ||
      pid <= 0 ||
      typeof token !== "string" ||
      token.length === 0 ||
      typeof acquiredAt !== "number" ||
      !Number.isFinite(acquiredAt) ||
      acquiredAt <= 0 ||
      acquiredAt > Date.now() + MAX_LOCK_FUTURE_SKEW_MS
    ) {
      return undefined;
    }
    return { pid, token, acquiredAt };
  } catch {
    return undefined;
  }
}

/**
 * Liveness check for a competing holder. Reclaims dead pids immediately; the
 * stale ceiling guards pid reuse. A same-pid holder is NOT reclaimable: it is
 * another service instance in this very process (callers serialize their own
 * instance with an in-process queue first), and a lock leaked by a previous
 * same-pid process is covered by the stale ceiling like any other pid-reuse
 * case.
 */
function holderAlive(holder: LockHolder, staleMs: number): boolean {
  if (Date.now() - holder.acquiredAt > staleMs) {
    return false;
  }
  if (holder.pid === process.pid) {
    return true;
  }
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch (error) {
    // EPERM = alive but owned by another user; anything else (ESRCH) = dead.
    return hasErrorCode(error, "EPERM");
  }
}

function sleepWithJitter(baseMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, baseMs + Math.floor(Math.random() * baseMs)));
}

/**
 * A mutex holder stuck longer than this inside the (tiny) critical section is
 * presumed crashed and its mutex is broken. The section performs only a
 * handful of filesystem operations, so seconds of margin is plenty.
 */
const RECLAIM_MUTEX_STALE_MS = 15_000;

/**
 * Content this build's writers can never produce mid-write (link/rename
 * publication is atomic-with-content), but a DIFFERENT build sharing the
 * same home — or a crashed editor — might. Corrupt content younger than this
 * grace is retried instead of reclaimed, so an in-progress non-atomic writer
 * gets time to finish publishing before anyone steals its lock.
 */
const CORRUPT_LOCK_GRACE_MS = 2_000;

/**
 * Enter the reclaim/release mutex for `lockPath`. Returns an exit function,
 * or undefined when a competitor holds a fresh mutex (back off and retry).
 * A mutex dir older than RECLAIM_MUTEX_STALE_MS (crashed holder) is broken.
 * Ownership is witnessed by a token file so a competitor that breaks our
 * mutex during an arbitrary pause is detectable via `owns()`. The token is
 * published with exclusive create: a process that stalled between its mkdir
 * and this publication long enough to be broken as stale must find the
 * successor's owner file and abandon, not overwrite it — a plain write would
 * let BOTH sides leave believing they hold the mutex.
 */
async function enterLockMutex(
  lockPath: string
): Promise<{ owns: () => Promise<boolean>; exit: () => Promise<void> } | undefined> {
  const mutexDir = `${lockPath}.reclaim`;
  const mutexToken = randomBytes(16).toString("hex");
  const mutexTokenFile = path.join(mutexDir, "owner");

  try {
    await fsPromises.mkdir(mutexDir);
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
    // Break a mutex abandoned by a crashed holder, then retry ONCE.
    // (A live holder finishes in milliseconds; see the stale ceiling.)
    try {
      const stat = await fsPromises.stat(mutexDir);
      if (Date.now() - stat.mtimeMs <= RECLAIM_MUTEX_STALE_MS) {
        return undefined;
      }
      await fsPromises.rm(mutexDir, { recursive: true, force: true });
    } catch {
      return undefined;
    }
    try {
      await fsPromises.mkdir(mutexDir);
    } catch {
      return undefined;
    }
  }
  try {
    await fsPromises.writeFile(mutexTokenFile, mutexToken, { flag: "wx" });
  } catch (error) {
    // EEXIST: a competitor broke our apparently-abandoned dir and published
    // its own owner (or we broke theirs and lost the publish race) — exactly
    // one publisher may win, and it is not us. ENOENT: the dir itself was
    // broken mid-publication. Both mean "abandon and let the caller retry".
    if (hasErrorCode(error, "EEXIST") || hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }

  const owns = async (): Promise<boolean> => {
    try {
      return (await fsPromises.readFile(mutexTokenFile, "utf-8")) === mutexToken;
    } catch {
      return false;
    }
  };
  return {
    owns,
    exit: async () => {
      // Release only OUR mutex: a competitor that broke ours owns the dir now.
      if (await owns()) {
        await fsPromises.rm(mutexDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

/**
 * Take ownership of a stale/corrupt lock WITHOUT ever making the lock path
 * absent. Returns the token that now owns the lock, or undefined when the
 * reclaim was abandoned (competitor holds the mutex, the holder turned out
 * live/fresh on re-read, corrupt content is within its publication grace, or
 * the file disappeared).
 *
 * Protocol:
 * 1. Enter the mkdir mutex (shared with release — see enterLockMutex).
 * 2. Inside the mutex, RE-READ the lock and re-evaluate staleness on the
 *    fresh content. A lock that changed since the caller's observation
 *    belongs to a new owner and is left untouched. Corrupt content younger
 *    than CORRUPT_LOCK_GRACE_MS is retried, not reclaimed: this build's
 *    writers publish atomically-with-content, but a different build's
 *    exclusive-create-then-write must not be stolen mid-publication.
 * 3. Take ownership by atomically REPLACING the file content (temp +
 *    rename-over). The path never goes absent, so a competing link-create
 *    cannot slip in between "remove stale" and "create ours". Immediately
 *    before the rename, re-verify we still own the mutex (a competitor may
 *    have broken it during an arbitrary pause); abandon if not.
 * 4. Confirm ownership with a post-rename re-read (same as the create path).
 *
 * Exported for tests.
 */
export async function reclaimStaleLock(
  lockPath: string,
  staleMs: number
): Promise<string | undefined> {
  const mutex = await enterLockMutex(lockPath);
  if (mutex === undefined) {
    return undefined;
  }
  try {
    // Fresh re-read INSIDE the mutex: the caller's observation may predate a
    // completed reclaim-and-acquire by a competitor. A live fresh holder is
    // never touched. A MISSING file aborts — the create path handles absence.
    let fileStat;
    try {
      fileStat = await fsPromises.stat(lockPath);
    } catch {
      return undefined;
    }
    const current = await readLockHolder(lockPath);
    if (current !== undefined && holderAlive(current, staleMs)) {
      return undefined;
    }
    if (current === undefined && Date.now() - fileStat.mtimeMs <= CORRUPT_LOCK_GRACE_MS) {
      // Possibly a non-atomic writer (older build) mid-publication: give it
      // its grace; the caller retries and reclaims only persistent corruption.
      return undefined;
    }

    const token = randomBytes(16).toString("hex");
    const tempPath = `${lockPath}.claim-${token}`;
    await fsPromises.writeFile(
      tempPath,
      JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() })
    );
    // Last-instant mutex re-check: if we paused long enough for a competitor
    // to break our mutex and reclaim, our rename would clobber ITS confirmed
    // lock. (A pause landing exactly between this check and the rename is the
    // residual window; it requires a >15s stall across two adjacent syscalls.)
    if (!(await mutex.owns())) {
      await fsPromises.rm(tempPath, { force: true }).catch(() => undefined);
      return undefined;
    }
    try {
      await fsPromises.rename(tempPath, lockPath);
    } catch (error) {
      await fsPromises.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
    const confirmed = await readLockHolder(lockPath);
    return confirmed?.token === token ? token : undefined;
  } finally {
    await mutex.exit();
  }
}

/**
 * Acquire the lock; returns the release function.
 *
 * Release serializes through the same mutex as reclamation so its
 * verify-then-unlink is atomic against a reclaimer replacing the file: a
 * holder releasing right at the stale ceiling could otherwise read its own
 * token, pause, and then delete the SUCCESSOR'S confirmed lock. If the mutex
 * stays contended past a bounded retry budget, the lock file is left in
 * place — it is then reclaimed as a dead/stale holder, never mis-deleted.
 */
export async function acquireCrossProcessLock(
  options: CrossProcessLockOptions
): Promise<() => Promise<void>> {
  const { lockPath, acquireTimeoutMs, staleMs, timeoutMessage } = options;
  await fsPromises.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + acquireTimeoutMs;

  // LEASE RENEWAL: `acquiredAt` is a renewable lease timestamp, not a birth
  // time. A LIVE transaction legitimately exceeding staleMs (e.g. a plugin
  // uninstall pruning many contended workspaces under the mutation lock)
  // must not become reclaimable on age alone — a sibling would steal the
  // lock mid-transaction and the original's late writes would clobber its
  // work. While held, the lease is re-stamped every staleMs/4 inside the
  // reclaim mutex (so a renewal cannot clobber a successor after a stall);
  // only holders that STOPPED renewing (crashed, wedged past the ceiling,
  // or pid-reused) age out.
  const startRenewal = (token: string): (() => Promise<void>) => {
    let renewing = false;
    let stopped = false;
    // The in-flight tick, joined by stop: clearing the interval only stops
    // FUTURE ticks, and a tick already holding the reclaim mutex could
    // otherwise outlast release's bounded retry budget and then re-stamp a
    // fresh lease onto a lock whose transaction already finished — blocking
    // siblings until the stale ceiling instead of immediately.
    let inFlight: Promise<void> = Promise.resolve();
    const interval = setInterval(
      () => {
        if (renewing || stopped) {
          return;
        }
        renewing = true;
        inFlight = (async () => {
          const mutex = await enterLockMutex(lockPath);
          if (mutex === undefined) {
            return; // Contended: try again next tick.
          }
          try {
            if (stopped) {
              return; // Release began while we waited for the mutex.
            }
            const current = await readLockHolder(lockPath);
            if (current?.token !== token) {
              return; // No longer ours: a reclaimer took over; stop touching it.
            }
            const tempPath = `${lockPath}.renew-${token}`;
            await fsPromises.writeFile(
              tempPath,
              JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() })
            );
            if (!stopped && (await mutex.owns())) {
              await fsPromises.rename(tempPath, lockPath);
            } else {
              await fsPromises.rm(tempPath, { force: true }).catch(() => undefined);
            }
          } finally {
            await mutex.exit();
          }
        })()
          .catch(() => undefined) // Best-effort: a missed renewal is the status quo.
          .finally(() => {
            renewing = false;
          });
      },
      Math.max(250, Math.floor(staleMs / 4))
    );
    interval.unref?.();
    return async () => {
      // Order matters: the flag is visible to the in-flight tick before the
      // join, so a tick still waiting on the mutex exits without writing,
      // and one already past the holder read skips the rename. The join is
      // unbounded on purpose — a rename can land only inside `inFlight`, so
      // release must not proceed (or give up) while it is unsettled; the
      // tick is a handful of local fs ops, and a filesystem wedged past that
      // stalls every other lock operation anyway.
      stopped = true;
      clearInterval(interval);
      await inFlight;
    };
  };

  const releaseFor = (token: string) => {
    const stopRenewal = startRenewal(token);
    return async () => {
      await stopRenewal();
      for (let attempt = 0; attempt < 40; attempt++) {
        const mutex = await enterLockMutex(lockPath);
        if (mutex !== undefined) {
          let released = false;
          try {
            const current = await readLockHolder(lockPath);
            // Last-instant mutex re-check, mirroring reclamation: a stall
            // longer than the mutex ceiling between the token read and the rm
            // lets a competitor break our mutex, reclaim, and publish a
            // successor — deleting it here would hand out double ownership.
            if (current?.token !== token) {
              released = true; // Not ours anymore: nothing to delete.
            } else if (await mutex.owns()) {
              // A transiently failing unlink (Windows file lock, antivirus
              // scan) must RETRY, not silently succeed: renewal already
              // stopped, so a holder record left behind reads as a live
              // owner until its lease ages out — blocking every sibling for
              // up to the stale ceiling even though the transaction is done.
              try {
                await fsPromises.rm(lockPath, { force: true });
                released = true;
              } catch {
                // Retry on the next attempt.
              }
            }
          } finally {
            await mutex.exit();
          }
          if (released) {
            return;
          }
        }
        await sleepWithJitter(25);
      }
      // Mutex never freed (or the unlink kept failing): leave the file; it
      // is reclaimable once its no-longer-renewed lease ages out.
    };
  };

  for (;;) {
    const token = randomBytes(16).toString("hex");
    // Publish atomically WITH content: write the holder record to a temp
    // file, hard-link it into place (exclusive: EEXIST when the path
    // exists), then unlink the temp name. No observer can ever read a
    // partially written lock — exclusive-create-then-write would let a
    // reclaimer misjudge the gap between create and write as corruption and
    // steal a lock its creator is about to confirm.
    const publishPath = `${lockPath}.publish-${token}`;
    await fsPromises.writeFile(
      publishPath,
      JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() })
    );
    try {
      await fsPromises.link(publishPath, lockPath);
      const confirmed = await readLockHolder(lockPath);
      if (confirmed?.token === token) {
        return releaseFor(token);
      }
      // Our create was clobbered by a concurrent reclaimer: retry.
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
      const holder = await readLockHolder(lockPath);
      if (holder === undefined || !holderAlive(holder, staleMs)) {
        // Corrupt/unreadable or dead-owner lock: take ownership in place via
        // the serialized reclaim protocol (never deletes the path).
        const reclaimedToken = await reclaimStaleLock(lockPath, staleMs);
        if (reclaimedToken !== undefined) {
          return releaseFor(reclaimedToken);
        }
      }
    } finally {
      await fsPromises.rm(publishPath, { force: true }).catch(() => undefined);
    }
    if (Date.now() > deadline) {
      throw new Error(timeoutMessage);
    }
    await sleepWithJitter(250);
  }
}

/**
 * Cross-process filesystem lock (extracted from the journal kit's append
 * lock so the durable-event blob lock can share one proven protocol).
 *
 * Protocol:
 * - Lock birth is atomic-with-content: the token (`pid:nonce`) is fully
 *   written to a temp file first and hard-linked into place (link fails
 *   EEXIST when held), so a reader can never observe a token-less lock.
 * - Waiting is a bounded jittered poll — there is no portable cross-process
 *   wake primitive available here.
 * - Crash remnants are reclaimed when the recorded owner is provably gone:
 *   its pid is dead, OR the pid is alive but belongs to a DIFFERENT process
 *   (PID reuse, detected via a process-birth identity recorded in the
 *   token), OR staleness cannot be proven either way and the lock's mtime
 *   exceeds a generous lease.
 * - Reclamation itself is serialized by a guard lockfile and verifies before
 *   displacing: under the guard the canonical token is re-read and must
 *   still equal the judged-stale token, so a lock released-and-reacquired
 *   while a reclaimer was deciding is never displaced (round 11: two
 *   concurrent reclaimers + a fresh acquirer could otherwise put two
 *   processes inside the protected section). Claim-by-rename then moves the
 *   verified-stale token aside; a post-rename mismatch (fresh owner
 *   displaced despite everything — possible only via the owner's own
 *   release inside the microsecond re-read→rename window of a lease-judged
 *   lock) restores it via link, and a failed restoration PRESERVES the
 *   displaced record instead of destroying the owner's only evidence.
 * - Release is ownership-verified: a mismatched token means the lock was
 *   reclaimed and re-acquired by someone else; leave it alone.
 *
 * Invariant: at most one process can believe it owns the lock. On
 * birth-capable platforms (Linux/macOS) this holds outright: a live holder
 * is never judged stale, and any canonical-token change between judgment
 * and displacement aborts the reclaim. On birth-less platforms live holders
 * renew the lease while held (r59), so lease expiry implies a crashed or
 * frozen owner rather than a slow one; the lease-judged residual window
 * (owner releasing exactly between the guarded re-read and the rename after
 * an event-loop freeze outlasting the lease) remains theoretically possible,
 * so holders also expose `assertStillOwned` for critical sections to
 * re-verify ownership immediately before irreversible mutations (mirrors the
 * rollback lock's commit-point doctrine in refinementRollback.ts).
 */

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import * as fs from "fs/promises";
import * as path from "path";
import { log } from "@/node/services/log";

/** Poll interval while another live process holds the lock. */
const FILE_LOCK_RETRY_MS = 10;

/**
 * Lease for locks whose staleness cannot be proven via pid + birth identity
 * (platforms without a birth probe, or pre-birth-format tokens). Most
 * legitimate holds are ms (appends) to seconds (blob-lock recovery sweeps),
 * and holds that CAN stall longer (target mutation locks wedged in slow
 * filesystem I/O) stay safe because live holders renew the lease below —
 * so an expired lease means the owner crashed or froze, never that it is
 * merely slow (r59). Recovery from PID reuse on birth-less platforms is
 * thus bounded by this lease instead of requiring manual lockfile cleanup.
 */
const FILE_LOCK_LEASE_MS = 5 * 60_000;

/**
 * How often a live holder refreshes the lockfile mtime while holding the
 * lock (r59). Lease-based staleness is the ONLY reclaim guard on birth-less
 * platforms (e.g. Windows without a usable `ps`), so without renewal a live
 * holder whose critical section stalls past the lease — a target mutation
 * wedged in filesystem I/O — was judged stale and displaced, letting a
 * competing backend double-enter the same protected section. Renewal is
 * event-loop driven: async-I/O stalls keep renewing (the holder is alive and
 * will commit), while a crashed or frozen process stops and its lease
 * expires as before.
 */
const FILE_LOCK_RENEW_INTERVAL_MS = FILE_LOCK_LEASE_MS / 4;

/** Interleaving points inside reclamation, exposed only for tests. */
export type ReclaimSeamPhase = "post-guard" | "pre-restore";

export interface ProcessFileLockOptions {
  /** Absolute or relative lockfile path; the parent directory is created. */
  lockPath: string;
  /** Max milliseconds to wait before acquisition fails. */
  timeoutMs: number;
  /** Human label for error/log messages (e.g. "append lock", "blob lock"). */
  label: string;
  /**
   * Test seam: awaited at deterministic points inside stale-lock
   * reclamation — the only way to exercise reclaim/acquire interleavings
   * (a real competitor cannot be paused between our judgment and our
   * rename). "post-guard" fires after guard acquisition, before the
   * verify-before-displace re-read; "pre-restore" fires after a wrongful
   * displacement is detected, before the restoration link.
   */
  testOnlyReclaimSeam?: (phase: ReclaimSeamPhase) => Promise<void>;
  /**
   * Lease-renewal cadence override (default FILE_LOCK_RENEW_INTERVAL_MS).
   * Exists so tests can observe renewal without a multi-minute wait; real
   * callers should not need to tune it.
   */
  renewIntervalMs?: number;
}

export interface ProcessFileLock extends AsyncDisposable {
  /**
   * Re-read the lockfile and throw when this acquisition no longer owns it
   * (wrongfully displaced by a reclaimer, or reclaimed after a wedge).
   * Critical sections call this immediately before irreversible mutations —
   * see the module-doc invariant discussion.
   */
  assertStillOwned(): Promise<void>;
}

/** Build a `pid:nonce[:birthHex]` ownership token for lock/guard files. */
function makeOwnershipToken(): { token: string; nonce: string } {
  const nonce = crypto.randomBytes(8).toString("hex");
  // Record our birth identity so a future reclaimer can distinguish "this
  // pid is alive" from "this pid now belongs to someone else" (hex-encoded:
  // ps-derived birth strings contain spaces and colons).
  const ownBirth = getProcessBirth(process.pid);
  const token =
    ownBirth === null
      ? `${process.pid}:${nonce}`
      : `${process.pid}:${nonce}:${Buffer.from(ownBirth).toString("hex")}`;
  return { token, nonce };
}

/** True when a signal-0 probe reaches the pid (EPERM = alive, not ours). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Birth-probe memo: probing can spawn `ps` on non-Linux platforms, and the
 * reclaim path polls every ~15ms during contention. A short TTL bounds the
 * spawn rate; process birth is immutable, so a cached LIVE answer only goes
 * stale via pid reuse, which cannot happen within the TTL while the pid is
 * still alive.
 */
const birthCache = new Map<number, { birth: string | null; at: number }>();
const BIRTH_CACHE_TTL_MS = 1_000;

/**
 * Stable identity of the process currently occupying `pid`, or null when the
 * platform offers no probe (or the process vanished mid-probe). Recorded in
 * lock tokens and compared at reclamation: a live pid whose CURRENT birth
 * differs from the token's proves the OS reused the pid for an unrelated
 * process — without this, kill(pid, 0) alone would judge a crashed owner's
 * reused pid live forever, wedging every append until manual cleanup.
 * Token creation and verification run the same probe order on the same
 * machine (session dirs are host-local), so formats always align.
 * Exported for tests (constructing a verified-live token needs the format).
 */
export function getProcessBirth(pid: number): string | null {
  const cached = birthCache.get(pid);
  if (cached !== undefined && Date.now() - cached.at < BIRTH_CACHE_TTL_MS) {
    return cached.birth;
  }
  const birth = probeProcessBirth(pid);
  birthCache.set(pid, { birth, at: Date.now() });
  return birth;
}

function probeProcessBirth(pid: number): string | null {
  // Linux: /proc/<pid>/stat field 22 (starttime, clock ticks since boot) is
  // unique per pid incarnation. The comm field can embed spaces/parens, so
  // fields are parsed after the LAST ')' where the format is well-defined
  // (state is field 3 → starttime is offset 19).
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const starttime = rest[19];
    if (starttime !== undefined && /^\d+$/.test(starttime)) {
      return `linux-ticks:${starttime}`;
    }
  } catch {
    // Not Linux (or the process vanished); try the portable fallback.
  }
  // macOS/BSD: full start timestamp, stable per process incarnation.
  try {
    const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8" });
    const line = out.stdout?.trim();
    if (out.status === 0 && line !== undefined && line.length > 0) {
      return `ps-lstart:${line}`;
    }
  } catch {
    // ps unavailable (e.g. Windows): undeterminable, lease policy governs.
  }
  return null;
}

/** Parsed lock token. Legacy `pid:nonce` tokens have no birth (null). */
function parseLockToken(raw: string): { pid: number | null; birth: string | null } {
  const parts = raw.split(":");
  const pid = Number.parseInt(parts[0], 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { pid: null, birth: null };
  }
  const birthHex = parts[2];
  if (birthHex === undefined || !/^[0-9a-f]+$/.test(birthHex)) {
    return { pid, birth: null };
  }
  return { pid, birth: Buffer.from(birthHex, "hex").toString("utf-8") };
}

export async function acquireProcessFileLock(
  options: ProcessFileLockOptions
): Promise<ProcessFileLock> {
  const { lockPath, timeoutMs, label } = options;
  assert(lockPath.length > 0, "acquireProcessFileLock requires a lock path");
  assert(timeoutMs > 0, "acquireProcessFileLock timeoutMs must be positive");
  const { token, nonce } = makeOwnershipToken();
  const tempPath = `${lockPath}.tmp-${process.pid}-${nonce}`;
  const deadline = Date.now() + timeoutMs;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(tempPath, token, "utf-8");
  try {
    for (;;) {
      try {
        await fs.link(tempPath, lockPath);
        // Lease renewal (r59, see FILE_LOCK_RENEW_INTERVAL_MS): keep a live
        // holder's mtime fresh so birth-less-platform reclaim can never
        // displace it mid-critical-section. unref'd — a held lock must not
        // keep the process alive; renewal only matters while real work
        // (which itself keeps the loop alive) is still running.
        const renewIntervalMs = options.renewIntervalMs ?? FILE_LOCK_RENEW_INTERVAL_MS;
        assert(renewIntervalMs > 0, "renewIntervalMs must be positive");
        let renewInFlight: Promise<void> | null = null;
        const renewTimer = setInterval(() => {
          if (renewInFlight !== null) return; // never overlap renewals
          renewInFlight = renewLeaseOnce(lockPath, token, label).finally(() => {
            renewInFlight = null;
          });
        }, renewIntervalMs);
        renewTimer.unref();
        return {
          assertStillOwned: () => assertLockOwned(lockPath, token, label),
          [Symbol.asyncDispose]: async () => {
            // Stop-and-JOIN renewal before releasing: a renewal still in
            // flight after release could otherwise refresh a successor's
            // lockfile it no longer owns (renewLeaseOnce re-verifies the
            // token, but only joining makes the ordering deterministic).
            clearInterval(renewTimer);
            if (renewInFlight !== null) await renewInFlight;
            await releaseFileLock(lockPath, token, label);
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
      await reclaimStaleFileLock(lockPath, label, options.testOnlyReclaimSeam);
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring ${label} ${lockPath} after ${timeoutMs}ms`);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, FILE_LOCK_RETRY_MS + Math.random() * FILE_LOCK_RETRY_MS)
      );
    }
  } finally {
    await fs.unlink(tempPath).catch(() => undefined);
  }
}

/**
 * One lease-renewal tick (r59): refresh the held lock's mtime so the lease —
 * the only staleness guard on birth-less platforms — never expires under a
 * live holder. Only the current owner renews (token re-verified first); the
 * residual read→utimes race can only refresh a successor's fresh lease,
 * never displace anyone. Never throws: a failed renewal degrades to the
 * pre-renewal exposure, still bounded by commit-point assertStillOwned.
 */
async function renewLeaseOnce(lockPath: string, token: string, label: string): Promise<void> {
  try {
    const current = await fs.readFile(lockPath, "utf-8");
    if (current !== token) {
      return; // Displaced or reclaimed: nothing of ours to renew.
    }
    const now = new Date();
    await fs.utimes(lockPath, now, now);
  } catch (error) {
    log.debug(`FileLock: failed to renew ${label} ${lockPath}`, { error });
  }
}

/** Throw when `token` is no longer the canonical lock content (see handle doc). */
async function assertLockOwned(lockPath: string, token: string, label: string): Promise<void> {
  let current: string | null = null;
  try {
    current = await fs.readFile(lockPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    // ENOENT = the lock vanished: someone judged us stale and reclaimed.
  }
  if (current !== token) {
    throw new Error(
      `${label} ${lockPath} is no longer owned by this holder (displaced or reclaimed); ` +
        `aborting before mutation`
    );
  }
}

/**
 * True when the lock is provably or presumptively stale (see module doc):
 * dead pid; live pid with a mismatched birth identity (PID reuse); or
 * undeterminable liveness past the lease. A live pid whose birth VERIFIABLY
 * matches the token is never stale, regardless of age — displacing a live
 * holder risks double-entry, which no lease can justify.
 */
async function isLockStale(lockPath: string, observed: string): Promise<boolean> {
  const { pid, birth } = parseLockToken(observed);
  if (pid === null) {
    // Malformed token: no owner to probe; only the lease bounds it.
    return await lockLeaseExpired(lockPath);
  }
  if (!isPidAlive(pid)) {
    return true;
  }
  const currentBirth = getProcessBirth(pid);
  if (birth !== null && currentBirth !== null) {
    return currentBirth !== birth;
  }
  return await lockLeaseExpired(lockPath);
}

/** True when the lockfile's mtime is older than the stale-lock lease. */
async function lockLeaseExpired(lockPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(lockPath);
    return Date.now() - stats.mtimeMs > FILE_LOCK_LEASE_MS;
  } catch {
    return false; // Vanished (released/reclaimed): retry acquisition instead.
  }
}

/**
 * Serialize reclaimers: at most one process may evaluate/displace a stale
 * lock at a time. The round-11 double entry began with exactly the
 * forbidden interleaving — reclaimer 1 removes the stale token, a fresh
 * owner acquires, and reclaimer 2 (still acting on its pre-removal read)
 * renames the fresh lock aside. When the guard is busy, `fn` is skipped and
 * the caller's poll loop retries; a crash-remnant guard (stale by the same
 * pid/birth/lease policy as locks) is unlinked so it cannot deadlock
 * reclamation. The unconditional unlink of a stale guard has its own
 * theoretical double-remove window (plain POSIX cannot compare-and-unlink);
 * the verify-before-displace re-read in reclaimStaleFileLock and holders'
 * commit-point assertStillOwned make that residual harmless — mirroring the
 * rollback lock's guard doctrine in refinementRollback.ts.
 */
async function withReclaimGuard(
  lockPath: string,
  label: string,
  fn: () => Promise<void>
): Promise<void> {
  const guardPath = `${lockPath}.reclaim`;
  const { token, nonce } = makeOwnershipToken();
  const tempPath = `${guardPath}.tmp-${process.pid}-${nonce}`;
  await fs.writeFile(tempPath, token, "utf-8");
  try {
    try {
      await fs.link(tempPath, guardPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const observed = await fs.readFile(guardPath, "utf-8").catch(() => null);
      if (observed !== null && (await isLockStale(guardPath, observed))) {
        await fs.unlink(guardPath).catch(() => undefined);
      }
      return; // Guard busy (or just freed): the caller's poll loop retries.
    }
    try {
      await fn();
    } finally {
      await releaseFileLock(guardPath, token, `${label} reclaim guard`);
    }
  } finally {
    await fs.unlink(tempPath).catch(() => undefined);
  }
}

/** Reclaim the lock if its recorded owner is provably gone (see module doc). */
async function reclaimStaleFileLock(
  lockPath: string,
  label: string,
  testOnlySeam?: (phase: ReclaimSeamPhase) => Promise<void>
): Promise<void> {
  let observed: string;
  try {
    observed = await fs.readFile(lockPath, "utf-8");
  } catch {
    return; // Already released or reclaimed; retry acquisition.
  }
  if (!(await isLockStale(lockPath, observed))) {
    return;
  }
  await withReclaimGuard(lockPath, label, async () => {
    if (testOnlySeam !== undefined) {
      await testOnlySeam("post-guard");
    }
    // Verify before displacing: with reclaimers serialized by the guard,
    // only the owner's own release can change the canonical token between
    // our staleness judgment and here — ANY change means a fresh owner may
    // hold the lock now, so the reclaim must abort rather than displace it.
    const current = await fs.readFile(lockPath, "utf-8").catch(() => null);
    if (current !== observed) {
      return;
    }
    const graveyard = `${lockPath}.stale-${crypto.randomBytes(4).toString("hex")}`;
    try {
      await fs.rename(lockPath, graveyard);
    } catch {
      return; // Lock vanished (owner released): retry acquisition.
    }
    const claimed = await fs.readFile(graveyard, "utf-8").catch(() => null);
    if (claimed !== null && claimed !== observed) {
      // Despite the guard and the re-read, a lease-judged owner released and
      // a fresh holder re-acquired inside the re-read→rename window: restore
      // the displaced owner's lock.
      if (testOnlySeam !== undefined) {
        await testOnlySeam("pre-restore");
      }
      try {
        await fs.link(graveyard, lockPath);
      } catch (error) {
        // A third process claimed the emptied path first. PRESERVE the
        // displaced record (round 11): destroying it would erase the only
        // evidence of the wrongful displacement while its holder still
        // believes it owns the section; the holder's commit-point
        // assertStillOwned aborts it instead.
        log.error(
          `FileLock: failed to restore a wrongfully displaced ${label} on ${lockPath}; ` +
            `preserving the displaced record at ${graveyard}`,
          { error }
        );
        return;
      }
      log.warn(`FileLock: reclaim raced a fresh ${label} on ${lockPath}; restored it`);
      await fs.unlink(graveyard).catch(() => undefined);
      return;
    }
    await fs.unlink(graveyard).catch(() => undefined);
  });
}

/** Release only if we still own the lock (a raced reclaim may have replaced it). */
async function releaseFileLock(lockPath: string, token: string, label: string): Promise<void> {
  try {
    const content = await fs.readFile(lockPath, "utf-8");
    if (content !== token) {
      log.warn(`FileLock: ${label} ${lockPath} changed owners before release; leaving it`);
      return;
    }
    await fs.unlink(lockPath);
  } catch (error) {
    log.debug(`FileLock: failed to release ${label} ${lockPath}`, { error });
  }
}

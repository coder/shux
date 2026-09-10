import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getXumHome } from "@/common/constants/paths";
import { log } from "@/node/services/log";
import { ensurePrivateDirSync } from "@/node/utils/fs";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

/**
 * Directory locks are installed by atomically renaming a staged directory with a
 * generation marker. Empty directories are release or crash remnants. Live owners
 * are never broken, dead owners are reclaimed immediately, and unreadable markers
 * fall back to TTL. Release only removes its own marker and an empty directory, so
 * a successor generation cannot be deleted by a late holder.
 */
export class FileLeaseManager {
  readonly rootDir: string;
  readonly providersFile: string;

  constructor(rootDir?: string) {
    this.rootDir = rootDir ?? getXumHome();
    this.providersFile = path.join(this.rootDir, "providers.jsonc");
  }

  /** Serializes cross-process providers.jsonc read-modify-write cycles. */
  async withProvidersFileLock<T>(fn: () => Promise<T> | T): Promise<T> {
    // Guards sub-second file mutations, so contention resolves quickly.
    return this.withDirLock(`${this.providersFile}.lock`, 5_000, 10_000, fn);
  }

  /** Serializes rotating-token refreshes so losers adopt the persisted winner. */
  async withCoderOauthRefreshLock<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.withDirLock(`${this.providersFile}.coder-refresh.lock`, 45_000, 60_000, fn);
  }

  /** Keeps each desktop login rollback snapshot anchored to committed credentials. */
  async withCoderOauthLoginCommitLock<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.withDirLock(`${this.providersFile}.coder-login.lock`, 15_000, 20_000, fn);
  }

  /** Installs the directory and generation marker as one observable step. */
  private tryInstallDirLock(lockPath: string): string | null {
    const stagePath = `${lockPath}.stage-${crypto.randomBytes(8).toString("hex")}`;
    const markerName = `owner-${crypto.randomBytes(16).toString("hex")}`;
    fs.mkdirSync(stagePath);
    try {
      fs.writeFileSync(path.join(stagePath, markerName), String(process.pid));
      fs.renameSync(stagePath, lockPath);
    } catch (error) {
      try {
        fs.rmSync(stagePath, { recursive: true, force: true });
      } catch {
        // Best effort; abandoned stages are swept by cleanupAbandonedStageDirs.
      }
      const code = (error as NodeJS.ErrnoException).code;
      // POSIX rename refuses a non-empty target with ENOTEMPTY (some
      // platforms report EEXIST); Windows refuses any existing target with
      // EPERM/EEXIST.
      if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM") {
        return null;
      }
      throw error;
    }
    return path.join(lockPath, markerName);
  }

  /** Removes crash-abandoned stages only after their install window has expired. */
  private cleanupAbandonedStageDirs(lockPath: string, ttlMs: number): void {
    const parent = path.dirname(lockPath);
    const prefix = `${path.basename(lockPath)}.stage-`;
    let entries: string[];
    try {
      entries = fs.readdirSync(parent);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) {
        continue;
      }
      const stagePath = path.join(parent, entry);
      try {
        if (Date.now() - fs.statSync(stagePath).mtimeMs > ttlMs) {
          fs.rmSync(stagePath, { recursive: true, force: true });
        }
      } catch {
        // Best effort (already removed, or racing its own install).
      }
    }
  }

  /** Acquires a bounded lock without deleting a live or successor generation. */
  private async withDirLock<T>(
    lockPath: string,
    acquireTimeoutMs: number,
    staleLockMs: number,
    fn: () => Promise<T> | T
  ): Promise<T> {
    const RETRY_DELAY_MS = 25;
    const deadline = Date.now() + acquireTimeoutMs;

    if (!fs.existsSync(this.rootDir)) {
      ensurePrivateDirSync(this.rootDir);
    }
    this.cleanupAbandonedStageDirs(lockPath, staleLockMs);

    let ownerFile: string;
    for (;;) {
      // tryInstallDirLock rethrows permanent filesystem errors (EACCES,
      // EROFS, ...); they would fail on every retry, so callers surface an
      // error instead of spinning until the deadline.
      const installed = this.tryInstallDirLock(lockPath);
      if (installed != null) {
        ownerFile = installed;
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring providers config lock at ${lockPath}`);
      }
      // Held by another process (or a crashed one): break stale locks, then
      // retry; immediately after a break/vanish, with a delay for a live
      // holder.
      if (this.tryBreakStaleDirLock(lockPath, staleLockMs)) {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }

    try {
      return await fn();
    } finally {
      try {
        fs.unlinkSync(ownerFile);
        try {
          fs.rmdirSync(lockPath);
        } catch (error) {
          // ENOENT/ENOTEMPTY: a breaker finished the removal or a successor
          // generation already acquired the path; leave it to them.
          log.debug("Failed to release providers config lock:", error);
        }
      } catch {
        // Marker already gone: this holder outlived staleLockMs and was
        // stale-broken; a successor may hold the lock now; keep it.
      }
    }
  }

  /**
   * Reserves the stored dynamic client for one login flow. Contenders use a fresh
   * registration rather than blocking for the full authorization window.
   */
  tryAcquireCoderOauthClientLease(ttlMs: number): (() => void) | null {
    const leasePath = `${this.providersFile}.coder-client.lock`;

    if (!fs.existsSync(this.rootDir)) {
      ensurePrivateDirSync(this.rootDir);
    }

    this.cleanupAbandonedStageDirs(leasePath, ttlMs);

    for (let attempt = 0; attempt < 2; attempt++) {
      let ownerFile: string;
      try {
        const installed = this.tryInstallDirLock(leasePath);
        if (installed == null) {
          // Contended: held by another flow (or a crash remnant).
          if (!this.tryBreakStaleDirLock(leasePath, ttlMs)) {
            return null; // Held by a live flow.
          }
          continue; // Stale lease broken (or it vanished); retry once.
        }
        ownerFile = installed;
      } catch (error) {
        // Filesystem errors mean the lease was never installed. The lease is
        // an optimization with a documented degradation path. Prefer a working
        // login through fresh registration over surfacing an acquisition error.
        log.debug("Failed to install Coder OAuth client lease:", error);
        return null;
      }

      return () => {
        try {
          fs.unlinkSync(ownerFile);
        } catch {
          return; // Stale-broken and reacquired by another flow; keep it.
        }
        try {
          fs.rmdirSync(leasePath);
        } catch (error) {
          // A release racing the staleness boundary can lose the directory to
          // a concurrent breaker after the unlink above: ENOENT means the
          // breaker finished the removal, ENOTEMPTY means a successor already
          // acquired a new generation; both correctly leave it untouched.
          log.debug("Failed to release Coder OAuth client lease:", error);
        }
      };
    }
    return null;
  }

  /** Returns whether acquisition should retry after checking the observed generation. */
  private tryBreakStaleDirLock(leasePath: string, ttlMs: number): boolean {
    let entries: string[];
    try {
      entries = fs.readdirSync(leasePath);
    } catch {
      return true; // Released between the failed mkdir and now; retry.
    }
    const isStale = (mtimeMs: number) => Date.now() - mtimeMs > ttlMs;

    if (entries.length === 0) {
      // Atomic installation makes empty directories reclaimable. Non-recursive
      // removal cannot delete a concurrently installed generation.
      try {
        fs.rmdirSync(leasePath);
      } catch {
        // ENOTEMPTY (a generation was renamed into place) or ENOENT (another
        // breaker won); the retried install/staleness check sorts either out.
      }
      return true;
    }

    // Staleness binds to the OBSERVED generation's marker: marker names are
    // generation-unique, so if the lease changes hands after this check the
    // unlink below ENOENTs and the rmdir ENOTEMPTYs; a live successor lease
    // is never destroyed (the reason breaking must not use recursive rm).
    for (const entry of entries) {
      const entryPath = path.join(leasePath, entry);
      // A live PID wins over TTL because the holder may still be in its critical
      // section. Dead owners are reclaimed immediately; unreadable markers use TTL.
      // A recycled PID may delay recovery, which is safer than overlapping holders.
      let ownerPid: number | null = null;
      try {
        const content = fs.readFileSync(entryPath, "utf8").trim();
        ownerPid = /^\d+$/.test(content) ? Number(content) : null;
      } catch {
        continue; // Vanished mid-check; the conditional cleanup below is safe.
      }
      if (ownerPid !== null) {
        if (isProcessAlive(ownerPid)) {
          return false;
        }
      } else {
        try {
          if (!isStale(fs.statSync(entryPath).mtimeMs)) {
            return false;
          }
        } catch {
          continue; // Vanished mid-check; the conditional cleanup below is safe.
        }
      }
      try {
        fs.unlinkSync(entryPath);
      } catch {
        // Already removed by a concurrent breaker or by its owner's release.
      }
    }
    try {
      fs.rmdirSync(leasePath);
    } catch {
      // ENOTEMPTY (a generation appeared) or ENOENT (another breaker won);
      // the retried mkdir/staleness check sorts either out.
    }
    return true;
  }
}

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileLeaseManager } from "./fileLeaseManager";

describe("FileLeaseManager", () => {
  let tempDir: string;
  let manager: FileLeaseManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-file-lease-test-"));
    manager = new FileLeaseManager(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function markCrashedHolder(leasePath: string, ttlMs: number): void {
    const staleTime = new Date(Date.now() - ttlMs - 1_000);
    fs.utimesSync(leasePath, staleTime, staleTime);
    for (const entry of fs.readdirSync(leasePath)) {
      const entryPath = path.join(leasePath, entry);
      fs.writeFileSync(entryPath, "999999999");
      fs.utimesSync(entryPath, staleTime, staleTime);
    }
  }

  describe("tryAcquireCoderOauthClientLease", () => {
    const TTL_MS = 60_000;

    it("is exclusive until released, including for a second FileLeaseManager on the same root", () => {
      const release = manager.tryAcquireCoderOauthClientLease(TTL_MS);
      expect(release).not.toBeNull();

      // Same file root = same lease, even from another FileLeaseManager instance
      // (stands in for another Xum process sharing providers.jsonc).
      const otherProcess = new FileLeaseManager(tempDir);
      expect(otherProcess.tryAcquireCoderOauthClientLease(TTL_MS)).toBeNull();

      release!();
      const reacquired = otherProcess.tryAcquireCoderOauthClientLease(TTL_MS);
      expect(reacquired).not.toBeNull();
      reacquired!();
    });

    it("breaks a stale lease left behind by a crashed holder", () => {
      const leasePath = path.join(tempDir, "providers.jsonc.coder-client.lock");
      fs.mkdirSync(leasePath, { recursive: true });
      const staleTime = new Date(Date.now() - TTL_MS - 1_000);
      fs.utimesSync(leasePath, staleTime, staleTime);

      const release = manager.tryAcquireCoderOauthClientLease(TTL_MS);
      expect(release).not.toBeNull();
      release!();
      expect(fs.existsSync(leasePath)).toBe(false);
    });

    it("judges staleness by the holder's generation marker, not the lease directory", () => {
      const leasePath = path.join(tempDir, "providers.jsonc.coder-client.lock");

      const release = manager.tryAcquireCoderOauthClientLease(TTL_MS);
      expect(release).not.toBeNull();

      // A breaker that judged staleness by the directory alone could destroy
      // a live successor generation created between its check and its remove
      // (check/remove TOCTOU). Binding staleness to the marker file makes the
      // destructive steps conditional: a fresh marker keeps the lease held
      // even when the directory timestamp looks stale.
      const staleTime = new Date(Date.now() - TTL_MS - 1_000);
      fs.utimesSync(leasePath, staleTime, staleTime);

      const otherProcess = new FileLeaseManager(tempDir);
      expect(otherProcess.tryAcquireCoderOauthClientLease(TTL_MS)).toBeNull();
      release!();
    });

    it("does not stale-break a lease whose holder process is still alive", () => {
      const leasePath = path.join(tempDir, "providers.jsonc.coder-client.lock");

      const release = manager.tryAcquireCoderOauthClientLease(TTL_MS);
      expect(release).not.toBeNull();

      // The holder outlives the TTL but its process (this one) is alive.
      // e.g. a suspended laptop or a stalled event loop. Breaking it would
      // let a second flow enter the same critical section and race the
      // resumed original; contenders must fail acquisition instead.
      const staleTime = new Date(Date.now() - TTL_MS - 1_000);
      for (const entry of fs.readdirSync(leasePath)) {
        fs.utimesSync(path.join(leasePath, entry), staleTime, staleTime);
      }

      const otherProcess = new FileLeaseManager(tempDir);
      expect(otherProcess.tryAcquireCoderOauthClientLease(TTL_MS)).toBeNull();
      release!();
    });

    it("does not release a lease that was stale-broken and reacquired by another process", () => {
      const leasePath = path.join(tempDir, "providers.jsonc.coder-client.lock");

      const originalRelease = manager.tryAcquireCoderOauthClientLease(TTL_MS);
      expect(originalRelease).not.toBeNull();

      // The lease crosses the staleness boundary and its holder "crashes"
      // (staleness binds to the holder's generation marker + a gone owner
      // PID); another process breaks it and acquires its own generation of
      // the same path.
      markCrashedHolder(leasePath, TTL_MS);
      const otherProcess = new FileLeaseManager(tempDir);
      const otherRelease = otherProcess.tryAcquireCoderOauthClientLease(TTL_MS);
      expect(otherRelease).not.toBeNull();

      // The original holder's late release must NOT remove the new owner's
      // lease; otherwise a third flow could acquire it concurrently and two
      // flows would clobber the stored client's single redirect slot.
      originalRelease!();
      expect(fs.existsSync(leasePath)).toBe(true);
      expect(manager.tryAcquireCoderOauthClientLease(TTL_MS)).toBeNull();

      otherRelease!();
      expect(fs.existsSync(leasePath)).toBe(false);
    });

    it("reclaims a dead-owner lease immediately, before the TTL elapses", () => {
      // Regression: a crashed holder's PID is deterministically dead, so
      // contenders must recover the orphan right away. Gating recovery on
      // the mtime TTL (which exceeds every acquisition timeout) would make
      // the first operation after a crash always fail despite the owner
      // being provably gone.
      const leasePath = path.join(tempDir, "providers.jsonc.coder-client.lock");
      fs.mkdirSync(leasePath, { recursive: true });
      fs.writeFileSync(path.join(leasePath, "owner-crashed"), "999999999");

      const release = manager.tryAcquireCoderOauthClientLease(TTL_MS);
      expect(release).not.toBeNull();
      release!();
    });

    it("reclaims an EMPTY orphaned lease directory immediately, before the TTL elapses", () => {
      // Regression: acquisition installs the owner marker atomically with the
      // lock directory (staged rename), so an empty directory can only be a
      // crash remnant; never a live acquisition. A fresh-mtime empty orphan
      // previously read as live until the TTL, and every acquisition timeout
      // is shorter than its TTL, so the first operation after such a crash
      // always failed.
      const leasePath = path.join(tempDir, "providers.jsonc.coder-client.lock");
      fs.mkdirSync(leasePath, { recursive: true }); // Fresh mtime, no marker.

      const release = manager.tryAcquireCoderOauthClientLease(TTL_MS);
      expect(release).not.toBeNull();
      release!();
      expect(fs.existsSync(leasePath)).toBe(false);
    });

    it("sweeps stage directories abandoned by a crashed acquisition", () => {
      const leasePath = path.join(tempDir, "providers.jsonc.coder-client.lock");
      const abandonedStage = `${leasePath}.stage-deadbeef`;
      fs.mkdirSync(abandonedStage, { recursive: true });
      fs.writeFileSync(path.join(abandonedStage, "owner-orphan"), "999999999");
      const staleTime = new Date(Date.now() - TTL_MS - 1_000);
      fs.utimesSync(abandonedStage, staleTime, staleTime);
      // A FRESH stage may belong to a concurrent in-flight acquisition and
      // must survive the sweep.
      const freshStage = `${leasePath}.stage-cafebabe`;
      fs.mkdirSync(freshStage, { recursive: true });

      const release = manager.tryAcquireCoderOauthClientLease(TTL_MS);
      expect(release).not.toBeNull();
      release!();

      expect(fs.existsSync(abandonedStage)).toBe(false);
      expect(fs.existsSync(freshStage)).toBe(true);
    });
  });

  describe("withProvidersFileLock", () => {
    it("acquires over a dead-owner lock immediately, before the TTL elapses", async () => {
      // Same regression as the lease variant: withDirLock's acquisition
      // timeout (5s) is shorter than its staleness TTL (10s), so a fresh
      // crash orphan must be reclaimed via the dead-PID check or the first
      // config write after the crash would always time out.
      const lockPath = path.join(tempDir, "providers.jsonc.lock");
      fs.mkdirSync(lockPath, { recursive: true });
      fs.writeFileSync(path.join(lockPath, "owner-crashed"), "999999999");

      const startedAt = Date.now();
      const result = await manager.withProvidersFileLock(() => "ran");
      expect(result).toBe("ran");
      // Well under the 5s acquisition timeout: the orphan was reclaimed on
      // the first contention check, not waited out.
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it("acquires over an EMPTY orphaned lock directory immediately, before the TTL elapses", async () => {
      // Regression: acquisition installs the owner marker atomically with the
      // lock directory (staged rename), so an empty directory can only be a
      // crash remnant; never a live acquisition. Previously a fresh-mtime
      // empty orphan read as live until the 10s TTL, and the 5s acquisition
      // timeout always fired first, so the first config write after such a
      // crash always timed out.
      const lockPath = path.join(tempDir, "providers.jsonc.lock");
      fs.mkdirSync(lockPath, { recursive: true }); // Fresh mtime, no marker.

      const startedAt = Date.now();
      const result = await manager.withProvidersFileLock(() => "ran");
      expect(result).toBe("ran");
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(fs.existsSync(lockPath)).toBe(false);
    });
  });

  describe("withCoderOauthRefreshLock", () => {
    it("serializes critical sections, including across FileLeaseManager instances on the same root", async () => {
      // A second FileLeaseManager on the same root stands in for another Xum process
      // sharing providers.jsonc.
      const otherProcess = new FileLeaseManager(tempDir);
      const events: string[] = [];
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
      let firstEntered!: () => void;
      const firstEnteredPromise = new Promise<void>((resolve) => (firstEntered = resolve));

      const first = manager.withCoderOauthRefreshLock(async () => {
        events.push("first:enter");
        firstEntered();
        await firstGate;
        events.push("first:exit");
      });
      await firstEnteredPromise;

      const second = otherProcess.withCoderOauthRefreshLock(() => {
        events.push("second:enter");
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events).toEqual(["first:enter"]);

      releaseFirst();
      await Promise.all([first, second]);
      expect(events).toEqual(["first:enter", "first:exit", "second:enter"]);
    });

    it("does not release a successor's lock after being stale-broken mid-section", async () => {
      // A holder that outlives staleLockMs (suspended process, stalled event
      // loop) can be stale-broken and the lock reacquired before its release
      // runs. That release must only remove its OWN generation; deleting the
      // successor's lock would let a third process into the critical section
      // (for the refresh lock, the concurrent rotating-refresh-token race).
      const lockPath = path.join(tempDir, "providers.jsonc.coder-refresh.lock");
      const otherProcess = new FileLeaseManager(tempDir);

      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
      let firstEntered!: () => void;
      const firstEnteredPromise = new Promise<void>((resolve) => (firstEntered = resolve));
      const first = manager.withCoderOauthRefreshLock(async () => {
        firstEntered();
        await firstGate;
      });
      await firstEnteredPromise;

      // The first holder's process "crashes" past the staleness boundary
      // (backdated marker + gone owner PID) while its release closure is
      // still pending, and a second process stale-breaks + reacquires.
      markCrashedHolder(lockPath, 120_000);
      let releaseSecond!: () => void;
      const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve));
      let secondEntered!: () => void;
      const secondEnteredPromise = new Promise<void>((resolve) => (secondEntered = resolve));
      const second = otherProcess.withCoderOauthRefreshLock(async () => {
        secondEntered();
        await secondGate;
      });
      await secondEnteredPromise;

      // The first holder's delayed release runs now. It must NOT unlink the
      // second holder's marker or delete the directory.
      releaseFirst();
      expect(fs.existsSync(lockPath)).toBe(true);

      releaseSecond();
      await Promise.all([first, second]);
      expect(fs.existsSync(lockPath)).toBe(false);
    });
  });
});

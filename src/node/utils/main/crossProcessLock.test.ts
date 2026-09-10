import { describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { acquireCrossProcessLock, reclaimStaleLock } from "./crossProcessLock";

async function tempLockPath(): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "cross-process-lock-"));
  return path.join(dir, "test.lock");
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsPromises.stat(target);
    return true;
  } catch {
    return false;
  }
}

const baseOptions = {
  acquireTimeoutMs: 400,
  staleMs: 60_000,
  timeoutMessage: "lock busy",
};

describe("acquireCrossProcessLock", () => {
  test("acquires, blocks a competing acquirer on a live holder, and releases", async () => {
    const lockPath = await tempLockPath();
    const release = await acquireCrossProcessLock({ lockPath, ...baseOptions });
    try {
      await acquireCrossProcessLock({ lockPath, ...baseOptions });
      expect.unreachable("second acquire must time out on a live holder");
    } catch (error) {
      expect((error as Error).message).toBe("lock busy");
    }
    await release();
    expect(await pathExists(lockPath)).toBe(false);
    const release2 = await acquireCrossProcessLock({ lockPath, ...baseOptions });
    await release2();
  });

  test("reclaims a holder past the stale ceiling even when its pid is alive", async () => {
    const lockPath = await tempLockPath();
    // An old positive timestamp puts the holder beyond the stale ceiling (pid-reuse guard).
    await fsPromises.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, token: "stale", acquiredAt: Date.now() - 120_000 })
    );
    const release = await acquireCrossProcessLock({ lockPath, ...baseOptions });
    await release();
    expect(await pathExists(lockPath)).toBe(false);
  });

  test("reclaims a lock with an implausibly future timestamp as corrupt", async () => {
    const lockPath = await tempLockPath();
    await fsPromises.writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        token: "future-clock",
        acquiredAt: Date.now() + 24 * 60 * 60 * 1000,
      })
    );
    // Corrupt records observe the publication grace before reclamation.
    const old = new Date(Date.now() - 10_000);
    await fsPromises.utimes(lockPath, old, old);
    const release = await acquireCrossProcessLock({ lockPath, ...baseOptions });
    await release();
    expect(await pathExists(lockPath)).toBe(false);
  });

  test("reclaims a corrupt lock file once its publication grace has passed", async () => {
    const lockPath = await tempLockPath();
    await fsPromises.writeFile(lockPath, "not json");
    // Corrupt content younger than the grace is retried (a non-atomic writer
    // from another build may still be publishing); age it past the grace.
    const old = new Date(Date.now() - 10_000);
    await fsPromises.utimes(lockPath, old, old);
    const release = await acquireCrossProcessLock({ lockPath, ...baseOptions });
    await release();
  });

  test("release never deletes a successor's lock (stale-ceiling release race)", async () => {
    // The Codex-flagged race: a holder past staleMs starts releasing while a
    // reclaimer replaces the file. Release's verify-then-unlink runs inside
    // the shared mutex, so a successor's confirmed lock must survive.
    const lockPath = await tempLockPath();
    const release = await acquireCrossProcessLock({ lockPath, ...baseOptions });
    // A reclaimer replaced the file after our stale ceiling elapsed.
    const successor = { pid: process.pid, token: "successor", acquiredAt: Date.now() };
    await fsPromises.writeFile(lockPath, JSON.stringify(successor));
    await release();
    const surviving = JSON.parse(await fsPromises.readFile(lockPath, "utf-8")) as {
      token: string;
    };
    expect(surviving.token).toBe("successor");
  });

  test("a live holder renews its lease past staleMs and stays unreclaimable", async () => {
    // A LIVE transaction exceeding staleMs (e.g. a long uninstall pruning
    // many contended workspaces) must not expire on age alone: the holder
    // re-stamps acquiredAt every staleMs/4, so only holders that STOPPED
    // renewing (crashed/wedged) age out.
    const lockPath = await tempLockPath();
    const release = await acquireCrossProcessLock({
      lockPath,
      acquireTimeoutMs: 400,
      staleMs: 1_000,
      timeoutMessage: "lock busy",
    });
    // Hold well past staleMs; a competitor must keep failing on a live lease.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    try {
      await acquireCrossProcessLock({
        lockPath,
        acquireTimeoutMs: 1_200,
        staleMs: 1_000,
        timeoutMessage: "lock busy",
      });
      expect.unreachable("the renewed live lease must not be reclaimable");
    } catch (error) {
      expect((error as Error).message).toBe("lock busy");
    }
    await release();
    const release2 = await acquireCrossProcessLock({ lockPath, ...baseOptions });
    await release2();
  }, 10_000);

  test("release retries a transiently failing unlink instead of leaving a live-looking holder", async () => {
    // A swallowed unlink failure (Windows file lock, antivirus scan) leaves
    // the holder record behind with renewal stopped: the live PID reads as a
    // valid owner until the lease ages out, blocking siblings for minutes.
    const lockPath = await tempLockPath();
    const release = await acquireCrossProcessLock({ lockPath, ...baseOptions });
    const realRm = fsPromises.rm;
    let failures = 0;
    const rmSpy = spyOn(fsPromises, "rm").mockImplementation((target, options) => {
      if (String(target) === lockPath && failures < 2) {
        failures += 1;
        return Promise.reject(new Error("EBUSY: resource busy"));
      }
      return realRm(target, options);
    });
    try {
      await release();
    } finally {
      rmSpy.mockRestore();
    }
    expect(failures).toBe(2);
    expect(await pathExists(lockPath)).toBe(false);
    const release2 = await acquireCrossProcessLock({ lockPath, ...baseOptions });
    await release2();
  });

  test("release during active renewals leaves the lock immediately reacquirable", async () => {
    // stopRenewal joins the in-flight renewal tick: releasing mid-tick must
    // never let a resumed renewal re-stamp a fresh lease onto the released
    // lock (which would block siblings until the stale ceiling). Release at
    // staggered offsets against a fast renewal interval, asserting the file
    // is gone and a competitor can acquire instantly every time.
    const lockPath = await tempLockPath();
    for (const holdMs of [260, 310, 380, 430]) {
      const release = await acquireCrossProcessLock({
        lockPath,
        acquireTimeoutMs: 400,
        staleMs: 1_000, // renewal ticks every 250ms
        timeoutMessage: "lock busy",
      });
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      await release();
      expect(await pathExists(lockPath)).toBe(false);
      const release2 = await acquireCrossProcessLock({
        lockPath,
        acquireTimeoutMs: 400,
        staleMs: 1_000,
        timeoutMessage: "lock busy",
      });
      await release2();
      expect(await pathExists(lockPath)).toBe(false);
    }
  }, 10_000);

  test("contending acquirers over a stale lock are mutually exclusive", async () => {
    const lockPath = await tempLockPath();
    await fsPromises.writeFile(
      lockPath,
      JSON.stringify({ pid: 1, token: "stale", acquiredAt: Date.now() - 120_000 })
    );
    let inside = 0;
    let overlaps = 0;
    await Promise.all(
      Array.from({ length: 5 }, async () => {
        const release = await acquireCrossProcessLock({
          lockPath,
          ...baseOptions,
          acquireTimeoutMs: 15_000,
        });
        inside += 1;
        if (inside > 1) overlaps += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        inside -= 1;
        await release();
      })
    );
    expect(overlaps).toBe(0);
  });
});

describe("reclaimStaleLock", () => {
  test("takes ownership of a stale lock in place and confirms", async () => {
    const lockPath = await tempLockPath();
    await fsPromises.writeFile(
      lockPath,
      JSON.stringify({ pid: 1, token: "s", acquiredAt: Date.now() - 120_000 })
    );
    const token = await reclaimStaleLock(lockPath, 60_000);
    expect(token).toBeDefined();
    const holder = JSON.parse(await fsPromises.readFile(lockPath, "utf-8")) as { token: string };
    expect(holder.token).toBe(token!);
    // Mutex and temp files are cleaned up.
    expect(await fsPromises.readdir(path.dirname(lockPath))).toEqual([path.basename(lockPath)]);
  });

  test("never touches a lock that became live/fresh after the caller's observation", async () => {
    // The Codex-flagged three-process race: a caller observed a stale
    // holder, but a competitor completed its own reclaim-and-acquire before
    // this reclaim ran. The fresh re-read inside the mutex must abandon
    // WITHOUT modifying the new owner's confirmed lock (the old design's
    // quarantine/restore could clobber it).
    const lockPath = await tempLockPath();
    const newOwner = { pid: process.pid, token: "new-owner", acquiredAt: Date.now() };
    await fsPromises.writeFile(lockPath, JSON.stringify(newOwner));
    const token = await reclaimStaleLock(lockPath, 60_000);
    expect(token).toBeUndefined();
    const surviving = JSON.parse(await fsPromises.readFile(lockPath, "utf-8")) as {
      token: string;
    };
    expect(surviving.token).toBe("new-owner");
    expect(await fsPromises.readdir(path.dirname(lockPath))).toEqual([path.basename(lockPath)]);
  });

  test("reclaims a corrupt-but-present lock in place once aged past the grace", async () => {
    const lockPath = await tempLockPath();
    await fsPromises.writeFile(lockPath, "not json");
    const old = new Date(Date.now() - 10_000);
    await fsPromises.utimes(lockPath, old, old);
    const token = await reclaimStaleLock(lockPath, 60_000);
    expect(token).toBeDefined();
    const holder = JSON.parse(await fsPromises.readFile(lockPath, "utf-8")) as { token: string };
    expect(holder.token).toBe(token!);
  });

  test("retries fresh corrupt content instead of stealing an in-progress publication", async () => {
    // A different build's exclusive-create-then-write can be observed between
    // create and write; content within the grace must not be reclaimed.
    const lockPath = await tempLockPath();
    await fsPromises.writeFile(lockPath, "not json");
    expect(await reclaimStaleLock(lockPath, 60_000)).toBeUndefined();
    expect(await fsPromises.readFile(lockPath, "utf-8")).toBe("not json");
  });

  test("abandons when the lock file is missing (the wx create path handles absence)", async () => {
    const lockPath = await tempLockPath();
    expect(await reclaimStaleLock(lockPath, 60_000)).toBeUndefined();
    expect(await pathExists(lockPath)).toBe(false);
    expect(await fsPromises.readdir(path.dirname(lockPath))).toEqual([]);
  });

  test("backs off while a competing reclaimer holds a fresh reclaim mutex", async () => {
    const lockPath = await tempLockPath();
    const stale = JSON.stringify({ pid: 1, token: "s", acquiredAt: Date.now() - 120_000 });
    await fsPromises.writeFile(lockPath, stale);
    const mutexDir = `${lockPath}.reclaim`;
    await fsPromises.mkdir(mutexDir);
    await fsPromises.writeFile(path.join(mutexDir, "owner"), "competitor");
    const token = await reclaimStaleLock(lockPath, 60_000);
    expect(token).toBeUndefined();
    // The stale lock and the competitor's mutex are untouched.
    expect(await fsPromises.readFile(lockPath, "utf-8")).toBe(stale);
    expect(await fsPromises.readFile(path.join(mutexDir, "owner"), "utf-8")).toBe("competitor");
  });

  test("breaks a reclaim mutex abandoned by a crashed reclaimer", async () => {
    const lockPath = await tempLockPath();
    await fsPromises.writeFile(
      lockPath,
      JSON.stringify({ pid: 1, token: "s", acquiredAt: Date.now() - 120_000 })
    );
    const mutexDir = `${lockPath}.reclaim`;
    await fsPromises.mkdir(mutexDir);
    // Age the mutex beyond RECLAIM_MUTEX_STALE_MS.
    const old = new Date(Date.now() - 60_000);
    await fsPromises.utimes(mutexDir, old, old);
    const token = await reclaimStaleLock(lockPath, 60_000);
    expect(token).toBeDefined();
    const holder = JSON.parse(await fsPromises.readFile(lockPath, "utf-8")) as { token: string };
    expect(holder.token).toBe(token!);
  });

  test("the lock path is never absent during a successful reclaim", async () => {
    // Watch for absence with a tight poller while a reclaim runs. rename-over
    // is atomic, so no observer may ever see ENOENT — the property that keeps
    // a third process's wx-create from slipping in mid-reclaim.
    const lockPath = await tempLockPath();
    await fsPromises.writeFile(
      lockPath,
      JSON.stringify({ pid: 1, token: "s", acquiredAt: Date.now() - 120_000 })
    );
    let sawAbsent = false;
    let stop = false;
    const watcher = (async () => {
      while (!stop) {
        if (!(await pathExists(lockPath))) {
          sawAbsent = true;
        }
      }
    })();
    const token = await reclaimStaleLock(lockPath, 60_000);
    stop = true;
    await watcher;
    expect(token).toBeDefined();
    expect(sawAbsent).toBe(false);
  });
});

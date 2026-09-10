import { describe, expect, test } from "bun:test";

import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { DisposableTempDir } from "@/node/services/tempDir";
import {
  targetMutationLockFilePath,
  withTargetMutationLock,
} from "@/node/services/refinement/targetMutationLocks";
import { acquireProcessFileLock, getProcessBirth } from "@/node/utils/concurrency/fileLock";
import {
  healRemovalTombstonesForRegisteredWorkspaces,
  isWorkspaceRemovalTombstoned,
  refineApplyLockPath,
  REMOVAL_TOMBSTONE_HEAL_MIN_AGE_MS,
  removeSessionDirUnderMemoryLocks,
  rollbackRemovalTombstoneIfOwned,
  TombstoneNotDurableError,
  workspaceRemovalTombstonePath,
} from "./workspaceRemoval";

describe("workspaceRemoval", () => {
  test("deletion waits for a live memory writer, then tombstones and deletes (r61)", async () => {
    using tmp = new DisposableTempDir("workspace-removal-test");
    const rootDir = path.join(tmp.path, "xum-home");
    const workspaceId = "ws-removal";
    const sessionDir = path.join(rootDir, "sessions", workspaceId);
    await fsPromises.mkdir(path.join(sessionDir, "memory"), { recursive: true });
    await fsPromises.writeFile(path.join(sessionDir, "memory", "note.md"), "contents\n");
    expect(await isWorkspaceRemovalTombstoned(rootDir, workspaceId)).toBe(false);

    // A memory writer holds the workspace store's target lock mid-commit.
    let releaseWriter!: () => void;
    const writerGate = new Promise<void>((resolve) => (releaseWriter = resolve));
    // Entry signal (r62): removal must start only once the writer provably
    // holds the lock, so this test can never silently degrade into timing
    // out the lock instead of exercising writer-vs-removal ordering.
    let writerEntered!: () => void;
    const entered = new Promise<void>((resolve) => (writerEntered = resolve));
    let writerDone = false;
    const writer = withTargetMutationLock(rootDir, path.join(sessionDir, "memory"), async () => {
      writerEntered();
      await writerGate;
      writerDone = true;
    });
    await entered;

    // Removal must serialize behind the writer, not delete under it.
    const removal = removeSessionDirUnderMemoryLocks({
      rootDir,
      sessionDir,
      workspaceId,
      attemptId: "test-attempt",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      await fsPromises.access(sessionDir).then(
        () => true,
        () => false
      )
    ).toBe(true);

    releaseWriter();
    await writer;
    await removal;
    expect(writerDone).toBe(true);
    expect(
      await fsPromises.access(sessionDir).then(
        () => true,
        () => false
      )
    ).toBe(false);
    // Tombstone published and durable — commit points refuse from now on.
    expect(await isWorkspaceRemovalTombstoned(rootDir, workspaceId)).toBe(true);
    const raw = await fsPromises.readFile(
      workspaceRemovalTombstonePath(rootDir, workspaceId),
      "utf-8"
    );
    expect((JSON.parse(raw) as { workspaceId: string }).workspaceId).toBe(workspaceId);
  });

  test("waits on the refine lock BEFORE taking the teardown target locks (r67)", async () => {
    using tmp = new DisposableTempDir("workspace-removal-test");
    const rootDir = path.join(tmp.path, "xum-home");
    const workspaceId = "ws-refine-order";
    const sessionDir = path.join(rootDir, "sessions", workspaceId);
    await fsPromises.mkdir(path.join(sessionDir, "memory"), { recursive: true });

    // Simulated admitted /refine apply in another backend: it holds the
    // refine serialization lock and still needs the memory target lock for
    // its per-edit mutations.
    const refineLock = await acquireProcessFileLock({
      lockPath: refineApplyLockPath(rootDir, workspaceId),
      timeoutMs: 1_000,
      label: "refine serialization lock (test apply)",
    });
    const removal = removeSessionDirUnderMemoryLocks({
      rootDir,
      sessionDir,
      workspaceId,
      attemptId: "test-attempt",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The pre-r67 ordering held the memory target lock while waiting on the
    // refine lock — the OPPOSITE order from an admitted apply, deadlocking
    // both paths until timeout. Refine-lock-first ordering leaves the target
    // lock free here, so the apply's mutation can drain...
    let applyMutationRan = false;
    await withTargetMutationLock(rootDir, path.join(sessionDir, "memory"), () => {
      applyMutationRan = true;
      return Promise.resolve();
    });
    expect(applyMutationRan).toBe(true);

    // ...and removal proceeds once the apply releases the refine lock.
    await refineLock[Symbol.asyncDispose]();
    await removal;
    expect(
      await fsPromises.access(sessionDir).then(
        () => true,
        () => false
      )
    ).toBe(false);
    expect(await isWorkspaceRemovalTombstoned(rootDir, workspaceId)).toBe(true);
  }, 20_000);

  test("publishes the tombstone even when lock acquisition fails (r62)", async () => {
    // Fail-closed orphan path: the caller deregisters the workspace even
    // when a wedged writer blocks the deletion, so the terminal marker must
    // still become durable or a foreign backend would keep mutating the
    // retained orphan forever.
    using tmp = new DisposableTempDir("workspace-removal-test");
    const rootDir = path.join(tmp.path, "xum-home");
    const workspaceId = "ws-wedged";
    const sessionDir = path.join(rootDir, "sessions", workspaceId);
    await fsPromises.mkdir(path.join(sessionDir, "memory"), { recursive: true });

    // A foreign process "holds" the workspace target's cross-process file
    // lock: a verified-live token for this pid is never treated as stale, so
    // acquisition times out (~2s) instead of reclaiming.
    const key = path.join(sessionDir, "memory");
    const lockPath = targetMutationLockFilePath(rootDir, key);
    await fsPromises.mkdir(path.dirname(lockPath), { recursive: true });
    const birth = getProcessBirth(process.pid);
    const token =
      birth === null
        ? `${process.pid}:feed`
        : `${process.pid}:feed:${Buffer.from(birth).toString("hex")}`;
    await fsPromises.writeFile(lockPath, token, { flag: "wx" });

    try {
      await removeSessionDirUnderMemoryLocks({
        rootDir,
        sessionDir,
        workspaceId,
        attemptId: "test-attempt",
      });
      expect.unreachable("removal must fail closed while the target lock is held");
    } catch (error) {
      expect(String(error)).toContain("Another process is mutating");
    }
    // Directory retained (never deleted under a live writer), tombstone durable.
    expect(
      await fsPromises.access(sessionDir).then(
        () => true,
        () => false
      )
    ).toBe(true);
    expect(await isWorkspaceRemovalTombstoned(rootDir, workspaceId)).toBe(true);
  }, 15_000);

  test("aborts with TombstoneNotDurableError when no marker can be written (r63)", async () => {
    // Without a durable marker, deregistering would leave the orphan
    // writable by foreign backends once the transient failure clears — the
    // caller must keep the workspace registered and retry.
    using tmp = new DisposableTempDir("workspace-removal-test");
    const rootDir = path.join(tmp.path, "xum-home");
    const workspaceId = "ws-enospc";
    const sessionDir = path.join(rootDir, "sessions", workspaceId);
    await fsPromises.mkdir(path.join(sessionDir, "memory"), { recursive: true });
    // Blocking `<rootDir>/locks` with a FILE makes both the lock acquisition
    // and every tombstone publication attempt fail.
    await fsPromises.writeFile(path.join(rootDir, "locks"), "not a directory");

    try {
      await removeSessionDirUnderMemoryLocks({
        rootDir,
        sessionDir,
        workspaceId,
        attemptId: "test-attempt",
      });
      expect.unreachable("removal must abort when the tombstone cannot be published");
    } catch (error) {
      expect(error).toBeInstanceOf(TombstoneNotDurableError);
    }
    expect(
      await fsPromises.access(sessionDir).then(
        () => true,
        () => false
      )
    ).toBe(true);
  }, 15_000);

  test("rollback deletes the tombstone only for the owning, still-registered attempt (r66)", async () => {
    using tmp = new DisposableTempDir("workspace-removal-test");
    const rootDir = path.join(tmp.path, "xum-home");
    const sessionDir = path.join(tmp.path, "sessions", "ws-rollback");
    const workspaceId = "ws-rollback";
    const write = async (attemptId: string) => {
      const p = workspaceRemovalTombstonePath(rootDir, workspaceId);
      await fsPromises.mkdir(path.dirname(p), { recursive: true });
      await fsPromises.writeFile(
        p,
        JSON.stringify({ workspaceId, removedAt: Date.now(), attemptId })
      );
    };

    // Foreign attempt's marker: a concurrent backend republished (or its
    // completed removal relies on it) — never delete it.
    await write("attempt-foreign");
    expect(
      await rollbackRemovalTombstoneIfOwned({
        rootDir,
        sessionDir,
        workspaceId,
        attemptId: "attempt-ours",
        workspaceStillRegistered: () => true,
      })
    ).toBe(false);
    expect(await isWorkspaceRemovalTombstoned(rootDir, workspaceId)).toBe(true);

    // Own marker but the workspace is no longer registered: another
    // backend's removal completed — the marker is its terminal state.
    await write("attempt-ours");
    expect(
      await rollbackRemovalTombstoneIfOwned({
        rootDir,
        sessionDir,
        workspaceId,
        attemptId: "attempt-ours",
        workspaceStillRegistered: () => false,
      })
    ).toBe(false);
    expect(await isWorkspaceRemovalTombstoned(rootDir, workspaceId)).toBe(true);

    // Own marker, workspace still registered: the failed attempt restores
    // usability by deleting its own tombstone.
    expect(
      await rollbackRemovalTombstoneIfOwned({
        rootDir,
        sessionDir,
        workspaceId,
        attemptId: "attempt-ours",
        workspaceStillRegistered: () => true,
      })
    ).toBe(true);
    expect(await isWorkspaceRemovalTombstoned(rootDir, workspaceId)).toBe(false);
  });

  test("startup heal reclaims old tombstones only for still-registered workspaces (r63)", async () => {
    using tmp = new DisposableTempDir("workspace-removal-test");
    const rootDir = path.join(tmp.path, "xum-home");
    // The healer ages markers by MTIME (r65): a crashed removal stops
    // renewing, so its marker's mtime matches its removedAt; a live slow
    // removal keeps the mtime fresh through startRemovalTombstoneLease.
    const write = async (workspaceId: string, removedAt: number, mtimeMs?: number) => {
      const p = workspaceRemovalTombstonePath(rootDir, workspaceId);
      await fsPromises.mkdir(path.dirname(p), { recursive: true });
      await fsPromises.writeFile(p, JSON.stringify({ workspaceId, removedAt }));
      const mtime = new Date(mtimeMs ?? removedAt);
      await fsPromises.utimes(p, mtime, mtime);
    };
    const old = Date.now() - REMOVAL_TOMBSTONE_HEAL_MIN_AGE_MS - 1_000;
    await write("ws-bricked-registered", old); // failure residue → heal
    await write("ws-mid-removal", Date.now()); // fresh: may be a removal in flight → keep
    await write("ws-gone", old); // deregistered long ago (normal terminal state) → keep
    // r65: published long ago but still lease-renewed (fresh mtime) — a
    // removal wedged between session deletion and config deregistration is
    // ACTIVE, not residue; healing it would reopen the durable removal gate
    // for foreign writers mid-removal.
    await write("ws-slow-removal", old, Date.now());

    const registered = new Set(["ws-bricked-registered", "ws-mid-removal", "ws-slow-removal"]);
    await healRemovalTombstonesForRegisteredWorkspaces({
      rootDir,
      findWorkspace: (id) => (registered.has(id) ? { id } : undefined),
    });

    expect(await isWorkspaceRemovalTombstoned(rootDir, "ws-bricked-registered")).toBe(false);
    expect(await isWorkspaceRemovalTombstoned(rootDir, "ws-mid-removal")).toBe(true);
    expect(await isWorkspaceRemovalTombstoned(rootDir, "ws-gone")).toBe(true);
    expect(await isWorkspaceRemovalTombstoned(rootDir, "ws-slow-removal")).toBe(true);
  });
});

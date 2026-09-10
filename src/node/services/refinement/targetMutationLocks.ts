/**
 * Shared per-target mutation locks (RLM rollback hardening).
 *
 * The rollback engine's divergence check and its inverse apply are two steps;
 * without a lock shared with ORDINARY writers, a normal MemoryService write
 * or agent_skill_write/delete to the same root can land between them and be
 * silently overwritten by the rollback (the rollback session mutex + lockfile
 * only serialize other rollbacks). Every mutation path therefore acquires a
 * process-wide mutex keyed by the canonical mutation root, and the rollback
 * re-verifies divergence INSIDE that lock immediately before applying.
 *
 * Keys (must be identical strings on the writer and rollback sides):
 * - memory, global/project scopes: `<muxRoot>/memory` (one coarse key — the
 *   rollback confinement root; per-scope granularity is not worth divergent
 *   key derivations, and memory writes are ms-range local I/O);
 * - memory, workspace scope: `<sessionDir>/memory` (the store root, which is
 *   also the rollback confinement root);
 * - skills: the resolved skills root (`.../.mux/skills`, `.../.agents/skills`
 *   or `<muxRoot>/skills`), as returned by the rollback confinement resolver
 *   and known to the local skill tools. Runtime-backed (SSH/Docker) skill
 *   writers are excluded: their rows are stamped `runtime: "remote"` and are
 *   never rollbackable, so there is nothing to serialize against.
 *
 * Lock ordering (deadlock safety): the rollback acquires its per-session
 * mutex, then the cross-process rollback lockfile, then per target key (in
 * one global sorted order) the in-process target mutex followed by the
 * cross-process target file lock; writers acquire only one target pair (and
 * may take the journal blob lock inside it). Mutex-before-file within a key
 * and sorted keys across multi-root rollbacks keep the nesting order
 * globally consistent, and nothing acquires the session mutex or rollback
 * lockfile while holding a target lock — no cycle exists.
 *
 * Cross-process scope (round 18): the debug-CLI rollback runs in a separate
 * process, so the in-process mutex alone let a live-app write land after the
 * CLI's in-lock divergence re-verify and be silently overwritten by the
 * inverse. Each target key therefore ALSO maps to a cross-process lockfile
 * (acquireProcessFileLock: birth-token liveness + bounded stale reclaim)
 * held through the same window as the mutex. The in-process MutexMap stays
 * as the fast path serializing same-process callers.
 *
 * Lockfile location: `<muxRoot>/locks/target-<sha256(key)>.lock` — an
 * external dir rather than a dotfile inside the root, because (a) skill
 * roots live inside repo checkouts where stray lockfiles would show up in
 * git status, and (b) the mutations themselves can DELETE the root
 * (agent_skill_delete, memory dir deletes), which would destroy an in-root
 * lockfile while held. Hashed keys avoid path-length/separator issues; keys
 * are lexical canonical roots, identical on the writer and rollback sides.
 *
 * Timeout policy: FAIL-FAST with a clear retryable error rather than
 * proceed-with-warning — proceeding would reopen the exact silent-overwrite
 * race this lock closes. Legitimate holds are ms-range disk I/O, crash
 * remnants are bounded by the file lock's birth/lease reclaim, so a
 * 2-second wait only ever fails against a genuinely wedged holder. A LIVE
 * holder wedged past the stale-lock lease stays safe even on hosts where
 * process birth is undeterminable: the file lock renews its lease while
 * held (r59), so lease-based reclaim can never displace a live holder
 * mid-mutation and let two processes commit to the same target.
 *
 * Callers that cannot resolve muxRoot (`null`) fall back to in-process-only
 * locking — the pre-round-18 behavior — rather than inventing a divergent
 * lockfile location the other side would not consult.
 */

import crypto from "node:crypto";
import * as path from "node:path";

import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";

/** Bound on waiting for a contended cross-process target lock (see module doc). */
export const TARGET_MUTATION_LOCK_TIMEOUT_MS = 2_000;

/** Process-wide registry; see module doc for key derivation and ordering. */
export const targetMutationLocks = new MutexMap<string>();

/** Cross-process lockfile path for one canonical target key (see module doc). */
export function targetMutationLockFilePath(muxRoot: string, key: string): string {
  const digest = crypto.createHash("sha256").update(path.resolve(key)).digest("hex").slice(0, 32);
  return path.join(muxRoot, "locks", `target-${digest}.lock`);
}

/** Canonical lock key for a memory store root (see module doc). */
export function memoryMutationLockKey(muxRoot: string, physicalRoot: string): string {
  const memoryRoot = path.resolve(muxRoot, "memory");
  const resolved = path.resolve(physicalRoot);
  return resolved === memoryRoot || resolved.startsWith(memoryRoot + path.sep)
    ? memoryRoot
    : resolved;
}

/** Acquire one target's in-process mutex + cross-process file lock, then run. */
export async function withTargetMutationLock<T>(
  muxRoot: string | null,
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  return withTargetMutationLocks(muxRoot, [key], fn);
}

/**
 * Acquire several target locks (deduped, sorted for a deterministic global
 * order so overlapping multi-root rollbacks cannot ABBA-deadlock), then run.
 * Each key nests its in-process mutex around its cross-process file lock
 * (skipped when muxRoot is null — see the module-doc fallback note).
 */
export async function withTargetMutationLocks<T>(
  muxRoot: string | null,
  keys: string[],
  fn: () => Promise<T>
): Promise<T> {
  const sorted = [...new Set(keys.map((key) => path.resolve(key)))].sort();
  const run = (index: number): Promise<T> => {
    if (index >= sorted.length) return fn();
    return targetMutationLocks.withLock(sorted[index], async () => {
      if (muxRoot === null) {
        return await run(index + 1);
      }
      await using _fileLock = await acquireTargetFileLock(muxRoot, sorted[index]);
      return await run(index + 1);
    });
  };
  return run(0);
}

/** Acquire the cross-process leg, rethrowing timeouts as actionable errors. */
async function acquireTargetFileLock(muxRoot: string, key: string): Promise<AsyncDisposable> {
  try {
    return await acquireProcessFileLock({
      lockPath: targetMutationLockFilePath(muxRoot, key),
      timeoutMs: TARGET_MUTATION_LOCK_TIMEOUT_MS,
      label: "target mutation lock",
    });
  } catch (error) {
    // Fail-fast (see module doc): proceeding would reopen the cross-process
    // silent-overwrite race this lock exists to close.
    throw new Error(
      `Another process is mutating '${key}' (e.g. a refinement rollback from the debug CLI). ` +
        `Retry shortly. (${error instanceof Error ? error.message : String(error)})`
    );
  }
}

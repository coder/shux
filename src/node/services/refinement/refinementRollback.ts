/**
 * Refinement rollback engine (RLM track, phase r6): makes the r2 journal
 * actionable. `listRefinements` returns the byId-deduped refinement rows of a
 * session; `rollbackRefinement` applies a row's recorded inverse back to the
 * filesystem and journals the rollback as a refinement row of its own (with
 * `rollbackOf`), so rollbacks are themselves invertible — rolling back a
 * rollback just inverts again.
 *
 * Safety posture:
 * - Confinement (never overridable, not even with force): inverse paths must
 *   resolve inside legal self-modification roots — memory scope roots under
 *   the session's xum home, or `.xum/skills` / `.mux/skills` (legacy) /
 *   `.agents/skills` directories.
 *   r2 only instruments the memory + skill tools, so repo AGENTS.md files and
 *   built-in skills (embedded in the app bundle) never appear in the journal;
 *   the confinement check refuses them anyway in case of a corrupted row.
 * - Divergence (overridable with force, CLI-only): if the current file state
 *   no longer matches what the inverse expects — a later journaled row touched
 *   the same paths, or the files were deleted/recreated since — refuse with an
 *   error listing the divergence.
 *
 * Scope note: inverses are applied to the HOST filesystem. Skill rows written
 * by remote runtimes carry runtime-namespace paths; those either fail the
 * confinement/divergence checks or simply do not exist locally, and are not
 * translated here (same v1 scope as the r2 emitters' cross-workspace caveat).
 */

import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import writeFileAtomic from "write-file-atomic";
import assert from "@/common/utils/assert";
import type { DurableEvent } from "@/common/types/durableEvent";
import {
  MemoryRefinementActionSchema,
  RefinementInverseSchema,
  RefinementPostStateSchema,
  RollbackRefinementActionSchema,
  SkillRefinementActionSchema,
  type RefinementInverse,
  type RollbackRefinementAction,
} from "@/common/types/refinement";
import { getErrorMessage } from "@/common/utils/errors";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import { acquireProcessFileLock, type ProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { sharedDurableEventJournal } from "@/node/utils/journal/durableEventJournal";
import type { BlobQuotaEntry } from "@/node/utils/journal/blobReclamation";
import { log } from "@/node/services/log";
import {
  reclaimExcessRefinementInverseBlobs,
  resolveRefinementInverse,
  sha256Hex,
  type RefinementFileCapture,
  type RefinementInverseDraft,
} from "./refinementJournal";
import { withTargetMutationLocks } from "./targetMutationLocks";
import { advanceWorkspaceMemoryRevision } from "./workspaceMemoryRevision";
import { isWorkspaceRemovalTombstoned } from "@/node/services/workspaceRemoval";
import {
  createLegacyPathRemapper,
  LegacyPathNotAdoptedError,
} from "@/node/services/memoryLegacyAdoption";

export type RefinementEvent = Extract<DurableEvent, { kind: "refinement" }>;

/** All refinement rows in the session journal (byId-deduped, seq order). */
export async function listRefinements(sessionDir: string): Promise<RefinementEvent[]> {
  assert(sessionDir.length > 0, "listRefinements requires a session dir");
  const events = await sharedDurableEventJournal(sessionDir).read();
  return events.filter((event): event is RefinementEvent => event.kind === "refinement");
}

export interface RollbackRefinementOptions {
  sessionDir: string;
  /** Envelope `id` of the refinement row to roll back. */
  id: string;
  /** Apply despite detected divergence. Confinement is NEVER overridable. */
  force?: boolean;
  /**
   * Session dir of the task-tree owner whose <sessionDir>/memory backs this
   * session's `/memories/workspace` (sub-agents only; omit when the session
   * owns its store). Admits that one extra memory root for confinement.
   */
  sharedWorkspaceMemorySessionDir?: string;
  /**
   * Session dirs of the OTHER live task-tree members sharing this session's
   * `/memories/workspace` store (owner, siblings, descendants), resolved at
   * rollback time. Each member journals only its own mutations of the shared
   * store, so their rows are merged into divergence detection: a child's
   * later edit under a path the owner renamed must surface as a conflict
   * when the owner rolls the rename back. Omit when the store is private.
   * MUST throw when membership cannot be established (unreadable config);
   * the rollback is then refused instead of assuming an empty tree.
   */
  listSharedWorkspaceMemoryPeerSessionDirs?: () => string[];
  /** Attribution for the emitted rollback row. */
  evidence: { toolName: string; toolCallId?: string; actor?: string };
  /** Caller-supplied justification, recorded in the rollback row's action. */
  reason?: string;
  /**
   * Test seam: runs after filesystem mutation, immediately before the
   * commit-point ownership re-check — the only way to deterministically
   * exercise the double-entry interleaving (a real competitor cannot be
   * paused between our mutation and our journal append).
   */
  testOnlyBeforeCommit?: () => Promise<void>;
  /**
   * Test seam: runs after the plan-time divergence check, immediately before
   * the per-target mutation locks are acquired — the only way to
   * deterministically interleave an ordinary writer into the check→apply
   * window (a real writer cannot be paused there).
   */
  testOnlyBeforeTargetLock?: () => Promise<void>;
  /**
   * Test seam: runs immediately before the rollback row is journaled — the
   * only way to deterministically interleave an ordinary writer into the
   * apply→journal window (r19 durable-ordering inversion).
   */
  testOnlyBeforeRollbackJournal?: () => Promise<void>;
}

export interface RollbackApplied {
  /** Envelope id of the emitted rollback row; null if journaling failed. */
  rollbackRowId: string | null;
  /** Files restored to their recorded prior contents. */
  restored: string[];
  /** Files deleted (the target row had created them). */
  deleted: string[];
  /** Rename that was undone. */
  renamed?: { from: string; to: string };
}

export type RollbackRefinementResult =
  | { success: true; data: RollbackApplied }
  | { success: false; error: string };

/** Expected, recoverable rollback refusals; converted to { success: false }. */
class RollbackError extends Error {}

/**
 * Per-session-dir locks serializing the whole read → validate → mutate →
 * append sequence. Without this, two concurrent rollback calls for the same
 * row (model tool + debug CLI, or two tool invocations) can both read the
 * journal before either appends, pass the already-rolled-back check, apply
 * the same inverse twice, and append duplicate `rollbackOf` rows. Both entry
 * points go through this module in-process, so a process-wide map suffices.
 */
const sessionLocks = new Map<string, AsyncMutex>();

function sessionLock(sessionDir: string): AsyncMutex {
  const key = path.resolve(sessionDir);
  let mutex = sessionLocks.get(key);
  if (mutex === undefined) {
    mutex = new AsyncMutex();
    sessionLocks.set(key, mutex);
  }
  return mutex;
}

/** Lockfile name inside the session dir for the cross-process rollback claim. */
const ROLLBACK_LOCKFILE = "refinement-rollback.lock";

/**
 * Bound on waiting for a contended rollback lockfile. Rollbacks are rare and
 * hold the lock for ms-range disk I/O, so a short poll-wait behaves like the
 * previous fail-fast on genuinely live contention while absorbing transient
 * overlap; crash remnants are reclaimed by the file-lock protocol below.
 */
const ROLLBACK_LOCK_TIMEOUT_MS = 2_000;

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}

/**
 * Cross-process rollback lock. The in-process mutex above cannot serialize
 * the debug CLI (a standalone Bun process, src/cli/debug/refinements.ts)
 * against the Electron backend: both processes could pass the
 * already-rolled-back check, double-apply the inverse, and append duplicate
 * `rollbackOf` rows.
 *
 * Backed by the shared acquireProcessFileLock protocol (r18 — previously a
 * bespoke PID-only lock): atomic-with-content lock birth, ownership-verified
 * release, and stale reclaim by pid + process-birth identity with a bounded
 * mtime-lease fallback. The birth token fixes the PID-reuse wedge (a crashed
 * owner's PID handed to an unrelated long-lived process no longer refuses
 * every rollback until manual cleanup), and legacy `pid:uuid` tokens from
 * older binaries degrade to the bounded lease instead of living forever.
 * Old `.reclaim-guard` remnants are ignored (they only gated the bespoke
 * reclaimers); the shared protocol brings its own `.reclaim` guard.
 *
 * Defense in depth: wrongful displacement of a live holder is practically
 * impossible but not provably impossible on birth-less platforms, so the
 * commit-point ownership re-verification in rollbackRefinement
 * (assertStillOwned before mutation and before the journal append) makes the
 * residual harmless — at most one entrant still owns the canonical lock at
 * the commit point; the loser aborts and self-compensates.
 *
 * Exported for tests (concurrency scenarios need the raw lock, not a full
 * rollback); production callers go through rollbackRefinement.
 */
export interface RollbackFileLock extends AsyncDisposable {
  /** Re-read the canonical lockfile and require this acquisition's token. */
  assertStillOwned(): Promise<void>;
}

export async function acquireRollbackFileLock(sessionDir: string): Promise<RollbackFileLock> {
  const lockPath = path.join(path.resolve(sessionDir), ROLLBACK_LOCKFILE);
  // A session dir may not exist yet (e.g. unknown-id refusals before any row
  // was journaled); the claim must still succeed so the ordinary "No
  // refinement row" refusal is reached instead of a lockfile ENOENT.
  await fsPromises.mkdir(path.resolve(sessionDir), { recursive: true });
  let fileLock: ProcessFileLock;
  try {
    fileLock = await acquireProcessFileLock({
      lockPath,
      timeoutMs: ROLLBACK_LOCK_TIMEOUT_MS,
      label: "rollback lock",
    });
  } catch (error) {
    throw new RollbackError(
      `Another rollback is in progress for this session (lockfile '${lockPath}'). ` +
        `Retry once it finishes. (${getErrorMessage(error)})`
    );
  }
  return {
    async assertStillOwned() {
      try {
        await fileLock.assertStillOwned();
      } catch (error) {
        // Only translate the ownership-loss failure; real fs errors propagate.
        if (!(error instanceof Error) || !error.message.includes("no longer owned")) {
          throw error;
        }
        throw new RollbackError(
          `Aborting rollback: lost ownership of '${lockPath}' mid-operation (another process reclaimed it). No changes were committed by this call.`
        );
      }
    },
    [Symbol.asyncDispose]: () => fileLock[Symbol.asyncDispose](),
  };
}

// ---------------------------------------------------------------------------
// Confinement: legal self-modification roots
// ---------------------------------------------------------------------------

/**
 * Memory scope roots derivable from the session dir. MemoryService stores
 * global/project scopes under `<muxRoot>/memory/...` and workspace scope under
 * `<muxRoot>/sessions/<ws>/memory/...` (see MemoryService.getStore). Returns
 * null when the session dir does not sit in a `<muxRoot>/sessions/<ws>`
 * layout — memory rollbacks are refused then, because no root can be trusted.
 */
function inferMemoryLayout(sessionDir: string): { muxRoot: string; sessionsDir: string } | null {
  const sessionsDir = path.dirname(path.resolve(sessionDir));
  if (path.basename(sessionsDir) !== "sessions") {
    return null;
  }
  return { muxRoot: path.dirname(sessionsDir), sessionsDir };
}

/**
 * Resolve the legal root containing `filePath` for the row's kind, or throw.
 * Purely lexical (the path is normalized by path.resolve); symlink escapes are
 * caught separately by assertNoSymlinkEscape before any write/delete.
 */
function resolveConfinementRoot(
  sessionDir: string,
  kind: "memory" | "skill",
  filePath: string,
  sharedWorkspaceMemorySessionDir?: string
): string {
  if (!path.isAbsolute(filePath)) {
    throw new RollbackError(`Refusing rollback: inverse path is not absolute: '${filePath}'`);
  }
  const resolved = path.resolve(filePath);
  const segments = resolved.split(path.sep);

  if (kind === "skill") {
    // Project skill files live under a `.xum/skills` (canonical),
    // `.mux/skills` (legacy read fallback), or `.agents/skills` directory
    // (project checkout or home). Require at least <skill>/<file> below the
    // skills root so the roots themselves can never be a rollback target.
    for (let i = 0; i + 1 < segments.length; i++) {
      const pair = `${segments[i]}/${segments[i + 1]}`;
      if (
        (pair === ".xum/skills" || pair === ".mux/skills" || pair === ".agents/skills") &&
        segments.length >= i + 4
      ) {
        return segments.slice(0, i + 2).join(path.sep);
      }
    }
    // Global skill files live at <muxRoot>/skills/<skill>/<file> — the same
    // root the producers resolve (agent_skill_write/delete use
    // path.join(muxScope.muxHome, "skills") for global scope), derived here
    // from the session dir layout like the memory roots below.
    const layout = inferMemoryLayout(sessionDir);
    if (layout !== null) {
      const globalSkillsRoot = path.join(layout.muxRoot, "skills");
      const relToGlobal = path.relative(globalSkillsRoot, resolved);
      if (!relToGlobal.startsWith("..") && !path.isAbsolute(relToGlobal)) {
        if (relToGlobal.split(path.sep).length >= 2) {
          return globalSkillsRoot;
        }
        throw new RollbackError(
          `Refusing rollback: path targets the global skills root, not a file inside it: '${filePath}'`
        );
      }
    }
    throw new RollbackError(
      `Refusing rollback: path is outside every skills root (.xum/skills, .mux/skills, .agents/skills, <xumHome>/skills): '${filePath}'`
    );
  }

  const layout = inferMemoryLayout(sessionDir);
  if (layout === null) {
    throw new RollbackError(
      `Refusing rollback: cannot derive memory roots from session dir '${sessionDir}' (expected <muxRoot>/sessions/<workspace>)`
    );
  }
  // <muxRoot>/memory/<scope>/<file...> (global + project scopes).
  const memoryRoot = path.join(layout.muxRoot, "memory");
  const relToMemory = path.relative(memoryRoot, resolved);
  if (!relToMemory.startsWith("..") && !path.isAbsolute(relToMemory)) {
    if (relToMemory.split(path.sep).length >= 2) {
      return memoryRoot;
    }
    throw new RollbackError(
      `Refusing rollback: path targets a memory scope root, not a file inside it: '${filePath}'`
    );
  }
  // <sessionDir>/memory/<file...> (workspace scope). Constrained to exactly
  // THIS session's memory subdir so a corrupted inverse can never touch other
  // workspaces' memory or session artifacts (chat.jsonl, journals). The one
  // sanctioned second root is the task-tree owner's memory subdir, supplied
  // by the CALLER (never read from the row): a sub-agent's workspace-scope
  // writes physically land there (MemoryService.resolveWorkspaceMemoryOwnerId)
  // while the row stays in the sub-agent's own journal.
  const workspaceMemoryRoots = [path.join(path.resolve(sessionDir), "memory")];
  if (sharedWorkspaceMemorySessionDir !== undefined) {
    const sharedSessionDir = path.resolve(sharedWorkspaceMemorySessionDir);
    assert(
      path.dirname(sharedSessionDir) === layout.sessionsDir,
      "sharedWorkspaceMemorySessionDir must be a sibling session dir"
    );
    workspaceMemoryRoots.push(path.join(sharedSessionDir, "memory"));
  }
  for (const workspaceMemoryRoot of workspaceMemoryRoots) {
    const relToWorkspaceMemory = path.relative(workspaceMemoryRoot, resolved);
    if (!relToWorkspaceMemory.startsWith("..") && !path.isAbsolute(relToWorkspaceMemory)) {
      if (relToWorkspaceMemory.length > 0) {
        return workspaceMemoryRoot;
      }
      throw new RollbackError(
        `Refusing rollback: path targets a memory scope root, not a file inside it: '${filePath}'`
      );
    }
  }
  throw new RollbackError(
    `Refusing rollback: path is outside every memory scope root: '${filePath}'`
  );
}

/**
 * Whether `root` (a confinement root from resolveConfinementRoot) is a
 * workspace memory root — this session's own or the sanctioned owner's. Its
 * parent is then the session dir that carries the store's clock
 * (workspaceMemoryRevision.ts).
 */
function isWorkspaceMemoryRoot(
  sessionDir: string,
  root: string,
  sharedWorkspaceMemorySessionDir: string | undefined
): boolean {
  const candidates = [path.join(path.resolve(sessionDir), "memory")];
  if (sharedWorkspaceMemorySessionDir !== undefined) {
    candidates.push(path.join(path.resolve(sharedWorkspaceMemorySessionDir), "memory"));
  }
  return candidates.includes(path.resolve(root));
}

/**
 * The components of a confinement root that repo (or harness-writable)
 * content controls and could substitute with a symlink: `.mux`/`.agents` and
 * their `skills` child for project roots; the `skills`/`memory` dir itself
 * for muxRoot-derived roots. Ancestors ABOVE these (the checkout path,
 * muxRoot) are environmental — worktree layouts and macOS /tmp legitimately
 * traverse symlinks — so they are intentionally not listed.
 */
function repoControlledRootComponents(rootAbs: string): string[] {
  const parent = path.dirname(rootAbs);
  const parentBase = path.basename(parent);
  if (parentBase === ".xum" || parentBase === ".mux" || parentBase === ".agents") {
    return [parent, rootAbs];
  }
  return [rootAbs];
}

/**
 * Reject link-substituted confinement roots. assertNoSymlinkEscape trusts
 * realpath(rootAbs) as its anchor, so a repo revision that replaces
 * `.xum/skills` (or `.mux/skills` / `.agents/skills`) with a symlink would make the
 * attacker-selected external directory the trust anchor — targets appear
 * "inside" it and the later rm/writeFileAtomic follows the link outside the
 * checkout. lstat each repo-controlled component and refuse when any is a
 * symlink; a missing component is fine (nothing exists to escape through).
 */
async function assertRootComponentsNotSymlinked(rootAbs: string): Promise<void> {
  for (const component of repoControlledRootComponents(rootAbs)) {
    let stat;
    try {
      stat = await fsPromises.lstat(component);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new RollbackError(
        `Refusing rollback: confinement root component '${component}' is a symbolic link (possible link substitution of a skills/memory root)`
      );
    }
  }
}

/**
 * Symlink-escape prevention (mirrors LocalMemoryStore.assertContained):
 * realpath the deepest existing ancestor of the target and require it to stay
 * inside the (realpathed) root. A missing root means nothing exists under it,
 * so there is nothing to escape through. Callers must first reject
 * link-substituted roots (assertRootComponentsNotSymlinked) — realpath here
 * would otherwise legitimize a symlinked root as the trust anchor.
 */
async function assertNoSymlinkEscape(rootAbs: string, targetAbs: string): Promise<void> {
  let realRoot: string;
  try {
    realRoot = await fsPromises.realpath(rootAbs);
  } catch {
    return;
  }
  let candidate = targetAbs;
  for (;;) {
    try {
      const real = await fsPromises.realpath(candidate);
      const rel = path.relative(realRoot, real);
      if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
        throw new RollbackError(
          `Refusing rollback: '${targetAbs}' escapes its root through a symlink`
        );
      }
      return;
    } catch (error) {
      if (error instanceof RollbackError) {
        throw error;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        return; // No existing ancestor at all (unreachable in practice).
      }
      candidate = parent;
    }
  }
}

/** Every filesystem path a parsed inverse touches. */
function inversePaths(inverse: RefinementInverse): string[] {
  switch (inverse.op) {
    case "delete-files":
      return inverse.paths;
    case "restore-files":
      // deletePaths are mutated (deleted) by the apply, so they need the
      // same confinement checks and target locks as the restored files (r67).
      return [...inverse.files.map((file) => file.path), ...(inverse.deletePaths ?? [])];
    case "rename":
      return [inverse.from, inverse.to];
  }
}

// ---------------------------------------------------------------------------
// Divergence detection
// ---------------------------------------------------------------------------

/** Path overlap including prefix containment (a rename can move a whole dir). */
function pathsOverlap(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return ra === rb || ra.startsWith(rb + path.sep) || rb.startsWith(ra + path.sep);
}

async function fileExists(target: string): Promise<boolean> {
  try {
    const stat = await fsPromises.stat(target);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Presence the current filesystem must show for the target's restore-files
 * inverse to apply cleanly: rows whose action was a delete expect their files
 * to be ABSENT now (present = recreated since); edit rows expect them PRESENT
 * (absent = deleted since). Returns null when the action is unparseable — the
 * caller then requires force, because no expectation can be established.
 */
function expectedPresenceForRestore(target: RefinementEvent): "present" | "absent" | null {
  const rollback = RollbackRefinementActionSchema.safeParse(target.data.action);
  if (rollback.success) {
    // Handled content-exactly by the caller via the original row's inverse.
    return null;
  }
  if (target.data.kind === "memory") {
    const parsed = MemoryRefinementActionSchema.safeParse(target.data.action);
    if (!parsed.success) return null;
    return parsed.data.op === "delete" ? "absent" : "present";
  }
  const parsed = SkillRefinementActionSchema.safeParse(target.data.action);
  if (!parsed.success) return null;
  return parsed.data.op === "write" ? "present" : "absent";
}

interface InverseContentReader {
  read(file: { path: string; text?: string; blobRef?: string }): Promise<string>;
}

/**
 * Collect divergence complaints for rolling back `target` given the current
 * filesystem + journal state. Empty array = safe to apply.
 */
/**
 * Journal order for conflict detection. Rows copied from a removed sub-agent's
 * journal (sharedMemoryRowMigration.ts) were appended later than they
 * happened; their `sourceTs` restores the mutation's real position relative
 * to the owner's own rows. Same-instant ties fall back to append sequence.
 */
function isAfter(row: RefinementEvent, other: RefinementEvent): boolean {
  const rowTs = row.data.sourceTs ?? row.ts;
  const otherTs = other.data.sourceTs ?? other.ts;
  return rowTs > otherTs || (rowTs === otherTs && row.seq > other.seq);
}

/**
 * Whether the order of two rows cannot be established: a row journaled while
 * the shared store's clock write failed (`orderUnknown`) has only
 * journal-local `ts`/`seq`, incomparable with other journals' rows. Callers
 * fail closed — such a pair conflicts in either direction (force overrides).
 */
function orderUnknown(
  row: RefinementEvent,
  target: RefinementEvent,
  targetRetargeted: boolean
): boolean {
  if (row.data.orderUnknown === true || target.data.orderUnknown === true) return true;
  // A retargeted target (see wasRetargeted) vs. a row of another journal.
  return targetRetargeted && row.workspaceId !== target.workspaceId;
}

/**
 * Memory rows from the other task-tree members' journals that touched the
 * shared workspace store (owner's <sessionDir>/memory). Read without their
 * session locks: journals are append-only and self-healing on read, and a
 * row landing after this read is caught by the fs-level checks like any
 * other concurrent writer.
 */
async function readSharedMemoryPeerRows(
  opts: RollbackRefinementOptions
): Promise<RefinementEvent[]> {
  // Membership must be established, not guessed: a resolver that cannot read
  // the topology (config.json missing/malformed) throws, and the rollback is
  // refused rather than proceeding with no peer journals — an owner would
  // otherwise move a child's later edit without warning.
  let peerDirs: string[];
  try {
    peerDirs = opts.listSharedWorkspaceMemoryPeerSessionDirs?.() ?? [];
  } catch (error) {
    throw new RollbackError(
      `Refusing rollback of '${opts.id}': the task tree sharing this workspace's memory store could not be resolved (${getErrorMessage(error)})`
    );
  }
  if (peerDirs.length === 0) return [];
  const sharedRoot = path.join(
    path.resolve(opts.sharedWorkspaceMemorySessionDir ?? opts.sessionDir),
    "memory"
  );
  const ownerSessionDir = path.dirname(sharedRoot);
  const actingWorkspaceId = path.basename(path.resolve(opts.sessionDir));
  // The same duplicate seen from the other side: a removal that aborted after
  // its pre-teardown pass leaves THIS (owner) journal holding copies of a
  // still-registered child's rows. Read as that child's peer rows, the
  // originals would count as separate later mutations of the very notes the
  // copies describe — and a retargeted original is `orderUnknown`, so the
  // copy could never be rolled back until the removal finally succeeds.
  // Only a copy that still REPRESENTS its source stands in for it: a copy
  // whose inverse is unparseable contributes nothing to divergence
  // (collectDivergence skips it), so suppressing its intact original would
  // let this rollback overwrite the peer mutation that original records.
  const migratedHere = new Set<string>();
  for (const row of await listRefinements(opts.sessionDir)) {
    if (
      row.data.migratedFrom !== undefined &&
      row.data.kind === "memory" &&
      RefinementInverseSchema.safeParse(row.data.inverse).success
    ) {
      migratedHere.add(row.data.migratedFrom);
    }
  }
  const peerRows: RefinementEvent[] = [];
  for (const peerDir of peerDirs) {
    assert(
      path.resolve(peerDir) !== path.resolve(opts.sessionDir),
      "peer session dirs exclude the acting session"
    );
    // A peer sub-agent's pre-sharing rows address ITS legacy private
    // notebook; the notes live in the shared store now (adoption manifest
    // in the peer's session dir). Retarget them through that peer's manifest
    // before the overlap test — the peer's later edit of an adopted note must
    // surface against the owner's rollback like any shared-store row. The
    // remapped inverse replaces the recorded one on the returned row, so the
    // acting session's later checks (its own remapper is a no-op for owner
    // paths) compare the paths the note actually lives at. Legacy paths the
    // shared store never took address invisible files and are dropped.
    // Strict: an unreadable peer manifest must refuse the rollback, not read
    // as "nothing adopted" and silently drop that peer's later mutations.
    let remap: RecordedPathRemapper;
    if (path.resolve(peerDir) === path.resolve(ownerSessionDir)) {
      remap = identityRemapper;
    } else {
      try {
        remap = await createLegacyPathRemapper({
          childSessionDir: peerDir,
          ownerSessionDir,
          strict: true,
        });
      } catch (error) {
        throw new RollbackError(
          `Refusing rollback of '${opts.id}': a tree member's adoption manifest could not be read (${getErrorMessage(error)})`
        );
      }
    }
    const peerWorkspaceId = path.basename(path.resolve(peerDir));
    for (const row of await listRefinements(peerDir)) {
      if (row.data.kind !== "memory") continue;
      // A removal that aborted after its pre-teardown pass leaves the owner
      // journal holding COPIES of this session's rows (migratedFrom =
      // "<this workspace>:<row id>") while this session lives on. They are
      // this journal's rows seen twice, not later peer edits.
      if (row.data.migratedFrom?.startsWith(`${actingWorkspaceId}:`) === true) continue;
      // ...and the originals of copies this journal already holds (above).
      if (migratedHere.has(`${peerWorkspaceId}:${row.id}`)) continue;
      const original = RefinementInverseSchema.safeParse(row.data.inverse);
      const parsed = parseRemappedInverse(row, remap);
      if (parsed === null || !original.success) continue;
      if (!inversePaths(parsed).some((p) => pathsOverlap(p, sharedRoot))) continue;
      // A retargeted peer row carries its private clock: order unknown.
      peerRows.push({
        ...row,
        data: {
          ...row.data,
          inverse: parsed,
          ...(wasRetargeted(original.data, parsed) ? { orderUnknown: true as const } : {}),
        },
      });
    }
  }
  return peerRows;
}

/**
 * Path retargeting applied to every recorded path of the acting session's
 * journal before it is compared or applied (see createLegacyPathRemapper):
 * identity for a session that owns its store. Rows whose paths cannot be
 * mapped (a legacy note the shared store never took) contribute nothing to
 * divergence — they address an invisible file the target cannot overlap.
 */
interface RecordedPathRemapper {
  path(filePath: string): string;
  inverse(inverse: RefinementInverse): RefinementInverse;
}
const identityRemapper: RecordedPathRemapper = {
  path: (filePath) => filePath,
  inverse: (inverse) => inverse,
};
function parseRemappedInverse(
  row: RefinementEvent,
  remap: RecordedPathRemapper
): RefinementInverse | null {
  const parsed = RefinementInverseSchema.safeParse(row.data.inverse);
  if (!parsed.success) return null;
  try {
    return remap.inverse(parsed.data);
  } catch (error) {
    if (error instanceof LegacyPathNotAdoptedError) return null;
    throw error;
  }
}

/**
 * Whether retargeting changed the inverse's paths: such a row was journaled
 * against a PRIVATE store (pre-sharing), so its `ts`/`sourceTs` belong to
 * that store's clock and are incomparable with the shared store's rows.
 */
function wasRetargeted(original: RefinementInverse, remapped: RefinementInverse): boolean {
  return JSON.stringify(inversePaths(original)) !== JSON.stringify(inversePaths(remapped));
}

async function collectDivergence(
  rows: RefinementEvent[],
  target: RefinementEvent,
  inverse: RefinementInverse,
  readContent: InverseContentReader,
  remap: RecordedPathRemapper,
  targetRetargeted: boolean
): Promise<string[]> {
  const complaints: string[] = [];
  const targetPaths = inversePaths(inverse);

  // Later journaled rows touching the same paths: the state the inverse
  // expects has been superseded — roll the newest row back first. Rollback
  // lineage is netted out so LIFO multi-edit unrolling works without force:
  // a row whose effect was itself rolled back is no longer on disk, and a
  // live rollback chain only conflicts when its net effect differs from the
  // state the target left behind (see liveRowConflictsWithTarget).
  const rolledBackIds = new Set(
    rows.map((row) => row.data.rollbackOf).filter((id): id is string => id !== undefined)
  );
  for (const row of rows) {
    if (row.id === target.id) continue;
    if (!isAfter(row, target) && !orderUnknown(row, target, targetRetargeted)) continue;
    if (rolledBackIds.has(row.id)) continue; // Effect undone by a later rollback row.
    if (!liveRowConflictsWithTarget(rows, row, target, targetRetargeted)) continue;
    const parsed = parseRemappedInverse(row, remap);
    if (parsed === null) continue;
    const overlap = inversePaths(parsed).some((p) => targetPaths.some((t) => pathsOverlap(p, t)));
    if (overlap) {
      complaints.push(
        orderUnknown(row, target, targetRetargeted)
          ? `refinement row ${row.id} (seq ${row.seq}) touched the same paths and its order relative to this row is unknown (its store clock write failed)`
          : `later refinement row ${row.id} (seq ${row.seq}) touched the same paths`
      );
    }
  }

  switch (inverse.op) {
    case "delete-files": {
      // Inverse of a create: the created files must still exist.
      for (const p of inverse.paths) {
        if (!(await fileExists(p))) {
          complaints.push(`expected '${p}' to exist (created by the target row), but it is gone`);
        }
      }
      break;
    }
    case "rename": {
      if (!(await fileExists(inverse.from)) && !(await dirExists(inverse.from))) {
        complaints.push(`expected rename source '${inverse.from}' to exist`);
      }
      if ((await fileExists(inverse.to)) || (await dirExists(inverse.to))) {
        complaints.push(`expected rename destination '${inverse.to}' to be absent`);
      }
      break;
    }
    case "restore-files": {
      const rollbackAction = RollbackRefinementActionSchema.safeParse(target.data.action);
      if (rollbackAction.success) {
        // Target is itself a rollback: it applied the original row's inverse,
        // so the current state must still match that applied inverse —
        // content-exact where the original restored files.
        complaints.push(
          ...(await collectRollbackTargetDivergence(rows, rollbackAction.data, readContent, remap))
        );
        break;
      }
      const presence = expectedPresenceForRestore(target);
      if (presence === null) {
        complaints.push("cannot determine the expected file state from the row's action payload");
        break;
      }
      for (const file of inverse.files) {
        const exists = await fileExists(file.path);
        if (presence === "present" && !exists) {
          complaints.push(
            `expected '${file.path}' to exist (edited by the target row), but it was deleted since`
          );
        }
        if (presence === "absent" && exists) {
          complaints.push(
            `expected '${file.path}' to be absent (deleted by the target row), but it was recreated since`
          );
        }
      }
      break;
    }
  }

  // Content-exact check via the row's recorded post-action hashes: a manual
  // or cross-workspace edit after the target row never appears in this
  // session's journal, so the seq-based scan above cannot see it.
  complaints.push(...(await collectPostStateDivergence(target, remap)));

  return complaints;
}

/**
 * Compare the current contents of every file the target row recorded a
 * post-action hash for. Rows without a parseable `postState` (written before
 * the field existed, or rollback rows, which never record it) contribute no
 * complaints — their expected post-edit contents cannot be reconstructed from
 * the journal, so the presence-only checks above are the best we can do.
 */
async function collectPostStateDivergence(
  target: RefinementEvent,
  remap: RecordedPathRemapper
): Promise<string[]> {
  const postState = RefinementPostStateSchema.safeParse(target.data.postState);
  if (!postState.success) {
    return [];
  }
  const complaints: string[] = [];
  for (const file of postState.data.files) {
    let filePath: string;
    let current: string;
    try {
      filePath = remap.path(file.path);
      current = await fsPromises.readFile(filePath, "utf-8");
    } catch {
      continue; // Missing (or unmappable) files are already reported by the presence checks.
    }
    if (sha256Hex(current) !== file.sha256) {
      complaints.push(
        `'${filePath}' was modified after the target refinement (current content no longer matches the state it left behind)`
      );
    }
  }
  return complaints;
}

/**
 * Whether a later row that is still live (not itself rolled back) leaves a
 * net disk effect conflicting with the state the target row left behind.
 * Plain rows always conflict — their edit is still on disk. A rollback chain
 * nets out by parity: an even number of rollbacks re-applied the chain's root
 * row, so the root's edit is back on disk (conflict). An odd chain rewound
 * the paths to just before its root, which matches the target's expectation
 * only when the root came after the target (the LIFO unroll case); rewinding
 * to before the target is a conflict. Live rows between target and root are
 * evaluated as their own chains, so "just before the root" is enough here.
 */
function liveRowConflictsWithTarget(
  rows: RefinementEvent[],
  row: RefinementEvent,
  target: RefinementEvent,
  targetRetargeted: boolean
): boolean {
  if (row.data.rollbackOf === undefined) {
    return true; // Plain later row: its edit is live on disk.
  }
  let rollbackCount = 0;
  let current: RefinementEvent = row;
  const seen = new Set<string>([row.id]);
  while (current.data.rollbackOf !== undefined) {
    const original = rows.find((r) => r.id === current.data.rollbackOf);
    if (original === undefined || seen.has(original.id)) {
      return true; // Corrupt chain (missing root or cycle): assume conflict.
    }
    seen.add(original.id);
    rollbackCount += 1;
    current = original;
  }
  if (rollbackCount % 2 === 0) {
    return true; // Even chain: the root row's edit was re-applied.
  }
  // Odd chain: rewound to just before root — a conflict unless the root is
  // provably after the target.
  return !isAfter(current, target) || orderUnknown(current, target, targetRetargeted);
}

async function dirExists(target: string): Promise<boolean> {
  try {
    const stat = await fsPromises.stat(target);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Divergence for rolling back a rollback row: the rollback applied the
 * ORIGINAL row's inverse, so the disk must still match that applied state.
 * This is the one case where content-exact comparison is possible, because
 * the applied contents are recorded in the original row.
 */
async function collectRollbackTargetDivergence(
  rows: RefinementEvent[],
  action: RollbackRefinementAction,
  readContent: InverseContentReader,
  remap: RecordedPathRemapper
): Promise<string[]> {
  const original = rows.find((row) => row.id === action.of);
  if (original === undefined) {
    return [`the original row '${action.of}' this rollback applied is missing from the journal`];
  }
  const applied = parseRemappedInverse(original, remap);
  if (applied === null) {
    return [`the original row '${action.of}' has an unparseable or unmappable inverse`];
  }
  const complaints: string[] = [];
  switch (applied.op) {
    case "delete-files":
      for (const p of applied.paths) {
        if (await fileExists(p)) {
          complaints.push(
            `expected '${p}' to be absent (the rollback deleted it), but it was recreated since`
          );
        }
      }
      break;
    case "restore-files":
      for (const file of applied.files) {
        if (!(await fileExists(file.path))) {
          complaints.push(
            `expected '${file.path}' to exist (the rollback restored it), but it was deleted since`
          );
          continue;
        }
        const expected = await readContent.read(file);
        const current = await fsPromises.readFile(file.path, "utf-8");
        if (current !== expected) {
          complaints.push(`'${file.path}' was edited since the rollback restored it`);
        }
      }
      // Mixed force-apply inverse (r67): the rollback also deleted these
      // paths, so their recreation since is divergence too.
      for (const p of applied.deletePaths ?? []) {
        if (await fileExists(p)) {
          complaints.push(
            `expected '${p}' to be absent (the rollback deleted it), but it was recreated since`
          );
        }
      }
      break;
    case "rename":
      // Structural rename expectations are already covered by the target's
      // own inverse (the mirrored rename) in collectDivergence.
      break;
  }
  return complaints;
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/**
 * Roll back one refinement row: validate, capture the pre-rollback state as
 * the new row's inverse, apply the target's inverse to disk, and append the
 * rollback row with `rollbackOf`. Refusals return { success: false }.
 */
export async function rollbackRefinement(
  opts: RollbackRefinementOptions
): Promise<RollbackRefinementResult> {
  try {
    assert(opts.sessionDir.length > 0, "rollbackRefinement requires a session dir");
    assert(opts.id.length > 0, "rollbackRefinement requires a target row id");
    // Held across read → validate → mutate → append so concurrent calls for
    // the same row cannot both pass validation and double-apply the inverse.
    // Two layers: the in-process mutex serializes callers inside this process
    // cheaply; the lockfile serializes the debug CLI (a separate Bun process)
    // against the backend.
    await using _lock = await sessionLock(opts.sessionDir).acquire();
    await using fileLock = await acquireRollbackFileLock(opts.sessionDir);
    const journal = sharedDurableEventJournal(opts.sessionDir);
    const rows = await listRefinements(opts.sessionDir);

    const target = rows.find((row) => row.id === opts.id);
    if (target === undefined) {
      throw new RollbackError(`No refinement row with id '${opts.id}' in this session`);
    }
    const kind = target.data.kind;
    if (kind !== "memory" && kind !== "skill") {
      throw new RollbackError(
        `Refinement kind '${kind}' is not rollbackable (only memory and skill rows are)`
      );
    }
    // Remote (SSH/Docker) rows carry runtime-namespace paths; this engine
    // applies inverses through host fsPromises, which would at best refuse on
    // divergence and at worst create/overwrite a similarly named LOCAL path
    // while the remote edit stays untouched. Not overridable with force:
    // force overrides divergence, not the addressing mode — a forced apply
    // would still write to the wrong filesystem. Rows without the field
    // (older binaries, local runtimes) are host-local by construction.
    if (target.data.runtime === "remote") {
      throw new RollbackError(
        `Row '${opts.id}' was produced by a remote (SSH/Docker) workspace runtime; its paths are not addressable on this host. Remote skill rollbacks are not supported.`
      );
    }
    const existingRollback = rows.find((row) => row.data.rollbackOf === opts.id);
    if (existingRollback !== undefined) {
      throw new RollbackError(
        `Row '${opts.id}' was already rolled back by row '${existingRollback.id}'. Roll back that row instead to re-apply.`
      );
    }

    const parsedInverse = RefinementInverseSchema.safeParse(target.data.inverse);
    if (!parsedInverse.success) {
      throw new RollbackError(
        `Row '${opts.id}' has an unparseable inverse payload: ${parsedInverse.error.message}`
      );
    }
    // Sub-agent whose `/memories/workspace` is the owner's store: rows
    // journaled before sharing address its own <sessionDir>/memory, whose
    // notes were since folded into the owner's store (memoryLegacyAdoption).
    // Every recorded path of this journal — the target's inverse, later rows
    // for overlap, post-state hashes, a rollback chain's root — is retargeted
    // to the adopted copy, so the rollback reverts the note the shared
    // notebook serves. Mapped BEFORE confinement: the manifest's targets are
    // checked like any other recorded path.
    const remap: RecordedPathRemapper =
      kind === "memory" &&
      opts.sharedWorkspaceMemorySessionDir !== undefined &&
      path.resolve(opts.sharedWorkspaceMemorySessionDir) !== path.resolve(opts.sessionDir)
        ? await createLegacyPathRemapper({
            childSessionDir: opts.sessionDir,
            ownerSessionDir: opts.sharedWorkspaceMemorySessionDir,
          })
        : identityRemapper;
    let inverse: RefinementInverse;
    try {
      inverse = remap.inverse(parsedInverse.data);
    } catch (error) {
      if (!(error instanceof LegacyPathNotAdoptedError)) throw error;
      throw new RollbackError(`Refusing rollback of '${opts.id}': ${error.message}`);
    }
    // A retargeted target was journaled against this session's private
    // clock: its order relative to OTHER journals' rows is unknown, so those
    // are compared as order-unknown (conflict unless forced). Same-journal
    // rows still order by their shared sequence.
    const targetRetargeted = wasRetargeted(parsedInverse.data, inverse);

    // Confinement first — never overridable. A corrupted inverse must never
    // write outside the memory/skill roots (repo AGENTS.md, built-in skills,
    // or anything else). Re-run at the sink (assertConfinement below) because
    // the staging/capture phases between plan and write are slow enough for a
    // repo revision to swap a root for a symlink in the meantime.
    const roots = new Map<string, string>();
    for (const p of inversePaths(inverse)) {
      roots.set(
        p,
        resolveConfinementRoot(opts.sessionDir, kind, p, opts.sharedWorkspaceMemorySessionDir)
      );
    }
    const assertConfinement = async (): Promise<void> => {
      for (const [p, root] of roots) {
        await assertRootComponentsNotSymlinked(root);
        await assertNoSymlinkEscape(root, path.resolve(p));
      }
    };
    await assertConfinement();

    const readContent: InverseContentReader = {
      read: async (file) => {
        if (file.text !== undefined) return file.text;
        assert(file.blobRef !== undefined, "refinement file has neither text nor blobRef");
        const text = await journal.blobs.getText(file.blobRef);
        if (text === null) {
          // Most likely evicted by the inverse-blob quota (the row outlives
          // its payload as an audit record); corruption reads the same way.
          // Phase-1 staging below resolves every payload before any write,
          // so this aborts with the tree untouched — no partial apply.
          throw new RollbackError(
            `Inverse payload for '${file.path}' (blob ${file.blobRef}) is no longer available — ` +
              `older inverse payloads are reclaimed once the per-session rollback horizon is ` +
              `exceeded (or the blob is corrupt). This refinement can no longer be rolled back.`
          );
        }
        return text;
      },
    };

    // Conflict detection sees this journal plus every live tree member's
    // shared-store rows (see listSharedWorkspaceMemoryPeerSessionDirs); the
    // store clock (`sourceTs`) orders rows across journals. Target lookup,
    // rollbackOf checks and the appended row stay on this session's journal.
    // Re-read under the target locks below before the apply.
    const divergence = await collectDivergence(
      kind === "memory" ? [...rows, ...(await readSharedMemoryPeerRows(opts))] : rows,
      target,
      inverse,
      readContent,
      remap,
      targetRetargeted
    );
    if (divergence.length > 0 && opts.force !== true) {
      throw new RollbackError(
        `Refusing rollback of '${opts.id}': current state diverges from what the inverse expects:\n` +
          divergence.map((line) => `  - ${line}`).join("\n") +
          `\nRe-run with force to apply anyway.`
      );
    }

    if (opts.testOnlyBeforeTargetLock !== undefined) {
      await opts.testOnlyBeforeTargetLock();
    }

    // Verify + apply run under the per-target mutation locks shared with
    // ORDINARY writers (MemoryService commands, local agent_skill_write/
    // delete — see targetMutationLocks.ts): the rollback session mutex +
    // lockfile only serialize other rollbacks, so without this a normal write
    // landing between the divergence check above and the apply below would be
    // silently overwritten. Ordering: session mutex → rollback lockfile →
    // target locks (writers take only a target lock; no cycle).
    const lockKeys = [...roots.values()];
    // Cross-process leg: derive the shared lockfile dir from the session-dir
    // layout (the same muxRoot the writers pass from config/muxScope). A
    // non-standard layout (null) degrades to in-process-only locking — see
    // targetMutationLocks.ts.
    const targetLockRoot = inferMemoryLayout(opts.sessionDir)?.muxRoot ?? null;
    const applied = await withTargetMutationLocks(targetLockRoot, lockKeys, async () => {
      // Teardown gates (r61), same tombstone MemoryService checks pre-commit,
      // same lock. Acting workspace: removal's fail-closed orphan path leaves
      // the journal on disk but the workspace tombstoned, and a rollback from
      // it must not mutate anything nor append into the retained session.
      // Shared-store owner: a delete inverse expects its target absent, so
      // divergence alone would let a rollback that was waiting on this lock
      // recreate the removed owner's <sessionDir>/memory.
      if (targetLockRoot !== null) {
        const actingSessionDir = path.resolve(opts.sessionDir);
        if (await isWorkspaceRemovalTombstoned(targetLockRoot, path.basename(actingSessionDir))) {
          throw new RollbackError(`Refusing rollback of '${opts.id}': this workspace was removed`);
        }
        if (opts.sharedWorkspaceMemorySessionDir !== undefined) {
          const ownerSessionDir = path.resolve(opts.sharedWorkspaceMemorySessionDir);
          const ownerMemoryRoot = path.join(ownerSessionDir, "memory");
          if (
            lockKeys.includes(ownerMemoryRoot) &&
            (await isWorkspaceRemovalTombstoned(targetLockRoot, path.basename(ownerSessionDir)))
          ) {
            throw new RollbackError(
              `Refusing rollback of '${opts.id}': the workspace owning the shared memory store was removed`
            );
          }
        }
      }
      // The remapper's directory proof (an adopted directory maps only while
      // the owner's subtree is EXACTLY the adopted descendants) was computed
      // before this lock: an owner note added beside the copies while the
      // rollback waited would travel along with a legacy directory rename.
      // Re-derive the mapping under the lock and require it to be identical;
      // a mapping that no longer holds refuses like at plan time.
      if (remap !== identityRemapper) {
        assert(
          opts.sharedWorkspaceMemorySessionDir !== undefined,
          "a legacy remapper exists only for a sub-agent sharing its notebook"
        );
        let relocked: RefinementInverse;
        try {
          relocked = (
            await createLegacyPathRemapper({
              childSessionDir: opts.sessionDir,
              ownerSessionDir: opts.sharedWorkspaceMemorySessionDir,
            })
          ).inverse(parsedInverse.data);
        } catch (error) {
          if (!(error instanceof LegacyPathNotAdoptedError)) throw error;
          throw new RollbackError(`Refusing rollback of '${opts.id}': ${error.message}`);
        }
        if (JSON.stringify(inversePaths(relocked)) !== JSON.stringify(inversePaths(inverse))) {
          throw new RollbackError(
            `Refusing rollback of '${opts.id}': the shared-store mapping of its recorded paths changed while waiting for the target lock`
          );
        }
      }
      // Re-verify INSIDE the lock, immediately before mutating: a writer that
      // won the lock first has already landed, and its change must surface as
      // divergence rather than be overwritten. The journals are re-read here
      // too: a rename row carries no post-state hash, so a tree member's edit
      // beneath the renamed destination that journaled between the plan-time
      // scan and this lock is visible only as its (now committed) row. Force
      // skips this exactly like the plan-time check. Cross-process residual:
      // a writer in ANOTHER process (live app vs. debug CLI) does not contend
      // on this in-process lock, so this re-verify narrows but cannot fully
      // close that window.
      if (opts.force !== true) {
        const lockedRows = await listRefinements(opts.sessionDir);
        const raced = await collectDivergence(
          kind === "memory"
            ? [...lockedRows, ...(await readSharedMemoryPeerRows(opts))]
            : lockedRows,
          target,
          inverse,
          readContent,
          remap,
          targetRetargeted
        );
        if (raced.length > 0) {
          throw new RollbackError(
            `Refusing rollback of '${opts.id}': a concurrent mutation landed before the apply:\n` +
              raced.map((line) => `  - ${line}`).join("\n") +
              `\nRe-run with force to apply anyway.`
          );
        }
      }

      // Capture the pre-rollback state (the new row's inverse) BEFORE mutating.
      const newInverse = await capturePreRollbackInverse(inverse);

      // Ownership re-verification before any filesystem mutation: guards +
      // reclamation make cross-process double-entry improbable; this check (and
      // the commit-point one below) makes it harmless. Losing ownership here
      // aborts with nothing mutated.
      await fileLock.assertStillOwned();

      // Sink recheck: the divergence + pre-rollback capture reads above take
      // long enough for a link substitution race; nothing has been mutated yet,
      // so a swapped root still aborts cleanly here (delete-files and rename
      // mutate immediately after this; restore-files rechecks again post-stage).
      await assertConfinement();

      // Apply the target's inverse to disk. Multi-file ops are two-phase: a
      // failure after the first mutation would otherwise leave an unjournaled
      // partial rollback behind (no rollbackOf row, and a retry refuses on the
      // resulting divergence).
      const applied: RollbackApplied = { rollbackRowId: null, restored: [], deleted: [] };
      switch (inverse.op) {
        case "delete-files":
          try {
            for (const p of inverse.paths) {
              await fsPromises.rm(p, { force: true });
              applied.deleted.push(p);
            }
          } catch (error) {
            await compensatePartialApply(applied.deleted, newInverse);
            throw error;
          }
          break;
        case "restore-files": {
          // Phase 1 — resolve every payload before any mutation, so a missing
          // or corrupt blob aborts with the tree untouched. All contents fit in
          // memory: inverses are bounded by the capture budgets at write time.
          const staged: RefinementFileCapture[] = [];
          for (const file of inverse.files) {
            staged.push({ path: file.path, content: await readContent.read(file) });
          }
          // Sink recheck after staging: blob reads are the slowest window
          // between plan-time confinement and the writes below.
          await assertConfinement();
          // Phase 2 — write. A mid-apply failure (e.g. an unwritable
          // destination) is compensated from the pre-rollback capture so the
          // tree returns to its pre-rollback state.
          try {
            for (const file of staged) {
              await fsPromises.mkdir(path.dirname(file.path), { recursive: true });
              // Same atomic-write discipline as LocalMemoryStore.writeFile.
              await writeFileAtomic(file.path, file.content, { encoding: "utf-8" });
              applied.restored.push(file.path);
            }
            // Mixed force-apply inverse (r67): delete the files the forced
            // rollback created. Their pre-apply contents are in newInverse,
            // so the compensation below can restore them too.
            for (const p of inverse.deletePaths ?? []) {
              await fsPromises.rm(p, { force: true });
              applied.deleted.push(p);
            }
          } catch (error) {
            await compensatePartialApply([...applied.restored, ...applied.deleted], newInverse);
            throw error;
          }
          break;
        }
        case "rename":
          // Single filesystem op: no partial state to compensate.
          await fsPromises.mkdir(path.dirname(inverse.to), { recursive: true });
          await fsPromises.rename(inverse.from, inverse.to);
          applied.renamed = { from: inverse.from, to: inverse.to };
          break;
      }

      // Commit point: even if two processes double-entered the critical section
      // (theoretically possible — plain POSIX files cannot make the guard's
      // delete-if-content-matches atomic), only the entrant still owning the
      // canonical lock may journal. The loser undoes its mutations, so no
      // duplicate rollbackOf rows and no unjournaled divergence can result.
      try {
        if (opts.testOnlyBeforeCommit !== undefined) {
          await opts.testOnlyBeforeCommit();
        }
        await fileLock.assertStillOwned();
      } catch (error) {
        await compensateApplied(applied, newInverse);
        throw error;
      }
      if (opts.testOnlyBeforeRollbackJournal !== undefined) {
        await opts.testOnlyBeforeRollbackJournal();
      }
      // Journal the rollback row while STILL HOLDING the target locks (r19):
      // ordinary writers journal inside their target-lock window, so
      // releasing the locks first let a writer mutate AND journal in the
      // gap — durable order (T, W, rollback-of-T) inverted from filesystem
      // order (T, rollback-of-T, W), and collectDivergence then treated the
      // rollback row as a later conflicting effect of W, refusing a safe
      // rollback of W. Lock nesting stays acyclic: the journal blob lock is
      // a leaf here exactly as in every ordinary writer, and no path
      // acquires a target lock while holding the blob lock. The filesystem
      // is already restored at this point, so a journaling failure must not
      // fail the operation (self-healing doctrine) — but it is reported via
      // rollbackRowId: null.
      try {
        const action: RollbackRefinementAction = {
          op: "rollback",
          of: opts.id,
          ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
        };
        // Inverse blob puts + the append referencing them run under the
        // journal blob lock: a concurrent reclamation pass must never
        // observe the put→append window (see withBlobLock).
        // A workspace-memory rollback is a store mutation like any other:
        // advance the owner store's clock (under the target lock held here)
        // for this row's cross-journal order AND as the cross-process change
        // signal — the debug CLI reaches this engine without MemoryService,
        // so nothing else would tell other backends' caches and Memory tabs.
        const workspaceMemoryRoot = [...new Set(roots.values())].find((root) =>
          isWorkspaceMemoryRoot(opts.sessionDir, root, opts.sharedWorkspaceMemorySessionDir)
        );
        let sourceTs: number | undefined;
        let orderUnknownRow = false;
        if (kind === "memory" && workspaceMemoryRoot !== undefined) {
          try {
            sourceTs = await advanceWorkspaceMemoryRevision(path.dirname(workspaceMemoryRoot));
          } catch (error) {
            // The inverse is already applied, so the row must still be
            // journaled — as order-unknown (see MemoryService.journalRefinement):
            // its journal-local `ts` is incomparable with other journals' rows.
            log.debug("[refinement] failed to advance workspace memory revision", { error });
            orderUnknownRow = true;
          }
        }
        let publishedBlobs: BlobQuotaEntry[] = [];
        const row = await journal.withBlobLock(async () => {
          const resolved = await resolveRefinementInverse(journal.blobs, newInverse);
          publishedBlobs = resolved.publishedBlobs;
          return journal.append({
            workspaceId: target.workspaceId,
            kind: "refinement",
            data: {
              kind,
              action,
              inverse: resolved.inverse,
              evidence: {
                workspaceId: target.workspaceId,
                toolName: opts.evidence.toolName,
                ...(opts.evidence.toolCallId !== undefined
                  ? { toolCallId: opts.evidence.toolCallId }
                  : {}),
                ...(opts.evidence.actor !== undefined ? { actor: opts.evidence.actor } : {}),
              },
              rollbackOf: opts.id,
              ...(sourceTs !== undefined ? { sourceTs } : {}),
              ...(orderUnknownRow ? { orderUnknown: true as const } : {}),
            },
          });
        });
        applied.rollbackRowId = row.id;
        // Rollback rows publish inverse payloads too: same per-session
        // quota, same best-effort contract (never fail an applied
        // rollback). Called after the publish lock releases — the mutex is
        // non-reentrant. Kept inside the target locks to mirror ordinary
        // writers (appendRefinementEvent reclaims inside their window).
        try {
          await reclaimExcessRefinementInverseBlobs(journal, publishedBlobs);
        } catch (error) {
          log.debug("[refinement] inverse blob reclamation failed; continuing", { error });
        }
      } catch (error) {
        log.error("[refinement] rollback applied but journaling the rollback row failed", {
          id: opts.id,
          error,
        });
      }

      return applied;
    });

    return { success: true, data: applied };
  } catch (error) {
    if (error instanceof RollbackError) {
      return { success: false, error: error.message };
    }
    return { success: false, error: `Rollback failed: ${getErrorMessage(error)}` };
  }
}

/**
 * Undo a fully applied inverse after the commit-point ownership check fails:
 * every mutated path returns to its captured pre-rollback state, so the
 * losing entrant of a (theoretical) double-entry leaves no trace.
 */
async function compensateApplied(
  applied: RollbackApplied,
  preState: RefinementInverseDraft
): Promise<void> {
  if (applied.renamed !== undefined) {
    // The rename's own pre-state IS the mirrored rename.
    assert(preState.op === "rename", "rename apply must capture a rename pre-state");
    try {
      await fsPromises.rename(applied.renamed.to, applied.renamed.from);
    } catch (error) {
      log.error("[refinement] failed to compensate an applied rollback rename", {
        renamed: applied.renamed,
        error,
      });
    }
    return;
  }
  const mutated = [...applied.deleted, ...applied.restored];
  if (mutated.length > 0) {
    await compensatePartialApply(mutated, preState);
  }
}

/**
 * Best-effort compensation for a mid-apply failure: put every already-mutated
 * path back to its pre-rollback state captured in `preState` (a path with
 * captured content is rewritten; a path without one did not exist and is
 * removed). Failures are logged, not thrown — the original apply error is the
 * actionable one, and any residue is at least reported instead of silently
 * masquerading as divergence on the next attempt.
 */
async function compensatePartialApply(
  mutatedPaths: string[],
  preState: RefinementInverseDraft
): Promise<void> {
  // capturePreRollbackInverse never produces a rename (renames are single-op).
  assert(preState.op !== "rename", "pre-rollback capture cannot be a rename");
  for (const p of mutatedPaths) {
    try {
      const prior =
        preState.op === "restore-files"
          ? preState.files.find((file) => file.path === p)
          : undefined;
      if (prior !== undefined) {
        // Captured from disk moments ago; only migrated rows carry bare references.
        assert("content" in prior, "pre-rollback capture carries file contents");
        await fsPromises.mkdir(path.dirname(p), { recursive: true });
        await writeFileAtomic(p, prior.content, { encoding: "utf-8" });
      } else {
        await fsPromises.rm(p, { force: true });
      }
    } catch (error) {
      log.error("[refinement] failed to compensate a partially applied rollback", {
        path: p,
        error,
      });
    }
  }
}

/**
 * Build the inverse of applying `inverse` from the CURRENT filesystem state.
 * - delete-files → restore the current contents of the files it will delete.
 * - restore-files → restore current contents where files exist; where they do
 *   not (the restore will create them), delete them again. A mixed state is
 *   only reachable with force; it is expressed as one restore-files inverse
 *   carrying the missing half in `deletePaths` (r67), so a double rollback
 *   both restores the edited files and deletes the force-created ones.
 * - rename → the mirrored rename.
 */
async function capturePreRollbackInverse(
  inverse: RefinementInverse
): Promise<RefinementInverseDraft> {
  switch (inverse.op) {
    case "rename":
      return { op: "rename", from: inverse.to, to: inverse.from };
    case "delete-files": {
      const files: RefinementFileCapture[] = [];
      for (const p of inverse.paths) {
        if (await fileExists(p)) {
          files.push({ path: p, content: await fsPromises.readFile(p, "utf-8") });
        }
      }
      return { op: "restore-files", files };
    }
    case "restore-files": {
      const existing: RefinementFileCapture[] = [];
      const missing: string[] = [];
      for (const file of inverse.files) {
        if (await fileExists(file.path)) {
          existing.push({
            path: file.path,
            content: await fsPromises.readFile(file.path, "utf-8"),
          });
        } else {
          missing.push(file.path);
        }
      }
      // The apply also DELETES inverse.deletePaths (r67): capture their
      // current contents so this inverse can restore them. Already-absent
      // deletePaths need no inverse half — the rm is a no-op.
      for (const p of inverse.deletePaths ?? []) {
        if (await fileExists(p)) {
          existing.push({ path: p, content: await fsPromises.readFile(p, "utf-8") });
        }
      }
      if (existing.length === 0 && missing.length > 0) {
        return { op: "delete-files", paths: missing };
      }
      return {
        op: "restore-files",
        files: existing,
        ...(missing.length > 0 ? { deletePaths: missing } : {}),
      };
    }
  }
}

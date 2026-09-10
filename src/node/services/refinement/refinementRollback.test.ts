import { describe, expect, it } from "bun:test";

import { spawnSync } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { REFINEMENT_INVERSE_BLOB_QUOTA_BYTES } from "@/common/types/refinement";
import { Config } from "@/node/config";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { MemoryMetaService } from "@/node/services/memoryMeta";
import { MemoryService, type MemoryScopeContext } from "@/node/services/memoryService";
import { TestTempDir } from "@/node/services/tools/testHelpers";
import { getProcessBirth } from "@/node/utils/concurrency/fileLock";
import { sharedDurableEventJournal } from "@/node/utils/journal/durableEventJournal";
import { appendRefinementEvent, reclaimExcessRefinementInverseBlobs } from "./refinementJournal";
import { memoryMutationLockKey, targetMutationLockFilePath } from "./targetMutationLocks";
import {
  acquireRollbackFileLock,
  listRefinements,
  rollbackRefinement,
  type RefinementEvent,
} from "./refinementRollback";

function pathExists(target: string): Promise<boolean> {
  return fsPromises.access(target).then(
    () => true,
    () => false
  );
}

interface RollbackFixture extends Disposable {
  muxHome: string;
  checkout: string;
  sessionDir: string;
  service: MemoryService;
  ctx: MemoryScopeContext;
}

const WORKSPACE_ID = "ws-rollback";
const EVIDENCE = { toolName: "test" };

/** Real MemoryService against a temp mux home: rollbacks consume real r2 rows. */
async function createFixture(): Promise<RollbackFixture> {
  const tempDir = new TestTempDir("test-refinement-rollback");
  const muxHome = path.join(tempDir.path, "mux-home");
  const checkout = path.join(tempDir.path, "checkout");
  await fsPromises.mkdir(muxHome, { recursive: true });
  await fsPromises.mkdir(checkout, { recursive: true });
  const config = new Config(muxHome);
  const service = new MemoryService(config, new MemoryMetaService(muxHome));
  return {
    muxHome,
    checkout,
    sessionDir: path.join(config.sessionsDir, WORKSPACE_ID),
    service,
    ctx: {
      runtime: new LocalRuntime(checkout),
      checkoutCwd: checkout,
      workspaceId: WORKSPACE_ID,
      projectPath: "/stable/project-id",
    },
    [Symbol.dispose]() {
      tempDir[Symbol.dispose]();
    },
  };
}

async function lastRow(sessionDir: string): Promise<RefinementEvent> {
  const rows = await listRefinements(sessionDir);
  expect(rows.length).toBeGreaterThan(0);
  return rows[rows.length - 1];
}

describe("refinementRollback", () => {
  it("create → edit → rollback restores byte-identical prior content (inline)", async () => {
    using fixture = await createFixture();
    const prior = "# Notes\n\noriginal content with unicode: ünïcödé ✓\n";
    await fixture.service.create(fixture.ctx, "/memories/global/notes.md", prior, "agent");
    await fixture.service.strReplace(
      fixture.ctx,
      "/memories/global/notes.md",
      "original content",
      "edited content",
      "agent"
    );
    const editRow = await lastRow(fixture.sessionDir);
    const physicalPath = path.join(fixture.muxHome, "memory", "global", "notes.md");
    expect(await fsPromises.readFile(physicalPath, "utf-8")).toContain("edited content");

    const result = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: editRow.id,
      evidence: EVIDENCE,
    });
    expect(result.success).toBe(true);
    expect(await fsPromises.readFile(physicalPath, "utf-8")).toBe(prior);
  });

  it("restores blob-backed prior content byte-identically and journals rollbackOf", async () => {
    using fixture = await createFixture();
    // Multi-KB prior content — the r2 inverse offloads it to a blob (as it
    // does every capture; see resolveRefinementInverse).
    const prior = `start\n${"x".repeat(4_196)}\nend\n`;
    await fixture.service.create(fixture.ctx, "/memories/global/big.md", prior, "agent");
    await fixture.service.strReplace(fixture.ctx, "/memories/global/big.md", "start", "s", "agent");
    const editRow = await lastRow(fixture.sessionDir);
    const inverse = editRow.data.inverse as { op: string; files: Array<{ blobRef?: string }> };
    expect(inverse.files[0].blobRef).toBeDefined();

    const result = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: editRow.id,
      evidence: EVIDENCE,
    });
    expect(result.success).toBe(true);
    const physicalPath = path.join(fixture.muxHome, "memory", "global", "big.md");
    expect(await fsPromises.readFile(physicalPath, "utf-8")).toBe(prior);

    const rollbackRow = await lastRow(fixture.sessionDir);
    expect(rollbackRow.data.rollbackOf).toBe(editRow.id);
    expect(rollbackRow.data.kind).toBe("memory");
    expect(rollbackRow.data.action).toMatchObject({ op: "rollback", of: editRow.id });
    if (!result.success) throw new Error("unreachable");
    expect(result.data.rollbackRowId).toBe(rollbackRow.id);
  });

  it("aborts a multi-file restore before any write when a blob is missing", async () => {
    using fixture = await createFixture();
    // Two files under one memory dir; the big one's captured content is
    // blob-backed in the delete row's inverse. Sorted capture order puts
    // a-small.md first, so a sequential apply would restore it before the
    // blob failure.
    await fixture.service.create(fixture.ctx, "/memories/global/notes/a-small.md", "sm\n", "agent");
    const big = "x".repeat(4_196);
    await fixture.service.create(fixture.ctx, "/memories/global/notes/z-big.md", big, "agent");
    await fixture.service.deletePath(fixture.ctx, "/memories/global/notes", "agent");
    const deleteRow = await lastRow(fixture.sessionDir);
    const inverse = deleteRow.data.inverse as {
      op: string;
      files: Array<{ path: string; blobRef?: string }>;
    };
    const blobbed = inverse.files.find((file) => file.blobRef !== undefined);
    expect(blobbed?.blobRef).toBeDefined();
    // Corrupt the journal: drop the blob payload backing z-big.md
    // (blobs live at blobs/<hash[0:2]>/<hash> with the ref's sha256: prefix stripped).
    const hash = blobbed!.blobRef!.slice("sha256:".length);
    await fsPromises.rm(path.join(fixture.sessionDir, "blobs", hash.slice(0, 2), hash));

    const result = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: deleteRow.id,
      evidence: EVIDENCE,
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    // The error names the unavailable payload (eviction and corruption read
    // the same way — the blob is simply gone).
    expect(result.error).toContain(blobbed!.blobRef!);
    // Phase 1 failed before any write: the small file must NOT be restored...
    const smallPath = path.join(fixture.muxHome, "memory", "global", "notes", "a-small.md");
    expect(await pathExists(smallPath)).toBe(false);
    // ...and no rollback row was appended.
    const rows = await listRefinements(fixture.sessionDir);
    expect(rows.some((row) => row.data.rollbackOf === deleteRow.id)).toBe(false);
  });

  it("refuses rollback of a SMALL-capture row whose payload was evicted (no inline immunity)", async () => {
    using fixture = await createFixture();
    // Small prior content (well under one quota charge): it must be
    // blob-backed and horizon-managed exactly like large captures.
    await fixture.service.create(fixture.ctx, "/memories/global/tiny.md", "prior\n", "agent");
    await fixture.service.strReplace(
      fixture.ctx,
      "/memories/global/tiny.md",
      "prior",
      "now",
      "agent"
    );
    const editRow = await lastRow(fixture.sessionDir);
    const inverse = editRow.data.inverse as { files: Array<{ blobRef?: string }> };
    const blobRef = inverse.files[0].blobRef;
    expect(blobRef).toBeDefined();

    const journal = sharedDurableEventJournal(fixture.sessionDir);
    await reclaimExcessRefinementInverseBlobs(journal, [
      { ref: `sha256:${"e".repeat(64)}`, size: REFINEMENT_INVERSE_BLOB_QUOTA_BYTES },
    ]);
    expect(await journal.blobs.has(blobRef as never)).toBe(false);

    const result = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: editRow.id,
      evidence: EVIDENCE,
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.error).toContain(blobRef!);
  });

  it("refuses rollback of a row whose inverse payload was evicted beyond the horizon", async () => {
    using fixture = await createFixture();
    const big = `start\n${"y".repeat(4_196)}\n`;
    await fixture.service.create(fixture.ctx, "/memories/global/evicted.md", big, "agent");
    await fixture.service.strReplace(
      fixture.ctx,
      "/memories/global/evicted.md",
      "start",
      "s",
      "agent"
    );
    const editRow = await lastRow(fixture.sessionDir);
    const inverse = editRow.data.inverse as { files: Array<{ blobRef?: string }> };
    const blobRef = inverse.files[0].blobRef;
    expect(blobRef).toBeDefined();

    // Simulate quota pressure: a new inverse payload whose recorded size
    // fills the whole horizon pushes the edit row's payload past it.
    const journal = sharedDurableEventJournal(fixture.sessionDir);
    await reclaimExcessRefinementInverseBlobs(journal, [
      { ref: `sha256:${"f".repeat(64)}`, size: REFINEMENT_INVERSE_BLOB_QUOTA_BYTES },
    ]);
    expect(await journal.blobs.has(blobRef as never)).toBe(false);

    const result = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: editRow.id,
      evidence: EVIDENCE,
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    // Descriptive refusal naming the evicted payload; no partial apply.
    expect(result.error).toContain(blobRef!);
    const physicalPath = path.join(fixture.muxHome, "memory", "global", "evicted.md");
    expect(await fsPromises.readFile(physicalPath, "utf-8")).toBe(big.replace("start", "s"));
    const rows = await listRefinements(fixture.sessionDir);
    expect(rows.some((row) => row.data.rollbackOf === editRow.id)).toBe(false);
  });

  it("compensates already-written files when a multi-file restore fails midway", async () => {
    using fixture = await createFixture();
    await fixture.service.create(fixture.ctx, "/memories/global/notes/a/first.md", "1\n", "agent");
    await fixture.service.create(fixture.ctx, "/memories/global/notes/z/second.md", "2\n", "agent");
    await fixture.service.deletePath(fixture.ctx, "/memories/global/notes", "agent");
    const deleteRow = await lastRow(fixture.sessionDir);

    // Sabotage the SECOND destination: a regular file where its parent dir
    // must be created makes phase 2 fail after the first file was written.
    const notesDir = path.join(fixture.muxHome, "memory", "global", "notes");
    await fsPromises.mkdir(notesDir, { recursive: true });
    await fsPromises.writeFile(path.join(notesDir, "z"), "not a dir\n", "utf-8");

    const result = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: deleteRow.id,
      evidence: EVIDENCE,
    });
    expect(result.success).toBe(false);
    // Compensation removed the already-restored first file (it was absent
    // pre-rollback), so a later retry sees no divergence from this failure.
    expect(await pathExists(path.join(notesDir, "a", "first.md"))).toBe(false);
    const rows = await listRefinements(fixture.sessionDir);
    expect(rows.some((row) => row.data.rollbackOf === deleteRow.id)).toBe(false);
  });

  it("refuses a double rollback of the same id, but allows rolling back the rollback", async () => {
    using fixture = await createFixture();
    await fixture.service.create(fixture.ctx, "/memories/global/a.md", "v1\n", "agent");
    await fixture.service.strReplace(fixture.ctx, "/memories/global/a.md", "v1", "v2", "agent");
    const editRow = await lastRow(fixture.sessionDir);
    const first = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: editRow.id,
      evidence: EVIDENCE,
    });
    expect(first.success).toBe(true);

    const second = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: editRow.id,
      evidence: EVIDENCE,
    });
    expect(second.success).toBe(false);
    if (second.success) throw new Error("unreachable");
    expect(second.error).toContain("already rolled back");

    // Rolling back the rollback re-applies the edit (double inversion).
    const rollbackRow = await lastRow(fixture.sessionDir);
    const undo = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: rollbackRow.id,
      evidence: EVIDENCE,
    });
    expect(undo.success).toBe(true);
    const physicalPath = path.join(fixture.muxHome, "memory", "global", "a.md");
    expect(await fsPromises.readFile(physicalPath, "utf-8")).toBe("v2\n");
  });

  it("refuses on divergence (file deleted since the edit) and applies with force", async () => {
    using fixture = await createFixture();
    await fixture.service.create(fixture.ctx, "/memories/global/gone.md", "v1\n", "agent");
    await fixture.service.strReplace(fixture.ctx, "/memories/global/gone.md", "v1", "v2", "agent");
    const editRow = await lastRow(fixture.sessionDir);
    const physicalPath = path.join(fixture.muxHome, "memory", "global", "gone.md");
    // Out-of-band deletion: the inverse expects the edited file to exist.
    await fsPromises.rm(physicalPath);

    const refused = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: editRow.id,
      evidence: EVIDENCE,
    });
    expect(refused.success).toBe(false);
    if (refused.success) throw new Error("unreachable");
    expect(refused.error).toContain("diverges");
    expect(refused.error).toContain(physicalPath);
    expect(await pathExists(physicalPath)).toBe(false);

    const forced = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: editRow.id,
      force: true,
      evidence: EVIDENCE,
    });
    expect(forced.success).toBe(true);
    expect(await fsPromises.readFile(physicalPath, "utf-8")).toBe("v1\n");
  });

  it("double rollback after a mixed force apply deletes the force-created files (r67)", async () => {
    using fixture = await createFixture();
    await fixture.service.create(fixture.ctx, "/memories/global/dir/a.md", "a original\n", "agent");
    await fixture.service.create(fixture.ctx, "/memories/global/dir/b.md", "b original\n", "agent");
    await fixture.service.deletePath(fixture.ctx, "/memories/global/dir", "agent");
    const deleteRow = await lastRow(fixture.sessionDir);
    const aPath = path.join(fixture.muxHome, "memory", "global", "dir", "a.md");
    const bPath = path.join(fixture.muxHome, "memory", "global", "dir", "b.md");

    // Out-of-band recreation of ONE deleted file → the delete row's
    // multi-file restore-files inverse now faces a mixed pre-state
    // (a.md exists, b.md absent), which is only applyable with force.
    await fsPromises.mkdir(path.dirname(aPath), { recursive: true });
    await fsPromises.writeFile(aPath, "a manual\n");

    const forced = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: deleteRow.id,
      evidence: EVIDENCE,
      force: true,
    });
    expect(forced.success).toBe(true);
    expect(await fsPromises.readFile(aPath, "utf-8")).toBe("a original\n");
    expect(await fsPromises.readFile(bPath, "utf-8")).toBe("b original\n");

    // The captured pre-state carries BOTH halves: restore a.md's manual
    // content AND delete the force-created b.md.
    const rollbackRow = await lastRow(fixture.sessionDir);
    expect(rollbackRow.data.rollbackOf).toBe(deleteRow.id);
    const inverse = rollbackRow.data.inverse as { op: string; deletePaths?: string[] };
    expect(inverse.op).toBe("restore-files");
    expect(inverse.deletePaths).toEqual([bPath]);

    // Rolling back the rollback must leave NO residue of the forced apply:
    // a.md returns to its manual content and b.md is deleted again.
    const double = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: rollbackRow.id,
      evidence: EVIDENCE,
    });
    expect(double.success).toBe(true);
    expect(await fsPromises.readFile(aPath, "utf-8")).toBe("a manual\n");
    expect(await pathExists(bPath)).toBe(false);
  });

  it("refuses when the file was manually edited after the refinement, applies with force", async () => {
    using fixture = await createFixture();
    await fixture.service.create(fixture.ctx, "/memories/global/hand.md", "v1\n", "agent");
    await fixture.service.strReplace(fixture.ctx, "/memories/global/hand.md", "v1", "v2", "agent");
    const editRow = await lastRow(fixture.sessionDir);
    const physicalPath = path.join(fixture.muxHome, "memory", "global", "hand.md");
    // Out-of-band edit (user editor, other workspace): the file still exists,
    // so presence checks pass — only the recorded postState hash detects it.
    await fsPromises.writeFile(physicalPath, "manually edited\n", "utf-8");

    const refused = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: editRow.id,
      evidence: EVIDENCE,
    });
    expect(refused.success).toBe(false);
    if (refused.success) throw new Error("unreachable");
    expect(refused.error).toContain("modified after the target refinement");
    // The manual edit is untouched by a refused rollback.
    expect(await fsPromises.readFile(physicalPath, "utf-8")).toBe("manually edited\n");

    const forced = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: editRow.id,
      force: true,
      evidence: EVIDENCE,
    });
    expect(forced.success).toBe(true);
    expect(await fsPromises.readFile(physicalPath, "utf-8")).toBe("v1\n");
  });

  it("fails while the cross-process lockfile is held by a live process", async () => {
    using fixture = await createFixture();
    await fixture.service.create(fixture.ctx, "/memories/global/lock.md", "v1\n", "agent");
    await fixture.service.strReplace(fixture.ctx, "/memories/global/lock.md", "v1", "v2", "agent");
    const editRow = await lastRow(fixture.sessionDir);

    // Simulate another process's in-flight rollback: our own PID is live, so
    // the lock must never be broken and the call must fail with a clear error.
    const lockPath = path.join(fixture.sessionDir, "refinement-rollback.lock");
    await fsPromises.writeFile(lockPath, String(process.pid), { encoding: "utf-8", flag: "wx" });

    const refused = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: editRow.id,
      evidence: EVIDENCE,
    });
    expect(refused.success).toBe(false);
    if (refused.success) throw new Error("unreachable");
    expect(refused.error).toContain("Another rollback is in progress");
    // The live owner's lockfile survives the refusal.
    expect(await fsPromises.readFile(lockPath, "utf-8")).toBe(String(process.pid));

    await fsPromises.unlink(lockPath);
    const retried = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: editRow.id,
      evidence: EVIDENCE,
    });
    expect(retried.success).toBe(true);
  });

  it("reclaims a stale lockfile whose owner is provably dead", async () => {
    using fixture = await createFixture();
    await fixture.service.create(fixture.ctx, "/memories/global/stale.md", "v1\n", "agent");
    await fixture.service.strReplace(fixture.ctx, "/memories/global/stale.md", "v1", "v2", "agent");
    const editRow = await lastRow(fixture.sessionDir);

    // A short-lived child that has already exited gives a provably dead PID
    // (ESRCH from kill(pid, 0)); crash remnants must not block rollbacks.
    const child = spawnSync(process.execPath, ["--version"]);
    expect(child.pid).toBeGreaterThan(0);
    const lockPath = path.join(fixture.sessionDir, "refinement-rollback.lock");
    await fsPromises.writeFile(lockPath, String(child.pid), { encoding: "utf-8", flag: "wx" });

    const result = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: editRow.id,
      evidence: EVIDENCE,
    });
    expect(result.success).toBe(true);
    // The reclaimed lock was released after the rollback.
    expect(await pathExists(lockPath)).toBe(false);
  });

  it("reclaims a lockfile whose recorded owner PID was reused by another process", async () => {
    using fixture = await createFixture();
    await fixture.service.create(fixture.ctx, "/memories/global/reuse.md", "v1\n", "agent");
    await fixture.service.strReplace(fixture.ctx, "/memories/global/reuse.md", "v1", "v2", "agent");
    const editRow = await lastRow(fixture.sessionDir);

    // r18: a crashed Xum's PID was handed to an unrelated LIVE process — the
    // recorded birth identity proves the reuse. A PID-only liveness check
    // treated this lock as live forever, refusing every rollback until
    // manual cleanup. Simulate with our own (alive) pid + a foreign birth.
    const lockPath = path.join(fixture.sessionDir, "refinement-rollback.lock");
    const bogusBirth = Buffer.from("crashed-xum-birth").toString("hex");
    await fsPromises.writeFile(lockPath, `${process.pid}:cafe:${bogusBirth}`, {
      encoding: "utf-8",
      flag: "wx",
    });

    const result = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: editRow.id,
      evidence: EVIDENCE,
    });
    expect(result.success).toBe(true);
    expect(await pathExists(lockPath)).toBe(false);
  });

  it("release leaves the lockfile alone when its token no longer matches", async () => {
    using fixture = await createFixture();
    // Materialize the session dir (acquire creates it, but be explicit).
    await fsPromises.mkdir(fixture.sessionDir, { recursive: true });
    const lockPath = path.join(fixture.sessionDir, "refinement-rollback.lock");

    const lock = await acquireRollbackFileLock(fixture.sessionDir);
    // Simulate a wrongful reclaim while we hold the lock: the pathname now
    // carries another acquisition's token.
    const foreignToken = `${process.pid}:foreign-uuid`;
    await fsPromises.writeFile(lockPath, foreignToken, "utf-8");

    await lock[Symbol.asyncDispose]();
    // Ownership-verified release must not unlink the new owner's lock.
    expect(await fsPromises.readFile(lockPath, "utf-8")).toBe(foreignToken);

    // Sanity: a matching token still releases (same acquire/dispose path).
    await fsPromises.unlink(lockPath);
    const lock2 = await acquireRollbackFileLock(fixture.sessionDir);
    await lock2[Symbol.asyncDispose]();
    expect(await pathExists(lockPath)).toBe(false);
  });

  it("a crash-remnant reclaim guard (dead PID) does not deadlock reclamation", async () => {
    using fixture = await createFixture();
    await fixture.service.create(fixture.ctx, "/memories/global/guard.md", "v1\n", "agent");
    await fixture.service.strReplace(fixture.ctx, "/memories/global/guard.md", "v1", "v2", "agent");
    const editRow = await lastRow(fixture.sessionDir);
    const lockPath = path.join(fixture.sessionDir, "refinement-rollback.lock");

    // A crashed reclaimer left BOTH files behind: a stale canonical lock and
    // a stale guard. The guard must be reclaimed one level deep by the same
    // dead-PID rule instead of wedging every future rollback.
    const child = spawnSync(process.execPath, ["--version"]);
    await fsPromises.writeFile(lockPath, `${child.pid}:dead-lock-uuid`, {
      encoding: "utf-8",
      flag: "wx",
    });
    await fsPromises.writeFile(`${lockPath}.reclaim`, `${child.pid}:dead-guard-uuid`, {
      encoding: "utf-8",
      flag: "wx",
    });

    const result = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: editRow.id,
      evidence: EVIDENCE,
    });
    expect(result.success).toBe(true);
    // Both remnants were cleaned up by the successful acquisition + release.
    expect(await pathExists(lockPath)).toBe(false);
    expect(await pathExists(`${lockPath}.reclaim`)).toBe(false);
  });

  it("commit-point ownership loss aborts, compensates mutations, and appends no row", async () => {
    using fixture = await createFixture();
    await fixture.service.create(fixture.ctx, "/memories/global/entry.md", "v1\n", "agent");
    await fixture.service.strReplace(fixture.ctx, "/memories/global/entry.md", "v1", "v2", "agent");
    const editRow = await lastRow(fixture.sessionDir);
    const physicalPath = path.join(fixture.muxHome, "memory", "global", "entry.md");
    const lockPath = path.join(fixture.sessionDir, "refinement-rollback.lock");

    // Simulate the theoretical double-entry: another process wrongly judged
    // us dead and reclaimed the canonical lock AFTER our mutation but before
    // our journal append. The commit-point re-check must catch it.
    const result = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: editRow.id,
      evidence: EVIDENCE,
      testOnlyBeforeCommit: async () => {
        // Mutation already applied at this point (v1 back on disk).
        expect(await fsPromises.readFile(physicalPath, "utf-8")).toBe("v1\n");
        await fsPromises.writeFile(lockPath, `${process.pid}:foreign-uuid`, "utf-8");
      },
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.error).toContain("lost ownership");
    // The losing entrant compensated: the file is back to its post-edit state...
    expect(await fsPromises.readFile(physicalPath, "utf-8")).toBe("v2\n");
    // ...and no rollbackOf row was committed.
    const rows = await listRefinements(fixture.sessionDir);
    expect(rows.some((row) => row.data.rollbackOf === editRow.id)).toBe(false);

    // With the foreign lock removed, a clean retry sees no divergence.
    await fsPromises.unlink(lockPath);
    const retry = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: editRow.id,
      evidence: EVIDENCE,
    });
    expect(retry.success).toBe(true);
    expect(await fsPromises.readFile(physicalPath, "utf-8")).toBe("v1\n");
  });

  it("refuses when an ordinary write lands between the divergence check and the apply", async () => {
    using fixture = await createFixture();
    await fixture.service.create(fixture.ctx, "/memories/global/live.md", "v1\n", "agent");
    await fixture.service.strReplace(fixture.ctx, "/memories/global/live.md", "v1", "v2", "agent");
    const editRow = await lastRow(fixture.sessionDir);
    const physicalPath = path.join(fixture.muxHome, "memory", "global", "live.md");

    // An ORDINARY MemoryService write (not another rollback) interleaves
    // after the plan-time divergence check but before the apply. Pre-fix the
    // rollback silently overwrote it with v1; post-fix the writer serializes
    // through the shared target lock and the in-lock re-verify surfaces it
    // as divergence.
    const result = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: editRow.id,
      evidence: EVIDENCE,
      testOnlyBeforeTargetLock: async () => {
        const write = await fixture.service.strReplace(
          fixture.ctx,
          "/memories/global/live.md",
          "v2",
          "v3",
          "agent"
        );
        expect(write.success).toBe(true);
      },
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.error).toContain("concurrent mutation");
    // The newer legitimate mutation is preserved, not silently overwritten.
    expect(await fsPromises.readFile(physicalPath, "utf-8")).toBe("v3\n");
    // No rollbackOf row was committed.
    const rows = await listRefinements(fixture.sessionDir);
    expect(rows.some((row) => row.data.rollbackOf === editRow.id)).toBe(false);
  });

  it("serializes concurrent rollbacks of the same row: one succeeds, one rollbackOf row", async () => {
    using fixture = await createFixture();
    await fixture.service.create(fixture.ctx, "/memories/global/race.md", "v1\n", "agent");
    await fixture.service.strReplace(fixture.ctx, "/memories/global/race.md", "v1", "v2", "agent");
    const editRow = await lastRow(fixture.sessionDir);

    // Model tool + debug CLI (or two tool invocations) racing on the same row:
    // without the per-session lock both pass the already-rolled-back check.
    const opts = { sessionDir: fixture.sessionDir, id: editRow.id, evidence: EVIDENCE };
    const results = await Promise.all([rollbackRefinement(opts), rollbackRefinement(opts)]);

    const successes = results.filter((result) => result.success);
    const failures = results.filter((result) => !result.success);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    if (failures[0].success) throw new Error("unreachable");
    expect(failures[0].error).toContain("already rolled back");

    const rollbackRows = (await listRefinements(fixture.sessionDir)).filter(
      (row) => row.data.rollbackOf === editRow.id
    );
    expect(rollbackRows).toHaveLength(1);
    const physicalPath = path.join(fixture.muxHome, "memory", "global", "race.md");
    expect(await fsPromises.readFile(physicalPath, "utf-8")).toBe("v1\n");
  });

  it("refuses when a later refinement row touched the same path (roll back newest first)", async () => {
    using fixture = await createFixture();
    await fixture.service.create(fixture.ctx, "/memories/global/stack.md", "v1\n", "agent");
    const createRow = await lastRow(fixture.sessionDir);
    await fixture.service.strReplace(fixture.ctx, "/memories/global/stack.md", "v1", "v2", "agent");

    const refused = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: createRow.id,
      evidence: EVIDENCE,
    });
    expect(refused.success).toBe(false);
    if (refused.success) throw new Error("unreachable");
    expect(refused.error).toContain("later refinement row");
  });

  it("unrolls multiple edits LIFO without force once later rows are rolled back", async () => {
    using fixture = await createFixture();
    await fixture.service.create(fixture.ctx, "/memories/global/lifo.md", "v1\n", "agent");
    await fixture.service.strReplace(fixture.ctx, "/memories/global/lifo.md", "v1", "v2", "agent");
    const edit1 = await lastRow(fixture.sessionDir);
    await fixture.service.strReplace(fixture.ctx, "/memories/global/lifo.md", "v2", "v3", "agent");
    const edit2 = await lastRow(fixture.sessionDir);

    const newest = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: edit2.id,
      evidence: EVIDENCE,
    });
    expect(newest.success).toBe(true);
    // edit2 is rolled back (and its rollback row rewound past nothing older),
    // so unrolling edit1 next must not flag divergence or require force.
    const older = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: edit1.id,
      evidence: EVIDENCE,
    });
    expect(older.success).toBe(true);
    const physicalPath = path.join(fixture.muxHome, "memory", "global", "lifo.md");
    expect(await fsPromises.readFile(physicalPath, "utf-8")).toBe("v1\n");
  });

  it("still refuses when a rolled-back rollback re-applied a later edit", async () => {
    using fixture = await createFixture();
    await fixture.service.create(fixture.ctx, "/memories/global/reapply.md", "v1\n", "agent");
    await fixture.service.strReplace(
      fixture.ctx,
      "/memories/global/reapply.md",
      "v1",
      "v2",
      "agent"
    );
    const edit1 = await lastRow(fixture.sessionDir);
    await fixture.service.strReplace(
      fixture.ctx,
      "/memories/global/reapply.md",
      "v2",
      "v3",
      "agent"
    );
    const edit2 = await lastRow(fixture.sessionDir);

    const undo = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: edit2.id,
      evidence: EVIDENCE,
    });
    expect(undo.success).toBe(true);
    const undoRow = await lastRow(fixture.sessionDir);
    // Roll back the rollback: edit2's content ("v3") is live on disk again.
    const redo = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: undoRow.id,
      evidence: EVIDENCE,
    });
    expect(redo.success).toBe(true);

    const refused = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: edit1.id,
      evidence: EVIDENCE,
    });
    expect(refused.success).toBe(false);
    if (refused.success) throw new Error("unreachable");
    expect(refused.error).toContain("later refinement row");
  });

  it("rolls back a skill write via the delete-files inverse and back again", async () => {
    using fixture = await createFixture();
    const skillFile = path.join(fixture.checkout, ".mux", "skills", "my-skill", "SKILL.md");
    const content = "---\nname: my-skill\n---\n\nbody\n";
    await fsPromises.mkdir(path.dirname(skillFile), { recursive: true });
    await fsPromises.writeFile(skillFile, content, "utf-8");
    // Same emitter the skill tools use: a write that created the file journals
    // a delete-files inverse.
    await appendRefinementEvent({
      sessionDir: fixture.sessionDir,
      workspaceId: WORKSPACE_ID,
      kind: "skill",
      action: { op: "write", skillName: "my-skill", filePath: "SKILL.md" },
      inverse: { op: "delete-files", paths: [skillFile] },
      evidence: { toolName: "agent_skill_write" },
    });
    const writeRow = await lastRow(fixture.sessionDir);

    const result = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: writeRow.id,
      evidence: EVIDENCE,
    });
    expect(result.success).toBe(true);
    expect(await pathExists(skillFile)).toBe(false);

    // The rollback row restores the deleted file byte-identically.
    const rollbackRow = await lastRow(fixture.sessionDir);
    expect(rollbackRow.data.rollbackOf).toBe(writeRow.id);
    const undo = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: rollbackRow.id,
      evidence: EVIDENCE,
    });
    expect(undo.success).toBe(true);
    expect(await fsPromises.readFile(skillFile, "utf-8")).toBe(content);
  });

  it("refuses remote-runtime skill rows even with force", async () => {
    using fixture = await createFixture();
    // A remote (SSH/Docker) workspace journaled this row: its path is
    // runtime-namespace, resembling a host path but on another filesystem.
    const remotePath = path.join(fixture.checkout, ".mux", "skills", "my-skill", "SKILL.md");
    await appendRefinementEvent({
      sessionDir: fixture.sessionDir,
      workspaceId: WORKSPACE_ID,
      kind: "skill",
      action: { op: "write", skillName: "my-skill", filePath: "SKILL.md" },
      inverse: { op: "delete-files", paths: [remotePath] },
      evidence: { toolName: "agent_skill_write" },
      runtime: "remote",
    });
    // A same-named LOCAL file must never be touched by a remote row.
    await fsPromises.mkdir(path.dirname(remotePath), { recursive: true });
    await fsPromises.writeFile(remotePath, "local content\n", "utf-8");
    const row = await lastRow(fixture.sessionDir);

    const refused = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: row.id,
      evidence: EVIDENCE,
    });
    expect(refused.success).toBe(false);
    if (refused.success) throw new Error("unreachable");
    expect(refused.error).toContain("remote");

    // force overrides divergence, NOT the addressing mode.
    const forced = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: row.id,
      force: true,
      evidence: EVIDENCE,
    });
    expect(forced.success).toBe(false);
    if (forced.success) throw new Error("unreachable");
    expect(forced.error).toContain("remote");
    expect(await fsPromises.readFile(remotePath, "utf-8")).toBe("local content\n");
  });

  it("rolls back a GLOBAL skill write (path under <muxHome>/skills)", async () => {
    using fixture = await createFixture();
    // Global-scope skills live at <muxHome>/skills (agent_skill_write/delete
    // resolve path.join(muxScope.muxHome, "skills")), NOT under a .mux/skills
    // segment — confinement must accept this root.
    const skillFile = path.join(fixture.muxHome, "skills", "my-skill", "SKILL.md");
    const content = "---\nname: my-skill\n---\n\nbody\n";
    await fsPromises.mkdir(path.dirname(skillFile), { recursive: true });
    await fsPromises.writeFile(skillFile, content, "utf-8");
    await appendRefinementEvent({
      sessionDir: fixture.sessionDir,
      workspaceId: WORKSPACE_ID,
      kind: "skill",
      action: { op: "write", skillName: "my-skill", filePath: "SKILL.md" },
      inverse: { op: "delete-files", paths: [skillFile] },
      evidence: { toolName: "agent_skill_write" },
    });
    const writeRow = await lastRow(fixture.sessionDir);

    const result = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: writeRow.id,
      evidence: EVIDENCE,
    });
    expect(result.success).toBe(true);
    expect(await pathExists(skillFile)).toBe(false);

    // The global skills ROOT itself is still not a legal target.
    await appendRefinementEvent({
      sessionDir: fixture.sessionDir,
      workspaceId: WORKSPACE_ID,
      kind: "skill",
      action: { op: "write", skillName: "x", filePath: "SKILL.md" },
      inverse: { op: "delete-files", paths: [path.join(fixture.muxHome, "skills", "loose-file")] },
      evidence: { toolName: "agent_skill_write" },
    });
    const rootRow = await lastRow(fixture.sessionDir);
    const refused = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: rootRow.id,
      force: true,
      evidence: EVIDENCE,
    });
    expect(refused.success).toBe(false);
    if (refused.success) throw new Error("unreachable");
    expect(refused.error).toContain("global skills root");
  });

  it("undoes a memory rename via the mirrored rename inverse", async () => {
    using fixture = await createFixture();
    await fixture.service.create(fixture.ctx, "/memories/global/old.md", "v1\n", "agent");
    await fixture.service.rename(
      fixture.ctx,
      "/memories/global/old.md",
      "/memories/global/new.md",
      "agent"
    );
    const renameRow = await lastRow(fixture.sessionDir);
    const result = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: renameRow.id,
      evidence: EVIDENCE,
    });
    expect(result.success).toBe(true);
    const oldPath = path.join(fixture.muxHome, "memory", "global", "old.md");
    expect(await fsPromises.readFile(oldPath, "utf-8")).toBe("v1\n");
    expect(await pathExists(path.join(fixture.muxHome, "memory", "global", "new.md"))).toBe(false);
  });

  it("journals the rollback row before releasing the target locks (no durable-order inversion)", async () => {
    using fixture = await createFixture();
    const virtualPath = "/memories/global/order.md";
    const physicalPath = path.join(fixture.muxHome, "memory", "global", "order.md");
    await fixture.service.create(fixture.ctx, virtualPath, "v1\n", "agent");
    await fixture.service.strReplace(fixture.ctx, virtualPath, "v1", "v2", "agent");
    const editRow = await lastRow(fixture.sessionDir); // T

    // r19: interleave an ordinary writer into the apply→journal window. The
    // writer is STARTED (not awaited) inside the seam: with the fix it parks
    // on the still-held target lock and lands after the rollback row; the
    // sleep only gives a NOT-blocked (buggy) writer time to mutate + journal
    // first — correctness is asserted on journal order below, never timing.
    let writerStarted = false;
    let writerPromise: Promise<unknown> = Promise.resolve();
    const result = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: editRow.id,
      evidence: EVIDENCE,
      testOnlyBeforeRollbackJournal: async () => {
        // Rollback already applied: disk is back to v1.
        expect(await fsPromises.readFile(physicalPath, "utf-8")).toBe("v1\n");
        writerStarted = true;
        writerPromise = fixture.service.strReplace(fixture.ctx, virtualPath, "v1", "v3", "agent");
        await new Promise((resolve) => setTimeout(resolve, 100));
      },
    });
    expect(result.success).toBe(true);
    expect(writerStarted).toBe(true);
    await writerPromise;
    expect(await fsPromises.readFile(physicalPath, "utf-8")).toBe("v3\n");

    // Durable order must match mutation order: T, R (rollback-of-T), W.
    const rows = await listRefinements(fixture.sessionDir);
    const rollbackRow = rows.find((row) => row.data.rollbackOf === editRow.id);
    expect(rollbackRow).toBeDefined();
    const writerRow = rows[rows.length - 1];
    expect(writerRow.data.rollbackOf).toBeUndefined();
    expect(rollbackRow!.seq).toBeLessThan(writerRow.seq);

    // The inverted order made collectDivergence treat R as a later
    // conflicting effect of W; with correct ordering, rolling back the
    // writer's edit is clean.
    const rollbackW = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: writerRow.id,
      evidence: EVIDENCE,
    });
    expect(rollbackW.success).toBe(true);
    expect(await fsPromises.readFile(physicalPath, "utf-8")).toBe("v1\n");
  });

  describe("cross-process target mutation lock", () => {
    /** A verified-live foreign-owner token (this process, real birth). */
    const foreignLiveToken = (): string => {
      const birth = getProcessBirth(process.pid);
      return birth === null
        ? `${process.pid}:foreign`
        : `${process.pid}:foreign:${Buffer.from(birth).toString("hex")}`;
    };

    /** The global-memory-root target lockfile for a fixture's mux home. */
    const memoryTargetLockPath = (muxHome: string): string =>
      targetMutationLockFilePath(
        muxHome,
        memoryMutationLockKey(muxHome, path.join(muxHome, "memory"))
      );

    it("a foreign-held target lock blocks an ordinary memory write (fail-fast)", async () => {
      using fixture = await createFixture();
      // Deterministic two-process interleaving: occupy the lockfile with a
      // valid live foreign token, as another process's in-flight rollback
      // would (verified-live → never reclaimed, so the writer must fail).
      const lockPath = memoryTargetLockPath(fixture.muxHome);
      await fsPromises.mkdir(path.dirname(lockPath), { recursive: true });
      await fsPromises.writeFile(lockPath, foreignLiveToken(), { encoding: "utf-8", flag: "wx" });

      const result = await fixture.service.create(
        fixture.ctx,
        "/memories/global/blocked.md",
        "should not land\n",
        "agent"
      );
      expect(result.success).toBe(false);
      if (result.success) throw new Error("unreachable");
      expect(result.error).toContain("Another process is mutating");
      // The write did NOT land while the other side held the target.
      const physicalPath = path.join(fixture.muxHome, "memory", "global", "blocked.md");
      expect(await pathExists(physicalPath)).toBe(false);

      // Lock released → the same write succeeds.
      await fsPromises.unlink(lockPath);
      const retried = await fixture.service.create(
        fixture.ctx,
        "/memories/global/blocked.md",
        "lands now\n",
        "agent"
      );
      expect(retried.success).toBe(true);
    });

    it("a foreign-held target lock blocks a rollback before any mutation", async () => {
      using fixture = await createFixture();
      await fixture.service.create(fixture.ctx, "/memories/global/held.md", "v1\n", "agent");
      await fixture.service.strReplace(
        fixture.ctx,
        "/memories/global/held.md",
        "v1",
        "v2",
        "agent"
      );
      const editRow = await lastRow(fixture.sessionDir);

      const lockPath = memoryTargetLockPath(fixture.muxHome);
      await fsPromises.mkdir(path.dirname(lockPath), { recursive: true });
      await fsPromises.writeFile(lockPath, foreignLiveToken(), { encoding: "utf-8", flag: "wx" });

      const refused = await rollbackRefinement({
        sessionDir: fixture.sessionDir,
        id: editRow.id,
        evidence: EVIDENCE,
      });
      expect(refused.success).toBe(false);
      if (refused.success) throw new Error("unreachable");
      expect(refused.error).toContain("Another process is mutating");
      // Nothing was applied while the writer-side process held the target.
      const physicalPath = path.join(fixture.muxHome, "memory", "global", "held.md");
      expect(await fsPromises.readFile(physicalPath, "utf-8")).toBe("v2\n");

      await fsPromises.unlink(lockPath);
      const retried = await rollbackRefinement({
        sessionDir: fixture.sessionDir,
        id: editRow.id,
        evidence: EVIDENCE,
      });
      expect(retried.success).toBe(true);
      expect(await fsPromises.readFile(physicalPath, "utf-8")).toBe("v1\n");
    });

    it("a dead-process target lock remnant is reclaimed instead of blocking writes", async () => {
      using fixture = await createFixture();
      const child = spawnSync(process.execPath, ["--version"]);
      expect(child.pid).toBeGreaterThan(0);
      const lockPath = memoryTargetLockPath(fixture.muxHome);
      await fsPromises.mkdir(path.dirname(lockPath), { recursive: true });
      await fsPromises.writeFile(lockPath, `${child.pid}:crashed`, {
        encoding: "utf-8",
        flag: "wx",
      });

      const result = await fixture.service.create(
        fixture.ctx,
        "/memories/global/reclaimed.md",
        "lands\n",
        "agent"
      );
      expect(result.success).toBe(true);
    });
  });

  describe("confinement guard rails", () => {
    it("refuses inverse paths outside every legal root, even with force", async () => {
      using fixture = await createFixture();
      // Corrupted row: a memory-kind inverse pointing at a repo AGENTS.md.
      const evilPath = path.join(fixture.checkout, "AGENTS.md");
      await appendRefinementEvent({
        sessionDir: fixture.sessionDir,
        workspaceId: WORKSPACE_ID,
        kind: "memory",
        action: { op: "str_replace", path: "/memories/global/x.md" },
        inverse: { op: "restore-files", files: [{ path: evilPath, content: "pwned" }] },
        evidence: { toolName: "memory" },
      });
      const row = await lastRow(fixture.sessionDir);
      const result = await rollbackRefinement({
        sessionDir: fixture.sessionDir,
        id: row.id,
        force: true,
        evidence: EVIDENCE,
      });
      expect(result.success).toBe(false);
      if (result.success) throw new Error("unreachable");
      expect(result.error).toContain("outside every memory scope root");
      expect(await pathExists(evilPath)).toBe(false);
    });

    it("refuses workspace memory paths that target another session's memory", async () => {
      using fixture = await createFixture();
      // Corrupted row: a memory-kind inverse pointing into a DIFFERENT
      // workspace's memory dir under the same sessions root.
      const foreign = path.join(fixture.muxHome, "sessions", "other-ws", "memory", "notes.md");
      await appendRefinementEvent({
        sessionDir: fixture.sessionDir,
        workspaceId: WORKSPACE_ID,
        kind: "memory",
        action: { op: "str_replace", path: "/memories/workspace/notes.md" },
        inverse: { op: "restore-files", files: [{ path: foreign, content: "pwned" }] },
        evidence: { toolName: "memory" },
      });
      const row = await lastRow(fixture.sessionDir);
      const result = await rollbackRefinement({
        sessionDir: fixture.sessionDir,
        id: row.id,
        force: true,
        evidence: EVIDENCE,
      });
      expect(result.success).toBe(false);
      if (result.success) throw new Error("unreachable");
      expect(result.error).toContain("outside every memory scope root");
      expect(await pathExists(foreign)).toBe(false);
    });

    it("rolls back workspace-scope memory inside the current session", async () => {
      using fixture = await createFixture();
      await fixture.service.create(fixture.ctx, "/memories/workspace/w.md", "v1\n", "agent");
      await fixture.service.strReplace(
        fixture.ctx,
        "/memories/workspace/w.md",
        "v1",
        "v2",
        "agent"
      );
      const editRow = await lastRow(fixture.sessionDir);
      const result = await rollbackRefinement({
        sessionDir: fixture.sessionDir,
        id: editRow.id,
        evidence: EVIDENCE,
      });
      expect(result.success).toBe(true);
      const physicalPath = path.join(fixture.sessionDir, "memory", "w.md");
      expect(await fsPromises.readFile(physicalPath, "utf-8")).toBe("v1\n");
    });

    it("refuses traversal that escapes the memory root lexically", async () => {
      using fixture = await createFixture();
      // Literal traversal in the stored path (path.join would pre-collapse it).
      const escapePath = `${fixture.muxHome}/memory/global/../../config.json`;
      await appendRefinementEvent({
        sessionDir: fixture.sessionDir,
        workspaceId: WORKSPACE_ID,
        kind: "memory",
        action: { op: "delete", path: "/memories/global/x.md" },
        inverse: { op: "restore-files", files: [{ path: escapePath, content: "pwned" }] },
        evidence: { toolName: "memory" },
      });
      const row = await lastRow(fixture.sessionDir);
      const result = await rollbackRefinement({
        sessionDir: fixture.sessionDir,
        id: row.id,
        force: true,
        evidence: EVIDENCE,
      });
      expect(result.success).toBe(false);
      if (result.success) throw new Error("unreachable");
      expect(result.error).toContain("Refusing rollback");
      expect(await pathExists(path.join(fixture.muxHome, "config.json"))).toBe(false);
    });

    it("refuses skill paths without a .mux/skills or .agents/skills root", async () => {
      using fixture = await createFixture();
      const evilPath = path.join(fixture.checkout, "src", "main.ts");
      await appendRefinementEvent({
        sessionDir: fixture.sessionDir,
        workspaceId: WORKSPACE_ID,
        kind: "skill",
        action: { op: "write", skillName: "x", filePath: "SKILL.md" },
        inverse: { op: "delete-files", paths: [evilPath] },
        evidence: { toolName: "agent_skill_write" },
      });
      await fsPromises.mkdir(path.dirname(evilPath), { recursive: true });
      await fsPromises.writeFile(evilPath, "code", "utf-8");
      const row = await lastRow(fixture.sessionDir);
      const result = await rollbackRefinement({
        sessionDir: fixture.sessionDir,
        id: row.id,
        force: true,
        evidence: EVIDENCE,
      });
      expect(result.success).toBe(false);
      if (result.success) throw new Error("unreachable");
      expect(result.error).toContain("outside every skills root");
      expect(await fsPromises.readFile(evilPath, "utf-8")).toBe("code");
    });

    it("refuses a link-substituted .mux/skills root, even with force", async () => {
      using fixture = await createFixture();
      const skillsRoot = path.join(fixture.checkout, ".mux", "skills");
      const target = path.join(skillsRoot, "my-skill", "SKILL.md");
      // Row journaled while the root was a real directory (a write that
      // created the file → delete-files inverse).
      await appendRefinementEvent({
        sessionDir: fixture.sessionDir,
        workspaceId: WORKSPACE_ID,
        kind: "skill",
        action: { op: "write", skillName: "my-skill", filePath: "SKILL.md" },
        inverse: { op: "delete-files", paths: [target] },
        evidence: { toolName: "agent_skill_write" },
      });
      const row = await lastRow(fixture.sessionDir);

      // A later repo revision replaces the skills root with a symlink to an
      // attacker-selected external dir that contains a matching file, so the
      // divergence checks pass and rm(target) would delete the OUTSIDE file.
      const outside = path.join(fixture.checkout, "outside-root");
      await fsPromises.mkdir(path.join(outside, "my-skill"), { recursive: true });
      await fsPromises.writeFile(path.join(outside, "my-skill", "SKILL.md"), "victim\n", "utf-8");
      await fsPromises.mkdir(path.join(fixture.checkout, ".mux"), { recursive: true });
      await fsPromises.symlink(outside, skillsRoot);

      const result = await rollbackRefinement({
        sessionDir: fixture.sessionDir,
        id: row.id,
        force: true, // Confinement is never overridable.
        evidence: EVIDENCE,
      });
      expect(result.success).toBe(false);
      if (result.success) throw new Error("unreachable");
      expect(result.error).toContain("symbolic link");
      // The file behind the link substitution is untouched.
      expect(await fsPromises.readFile(path.join(outside, "my-skill", "SKILL.md"), "utf-8")).toBe(
        "victim\n"
      );
    });

    it("refuses a link-substituted .mux directory itself", async () => {
      using fixture = await createFixture();
      const target = path.join(fixture.checkout, ".mux", "skills", "my-skill", "SKILL.md");
      await appendRefinementEvent({
        sessionDir: fixture.sessionDir,
        workspaceId: WORKSPACE_ID,
        kind: "skill",
        action: { op: "write", skillName: "my-skill", filePath: "SKILL.md" },
        inverse: { op: "delete-files", paths: [target] },
        evidence: { toolName: "agent_skill_write" },
      });
      const row = await lastRow(fixture.sessionDir);

      const outside = path.join(fixture.checkout, "outside-mux");
      await fsPromises.mkdir(path.join(outside, "skills", "my-skill"), { recursive: true });
      await fsPromises.writeFile(
        path.join(outside, "skills", "my-skill", "SKILL.md"),
        "victim\n",
        "utf-8"
      );
      await fsPromises.symlink(outside, path.join(fixture.checkout, ".mux"));

      const result = await rollbackRefinement({
        sessionDir: fixture.sessionDir,
        id: row.id,
        force: true,
        evidence: EVIDENCE,
      });
      expect(result.success).toBe(false);
      if (result.success) throw new Error("unreachable");
      expect(result.error).toContain("symbolic link");
      expect(
        await fsPromises.readFile(path.join(outside, "skills", "my-skill", "SKILL.md"), "utf-8")
      ).toBe("victim\n");
    });

    it("refuses symlink escapes out of the skills root", async () => {
      using fixture = await createFixture();
      const skillsRoot = path.join(fixture.checkout, ".mux", "skills");
      const outside = path.join(fixture.checkout, "outside");
      await fsPromises.mkdir(outside, { recursive: true });
      await fsPromises.mkdir(skillsRoot, { recursive: true });
      // <skillsRoot>/evil → symlink to a directory outside the root.
      await fsPromises.symlink(outside, path.join(skillsRoot, "evil"));
      const target = path.join(skillsRoot, "evil", "SKILL.md");
      await appendRefinementEvent({
        sessionDir: fixture.sessionDir,
        workspaceId: WORKSPACE_ID,
        kind: "skill",
        action: { op: "write", skillName: "evil", filePath: "SKILL.md" },
        inverse: { op: "restore-files", files: [{ path: target, content: "pwned" }] },
        evidence: { toolName: "agent_skill_write" },
      });
      const row = await lastRow(fixture.sessionDir);
      const result = await rollbackRefinement({
        sessionDir: fixture.sessionDir,
        id: row.id,
        force: true,
        evidence: EVIDENCE,
      });
      expect(result.success).toBe(false);
      if (result.success) throw new Error("unreachable");
      expect(result.error).toContain("symlink");
      expect(await pathExists(path.join(outside, "SKILL.md"))).toBe(false);
    });

    it("refuses non-rollbackable refinement kinds", async () => {
      using fixture = await createFixture();
      await sharedDurableEventJournal(fixture.sessionDir).append({
        workspaceId: WORKSPACE_ID,
        kind: "refinement",
        data: { kind: "other", action: {}, inverse: { op: "delete-files", paths: ["/x"] } },
      });
      const row = await lastRow(fixture.sessionDir);
      const result = await rollbackRefinement({
        sessionDir: fixture.sessionDir,
        id: row.id,
        evidence: EVIDENCE,
      });
      expect(result.success).toBe(false);
      if (result.success) throw new Error("unreachable");
      expect(result.error).toContain("not rollbackable");
    });
  });

  it("refuses unknown ids", async () => {
    using fixture = await createFixture();
    const result = await rollbackRefinement({
      sessionDir: fixture.sessionDir,
      id: "does-not-exist",
      evidence: EVIDENCE,
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.error).toContain("No refinement row");
  });
});

import * as path from "node:path";
import assert from "@/common/utils/assert";
import { isValidSourceClock } from "@/common/types/durableEvent";
import {
  MemoryRefinementActionSchema,
  RefinementEvidenceSchema,
  RefinementInverseSchema,
  RefinementPostStateSchema,
  RollbackRefinementActionSchema,
  type MemoryRefinementAction,
  type RefinementInverse,
  type RollbackRefinementAction,
} from "@/common/types/refinement";
import { log } from "@/node/services/log";
import type { BlobQuotaEntry } from "@/node/utils/journal/blobReclamation";
import { sharedDurableEventJournal } from "@/node/utils/journal/durableEventJournal";
import {
  appendRefinementEventUnderBlobLock,
  reclaimRefinementInverseBlobsBestEffort,
  type RefinementFileCapture,
  type RefinementFileReference,
  type RefinementInverseDraft,
} from "./refinementJournal";
import { listRefinements } from "./refinementRollback";
import {
  createLegacyPathRemapper,
  LegacyPathNotAdoptedError,
} from "@/node/services/memoryLegacyAdoption";

function inversePaths(inverse: RefinementInverse): string[] {
  switch (inverse.op) {
    case "delete-files":
      return inverse.paths;
    case "restore-files":
      return [...inverse.files.map((file) => file.path), ...(inverse.deletePaths ?? [])];
    case "rename":
      return [inverse.from, inverse.to];
  }
}

function isInside(root: string, filePath: string): boolean {
  const rel = path.relative(root, path.resolve(filePath));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Before a sub-agent's session directory is deleted, re-append its LIVE
 * memory refinement rows that target the owner's shared `/memories/workspace`
 * store into the OWNER's journal, copying the inverse blob payloads. The
 * edits themselves already live in the owner's store; without this their
 * audit trail and rollback IDs would vanish with the child's journal. Rows
 * already rolled back and rows targeting other roots (global/project) are
 * left alone — they die with the child as before.
 *
 * Rollback rows travel too, but only when their target has an owner copy,
 * with `rollbackOf` remapped to that copy: removal runs this in two passes
 * (pre-teardown, then a delta pass under the removal locks), and another
 * backend can roll a row back in between. Its copy is already in the owner
 * journal by then; without the rollback row following it, the owner journal
 * would claim an edit whose inverse was already applied is still live and
 * rollbackable. A row rolled back before its FIRST copy is simply dead and
 * stays behind with its whole lineage.
 *
 * A row whose inverse payload was reclaimed is copied as an audit-only record
 * (RefinementFileReference) so conflict detection keeps seeing the edit; a
 * row that cannot be parsed at all is skipped with a log line — nothing
 * durable exists to preserve.
 * A row that CAN be reconstructed but cannot be persisted in the owner's
 * journal throws: the caller must not delete the source journal, or the
 * only inverse and rollback ID would be lost. Returns the number migrated.
 */
export async function migrateSharedMemoryRefinementRows(args: {
  childSessionDir: string;
  childWorkspaceId: string;
  ownerSessionDir: string;
  ownerWorkspaceId: string;
}): Promise<number> {
  assert(
    args.childSessionDir.length > 0,
    "migrateSharedMemoryRefinementRows requires childSessionDir"
  );
  assert(
    args.ownerSessionDir.length > 0,
    "migrateSharedMemoryRefinementRows requires ownerSessionDir"
  );
  assert(
    args.ownerWorkspaceId.length > 0,
    "migrateSharedMemoryRefinementRows requires ownerWorkspaceId"
  );
  assert(
    args.childWorkspaceId.length > 0,
    "migrateSharedMemoryRefinementRows requires childWorkspaceId"
  );
  const ownerMemoryRoot = path.join(path.resolve(args.ownerSessionDir), "memory");
  const rows = await listRefinements(args.childSessionDir);
  // Pre-sharing rows address the child's legacy private notebook; their notes
  // live in the owner store now (adoption manifest, read while the child
  // session still exists). Retargeted like the rollback engine does, so the
  // adopted copy stays rollbackable once the child journal is gone; legacy
  // paths the shared store never took are skipped below like other roots.
  // Strict: an unreadable manifest must abort the removal (throws), not read
  // as "nothing adopted" and let the child journal be deleted with the only
  // rollback IDs and inverse payloads of adopted notes.
  const remap = await createLegacyPathRemapper({
    childSessionDir: args.childSessionDir,
    ownerSessionDir: args.ownerSessionDir,
    strict: true,
  });
  const remapInverse = (inverse: RefinementInverse): RefinementInverse | null => {
    try {
      return remap.inverse(inverse);
    } catch (error) {
      if (error instanceof LegacyPathNotAdoptedError) return null;
      throw error;
    }
  };
  // Liveness follows the whole rollback chain (rollback → rollback of the
  // rollback re-applies): an original row is live when it has been rolled
  // back an even number of times. Rollback rows themselves are never copied.
  const rollbackByTarget = new Map(
    rows
      .filter((row) => row.data.rollbackOf !== undefined)
      .map((row) => [row.data.rollbackOf!, row] as const)
  );
  // Returns null on a corrupted (cyclic / absurdly long) lineage: such a row
  // is treated as non-migratable instead of hanging removal.
  const isLive = (rowId: string): boolean | null => {
    const visited = new Set<string>([rowId]);
    let depth = 0;
    for (
      let next = rollbackByTarget.get(rowId);
      next !== undefined;
      next = rollbackByTarget.get(next.id)
    ) {
      if (visited.has(next.id) || depth >= 1024) {
        log.warn("[refinement] corrupted rollback lineage; skipping row migration", { rowId });
        return null;
      }
      visited.add(next.id);
      depth++;
    }
    return depth % 2 === 0;
  };
  const childJournal = sharedDurableEventJournal(args.childSessionDir);
  const ownerJournal = sharedDurableEventJournal(args.ownerSessionDir);
  let migrated = 0;
  const publishedBlobs: BlobQuotaEntry[] = [];
  // One hold of the owner journal's publish lock for the whole batch: the
  // dedup read and every append happen inside it, so a second backend
  // removing the same child concurrently (or a retried removal — the child
  // journal survives a retryable failure or a crash before deletion) sees the
  // copied rows before it decides, and the owner journal is read once rather
  // than once per row. Rows already copied are identified by their source
  // identity on the owner side.
  await ownerJournal.withBlobLock(async () => {
    const ownerRows = await listRefinements(args.ownerSessionDir);
    // Source identity → owner-journal id of its copy (earlier passes and this
    // one). Only a copy that is still a USABLE memory row counts — parseable
    // action (memory or rollback) and inverse: a copy whose persisted state
    // is corrupted would otherwise make a retried removal skip its intact
    // source, delete the child session, and leave the owner with nothing
    // but an unusable rollback record. Such a source is copied again (the
    // corrupted row stays behind as an audit record).
    const ownerIdBySource = new Map<string, string>();
    for (const ownerRow of ownerRows) {
      if (ownerRow.data.migratedFrom === undefined || ownerRow.data.kind !== "memory") continue;
      const usable =
        RefinementInverseSchema.safeParse(ownerRow.data.inverse).success &&
        (MemoryRefinementActionSchema.safeParse(ownerRow.data.action).success ||
          RollbackRefinementActionSchema.safeParse(ownerRow.data.action).success);
      if (usable) ownerIdBySource.set(ownerRow.data.migratedFrom, ownerRow.id);
    }
    // Owner rows already rolled back (by anyone): a second rollback row for
    // the same target would corrupt the lineage the rollback engine walks.
    const ownerRollbackTargets = new Set(
      ownerRows.map((ownerRow) => ownerRow.data.rollbackOf).filter((id) => id !== undefined)
    );
    for (const row of rows) {
      if (row.data.kind !== "memory") continue;
      const migratedFrom = `${args.childWorkspaceId}:${row.id}`;
      if (ownerIdBySource.has(migratedFrom)) continue;
      let action: MemoryRefinementAction | RollbackRefinementAction;
      let rollbackOf: string | undefined;
      if (row.data.rollbackOf === undefined) {
        if (isLive(row.id) !== true) continue;
        const parsed = MemoryRefinementActionSchema.safeParse(row.data.action);
        if (!parsed.success) continue;
        action = parsed.data;
      } else {
        // Child journal order puts a rollback row after its target, so the
        // target's copy (from an earlier pass or this loop) is known here.
        rollbackOf = ownerIdBySource.get(`${args.childWorkspaceId}:${row.data.rollbackOf}`);
        if (rollbackOf === undefined || ownerRollbackTargets.has(rollbackOf)) continue;
        const parsed = RollbackRefinementActionSchema.safeParse(row.data.action);
        if (!parsed.success) continue;
        action = { ...parsed.data, of: rollbackOf };
      }
      const parsedInverse = RefinementInverseSchema.safeParse(row.data.inverse);
      if (!parsedInverse.success) continue;
      const remapped = remapInverse(parsedInverse.data);
      if (remapped === null) continue;
      // A row whose paths were retargeted was journaled against the child's
      // PRIVATE store (pre-sharing, or a self-fallback while config.json was
      // unreadable): any `sourceTs` it carries is that private clock's, not
      // the owner's, so its order among the owner's rows is unknown.
      const retargeted =
        JSON.stringify(inversePaths(parsedInverse.data)) !== JSON.stringify(inversePaths(remapped));
      const inverse = { success: true as const, data: remapped };
      if (!inversePaths(inverse.data).every((p) => isInside(ownerMemoryRoot, p))) continue;

      let draft: RefinementInverseDraft;
      if (inverse.data.op === "restore-files") {
        const files: Array<RefinementFileCapture | RefinementFileReference> = [];
        for (const file of inverse.data.files) {
          // Contents are blob-offloaded at append (resolveRefinementInverse); older
          // rows may carry them inline.
          const content =
            file.text ??
            (file.blobRef === undefined ? null : await childJournal.blobs.getText(file.blobRef));
          if (content !== null) {
            files.push({ path: file.path, content });
          } else if (file.blobRef !== undefined) {
            // Payload reclaimed under the child's inverse-blob quota. The row
            // still travels as an audit record — its paths and source order
            // are what conflict detection needs when the owner later rolls
            // back an older edit over the same files (a directory rename has
            // no post-state hash to notice the child's newer content by) —
            // but it can no longer be rolled back: the reference resolves to
            // nothing in the owner journal, which the rollback engine
            // refuses exactly like an evicted payload of its own.
            files.push({ path: file.path, blobRef: file.blobRef });
          } else {
            break; // neither text nor blobRef: nothing durable to preserve
          }
        }
        if (files.length !== inverse.data.files.length) {
          log.debug("[refinement] skipping shared-memory row migration: inverse payload missing", {
            rowId: row.id,
          });
          continue;
        }
        draft = {
          op: "restore-files",
          files,
          ...(inverse.data.deletePaths !== undefined
            ? { deletePaths: inverse.data.deletePaths }
            : {}),
        };
      } else {
        draft = inverse.data;
      }
      const evidence = RefinementEvidenceSchema.safeParse(row.data.evidence);
      const postState = RefinementPostStateSchema.safeParse(row.data.postState);
      // Throws: this is the only durable copy once the child's journal goes.
      const appended = await appendRefinementEventUnderBlobLock(ownerJournal, {
        sessionDir: args.ownerSessionDir,
        workspaceId: args.ownerWorkspaceId,
        kind: "memory",
        action,
        inverse: draft,
        evidence: {
          toolName: evidence.success ? evidence.data.toolName : "memory",
          ...(evidence.success && evidence.data.toolCallId !== undefined
            ? { toolCallId: evidence.data.toolCallId }
            : {}),
          ...(evidence.success && evidence.data.actor !== undefined
            ? { actor: evidence.data.actor }
            : {}),
        },
        ...(postState.success
          ? {
              postState: {
                files: postState.data.files.flatMap((file) => {
                  try {
                    return [{ ...file, path: remap.path(file.path) }];
                  } catch (error) {
                    if (error instanceof LegacyPathNotAdoptedError) return [];
                    throw error;
                  }
                }),
              },
            }
          : {}),
        migratedFrom,
        ...(rollbackOf !== undefined ? { rollbackOf } : {}),
        // A row without a store-clock value (pre-sharing, or its clock write
        // failed) has only a journal-local `ts`, incomparable with the
        // owner's clock-stamped rows: carried as order-unknown rather than
        // dressed up as a clock value.
        ...(isValidSourceClock(row.data.sourceTs) && !retargeted
          ? { sourceTs: row.data.sourceTs }
          : {}),
        // A malformed clock value is copied as no clock at all (order unknown).
        ...(row.data.orderUnknown === true || !isValidSourceClock(row.data.sourceTs) || retargeted
          ? { orderUnknown: true as const }
          : {}),
        ...(row.data.runtime === "remote" ? { runtime: "remote" as const } : {}),
      });
      publishedBlobs.push(...appended.publishedBlobs);
      ownerIdBySource.set(migratedFrom, appended.rowId);
      if (rollbackOf !== undefined) ownerRollbackTargets.add(rollbackOf);
      migrated++;
    }
  });
  // Migrated rows carry sourceTs (appended out of chronological order), so
  // the quota pass re-derives retention in source order.
  if (publishedBlobs.length > 0) {
    await reclaimRefinementInverseBlobsBestEffort(ownerJournal, publishedBlobs, { resweep: true });
  }
  return migrated;
}

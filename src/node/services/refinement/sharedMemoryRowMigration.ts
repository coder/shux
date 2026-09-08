import * as path from "node:path";
import assert from "@/common/utils/assert";
import {
  MemoryRefinementActionSchema,
  RefinementEvidenceSchema,
  RefinementInverseSchema,
  RefinementPostStateSchema,
  type RefinementInverse,
} from "@/common/types/refinement";
import { log } from "@/node/services/log";
import { sharedDurableEventJournal } from "@/node/utils/journal/durableEventJournal";
import { appendRefinementEvent, type RefinementInverseDraft } from "./refinementJournal";
import { listRefinements } from "./refinementRollback";

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
 * already rolled back (or rollback rows themselves) and rows targeting other
 * roots (global/project) are left alone — they die with the child as before.
 *
 * Best-effort per row: a row whose payload cannot be reconstructed (evicted
 * blob, unparseable action) is skipped with a log line rather than failing
 * the removal. Returns the number of rows migrated.
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
  // Liveness follows the whole rollback chain (rollback → rollback of the
  // rollback re-applies): an original row is live when it has been rolled
  // back an even number of times. Rollback rows themselves are never copied.
  const rollbackByTarget = new Map(
    rows
      .filter((row) => row.data.rollbackOf !== undefined)
      .map((row) => [row.data.rollbackOf!, row] as const)
  );
  const isLive = (rowId: string): boolean => {
    let depth = 0;
    for (
      let next = rollbackByTarget.get(rowId);
      next !== undefined;
      next = rollbackByTarget.get(next.id)
    ) {
      depth++;
    }
    return depth % 2 === 0;
  };
  // Idempotent across retried removals (the child journal survives a
  // retryable removal failure or a crash before deletion): rows already
  // copied are identified by their source identity on the owner side.
  const alreadyMigrated = new Set(
    (await listRefinements(args.ownerSessionDir))
      .map((row) => row.data.migratedFrom)
      .filter((id): id is string => id !== undefined)
  );
  const childJournal = sharedDurableEventJournal(args.childSessionDir);
  let migrated = 0;
  for (const row of rows) {
    if (row.data.kind !== "memory" || row.data.rollbackOf !== undefined || !isLive(row.id)) {
      continue;
    }
    const migratedFrom = `${args.childWorkspaceId}:${row.id}`;
    if (alreadyMigrated.has(migratedFrom)) continue;
    const inverse = RefinementInverseSchema.safeParse(row.data.inverse);
    const action = MemoryRefinementActionSchema.safeParse(row.data.action);
    if (!inverse.success || !action.success) continue;
    if (!inversePaths(inverse.data).every((p) => isInside(ownerMemoryRoot, p))) continue;

    let draft: RefinementInverseDraft;
    if (inverse.data.op === "restore-files") {
      const files: Array<{ path: string; content: string }> = [];
      for (const file of inverse.data.files) {
        // Contents are blob-offloaded at append (resolveRefinementInverse); older
        // rows may carry them inline.
        const content =
          file.text ??
          (file.blobRef === undefined ? null : await childJournal.blobs.getText(file.blobRef));
        if (content === null) break;
        files.push({ path: file.path, content });
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
    await appendRefinementEvent({
      sessionDir: args.ownerSessionDir,
      workspaceId: args.ownerWorkspaceId,
      kind: "memory",
      action: action.data,
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
      ...(postState.success ? { postState: postState.data } : {}),
      migratedFrom,
      ...(row.data.runtime === "remote" ? { runtime: "remote" as const } : {}),
    });
    migrated++;
  }
  return migrated;
}

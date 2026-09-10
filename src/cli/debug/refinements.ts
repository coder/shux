import * as path from "path";
import { defaultConfig } from "@/node/config";
import {
  MemoryRefinementActionSchema,
  RollbackRefinementActionSchema,
  SkillRefinementActionSchema,
} from "@/common/types/refinement";
import {
  listRefinements,
  rollbackRefinement,
  type RefinementEvent,
} from "@/node/services/refinement/refinementRollback";

/** One-line action summary for the list output (op + primary target). */
export function summarizeRefinementAction(row: RefinementEvent): string {
  const rollback = RollbackRefinementActionSchema.safeParse(row.data.action);
  if (rollback.success) {
    return `rollback of ${rollback.data.of}${rollback.data.reason !== undefined ? ` (${rollback.data.reason})` : ""}`;
  }
  if (row.data.kind === "memory") {
    const memory = MemoryRefinementActionSchema.safeParse(row.data.action);
    if (memory.success) {
      const dest = memory.data.newPath !== undefined ? ` -> ${memory.data.newPath}` : "";
      return `${memory.data.op} ${memory.data.path}${dest}`;
    }
  }
  const skill = SkillRefinementActionSchema.safeParse(row.data.action);
  if (skill.success) {
    const file = skill.data.filePath !== undefined ? `/${skill.data.filePath}` : "";
    return `${skill.data.op} ${skill.data.skillName}${file}`;
  }
  return "(unparseable action)";
}

export interface RefinementsCommandOptions {
  rollback?: string;
  force?: boolean;
  /** Test seam: bypass ~/.mux session resolution for fixture sessions. */
  sessionDir?: string;
}

/**
 * Debug command: list a session's refinement journal rows, or roll one back.
 * Usage: bun debug refinements <workspace-id> [--rollback <id>] [--force]
 */
export async function refinementsCommand(
  workspaceId: string,
  opts: RefinementsCommandOptions = {}
): Promise<void> {
  const sessionDir = opts.sessionDir ?? path.join(defaultConfig.sessionsDir, workspaceId);

  if (opts.rollback !== undefined) {
    const result = await rollbackRefinement({
      sessionDir,
      id: opts.rollback,
      force: opts.force,
      evidence: { toolName: "debug-cli", actor: "user" },
    });
    if (!result.success) {
      console.error(result.error);
      process.exitCode = 1;
      return;
    }
    for (const restored of result.data.restored) {
      console.log(`restored ${restored}`);
    }
    for (const deleted of result.data.deleted) {
      console.log(`deleted ${deleted}`);
    }
    if (result.data.renamed) {
      console.log(`renamed ${result.data.renamed.from} -> ${result.data.renamed.to}`);
    }
    console.log(
      result.data.rollbackRowId !== null
        ? `rollback journaled as ${result.data.rollbackRowId} (rollbackOf ${opts.rollback})`
        : `rollback applied but journaling FAILED (no rollback row)`
    );
    return;
  }

  const rows = await listRefinements(sessionDir);
  if (rows.length === 0) {
    console.log("No refinement rows in this session.");
    return;
  }
  for (const row of rows) {
    const parts = [
      row.id,
      row.data.kind,
      summarizeRefinementAction(row),
      new Date(row.ts).toISOString(),
    ];
    if (row.data.rollbackOf !== undefined) {
      parts.push(`rollbackOf=${row.data.rollbackOf}`);
    }
    console.log(parts.join("  "));
  }
}

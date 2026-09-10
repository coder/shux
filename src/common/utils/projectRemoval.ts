import { z } from "zod";
import { isWorkspaceArchived } from "./archive";

/**
 * Single source of truth for removal blocker counts: the projects.getRemovalBlockers
 * IPC output validates against this schema, so service return type and runtime
 * validation cannot drift.
 */
export const ProjectWorkspaceCountsSchema = z.object({
  activeCount: z.number().int().nonnegative(),
  archivedCount: z.number().int().nonnegative(),
});

export type ProjectWorkspaceCounts = z.infer<typeof ProjectWorkspaceCountsSchema>;

/**
 * Compute active vs archived workspace counts from a project's workspace config entries.
 * Used by both backend (removal policy) and frontend (sidebar eligibility).
 */
export function getProjectWorkspaceCounts(
  workspaces: ReadonlyArray<{ archivedAt?: string; unarchivedAt?: string }>
): ProjectWorkspaceCounts {
  let archivedCount = 0;
  for (const ws of workspaces) {
    if (isWorkspaceArchived(ws.archivedAt, ws.unarchivedAt)) archivedCount += 1;
  }
  return { activeCount: workspaces.length - archivedCount, archivedCount };
}

import assert from "@/common/utils/assert";
import type { Config } from "@/node/config";
import { log } from "@/node/services/log";
import { findWorkspaceEntry } from "@/node/services/taskUtils";

type ProjectsConfig = ReturnType<Config["loadConfigOrDefault"]>;

/**
 * The workspace whose <sessionDir>/memory backs `/memories/workspace` for
 * `workspaceId`: the root of its parentWorkspaceId chain. Sub-agents (and
 * nested sub-agents) thereby share ONE notebook with the workspace that
 * spawned the task tree, while their transcripts/session artifacts stay
 * separate. Full `kind: "workspace"` tasks and forks carry no
 * parentWorkspaceId and own their notes.
 *
 * Unknown IDs, dangling parents, cycles, and depth overflow resolve to the ID
 * itself so a misconfigured tree degrades to per-workspace behavior instead
 * of failing every memory command. Callers that need "is this a shared
 * child?" must compare the result to the input rather than test
 * parentWorkspaceId, so those fallbacks keep their private store usable.
 *
 * Pure over one config snapshot; MemoryService memoizes it, removal and the
 * rollback tooling call it directly.
 */
export function resolveWorkspaceMemoryOwnerId(cfg: ProjectsConfig, workspaceId: string): string {
  assert(workspaceId.length > 0, "resolveWorkspaceMemoryOwnerId requires a workspaceId");
  let current = workspaceId;
  const visited = new Set<string>();
  for (let depth = 0; depth < 32; depth++) {
    if (visited.has(current)) {
      log.warn("[memory] parentWorkspaceId cycle; using acting workspace as memory owner", {
        workspaceId,
      });
      return workspaceId;
    }
    visited.add(current);
    const entry = findWorkspaceEntry(cfg, current);
    if (entry === null) {
      // Only the chain root may be unknown without invalidating the walk: an
      // unregistered starting workspace simply resolves to itself.
      if (current !== workspaceId) {
        log.warn("[memory] parentWorkspaceId points at an unknown workspace", {
          workspaceId,
          parentWorkspaceId: current,
        });
      }
      return workspaceId;
    }
    const parentWorkspaceId = entry.workspace.parentWorkspaceId;
    if (parentWorkspaceId === undefined || parentWorkspaceId === "") return current;
    current = parentWorkspaceId;
  }
  log.warn("[memory] parentWorkspaceId chain too deep; using acting workspace as memory owner", {
    workspaceId,
  });
  return workspaceId;
}

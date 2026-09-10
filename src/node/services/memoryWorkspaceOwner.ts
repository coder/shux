import * as path from "node:path";
import assert from "@/common/utils/assert";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import { log } from "@/node/services/log";

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
 * Pure over one config snapshot (indexed once per snapshot, see
 * workspaceMemoryOwnerResolver); MemoryService memoizes it, removal and the
 * rollback tooling call it directly.
 */
export function resolveWorkspaceMemoryOwnerId(cfg: ProjectsConfig, workspaceId: string): string {
  return workspaceMemoryOwnerResolver(cfg)(workspaceId);
}

/**
 * Per-snapshot resolvers keyed by the config object: bulk passes (memo
 * revalidation on every local config edit, launch sweep, change diffing)
 * resolve many workspaces against one snapshot, and a linear
 * findWorkspaceEntry per chain hop would make them O(n²) on the main process.
 * The index is built once per snapshot and the snapshot is never mutated
 * after load, so a WeakMap keyed by identity is safe.
 */
const resolversBySnapshot = new WeakMap<ProjectsConfig, (workspaceId: string) => string>();

export function workspaceMemoryOwnerResolver(cfg: ProjectsConfig): (workspaceId: string) => string {
  const cached = resolversBySnapshot.get(cfg);
  if (cached !== undefined) return cached;
  const byId = new Map<string, WorkspaceConfigEntry>();
  for (const project of cfg.projects.values()) {
    for (const workspace of project.workspaces) {
      if (workspace.id !== undefined) byId.set(workspace.id, workspace);
    }
  }
  const resolver = (workspaceId: string): string => {
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
      const entry = byId.get(current);
      if (entry === undefined) {
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
      // A pinned owner (recorded when an intermediate ancestor was removed)
      // short-circuits the walk; if that owner is itself gone, fall through to
      // the parent chain, which then dangles and resolves to self.
      const pinned = entry.memoryOwnerWorkspaceId;
      if (pinned !== undefined && pinned !== "" && byId.has(pinned)) {
        return pinned;
      }
      const parentWorkspaceId = entry.parentWorkspaceId;
      if (parentWorkspaceId === undefined || parentWorkspaceId === "") return current;
      current = parentWorkspaceId;
    }
    log.warn("[memory] parentWorkspaceId chain too deep; using acting workspace as memory owner", {
      workspaceId,
    });
    return workspaceId;
  };
  resolversBySnapshot.set(cfg, resolver);
  return resolver;
}

/**
 * Session dirs of the OTHER registered members of `workspaceId`'s task tree —
 * every workspace resolving to the same owner (the owner itself, siblings,
 * descendants). They journal their own mutations of the shared
 * `/memories/workspace` store, so a rollback in one member must consult all
 * of them for later conflicting rows (refinementRollback.ts). Empty for a
 * workspace that owns its store alone.
 */
export function sharedWorkspaceMemoryPeerSessionDirs(
  cfg: ProjectsConfig,
  sessionsDir: string,
  workspaceId: string
): string[] {
  assert(sessionsDir.length > 0, "sharedWorkspaceMemoryPeerSessionDirs requires sessionsDir");
  const resolve = workspaceMemoryOwnerResolver(cfg);
  const owner = resolve(workspaceId);
  const peers: string[] = [];
  for (const project of cfg.projects.values()) {
    for (const workspace of project.workspaces) {
      if (workspace.id === undefined || workspace.id === workspaceId) continue;
      if (resolve(workspace.id) === owner) peers.push(path.join(sessionsDir, workspace.id));
    }
  }
  return peers;
}

/** Owner root and live peers of a workspace sharing its notebook (rollback). */
export interface SharedWorkspaceMemoryTopology {
  /** Owner session dir when the workspace is a sub-agent sharing its notebook. */
  ownerSessionDir: string | undefined;
  /** Other live task-tree members' session dirs (see RollbackRefinementOptions). */
  peerSessionDirs: string[];
}

/**
 * The rollback topology from ONE config snapshot that must prove itself:
 * `loadExistingConfigOrThrow` throws when config.json is unreadable OR
 * absent (mid-rewrite), so callers refuse instead of degrading to the
 * fresh-install view in which the workspace owns its notebook — that "self"
 * fallback would omit the owner root (a pre-sharing row's inverse then lands
 * on the hidden legacy notebook instead of the owner's adopted copy) and the
 * peer list (conflicting sibling rows go unseen). Peers are re-resolved per
 * check by the engine (a member registered while waiting for the store lock
 * must count), so callers hand it a callback that calls this again.
 */
export function resolveSharedWorkspaceMemoryTopology(
  config: Pick<Config, "loadExistingConfigOrThrow" | "sessionsDir">,
  workspaceId: string
): SharedWorkspaceMemoryTopology {
  const cfg = config.loadExistingConfigOrThrow();
  const ownerId = resolveWorkspaceMemoryOwnerId(cfg, workspaceId);
  return {
    ownerSessionDir: ownerId === workspaceId ? undefined : path.join(config.sessionsDir, ownerId),
    peerSessionDirs: sharedWorkspaceMemoryPeerSessionDirs(cfg, config.sessionsDir, workspaceId),
  };
}

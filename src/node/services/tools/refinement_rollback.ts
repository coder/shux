import * as path from "node:path";
import { tool, type Tool } from "ai";

import type { RefinementRollbackToolResult } from "@/common/types/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { listRefinements, rollbackRefinement } from "@/node/services/refinement/refinementRollback";
import { RefinementInverseSchema, type RefinementInverse } from "@/common/types/refinement";
import type { MemoryScopeAccess } from "@/common/constants/memory";
import type { MemoryScopeContext, MemoryService } from "@/node/services/memoryService";
import {
  createLegacyPathRemapper,
  LegacyPathNotAdoptedError,
} from "@/node/services/memoryLegacyAdoption";
import { getErrorMessage } from "@/common/utils/errors";
import type { SharedWorkspaceMemoryTopology } from "@/node/services/memoryWorkspaceOwner";

interface RefinementRollbackToolArgs {
  id: string;
  reason: string;
}

/**
 * Model-facing rollback of journaled harness self-modifications (RLM mode
 * only — assembled in toolAssembly from the sandbox context, never part of the
 * base toolset, so with the experiment off the tool does not exist).
 *
 * No force parameter on purpose: divergence overrides are a human decision
 * (debug CLI --force). The model gets the refusal text and can report it.
 */
/**
 * Policy gate for memory rows: every path the target row's inverse would touch
 * must lie in a scope this agent may write. Unknown rows/inverses fall through
 * (null) so the engine produces its canonical refusal.
 */
async function refuseReadOnlyMemoryRollback(
  sessionDir: string,
  sharedWorkspaceMemorySessionDir: string | undefined,
  id: string,
  memory: { service: MemoryService; ctx: MemoryScopeContext; access: MemoryScopeAccess }
): Promise<string | null> {
  const row = (await listRefinements(sessionDir)).find((candidate) => candidate.id === id);
  if (row?.data.kind !== "memory") return null;
  const parsed = RefinementInverseSchema.safeParse(row.data.inverse);
  if (!parsed.success) return null;
  // The paths the engine will actually touch: a sub-agent's pre-sharing rows
  // address its legacy private notebook, which the engine retargets to the
  // adopted owner copy (refinementRollback.ts) — classify THOSE paths, or the
  // legacy ones would read as unclassifiable and refuse every such row here.
  // A legacy path the engine cannot map falls through to its refusal.
  let inverse: RefinementInverse = parsed.data;
  if (
    sharedWorkspaceMemorySessionDir !== undefined &&
    path.resolve(sharedWorkspaceMemorySessionDir) !== path.resolve(sessionDir)
  ) {
    const remap = await createLegacyPathRemapper({
      childSessionDir: sessionDir,
      ownerSessionDir: sharedWorkspaceMemorySessionDir,
    });
    try {
      inverse = remap.inverse(parsed.data);
    } catch (error) {
      if (error instanceof LegacyPathNotAdoptedError) return null;
      throw error;
    }
  }
  const paths =
    inverse.op === "delete-files"
      ? inverse.paths
      : inverse.op === "rename"
        ? [inverse.from, inverse.to]
        : [...inverse.files.map((file) => file.path), ...(inverse.deletePaths ?? [])];
  for (const physicalPath of paths) {
    const scope = memory.service.scopeOfPhysicalPath(memory.ctx, physicalPath);
    // Fail closed: a memory row's paths always lie in some scope root, so
    // "unclassifiable" means this context's roots no longer match the row
    // (e.g. the owner root admitted at preparation time while the per-context
    // resolver now falls back to self because config.json is unreadable) —
    // the policy cannot be evaluated, so the write must not proceed.
    if (scope === null) {
      return `Cannot classify '${physicalPath}' against this agent's memory scopes; refusing to roll back '${id}'.`;
    }
    if (memory.access[scope] !== "readwrite") {
      return `The ${scope} memory scope is read-only for this agent; rolling back '${id}' would write into it.`;
    }
  }
  return null;
}

export type SharedWorkspaceMemoryTopologyResolver = () => SharedWorkspaceMemoryTopology;

export function createRefinementRollbackTool(ctx: {
  workspaceId: string;
  sessionDir: string;
  /**
   * Task-tree topology of a workspace sharing its notebook, resolved PER
   * EXECUTION (membership changes while the tool instance lives) from a
   * config snapshot that must prove itself: a throw refuses the rollback. No
   * fallback view is acceptable here — ownership read from a missing
   * config.json resolves to "self", which would omit the owner root (a
   * pre-sharing row's inverse then lands on the hidden legacy notebook
   * instead of the owner's adopted copy) and the peer list (conflicting
   * sibling rows go unseen). Omitted = the workspace owns its notebook.
   */
  sharedWorkspaceMemory?: SharedWorkspaceMemoryTopologyResolver;
  /**
   * Memory integration: announces rolled-back memory files so shared-store
   * readers refresh, and applies the agent's per-scope write policy — a
   * rollback is a write into the scope, so a read-only scope (e.g. the shared
   * workspace notebook for an explore-like sub-agent) refuses it, exactly as
   * the memory tool would.
   */
  memory?: { service: MemoryService; ctx: MemoryScopeContext; access: MemoryScopeAccess };
}): Tool {
  return tool({
    description: TOOL_DEFINITIONS.refinement_rollback.description,
    inputSchema: TOOL_DEFINITIONS.refinement_rollback.schema,
    execute: async (
      { id, reason }: RefinementRollbackToolArgs,
      { toolCallId }
    ): Promise<RefinementRollbackToolResult> => {
      // Resolved once here for the owner root (stable for the session's
      // lifetime) and the policy gate; peers are re-resolved by the engine per
      // check through the same resolver (a throw there refuses too).
      let topology: SharedWorkspaceMemoryTopology;
      try {
        topology = ctx.sharedWorkspaceMemory?.() ?? {
          ownerSessionDir: undefined,
          peerSessionDirs: [],
        };
      } catch (error) {
        return {
          success: false,
          error: `Cannot resolve this workspace's shared-memory ownership right now (${getErrorMessage(error)}); refusing to roll back '${id}'.`,
        };
      }
      if (ctx.memory !== undefined) {
        const refusal = await refuseReadOnlyMemoryRollback(
          ctx.sessionDir,
          topology.ownerSessionDir,
          id,
          ctx.memory
        );
        if (refusal !== null) return { success: false, error: refusal };
      }
      const result = await rollbackRefinement({
        sessionDir: ctx.sessionDir,
        sharedWorkspaceMemorySessionDir: topology.ownerSessionDir,
        listSharedWorkspaceMemoryPeerSessionDirs: () =>
          ctx.sharedWorkspaceMemory?.().peerSessionDirs ?? [],
        id,
        reason,
        evidence: { toolName: "refinement_rollback", toolCallId, actor: "agent" },
      });
      if (!result.success) {
        return { success: false, error: result.error };
      }
      // Rollback writes inverses straight to disk, bypassing MemoryService's
      // change events; announce them so the (possibly shared) store's other
      // readers — owner, siblings, open Memory tabs — do not keep stale context.
      ctx.memory?.service.notifyExternalMutation(ctx.memory.ctx, [
        ...result.data.restored,
        ...result.data.deleted,
        ...(result.data.renamed === undefined
          ? []
          : [result.data.renamed.from, result.data.renamed.to]),
      ]);
      return {
        success: true,
        rollbackOf: id,
        rollbackRowId: result.data.rollbackRowId,
        restored: result.data.restored,
        deleted: result.data.deleted,
        ...(result.data.renamed !== undefined ? { renamed: result.data.renamed } : {}),
      };
    },
  });
}

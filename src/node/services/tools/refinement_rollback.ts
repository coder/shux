import { tool, type Tool } from "ai";

import type { RefinementRollbackToolResult } from "@/common/types/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { listRefinements, rollbackRefinement } from "@/node/services/refinement/refinementRollback";
import { RefinementInverseSchema } from "@/common/types/refinement";
import type { MemoryScopeAccess } from "@/common/constants/memory";
import type { MemoryScopeContext, MemoryService } from "@/node/services/memoryService";

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
  id: string,
  memory: { service: MemoryService; ctx: MemoryScopeContext; access: MemoryScopeAccess }
): Promise<string | null> {
  const row = (await listRefinements(sessionDir)).find((candidate) => candidate.id === id);
  if (row?.data.kind !== "memory") return null;
  const inverse = RefinementInverseSchema.safeParse(row.data.inverse);
  if (!inverse.success) return null;
  const paths =
    inverse.data.op === "delete-files"
      ? inverse.data.paths
      : inverse.data.op === "rename"
        ? [inverse.data.from, inverse.data.to]
        : [...inverse.data.files.map((file) => file.path), ...(inverse.data.deletePaths ?? [])];
  for (const physicalPath of paths) {
    const scope = memory.service.scopeOfPhysicalPath(memory.ctx, physicalPath);
    if (scope !== null && memory.access[scope] !== "readwrite") {
      return `The ${scope} memory scope is read-only for this agent; rolling back '${id}' would write into it.`;
    }
  }
  return null;
}

export function createRefinementRollbackTool(ctx: {
  workspaceId: string;
  sessionDir: string;
  /** Owner session dir when this workspace is a sub-agent sharing its notebook. */
  sharedWorkspaceMemorySessionDir?: string;
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
      if (ctx.memory !== undefined) {
        const refusal = await refuseReadOnlyMemoryRollback(ctx.sessionDir, id, ctx.memory);
        if (refusal !== null) return { success: false, error: refusal };
      }
      const result = await rollbackRefinement({
        sessionDir: ctx.sessionDir,
        sharedWorkspaceMemorySessionDir: ctx.sharedWorkspaceMemorySessionDir,
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

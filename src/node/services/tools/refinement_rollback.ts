import { tool, type Tool } from "ai";

import type { RefinementRollbackToolResult } from "@/common/types/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { rollbackRefinement } from "@/node/services/refinement/refinementRollback";

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
export function createRefinementRollbackTool(ctx: {
  workspaceId: string;
  sessionDir: string;
}): Tool {
  return tool({
    description: TOOL_DEFINITIONS.refinement_rollback.description,
    inputSchema: TOOL_DEFINITIONS.refinement_rollback.schema,
    execute: async (
      { id, reason }: RefinementRollbackToolArgs,
      { toolCallId }
    ): Promise<RefinementRollbackToolResult> => {
      const result = await rollbackRefinement({
        sessionDir: ctx.sessionDir,
        id,
        reason,
        evidence: { toolName: "refinement_rollback", toolCallId, actor: "agent" },
      });
      if (!result.success) {
        return { success: false, error: result.error };
      }
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

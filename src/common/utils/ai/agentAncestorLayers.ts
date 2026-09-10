/**
 * Walks an agent's declared base chain over an already-gathered descriptor
 * lookup, producing resolver ancestor layers child to root. Reads no agent
 * files; adapters build the lookup from their environment. The implicit
 * plan/exec fallback is not represented here: the pure resolver appends it.
 */

import type {
  AgentAiAncestorLayer,
  AgentAiDefinitionDefaults,
} from "@/common/types/agentAiSettings";

export interface AgentAncestorDescriptor {
  base?: string;
  definitionAiDefaults?: AgentAiDefinitionDefaults;
}

/** Matches MAX_INHERITANCE_DEPTH in the Node definition loader. */
export const MAX_AGENT_CHAIN_DEPTH = 10;

export function collectDeclaredAncestorLayers(
  agentId: string,
  descriptorsById: ReadonlyMap<string, AgentAncestorDescriptor>
): AgentAiAncestorLayer[] {
  const visited = new Set<string>([agentId]);
  const ancestors: AgentAiAncestorLayer[] = [];
  let cursor = agentId;

  while (ancestors.length < MAX_AGENT_CHAIN_DEPTH) {
    const base = descriptorsById.get(cursor)?.base;
    // Same-id bases (e.g. project exec.md with base: exec) refine the
    // definition, not the config chain; cycles end traversal.
    if (base == null || base === cursor || visited.has(base)) break;
    visited.add(base);
    const definitionAiDefaults = descriptorsById.get(base)?.definitionAiDefaults;
    ancestors.push({ agentId: base, ...(definitionAiDefaults ? { definitionAiDefaults } : {}) });
    cursor = base;
  }

  return ancestors;
}

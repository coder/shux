import type { Runtime } from "@/node/runtime/Runtime";

import type { AgentDefinitionPackage, AgentId } from "@/common/types/agentDefinition";
import { log } from "@/node/services/log";

import {
  agentVisitKey,
  computeBaseSkipScope,
  MAX_INHERITANCE_DEPTH,
  readAgentDefinition,
} from "./agentDefinitionsService";
import { getErrorMessage } from "@/common/utils/errors";

export interface AgentForInheritance {
  id: AgentId;
  base?: AgentId;
  tools?: AgentDefinitionPackage["frontmatter"]["tools"];
  uiColor?: string;
  /** Per-hop (unmerged) frontmatter `ai` defaults for AI-settings resolution. */
  ai?: AgentDefinitionPackage["frontmatter"]["ai"];
  /** Provenance of the hop's winning definition (strict-send chain pinning). */
  scope: AgentDefinitionPackage["scope"];
  source?: string;
}

interface ResolveAgentInheritanceChainOptions {
  runtime: Runtime;
  workspacePath: string;
  agentId: AgentId;
  agentDefinition: AgentDefinitionPackage;
  workspaceId: string;
  maxDepth?: number;
  /** agent-plugins experiment: also resolve base agents contributed by Agent Plugins. */
  includeAgentPlugins?: boolean;
}

/**
 * Resolve an agent's `base` inheritance chain (starting at the selected agent).
 *
 * IMPORTANT: Tool-policy computation requires the base chain to be present.
 * Building an "all agents" set in callers is error-prone because base agents
 * can be workspace-defined (project/global) rather than built-ins.
 *
 * When resolving a base with the same ID as the current agent (e.g., project-scope
 * `exec.md` with `base: exec`), we skip the current scope to find global/built-in.
 */
export async function resolveAgentInheritanceChain(
  options: ResolveAgentInheritanceChainOptions
): Promise<AgentForInheritance[]> {
  const { runtime, workspacePath, agentId, agentDefinition, workspaceId } = options;
  const maxDepth = options.maxDepth ?? MAX_INHERITANCE_DEPTH;

  const agentsForInheritance: AgentForInheritance[] = [];
  const seenPackages = new Set<string>();
  let currentAgentId = agentId;
  let currentDefinition = agentDefinition;

  for (let depth = 0; depth < maxDepth; depth++) {
    const visitKey = agentVisitKey(currentDefinition.id, currentDefinition.scope);
    if (seenPackages.has(visitKey)) {
      log.warn("Agent definition base chain has a cycle; stopping resolution", {
        workspaceId,
        agentId,
        currentAgentId,
        scope: currentDefinition.scope,
      });
      break;
    }
    seenPackages.add(visitKey);

    agentsForInheritance.push({
      id: currentAgentId,
      base: currentDefinition.frontmatter.base,
      tools: currentDefinition.frontmatter.tools,
      uiColor: currentDefinition.frontmatter.ui?.color,
      ai: currentDefinition.frontmatter.ai,
      scope: currentDefinition.scope,
      ...(currentDefinition.source != null ? { source: currentDefinition.source } : {}),
    });

    const baseId = currentDefinition.frontmatter.base;
    if (!baseId) {
      break;
    }

    const skipScopesAbove = computeBaseSkipScope(baseId, currentAgentId, currentDefinition.scope);
    currentAgentId = baseId;

    try {
      currentDefinition = await readAgentDefinition(runtime, workspacePath, baseId, {
        includeAgentPlugins: options.includeAgentPlugins,
        skipScopesAbove,
      });
    } catch (error) {
      log.warn("Failed to load base agent definition; stopping inheritance resolution", {
        workspaceId,
        agentId,
        baseId,
        error: getErrorMessage(error),
      });
      break;
    }
  }

  return agentsForInheritance;
}

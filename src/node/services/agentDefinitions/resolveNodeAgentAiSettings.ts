/**
 * Node adapter for the unified agent AI-settings resolver: reads agent
 * definitions, assembles the declared base chain, gathers configured defaults,
 * and delegates all precedence to the pure resolver. Owns missing-definition
 * and cycle logging so the pure layer stays side-effect free.
 */

import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import type {
  AgentAiAncestorLayer,
  AgentAiDefinitionDefaults,
  AgentAiProfile,
  AgentAiSettingsLayerValues,
  ResolvedAgentAiSettings,
} from "@/common/types/agentAiSettings";
import type {
  OpenAIReasoningMode,
  ParsedThinkingInput,
  ThinkingLevel,
} from "@/common/types/thinking";
import { resolveAgentAiSettings } from "@/common/utils/ai/resolveAgentAiSettings";
import { getErrorMessage } from "@/common/utils/errors";
import type { Runtime } from "@/node/runtime/Runtime";
import { log } from "@/node/services/log";

import { readAgentDefinition } from "./agentDefinitionsService";
import { resolveAgentInheritanceChain } from "./resolveAgentInheritanceChain";

/** Checkout context for reading agent definitions; omit when unavailable. */
export interface NodeAgentDefinitionContext {
  runtime: Runtime;
  workspacePath: string;
  workspaceId: string;
  /** agent-plugins experiment: also resolve definitions contributed by Agent Plugins. */
  includeAgentPlugins?: boolean;
}

export interface ResolveNodeAgentAiSettingsParams {
  agentId: string;
  profile: AgentAiProfile;
  cfg: {
    agentAiDefaults?: AgentAiDefaults;
    minThinkingLevelByModel?: Record<string, ThinkingLevel>;
  };
  providersConfig?: ProvidersConfigMap | null;
  explicit?: {
    model?: string;
    thinkingLevel?: ParsedThinkingInput;
    reasoningMode?: OpenAIReasoningMode;
  };
  targetWorkspaceSettings?: AgentAiSettingsLayerValues;
  parentWorkspaceExecSettings?: AgentAiSettingsLayerValues;
  parentRuntime?: AgentAiSettingsLayerValues;
  fallbacks?: readonly AgentAiSettingsLayerValues[];
  defaultModel?: string;
  /**
   * When present, target/ancestor definition `ai` defaults and the declared
   * base chain are read from the checkout. When absent (e.g. recovery paths
   * without a live runtime), resolution uses the implicit fallback ancestor
   * only.
   */
  definitionContext?: NodeAgentDefinitionContext;
}

function toDefinitionDefaults(
  ai: { model?: string; thinkingLevel?: ThinkingLevel } | undefined
): AgentAiDefinitionDefaults | undefined {
  if (!ai || (ai.model === undefined && ai.thinkingLevel === undefined)) {
    return undefined;
  }
  return { model: ai.model, thinkingLevel: ai.thinkingLevel };
}

/** Field-wise merge of definition layers; the closer scope/hop wins per field. */
function mergeDefinitionDefaults(
  closer: AgentAiDefinitionDefaults | undefined,
  further: AgentAiDefinitionDefaults | undefined
): AgentAiDefinitionDefaults | undefined {
  if (!closer) return further;
  if (!further) return closer;
  return {
    model: closer.model ?? further.model,
    thinkingLevel: closer.thinkingLevel ?? further.thinkingLevel,
  };
}

/**
 * Map an inheritance chain (target first, as returned by
 * resolveAgentInheritanceChain) onto resolver layers. The chain may contain
 * multiple entries with the same agent ID distinguished by scope (e.g.
 * project `exec.md` with `base: exec` refining the global/built-in `exec`);
 * the shared resolver deduplicates ancestors by ID, so same-ID entries must
 * merge field-wise into one layer here instead of being dropped.
 */
export function collectDefinitionLayers(
  agentId: string,
  chain: ReadonlyArray<{ id: string; ai?: { model?: string; thinkingLevel?: ThinkingLevel } }>
): {
  targetDefinitionAiDefaults?: AgentAiDefinitionDefaults;
  ancestors: AgentAiAncestorLayer[];
} {
  const targetId = chain[0]?.id ?? agentId;
  let targetDefinitionAiDefaults = toDefinitionDefaults(chain[0]?.ai);
  const ancestorsById = new Map<string, AgentAiAncestorLayer>();
  for (const entry of chain.slice(1)) {
    const defaults = toDefinitionDefaults(entry.ai);
    if (entry.id === targetId || entry.id === agentId) {
      targetDefinitionAiDefaults = mergeDefinitionDefaults(targetDefinitionAiDefaults, defaults);
      continue;
    }
    const existing = ancestorsById.get(entry.id);
    if (existing) {
      existing.definitionAiDefaults = mergeDefinitionDefaults(
        existing.definitionAiDefaults,
        defaults
      );
    } else {
      ancestorsById.set(entry.id, { agentId: entry.id, definitionAiDefaults: defaults });
    }
  }
  return { targetDefinitionAiDefaults, ancestors: [...ancestorsById.values()] };
}

async function loadDefinitionLayers(
  agentId: string,
  context: NodeAgentDefinitionContext | undefined
): Promise<{
  targetDefinitionAiDefaults?: AgentAiDefinitionDefaults;
  ancestors: AgentAiAncestorLayer[];
}> {
  if (!context) {
    return { ancestors: [] };
  }

  try {
    const agentDefinition = await readAgentDefinition(
      context.runtime,
      context.workspacePath,
      agentId,
      { includeAgentPlugins: context.includeAgentPlugins }
    );
    const chain = await resolveAgentInheritanceChain({
      runtime: context.runtime,
      workspacePath: context.workspacePath,
      agentId: agentDefinition.id,
      agentDefinition,
      workspaceId: context.workspaceId,
      includeAgentPlugins: context.includeAgentPlugins,
    });

    return collectDefinitionLayers(agentId, chain);
  } catch (error) {
    // A missing or unreadable definition must not break resolution: fall back
    // to the implicit base the resolver appends on its own.
    log.debug("resolveNodeAgentAiSettings: definition chain unavailable", {
      agentId,
      workspaceId: context.workspaceId,
      error: getErrorMessage(error),
    });
    return { ancestors: [] };
  }
}

export async function resolveNodeAgentAiSettings(
  params: ResolveNodeAgentAiSettingsParams
): Promise<ResolvedAgentAiSettings> {
  const { targetDefinitionAiDefaults, ancestors } = await loadDefinitionLayers(
    params.agentId,
    params.definitionContext
  );

  const result = resolveAgentAiSettings({
    targetAgentId: params.agentId,
    profile: params.profile,
    explicit: params.explicit,
    targetWorkspaceSettings: params.targetWorkspaceSettings,
    agentAiDefaults: params.cfg.agentAiDefaults,
    targetDefinitionAiDefaults,
    ancestors,
    parentWorkspaceExecSettings: params.parentWorkspaceExecSettings,
    parentRuntime: params.parentRuntime,
    fallbacks: params.fallbacks,
    defaultModel: params.defaultModel,
    providersConfig: params.providersConfig,
    minThinkingLevelByModel: params.cfg.minThinkingLevelByModel,
  });

  for (const diagnostic of result.diagnostics) {
    log.debug("resolveNodeAgentAiSettings: " + diagnostic, { agentId: params.agentId });
  }

  return result;
}

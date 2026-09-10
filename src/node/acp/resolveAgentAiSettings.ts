/**
 * ACP adapter for the unified agent AI-settings resolver: gathers configured
 * defaults and agent descriptors over ORPC, assembles the declared base chain
 * (plus the implicit plan/exec fallback ancestor), and delegates precedence to
 * the shared pure resolver.
 */

import assert from "node:assert/strict";
import type {
  AgentAiSettingsLayerValues,
  ResolveAgentAiSettingsInput,
  ResolvedAgentAiSettings,
} from "@/common/types/agentAiSettings";
import {
  collectDeclaredAncestorLayers,
  type AgentAncestorDescriptor,
} from "@/common/utils/ai/agentAncestorLayers";
import { resolveAgentAiSettings as resolveAgentAiSettingsShared } from "@/common/utils/ai/resolveAgentAiSettings";
import type { ORPCClient } from "./serverConnection";

/**
 * Selected (persistence-shaped) settings, threaded into prompt sends so ACP
 * sessions do not silently downgrade pro workspaces to standard.
 */
export type ResolvedAiSettings = ResolvedAgentAiSettings["selected"];

function buildAgentsListInput(
  workspaceId?: string
):
  | { workspaceId: string; includeDisabled: boolean }
  | { projectPath: string; includeDisabled: boolean } {
  const trimmedWorkspaceId = workspaceId?.trim();
  if (trimmedWorkspaceId) {
    return { workspaceId: trimmedWorkspaceId, includeDisabled: true };
  }

  // Fallback for callers that do not have workspace context yet.
  return { projectPath: process.cwd(), includeDisabled: true };
}

export interface AcpResolveExtras {
  explicit?: ResolveAgentAiSettingsInput["explicit"];
  targetWorkspaceSettings?: AgentAiSettingsLayerValues;
  parentRuntime?: AgentAiSettingsLayerValues;
}

/**
 * Detailed variant returning the full resolver result; callers such as ACP
 * /compact supply additional tiers (explicit command flags, the workspace's
 * compact bucket, the live session settings as parent runtime).
 */
export async function resolveAcpAgentAiSettings(
  client: ORPCClient,
  agentId: string,
  workspaceId?: string,
  extras?: AcpResolveExtras
): Promise<ResolvedAgentAiSettings> {
  const trimmedAgentId = agentId.trim();
  assert(trimmedAgentId.length > 0, "resolveAgentAiSettings: agentId must be non-empty");

  const [config, agents] = await Promise.all([
    client.config.getConfig(),
    client.agents.list(buildAgentsListInput(workspaceId)),
  ]);

  const agentDef = agents.find((agent) => agent.id === trimmedAgentId);
  const agentDefsById = new Map<string, AgentAncestorDescriptor>(
    agents.map((agent) => [agent.id, { base: agent.base, definitionAiDefaults: agent.aiDefaults }])
  );

  return resolveAgentAiSettingsShared({
    targetAgentId: trimmedAgentId,
    profile: "interactive",
    explicit: extras?.explicit,
    targetWorkspaceSettings: extras?.targetWorkspaceSettings,
    agentAiDefaults: config.agentAiDefaults,
    targetDefinitionAiDefaults: agentDef?.aiDefaults,
    ancestors: collectDeclaredAncestorLayers(trimmedAgentId, agentDefsById),
    parentRuntime: extras?.parentRuntime,
  });
}

export async function resolveAgentAiSettings(
  client: ORPCClient,
  agentId: string,
  workspaceId?: string
): Promise<ResolvedAiSettings> {
  const resolved = await resolveAcpAgentAiSettings(client, agentId, workspaceId);
  return {
    model: resolved.selected.model,
    thinkingLevel: resolved.selected.thinkingLevel,
    ...(resolved.selected.reasoningMode != null
      ? { reasoningMode: resolved.selected.reasoningMode }
      : {}),
  };
}

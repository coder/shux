import { AgentIdSchema } from "@/common/schemas/ids";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

const REMOVED_BUILTIN_AGENT_FALLBACKS: Readonly<Record<string, string>> = {
  ask: WORKSPACE_DEFAULTS.agentId,
  auto: WORKSPACE_DEFAULTS.agentId,
  mux: WORKSPACE_DEFAULTS.agentId,
};

export function normalizeAgentId(
  value: unknown,
  fallback: string = WORKSPACE_DEFAULTS.agentId
): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return fallback;
  }

  return normalized;
}

export function resolvePersistedAgentIdCandidates(
  value: { agentId?: unknown; agentType?: unknown; parentWorkspaceId?: unknown } | undefined
): string[] {
  if (value == null) {
    return [];
  }

  // Legacy task/workspace records may only have agentType. For child task workspaces,
  // agentType is the creation-time identity while agentId may be restamped by recovery sends.
  // Coerce and validate each field independently so blank or corrupt values cannot mask a valid value.
  const candidateFields =
    value.parentWorkspaceId == null
      ? [value.agentId, value.agentType]
      : [value.agentType, value.agentId];
  const candidates = candidateFields.map(normalizePersistedAgentCandidate);
  return candidates.filter(
    (candidate, index): candidate is string =>
      candidate != null && candidates.indexOf(candidate) === index
  );
}

export function resolvePersistedAgentId(
  value: { agentId?: unknown; agentType?: unknown; parentWorkspaceId?: unknown } | undefined,
  fallback: string = WORKSPACE_DEFAULTS.agentId
): string {
  return resolvePersistedAgentIdCandidates(value)[0] ?? fallback;
}

export function normalizePersistedAgentCandidate(value: unknown): string | undefined {
  const normalized = normalizeAgentId(value, "");
  return AgentIdSchema.safeParse(normalized).success ? normalized : undefined;
}

export function resolveRemovedBuiltinAgentId(
  value: unknown,
  availableAgentIds: Iterable<string>,
  fallback: string = WORKSPACE_DEFAULTS.agentId
): string {
  const normalized = normalizeAgentId(value, fallback);
  const replacement = REMOVED_BUILTIN_AGENT_FALLBACKS[normalized];
  if (!replacement) {
    return normalized;
  }

  for (const candidate of availableAgentIds) {
    if (normalizeAgentId(candidate, "") === normalized) {
      return normalized;
    }
  }

  return replacement;
}

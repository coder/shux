import type {
  AgentAiDefaults,
  AgentAiDefaultsEntry,
  AgentAiSubagentProfile,
  SubagentAiDefaults,
} from "@/common/config/schemas/appConfigOnDisk";
import { AgentIdSchema } from "@/common/orpc/schemas";
import { normalizeAgentId } from "@/common/utils/agentIds";
import { coerceOpenAIReasoningMode, coerceThinkingLevel, type ThinkingLevel } from "./thinking";

export type { AgentAiDefaults, AgentAiDefaultsEntry, AgentAiSubagentProfile };

const SUBAGENT_PROFILE_FIELDS = ["modelString", "thinkingLevel", "reasoningMode"] as const;

function normalizeProfileFields(entry: Record<string, unknown>): AgentAiSubagentProfile {
  const modelString =
    typeof entry.modelString === "string" && entry.modelString.trim().length > 0
      ? entry.modelString.trim()
      : undefined;

  const thinkingLevel: ThinkingLevel | undefined = coerceThinkingLevel(entry.thinkingLevel);
  const reasoningMode = coerceOpenAIReasoningMode(entry.reasoningMode);

  return { modelString, thinkingLevel, reasoningMode };
}

function isEmptyProfile(profile: AgentAiSubagentProfile): boolean {
  return SUBAGENT_PROFILE_FIELDS.every((field) => profile[field] === undefined);
}

/**
 * Drops delegated fields equal to the base profile: the delegated profile is a
 * sparse diff, so equal values must fall through to the base at read time
 * instead of freezing a copy that a later base edit would silently miss.
 * Explicit canonical Exec fields are exempt: absence inherits from the calling
 * chat before the global profile. Legacy-only mirrors retain their old cleanup.
 */
function pruneSubagentProfile(
  profile: AgentAiSubagentProfile,
  base: AgentAiDefaultsEntry,
  explicitFields?: AgentAiSubagentProfile
): AgentAiSubagentProfile | undefined {
  const pruned: AgentAiSubagentProfile = { ...profile };
  for (const field of SUBAGENT_PROFILE_FIELDS) {
    if (explicitFields?.[field] === undefined && pruned[field] === base[field]) {
      delete pruned[field];
    }
  }
  return isEmptyProfile(pruned) ? undefined : pruned;
}

export function normalizeAgentAiDefaults(raw: unknown): AgentAiDefaults {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : ({} as const);

  const result: AgentAiDefaults = {};

  for (const [agentIdRaw, entryRaw] of Object.entries(record)) {
    const agentId = normalizeAgentId(agentIdRaw, "");
    if (!agentId) continue;
    if (!AgentIdSchema.safeParse(agentId).success) continue;
    if (!entryRaw || typeof entryRaw !== "object") continue;

    const entry = entryRaw as Record<string, unknown>;
    const base = normalizeProfileFields(entry);

    const enabled = typeof entry.enabled === "boolean" ? entry.enabled : undefined;
    const advisorEnabled =
      typeof entry.advisorEnabled === "boolean" ? entry.advisorEnabled : undefined;

    const normalized: AgentAiDefaultsEntry = { ...base, enabled, advisorEnabled };

    if (entry.subagent && typeof entry.subagent === "object" && !Array.isArray(entry.subagent)) {
      const profile = normalizeProfileFields(entry.subagent as Record<string, unknown>);
      const subagent = pruneSubagentProfile(
        profile,
        normalized,
        agentId === "exec" ? profile : undefined
      );
      if (subagent) {
        normalized.subagent = subagent;
      }
    }

    if (
      isEmptyProfile(normalized) &&
      enabled === undefined &&
      advisorEnabled === undefined &&
      normalized.subagent === undefined
    ) {
      continue;
    }

    result[agentId] = normalized;
  }

  return result;
}

function normalizeLegacySubagentAiDefaults(raw: unknown): SubagentAiDefaults {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : ({} as const);

  const result: SubagentAiDefaults = {};
  for (const [agentIdRaw, entryRaw] of Object.entries(record)) {
    const agentId = normalizeAgentId(agentIdRaw, "");
    if (!agentId) continue;
    if (!AgentIdSchema.safeParse(agentId).success) continue;
    if (!entryRaw || typeof entryRaw !== "object") continue;

    const profile = normalizeProfileFields(entryRaw as Record<string, unknown>);
    if (isEmptyProfile(profile)) continue;
    result[agentId] = profile;
  }
  return result;
}

/**
 * Folds a legacy root `subagentAiDefaults` map into the canonical nested
 * `subagent` profiles. Canonical nested fields win when both exist (the legacy
 * map is a projection derived from them); legacy-only delegated data is
 * preserved under `.subagent` rather than promoted to the interactive profile.
 */
export function mergeLegacySubagentAiDefaults(
  agentAiDefaults: AgentAiDefaults,
  rawLegacySubagentAiDefaults: unknown
): AgentAiDefaults {
  const legacyEntries = Object.entries(
    normalizeLegacySubagentAiDefaults(rawLegacySubagentAiDefaults)
  );
  if (legacyEntries.length === 0) {
    return agentAiDefaults;
  }

  const result: AgentAiDefaults = { ...agentAiDefaults };
  for (const [agentId, legacyEntry] of legacyEntries) {
    const base: AgentAiDefaultsEntry = result[agentId] ? { ...result[agentId] } : {};
    const merged: AgentAiSubagentProfile = { ...base.subagent };
    merged.modelString ??= legacyEntry.modelString;
    merged.thinkingLevel ??= legacyEntry.thinkingLevel;
    merged.reasoningMode ??= legacyEntry.reasoningMode;
    const pruned = pruneSubagentProfile(
      merged,
      base,
      agentId === "exec" ? base.subagent : undefined
    );
    if (pruned) {
      base.subagent = pruned;
    } else {
      delete base.subagent;
    }
    if (base.subagent !== undefined || result[agentId] !== undefined) {
      result[agentId] = base;
    }
  }
  return result;
}

/**
 * One-way disk projection for downgrade compatibility. Older builds resolve
 * delegated runs from the root `subagentAiDefaults` map (field-wise, with
 * `agentAiDefaults` fallback), so we emit the effective delegated profile for
 * mirrored agents and sparse overrides for the excluded built-ins (plan, exec,
 * compact) that older builds treat as canonical delegated storage.
 */
export function deriveLegacySubagentAiDefaultsProjection(
  agentAiDefaults: AgentAiDefaults
): SubagentAiDefaults {
  const projection: SubagentAiDefaults = {};
  for (const [agentId, entry] of Object.entries(agentAiDefaults)) {
    if (agentId === "plan" || agentId === "compact") {
      // Parity with older builds, which never mirrored these into the legacy map.
      continue;
    }
    if (agentId === "exec") {
      if (entry.subagent && !isEmptyProfile(entry.subagent)) {
        projection.exec = { ...entry.subagent };
      }
      continue;
    }
    const effective: AgentAiSubagentProfile = {
      modelString: entry.subagent?.modelString ?? entry.modelString,
      thinkingLevel: entry.subagent?.thinkingLevel ?? entry.thinkingLevel,
      reasoningMode: entry.subagent?.reasoningMode ?? entry.reasoningMode,
    };
    if (!isEmptyProfile(effective)) {
      projection[agentId] = effective;
    }
  }
  return projection;
}

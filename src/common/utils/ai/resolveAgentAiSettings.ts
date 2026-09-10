/**
 * Pure field-wise resolver for agent AI settings (model, thinkingLevel,
 * reasoningMode). Every execution surface resolves through this one precedence
 * order; adapters differ only in which input tiers they supply:
 *
 *   1. explicit invocation overrides
 *   2. target workspace per-agent bucket
 *   3. target configured profile (delegated `subagent` override, then calling
 *      workspace Exec settings for Exec sub-agents only, then base)
 *   4. target definition frontmatter `ai` defaults
 *   5. declared ancestors child to root (config profile, then definition
 *      defaults), then the implicit plan/exec fallback (reasoningMode only)
 *   6. parent runtime hint
 *   7. root workspace / activity fallbacks
 *   8. system fallback (default model, thinking off, no reasoning preference)
 *
 * Each field resolves independently: a model-only value at a higher tier never
 * blocks thinking or reasoning from lower tiers. Invalid persisted/config
 * candidates fall through with a diagnostic (self-healing); invalid explicit
 * values throw so callers surface an error instead of silently running a
 * fallback model. No I/O, no logging.
 */

import { DEFAULT_MODEL } from "@/common/constants/knownModels";
import type {
  AgentAiSettingsLayerValues,
  AiSettingSource,
  ResolveAgentAiSettingsInput,
  ResolvedAgentAiSettings,
} from "@/common/types/agentAiSettings";
import {
  coerceOpenAIReasoningMode,
  coerceThinkingLevel,
  type OpenAIReasoningMode,
  type ThinkingLevel,
} from "@/common/types/thinking";
import { normalizeModelInput } from "@/common/utils/ai/normalizeModelInput";
import { openaiProModeAvailable } from "@/common/utils/ai/proMode";
import {
  enforceThinkingPolicy,
  lookupMinThinkingLevelOverride,
  resolveMinimumThinkingLevel,
  resolveThinkingInput,
} from "@/common/utils/thinking/policy";

export class InvalidExplicitAiSettingError extends Error {
  readonly field: "model";
  readonly value: string;

  constructor(field: "model", value: string) {
    super(`Invalid explicit ${field}: "${value}"`);
    this.name = "InvalidExplicitAiSettingError";
    this.field = field;
    this.value = value;
  }
}

/**
 * The implicit base an agent falls back to when its declared chain ends:
 * plan stays plan (no fallback), everything else falls back to exec.
 */
export function implicitBaseAgentId(agentId: string): string {
  return agentId === "plan" ? "plan" : "exec";
}

interface Candidate {
  values: AgentAiSettingsLayerValues;
  source: AiSettingSource;
  /** The implicit fallback ancestor inherits reasoningMode only. */
  reasoningOnly?: boolean;
}

function buildCandidates(input: ResolveAgentAiSettingsInput): Candidate[] {
  const candidates: Candidate[] = [];
  const defaults = input.agentAiDefaults ?? {};

  if (input.targetWorkspaceSettings) {
    candidates.push({
      values: input.targetWorkspaceSettings,
      source: { tier: "workspace", agentId: input.targetAgentId },
    });
  }

  const pushConfig = (agentId: string, reasoningOnly: boolean) => {
    const entry = defaults[agentId];
    if (input.profile === "subagent" && entry?.subagent) {
      candidates.push({
        values: {
          model: entry.subagent.modelString,
          thinkingLevel: entry.subagent.thinkingLevel,
          reasoningMode: entry.subagent.reasoningMode,
        },
        source: { tier: "config-subagent", agentId },
        reasoningOnly,
      });
    }
    // A chat's Exec choice outranks global defaults, but never explicit child
    // overrides. Do not promote this context for Exec-derived custom agents.
    if (
      input.profile === "subagent" &&
      input.targetAgentId === "exec" &&
      agentId === "exec" &&
      input.parentWorkspaceExecSettings
    ) {
      candidates.push({
        values: input.parentWorkspaceExecSettings,
        source: { tier: "parent-workspace-exec", agentId: "exec" },
      });
    }
    if (!entry) return;
    candidates.push({
      values: {
        model: entry.modelString,
        thinkingLevel: entry.thinkingLevel,
        reasoningMode: entry.reasoningMode,
      },
      source: { tier: "config", agentId },
      reasoningOnly,
    });
  };

  pushConfig(input.targetAgentId, false);

  if (input.targetDefinitionAiDefaults) {
    candidates.push({
      values: {
        model: input.targetDefinitionAiDefaults.model,
        thinkingLevel: input.targetDefinitionAiDefaults.thinkingLevel,
      },
      source: { tier: "definition", agentId: input.targetAgentId },
    });
  }

  const chainIds = new Set<string>([input.targetAgentId]);
  for (const ancestor of input.ancestors ?? []) {
    if (chainIds.has(ancestor.agentId)) continue;
    chainIds.add(ancestor.agentId);
    pushConfig(ancestor.agentId, false);
    if (ancestor.definitionAiDefaults) {
      candidates.push({
        values: {
          model: ancestor.definitionAiDefaults.model,
          thinkingLevel: ancestor.definitionAiDefaults.thinkingLevel,
        },
        source: { tier: "definition", agentId: ancestor.agentId },
      });
    }
  }

  // A chain terminus without a declared base still falls back to the default
  // base, contributing reasoningMode only: switching to an unconfigured agent
  // inherits pro/standard without yanking model or thinking to the fallback
  // agent's configured defaults.
  const terminus = input.ancestors?.at(-1)?.agentId ?? input.targetAgentId;
  const fallback = implicitBaseAgentId(terminus);
  if (!chainIds.has(fallback)) {
    pushConfig(fallback, true);
  }

  if (input.parentRuntime) {
    candidates.push({ values: input.parentRuntime, source: { tier: "parent-runtime" } });
  }

  for (const fallbackLayer of input.fallbacks ?? []) {
    candidates.push({ values: fallbackLayer, source: { tier: "fallback" } });
  }

  return candidates;
}

/** First candidate whose field survives coercion wins; invalid values fall through. */
function pickField<T>(
  candidates: readonly Candidate[],
  field: "model" | "thinkingLevel" | "reasoningMode",
  coerce: (raw: unknown) => T | undefined,
  diagnostics: string[]
): { value: T; source: AiSettingSource } | undefined {
  for (const candidate of candidates) {
    if (candidate.reasoningOnly && field !== "reasoningMode") continue;
    const raw = candidate.values[field];
    if (raw === undefined) continue;
    const coerced = coerce(raw);
    if (coerced === undefined) {
      diagnostics.push(`skipped invalid ${field} "${String(raw)}" from ${candidate.source.tier}`);
      continue;
    }
    return { value: coerced, source: candidate.source };
  }
  return undefined;
}

function coerceModel(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  return normalizeModelInput(raw).model ?? undefined;
}

export function resolveAgentAiSettings(
  input: ResolveAgentAiSettingsInput
): ResolvedAgentAiSettings {
  const diagnostics: string[] = [];
  const candidates = buildCandidates(input);
  const providersConfig = input.providersConfig ?? null;

  // --- model ---
  let model: { value: string; source: AiSettingSource } | undefined;
  const explicitModel =
    typeof input.explicit?.model === "string" && input.explicit.model.trim().length > 0
      ? input.explicit.model
      : undefined;
  if (explicitModel !== undefined) {
    const normalized = normalizeModelInput(explicitModel).model;
    if (normalized == null) {
      throw new InvalidExplicitAiSettingError("model", explicitModel);
    }
    model = { value: normalized, source: { tier: "explicit" } };
  } else {
    model = pickField(candidates, "model", coerceModel, diagnostics);
  }
  model ??= {
    value: normalizeModelInput(input.defaultModel).model ?? DEFAULT_MODEL,
    source: { tier: "default" },
  };

  // --- thinkingLevel (numeric explicit input maps into the resolved model's policy) ---
  let thinking: { value: ThinkingLevel; source: AiSettingSource } | undefined;
  if (input.explicit?.thinkingLevel != null) {
    thinking = {
      value: resolveThinkingInput(input.explicit.thinkingLevel, model.value, providersConfig),
      source: { tier: "explicit" },
    };
  } else {
    thinking = pickField(candidates, "thinkingLevel", coerceThinkingLevel, diagnostics);
  }
  thinking ??= { value: "off", source: { tier: "default" } };

  // --- reasoningMode ---
  let reasoning: { value: OpenAIReasoningMode; source: AiSettingSource } | undefined;
  if (input.explicit?.reasoningMode != null) {
    reasoning = { value: input.explicit.reasoningMode, source: { tier: "explicit" } };
  } else {
    reasoning = pickField(candidates, "reasoningMode", coerceOpenAIReasoningMode, diagnostics);
  }

  // --- effective values (provider-safe) ---
  const minThinkingFloor = resolveMinimumThinkingLevel(
    model.value,
    lookupMinThinkingLevelOverride(input.minThinkingLevelByModel, model.value),
    providersConfig
  );
  const effectiveThinking = enforceThinkingPolicy(
    model.value,
    thinking.value,
    minThinkingFloor,
    providersConfig
  );

  const proAvailable =
    input.proModeAvailable ?? openaiProModeAvailable(model.value, { providersConfig });
  const effectiveReasoning =
    reasoning?.value === "pro" && !proAvailable ? undefined : reasoning?.value;

  return {
    selected: {
      model: model.value,
      thinkingLevel: thinking.value,
      ...(reasoning !== undefined ? { reasoningMode: reasoning.value } : {}),
    },
    effective: {
      model: model.value,
      thinkingLevel: effectiveThinking,
      ...(effectiveReasoning !== undefined ? { reasoningMode: effectiveReasoning } : {}),
    },
    sources: {
      model: model.source,
      thinkingLevel: thinking.source,
      ...(reasoning !== undefined ? { reasoningMode: reasoning.source } : {}),
    },
    diagnostics,
  };
}

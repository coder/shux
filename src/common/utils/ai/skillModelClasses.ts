import type { ProvidersConfigMap } from "@/common/orpc/types";
import {
  parseThinkingInput,
  type ParsedThinkingInput,
  type ThinkingLevel,
} from "@/common/types/thinking";
import { normalizeModelInput } from "@/common/utils/ai/normalizeModelInput";
import { resolveThinkingInput } from "@/common/utils/thinking/policy";

/**
 * Skill frontmatter `metadata` key naming the model class a skill prefers to
 * run on (e.g. `metadata: { model-class: small }`). The spec-standard metadata
 * map is used instead of a new frontmatter field so skills stay portable:
 * other agent tools ignore unknown metadata entries, and mux already parses
 * and preserves the map.
 */
export const SKILL_MODEL_CLASS_METADATA_KEY = "model-class";

export interface ModelClassTarget {
  model: string;
  /** Deferred: numeric indices are model-relative until resolved. */
  thinkingLevel?: ParsedThinkingInput;
}

/**
 * Parse a `modelClasses` config value. Values use the one-shot override
 * syntax: a model alias or full "provider:model" id with an optional
 * `+thinking` suffix ("haiku+0", "sonnet+high", "anthropic:claude-fable-5+max").
 *
 * Unlike the composer's one-shot key parser (which only accepts known aliases
 * so unknown slash commands aren't swallowed), full model ids are accepted
 * here — config values are explicit user intent with no shadowing risk.
 *
 * Returns null when the model or thinking part is invalid (callers fail open).
 */
export function parseModelClassValue(value: string): ModelClassTarget | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const { modelPart, thinkingSuffix } = splitModelClassValue(trimmed);

  const normalized = normalizeModelInput(modelPart);
  if (normalized.model == null) {
    return null;
  }

  if (thinkingSuffix == null) {
    return { model: normalized.model };
  }

  const thinkingLevel = parseThinkingInput(thinkingSuffix);
  if (thinkingLevel == null) {
    return null;
  }

  return { model: normalized.model, thinkingLevel };
}

/**
 * Split a class value into its model part and raw thinking suffix.
 *
 * Custom providers can expose model ids that themselves contain "+"
 * (proxy:model+v2), so the suffix is the text after the LAST "+" and only
 * when it parses as a thinking token (named level or numeric index) —
 * otherwise the whole string is the model. A model id whose final segment
 * happens to look like a thinking token (proxy:model+2) resolves toward the
 * suffix reading; bind such a model by adding an explicit level
 * (proxy:model+2+low) or renaming the exposed id. Editors preserve the raw
 * suffix across model changes so a model-relative numeric level
 * ("+0" = lowest allowed) keeps its meaning on the new model.
 */
export function splitModelClassValue(value: string): {
  modelPart: string;
  thinkingSuffix: string | null;
} {
  const plusIndex = value.lastIndexOf("+");
  if (plusIndex === -1) {
    return { modelPart: value, thinkingSuffix: null };
  }
  const candidate = value.slice(plusIndex + 1);
  if (parseThinkingInput(candidate) == null) {
    // Not a thinking token: the "+" belongs to the model id itself.
    return { modelPart: value, thinkingSuffix: null };
  }
  return { modelPart: value.slice(0, plusIndex), thinkingSuffix: candidate };
}

/** Inverse of splitModelClassValue: build a `model[+thinking]` class value. */
export function buildModelClassValue(model: string, thinkingSuffix: string | null): string {
  return thinkingSuffix ? `${model}+${thinkingSuffix}` : model;
}

/**
 * Class names surfaced as fixed slots in the Settings → Models editor. The
 * config map accepts arbitrary names (hand-edited custom classes are preserved
 * and keep routing), but skills are portable across machines only when they
 * bind to this shared vocabulary.
 */
export const CANONICAL_MODEL_CLASSES = ["large", "medium", "small"] as const;

export type SkillModelClassBinding =
  | { status: "unbound" }
  | { status: "unknown-class"; className: string }
  | { status: "invalid-value"; className: string; value: string }
  | { status: "resolved"; className: string; model: string; thinkingLevel?: ThinkingLevel };

/**
 * Resolve the model-class binding for a slash-invoked skill.
 *
 * Class-binding precedence: the config-side routing table
 * (`skillModelClasses[skillName]`) wins over the skill's own frontmatter
 * `metadata["model-class"]` — local config is explicit user intent and works
 * for skills the user does not own.
 *
 * Broken bindings are reported, not swallowed: a bound skill whose class is
 * missing or malformed returns a distinct status so callers can raise an
 * actionable error instead of silently running on an unintended (possibly
 * expensive) model. One deliberate exception: frontmatter bindings are inert
 * while the user has no `modelClasses` configured at all — skills shipping
 * `metadata: model-class` must not break for users who never opted into model
 * classes. A config-table binding is explicit local intent and always counts.
 */
export function resolveSkillModelClassBinding(args: {
  skillName: string;
  frontmatterMetadata?: Record<string, string>;
  modelClasses?: Record<string, string>;
  skillModelClasses?: Record<string, string>;
  providersConfig?: ProvidersConfigMap | null;
}): SkillModelClassBinding {
  const tableClass = args.skillModelClasses?.[args.skillName];
  const boundViaTable = typeof tableClass === "string" && tableClass.trim().length > 0;
  const rawClass = boundViaTable
    ? tableClass
    : args.frontmatterMetadata?.[SKILL_MODEL_CLASS_METADATA_KEY];
  const className = typeof rawClass === "string" ? rawClass.trim() : "";
  if (!className) {
    return { status: "unbound" };
  }

  const modelClasses = args.modelClasses ?? {};
  const classValue = modelClasses[className];
  if (typeof classValue !== "string") {
    // A frontmatter binding to a class the user never defined stays inert:
    // skills the user does not own must not start failing sends just because
    // some other class got configured (partial configuration is the normal
    // state of the three-slot editor). A config-table binding is the user's
    // own explicit routing intent, so a dangling table entry errors loudly.
    // Bindings to a class that EXISTS but is broken (invalid value,
    // unavailable model) always error — that is the churn signal this
    // feature exists to surface.
    if (!boundViaTable) {
      return { status: "unbound" };
    }
    return { status: "unknown-class", className };
  }

  const target = parseModelClassValue(classValue);
  if (!target) {
    return { status: "invalid-value", className, value: classValue };
  }

  // Numeric thinking indices are model-relative; resolve to a concrete level
  // now. Downstream enforceThinkingPolicy still clamps (min-thinking floors).
  const thinkingLevel =
    target.thinkingLevel != null
      ? resolveThinkingInput(target.thinkingLevel, target.model, args.providersConfig)
      : undefined;

  return {
    status: "resolved",
    className,
    model: target.model,
    ...(thinkingLevel != null ? { thinkingLevel } : {}),
  };
}

export type SkillModelClassRoutingProblem =
  | { kind: "unknown-class"; skillName: string; className: string }
  | { kind: "invalid-value"; skillName: string; className: string; value: string }
  | { kind: "model-unavailable"; skillName: string; className: string; model: string };

/**
 * User-facing message for a broken skill model-class binding. The copy always
 * names the fix location and the one-shot bypass so a stale mapping never
 * strands the user.
 */
export function describeSkillModelClassRoutingProblem(
  problem: SkillModelClassRoutingProblem
): string {
  const fixHint = `Update it in Settings → Models → Model Classes, or bypass routing with a one-shot override (e.g. "/sonnet /${problem.skillName}").`;
  switch (problem.kind) {
    case "unknown-class":
      return `Skill "${problem.skillName}" is bound to model class "${problem.className}", but no class with that name is configured. ${fixHint}`;
    case "invalid-value":
      return `Model class "${problem.className}" (used by skill "${problem.skillName}") has an invalid value "${problem.value}". ${fixHint}`;
    case "model-unavailable":
      return `Model class "${problem.className}" (used by skill "${problem.skillName}") maps to "${problem.model}", but no configured provider route can serve it. ${fixHint}`;
  }
}

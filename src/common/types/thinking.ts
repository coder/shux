/**
 * Thinking/Reasoning level types and mappings for AI models
 *
 * This module provides a unified interface for controlling reasoning across
 * different AI providers (Anthropic, OpenAI, etc.)
 */

import { z } from "zod";

export const THINKING_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const ThinkingLevelSchema = z.enum(THINKING_LEVELS);

/**
 * User-facing display labels for thinking levels.
 * Used in CLI help text and UI display.
 */
export const THINKING_DISPLAY_LABELS: Record<ThinkingLevel, string> = {
  off: "OFF",
  low: "LOW",
  medium: "MED",
  high: "HIGH",
  xhigh: "MAX",
  max: "MAX",
};

/**
 * Display label for thinking levels, with provider-aware xhigh labeling.
 *
 * Models with a native "xhigh" effort level (OpenAI, Anthropic Opus 4.7+,
 * Anthropic Sonnet 5+) show "XHIGH" for the xhigh ThinkingLevel; on those
 * providers xhigh and max are distinct. On Opus/Sonnet 4.6 (where xhigh maps
 * to max effort), it shows "MAX".
 * Medium always displays as "MED".
 */
export function getThinkingDisplayLabel(level: ThinkingLevel, modelString?: string): string {
  if ((level === "xhigh" || level === "max") && modelString) {
    const normalized = modelString.trim().toLowerCase();
    const withoutPrefix = normalized.replace(/^[a-z0-9_-]+:\s*/, "");

    // OpenAI: both xhigh and max resolve to "xhigh" reasoning effort — except
    // native-max models (GPT-5.6 family, GPT-6 Astra), where "max" is a distinct
    // native effort above xhigh.
    if (normalized.startsWith("openai:") || withoutPrefix.startsWith("openai/")) {
      if (level === "max" && openaiSupportsNativeMaxEffort(modelString)) return "MAX";
      return "XHIGH";
    }

    // Anthropic Opus 4.7+: xhigh is a distinct effort level from max
    if (level === "xhigh" && anthropicSupportsNativeXhigh(modelString)) return "XHIGH";

    // Grok 4.6: xhigh is a distinct native reasoning effort (its policy has no max).
    if (level === "xhigh" && isGrok46Model(modelString)) return "XHIGH";
  }
  return THINKING_DISPLAY_LABELS[level];
}

/**
 * UI option label for thinking levels.
 *
 * Settings dropdowns use lowercase labels for most levels, but xhigh/max should
 * remain provider-aware to match the model's terminology.
 */
export function getThinkingOptionLabel(level: ThinkingLevel, modelString?: string): string {
  if (level !== "xhigh" && level !== "max") {
    return level;
  }

  return getThinkingDisplayLabel(level, modelString) === "XHIGH" ? "xhigh" : "max";
}

/**
 * Reverse mapping from display labels/aliases to internal ThinkingLevel values.
 * Accepts both canonical names and shorthand aliases (e.g., "med" → "medium").
 */
const DISPLAY_LABEL_TO_LEVEL: Record<string, ThinkingLevel> = {
  off: "off",
  low: "low",
  med: "medium",
  high: "high",
  max: "max",
  xhigh: "xhigh",
  medium: "medium",
};

/**
 * Result of parsing a thinking level input. Named levels resolve to a
 * ThinkingLevel string immediately; numeric indices are deferred and
 * resolved against the target model's thinking policy at send time
 * (since different models have different allowed level sets).
 */
export type ParsedThinkingInput = ThinkingLevel | number;

/**
 * Maximum numeric thinking index (inclusive). Indices 0–N map to
 * the model's allowed levels sorted from lowest to highest.
 * Kept generous — out-of-range indices are clamped to the model's max.
 */
export const MAX_THINKING_INDEX = 9;

/**
 * Parse a thinking level from user input — accepts both named levels
 * ("off", "low", "med", "medium", "high", "max", "xhigh") and numeric
 * indices (0–N). Named levels resolve immediately; numeric indices are
 * returned as numbers for model-aware resolution later via
 * `resolveThinkingInput()` in policy.ts.
 *
 * Used by both `mux run --thinking` and `/model+level` oneshot.
 */
export function parseThinkingInput(value: string): ParsedThinkingInput | undefined {
  const normalized = value.trim().toLowerCase();

  // Named level first (e.g., "off", "low", "med", "high", "max", "xhigh")
  const named = DISPLAY_LABEL_TO_LEVEL[normalized];
  if (named) return named;

  // Numeric index — resolved later against the model's thinking policy
  // (e.g., 0 = lowest allowed level, which is "medium" for gpt-5.5-pro)
  const num = parseInt(normalized, 10);
  if (!Number.isNaN(num) && String(num) === normalized && num >= 0 && num <= MAX_THINKING_INDEX) {
    return num;
  }

  return undefined;
}

/**
 * Active thinking levels (excludes "off")
 * Used for storing/restoring the last-used thinking level per model
 */
export type ThinkingLevelOn = Exclude<ThinkingLevel, "off">;

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

/**
 * Synonym aliases for CLI/UI input: "med" → "medium".
 * "xhigh" and "max" are both first-class ThinkingLevel values (not synonyms).
 */
export const THINKING_LEVEL_SYNONYMS: Readonly<Record<string, ThinkingLevel>> = {
  med: "medium",
};

export function coerceThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (typeof value !== "string") return undefined;
  const synonym = THINKING_LEVEL_SYNONYMS[value];
  if (synonym) return synonym;
  return isThinkingLevel(value) ? value : undefined;
}

/**
 * Anthropic thinking token budget mapping
 *
 * These heuristics balance thinking depth with response time and cost.
 * Used for models that support extended thinking with budgetTokens
 * (e.g., Sonnet 4.5, Haiku 4.5, Opus 4.1, etc.)
 *
 * - off: No extended thinking
 * - low: Quick thinking for straightforward tasks (4K tokens)
 * - medium: Standard thinking for moderate complexity (10K tokens)
 * - high: Deep thinking for complex problems (20K tokens)
 */
export const ANTHROPIC_THINKING_BUDGETS: Record<ThinkingLevel, number> = {
  off: 0,
  low: 4000,
  medium: 10000,
  high: 20000,
  xhigh: 20000, // Same as high - budget ceiling; effort: "max" controls depth
  max: 20000,
};

/**
 * Anthropic effort type - matches SDK's AnthropicProviderOptions["effort"].
 */
export type AnthropicEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Anthropic effort parameter mapping (Opus 4.5+)
 *
 * The effort parameter controls how much computational work the model applies.
 * - Opus 4.5 supports: low, medium, high (policy clamps xhigh → high)
 * - Opus 4.6 supports: low, medium, high, max (xhigh maps to "max" effort)
 * - Opus 4.7+ and Sonnet 5+ support: low, medium, high, xhigh, max (native xhigh)
 *
 * The table keeps `xhigh: "max"` as the non-native fallback; `getAnthropicEffort`
 * upgrades it to the native "xhigh" wire value on models that support it.
 *
 * SDK coupling note: explicit `providerOptions.anthropic.effort` values flow
 * verbatim into `output_config.effort` as of @ai-sdk/anthropic 4.0.11 (its Zod
 * schema accepts "xhigh"; its `supportsXhighEffort` model gating applies only to
 * the SDK's top-level `reasoning` CallOption mapping, which Xum does not use).
 * Re-verify this pass-through on major SDK upgrades.
 */
const ANTHROPIC_EFFORT: Record<ThinkingLevel, AnthropicEffortLevel> = {
  off: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max", // Non-native fallback; native-xhigh models get "xhigh" via getAnthropicEffort
  max: "max",
};

/**
 * Model-aware Anthropic effort resolution: `xhigh` maps to the native "xhigh"
 * wire value only on models that support it (Opus 4.7+, Sonnet 5+, Mythos);
 * everywhere else it falls back to "max" per the table above.
 */
export function getAnthropicEffort(
  level: ThinkingLevel,
  capabilityModel: string
): AnthropicEffortLevel {
  if (level === "xhigh" && anthropicSupportsNativeXhigh(capabilityModel)) {
    return "xhigh";
  }
  return ANTHROPIC_EFFORT[level];
}

/**
 * Normalize a model string to its bare model id for capability matching:
 * trims, lowercases, and strips both a `provider:` prefix (e.g. `anthropic:`)
 * and a `namespace/` segment (e.g. gateway-wrapped `openai/gpt-5.5-pro`).
 *
 * Kept in one place so capability predicates that key off the bare id
 * (see `anthropicSupportsNativeXhigh` and the thinking policy resolver) stay
 * consistent about how provider prefixes and gateway namespaces are removed.
 */
export function stripModelProviderPrefixes(modelString: string): string {
  return modelString
    .trim()
    .toLowerCase()
    .replace(/^[a-z0-9_-]+:\s*/, "")
    .replace(/^[a-z0-9_-]+\//, "");
}

/**
 * Whether the given Anthropic model supports the native "xhigh" API effort level
 * (distinct from "max").
 *
 * Matches:
 * - `claude-opus-4-7`, `claude-opus-4-8`, ... `claude-opus-4-99`, and any Opus 5+.
 * - `claude-sonnet-5` and any future Sonnet 5+ (Sonnet 5 introduced native xhigh effort for
 *   the Sonnet tier; Sonnet 4.6 and earlier did not).
 * - Mythos-class models (`claude-fable-*`, `claude-mythos-*`), the tier above Opus.
 */
export function anthropicSupportsNativeXhigh(modelString: string): boolean {
  const withoutPrefix = stripModelProviderPrefixes(modelString);
  // Opus 4.7+ (4-7, 4-8, 4-9, 4-10, 4-11, ...) or any Opus 5+, Sonnet 5+ (5, 6, ... 10+),
  // plus the Mythos-class Fable / Mythos models that sit above Opus.
  return (
    /claude-opus-(?:4-(?:[7-9]|\d{2,})|[5-9]|\d{2,})/.test(withoutPrefix) ||
    /claude-sonnet-(?:[5-9]|\d{2,})/.test(withoutPrefix) ||
    /claude-(?:fable|mythos)-/.test(withoutPrefix)
  );
}

/**
 * GPT-5.6 family matcher: the bare `gpt-5.6` alias (OpenAI routes it to Sol)
 * plus the Sol/Terra/Luna tiers. The `\b` + lookaheads tolerate version-date
 * suffixes (e.g. gpt-5.6-sol-2026-07-09) while rejecting hypothetical named
 * variants (e.g. gpt-5.6-sol-mini) and other ids (e.g. gpt-5.61).
 */
export function isGpt56FamilyModel(modelString: string): boolean {
  const withoutPrefix = stripModelProviderPrefixes(modelString);
  return /^gpt-5\.6(?:-(?:sol|terra|luna))?\b(?!\.)(?!-[a-z])/.test(withoutPrefix);
}

/**
 * GPT-6 Astra matcher (released September 3, 2026 under the API id
 * `gpt-6-astra`; there is no bare `gpt-6` alias). Accepts only the bare id or a
 * dated snapshot (`-YYYY-MM-DD` / `-YYYYMMDD`, e.g. gpt-6-astra-2026-09-30) and
 * is anchored so any other qualifier, named (`gpt-6-astra-mini`) or numeric
 * (`gpt-6-astra-2-mini`, `gpt-6-astra-2026-preview`), stays outside it. A false
 * match would apply Astra's reasoning surface (native `max`, no `none`) to a
 * model that may reject it.
 */
export function isGpt6AstraModel(modelString: string): boolean {
  const withoutPrefix = stripModelProviderPrefixes(modelString);
  return /^gpt-6-astra(?:-\d{4}-\d{2}-\d{2}|-\d{8})?$/.test(withoutPrefix);
}

/**
 * Whether the given OpenAI model supports the native "max" reasoning effort.
 *
 * The GPT-5.6 GA launch (July 9, 2026) added a top reasoning effort above
 * xhigh for the whole family — Sol, Terra, Luna, and the bare `gpt-5.6` alias
 * (see the OpenAI changelog: "GPT-5.6 adds ... max reasoning effort, and Pro
 * mode"). Earlier preview coverage described it as Sol-only, which is stale.
 *
 * GPT-6 Astra keeps the native max effort (its model page lists
 * low/medium/high/xhigh/max) but, unlike the GPT-5.6 family, rejects `none`; see
 * openaiRejectsDisabledReasoning. Pro mode is independent of that effort ladder.
 */
export function openaiSupportsNativeMaxEffort(modelString: string): boolean {
  return isGpt56FamilyModel(modelString) || isGpt6AstraModel(modelString);
}

/**
 * Whether the given OpenAI model rejects `reasoning.effort: "none"`.
 *
 * GPT-6 Astra returns HTTP 400 for `none` and lists no `minimal`; reasoning
 * cannot be turned off. OpenAI's migration guidance for callers of either value
 * is to send `low`, so the thinking policy drops "off" and clamps it to "low".
 */
export function openaiRejectsDisabledReasoning(modelString: string): boolean {
  return isGpt6AstraModel(modelString);
}

/**
 * OpenAI Responses API reasoning mode (orthogonal to reasoning effort).
 * Absent/"standard" is the API default; "pro" enables the slower, more
 * thorough pro-mode serving introduced with the GPT-5.6 family.
 */
export const OPENAI_REASONING_MODES = ["standard", "pro"] as const;
export type OpenAIReasoningMode = (typeof OPENAI_REASONING_MODES)[number];
export const OpenAIReasoningModeSchema = z.enum(OPENAI_REASONING_MODES);

/** Coerce an untrusted persisted value to an OpenAIReasoningMode (or undefined). */
export function coerceOpenAIReasoningMode(value: unknown): OpenAIReasoningMode | undefined {
  return OPENAI_REASONING_MODES.includes(value as OpenAIReasoningMode)
    ? (value as OpenAIReasoningMode)
    : undefined;
}

/**
 * Whether the given OpenAI model supports `reasoning.mode: "pro"` on the
 * Responses API.
 *
 * "GPT-5.6 Sol Pro" is not a separate model id: the same GPT-5.6 ids are
 * served with `reasoning.mode: "pro"`. Per the Responses API reasoning guide,
 * pro mode is available on every GPT-5.6 model (Sol, Terra, Luna, and the bare
 * `gpt-5.6` alias) — the Sol/Terra-only restriction came from stale preview
 * coverage.
 *
 * GPT-6 Astra also supports Pro on the same model id; keep it independent of
 * effort so choosing native max does not silently opt users into Pro serving.
 */
export function openaiSupportsProMode(modelString: string): boolean {
  return isGpt56FamilyModel(modelString) || isGpt6AstraModel(modelString);
}

/**
 * Whether the model is a frontier Grok (4.5 or 4.6, including provider/gateway
 * prefixes and aliases). These models always reason and are served over xAI's
 * Responses API.
 */
export function isGrokFrontierModel(modelString: string): boolean {
  const withoutPrefix = stripModelProviderPrefixes(modelString);
  return /^grok-4\.[56](?:$|-)/.test(withoutPrefix);
}

/**
 * Whether the model is Grok 4.6, which supports native xhigh reasoning effort
 * (Grok 4.5 tops out at high).
 */
export function isGrok46Model(modelString: string): boolean {
  const withoutPrefix = stripModelProviderPrefixes(modelString);
  return /^grok-4\.6(?:$|-)/.test(withoutPrefix);
}

/** GLM 5.3 and GLM 5.3 Flash always reason with low, high, or max effort. */
export function isGlm53Model(modelString: string): boolean {
  const withoutPrefix = stripModelProviderPrefixes(modelString);
  return /^glm-5\.3(?:-flash)?(?:$|-(?:latest|\d))/.test(withoutPrefix);
}

/**
 * Kimi K3 (Moonshot AI) always reasons and supports only the max reasoning
 * effort; the thinking policy and the Moonshot/OpenRouter provider-options
 * branches key off this predicate.
 */
export function isKimiK3Model(modelString: string): boolean {
  return stripModelProviderPrefixes(modelString) === "kimi-k3";
}

/**
 * Whether the given Anthropic model rejects `thinking: { type: "disabled" }`.
 *
 * Mythos-class models (Fable/Mythos) cannot turn thinking off: the API errors with
 * '"thinking.type.disabled" is not supported for this model. Thinking defaults to
 * adaptive mode when not specified'. Callers must either clamp "off" away via the
 * thinking policy or omit the `thinking` field entirely (letting the API default
 * to adaptive).
 */
export function anthropicRejectsDisabledThinking(modelString: string): boolean {
  const withoutPrefix = stripModelProviderPrefixes(modelString);
  return /claude-(?:fable|mythos)-/.test(withoutPrefix);
}

/**
 * Default thinking level when no value is set (UI initial state, backend fallback).
 * Semantically different from DEFAULT_THINKING_LEVEL which is the level used
 * when a user opts *into* thinking (e.g., CLI `--thinking` with no explicit level).
 */
export const THINKING_LEVEL_OFF: ThinkingLevel = "off";

/**
 * Default thinking level to use when toggling thinking on
 * if no previous value is stored for the model
 */
export const DEFAULT_THINKING_LEVEL: ThinkingLevelOn = "medium";

/**
 * OpenAI reasoning_effort mapping
 *
 * Maps our unified levels to OpenAI's reasoningEffort parameter
 * (used by o1, o3-mini, gpt-5, etc.)
 */
export const OPENAI_REASONING_EFFORT: Record<ThinkingLevel, string | undefined> = {
  off: undefined,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh", // Maps 1:1 to OpenAI's reasoning effort value
  max: "xhigh",
};

/**
 * Model-aware OpenAI reasoning effort resolution.
 *
 * Most OpenAI models top out at "xhigh", so the ThinkingLevel "max" downgrades to
 * "xhigh" (see OPENAI_REASONING_EFFORT). The GPT-5.6 family ships a distinct native
 * effort above xhigh with the wire value "max" on the Responses API (live-verified:
 * the response echoes `effort: max`; not yet in the SDK's typed union).
 *
 * GPT-5.6 "off" maps to the explicit "none" effort: omitting the field defaults
 * the request to medium (live-verified 2026-07-10 — an effort-less request echoed
 * `effort: medium`), which would silently ignore the user's off selection.
 *
 * GPT-6 Astra shares the native "max" but rejects "none" with a 400 (see
 * openaiRejectsDisabledReasoning). The thinking policy already excludes "off" for
 * it; a stray "off" clamps to "low" here so a caller bypassing policy cannot
 * trigger the error.
 */
export function getOpenAIReasoningEffort(
  level: ThinkingLevel,
  modelString: string
): string | undefined {
  if (openaiSupportsNativeMaxEffort(modelString)) {
    if (level === "max") return "max";
    if (level === "off") return openaiRejectsDisabledReasoning(modelString) ? "low" : "none";
  }
  return OPENAI_REASONING_EFFORT[level];
}

/**
 * OpenRouter reasoning effort mapping
 *
 * Maps our unified levels to OpenRouter's reasoning.effort parameter
 * (used by Claude Sonnet Thinking and other reasoning models via OpenRouter)
 */

/**
 * Thinking budgets for Gemini 2.5 models (in tokens)
 */
export const GEMINI_THINKING_BUDGETS: Record<ThinkingLevel, number> = {
  off: 0,
  low: 2048,
  medium: 8192,
  high: 16384, // Conservative max (some models go to 32k)
  xhigh: 16384, // Same as high - Gemini doesn't support xhigh
  max: 16384,
} as const;
export const OPENROUTER_REASONING_EFFORT: Record<
  ThinkingLevel,
  "low" | "medium" | "high" | undefined
> = {
  off: undefined,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high", // Fallback to high - OpenRouter doesn't support xhigh
  max: "high",
};

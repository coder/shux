/**
 * Thinking policy per model
 *
 * Represents allowed thinking levels for a model as a simple subset.
 * The policy naturally expresses model capabilities:
 * - ["high"] = Fixed policy (e.g., gpt-5-pro only supports HIGH)
 * - ["off"] = No reasoning capability
 * - ["off", "low", "medium", "high"] = Fully selectable
 *
 * UI behavior derives from the subset:
 * - Single element = Non-interactive display
 * - Multiple elements = User can select from options
 */

import type { ProvidersConfigMap } from "@/common/orpc/types";
import {
  THINKING_LEVELS,
  DEFAULT_THINKING_LEVEL,
  THINKING_LEVEL_OFF,
  anthropicRejectsDisabledThinking,
  anthropicSupportsNativeXhigh,
  isGrok46Model,
  isGrokFrontierModel,
  isGlm53Model,
  isKimiK3Model,
  openaiRejectsDisabledReasoning,
  openaiSupportsNativeMaxEffort,
  stripModelProviderPrefixes,
  type ThinkingLevel,
  type ParsedThinkingInput,
} from "@/common/types/thinking";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";
import { normalizeSelectedModel, normalizeToCanonical } from "@/common/utils/ai/models";

/**
 * Thinking policy is simply the set of allowed thinking levels for a model.
 * Pure subset design - no wrapper object, no discriminated union.
 */
export type ThinkingPolicy = readonly ThinkingLevel[];

/**
 * True when modelName is a bare Gemini Flash chat model ID using Google's
 * thinkingLevel config (minimal/low/medium/high) instead of Gemini 2.x thinkingBudget.
 * @param modelName Provider model ID without the provider prefix (e.g. "gemini-3.5-flash", not "google:gemini-3.5-flash").
 */
export function isGeminiFlashThinkingLevelModelName(modelName: string): boolean {
  const normalized = modelName.trim().toLowerCase();
  return (
    ((normalized === "gemini-3-flash" || normalized.startsWith("gemini-3-flash-")) &&
      !normalized.startsWith("gemini-3-flash-lite")) ||
    (normalized.startsWith("gemini-3.5-flash") &&
      !normalized.startsWith("gemini-3.5-flash-lite")) ||
    (normalized.startsWith("gemini-3.6-flash") &&
      !normalized.startsWith("gemini-3.6-flash-lite")) ||
    (normalized.startsWith("gemini-3.7-flash") &&
      !normalized.startsWith("gemini-3.7-flash-lite")) ||
    isGeminiFlashMinimalRejectingModelName(normalized)
  );
}

/**
 * True for Gemini Flash thinking-level models that reject `thinkingLevel: "minimal"`.
 * Gemini 3.8 Flash only accepts low/medium/high; sending MINIMAL returns an API
 * validation error ("Thinking level MINIMAL is not supported for this model"), so Xum
 * cannot expose "off" for it the way it does for 3–3.7 Flash.
 * @param modelName Provider model ID without the provider prefix.
 */
export function isGeminiFlashMinimalRejectingModelName(modelName: string): boolean {
  const normalized = modelName.trim().toLowerCase();
  return (
    normalized.startsWith("gemini-3.8-flash") && !normalized.startsWith("gemini-3.8-flash-lite")
  );
}

/**
 * Returns the thinking policy for a given model.
 *
 * Rules:
 * - openai:gpt-5.1-codex-max → ["off", "low", "medium", "high", "xhigh"] (5 levels including xhigh)
 * - openai:gpt-5.2-codex → ["off", "low", "medium", "high", "xhigh"] (5 levels including xhigh)
 * - openai:gpt-5.3-codex / Spark variants →
 *   ["off", "low", "medium", "high", "xhigh"] (5 levels including xhigh)
 * - openai:gpt-5.2 / openai:gpt-5.5 → ["off", "low", "medium", "high", "xhigh"]
 * - openai:gpt-5.6 family (Sol/Terra/Luna and the bare alias) →
 *   ["off", "low", "medium", "high", "xhigh", "max"] (6 levels; native max at GA)
 * - openai:gpt-6-astra → ["low", "medium", "high", "xhigh", "max"] (native max; the API
 *   rejects "none", so reasoning cannot be disabled)
 * - openai:gpt-5.2-pro / openai:gpt-5.5-pro → ["medium", "high", "xhigh"] (3 levels)
 * - openai:gpt-5-pro → ["high"] (only supported level, legacy)
 * - Gemini 3.8 Flash → ["low", "medium", "high"] (API rejects minimal, so no "off")
 * - Older Gemini Flash chat variants → ["off", "low", "medium", "high"]
 * - gemini-3 Pro variants → ["low", "high"] (thinking level only)
 * - xai:grok-4.6 → ["low", "medium", "high", "xhigh"] (reasoning cannot be disabled)
 * - xai:grok-4.5 → ["low", "medium", "high"] (reasoning cannot be disabled)
 * - zai:glm-5.3-flash → ["low", "high", "max"] (reasoning cannot be disabled)
 * - default → ["off", "low", "medium", "high"] (standard 4 levels; xhigh is opt-in per model)
 *
 * Tolerates version suffixes (e.g., gpt-5-pro-2025-10-06).
 * Does NOT match gpt-5-pro-mini (uses negative lookahead).
 *
 * Pass `providersConfig` so configured aliases (`mappedToModel`, e.g.
 * `openai:team-sol` -> `openai:gpt-5.6-sol`) resolve to their capability model
 * before rule matching — matching how `buildProviderOptions` /
 * `openaiProModeAvailable` detect capabilities. Without it, mapped aliases fall
 * through to the default 4-level policy and clamping strips levels (e.g. native
 * max) the target model actually supports.
 */
export function getThinkingPolicyForModel(
  modelString: string,
  providersConfig?: ProvidersConfigMap | null
): ThinkingPolicy {
  const capabilityModel = resolveModelForMetadata(modelString, providersConfig ?? null);
  return getExplicitThinkingPolicy(capabilityModel) ?? DEFAULT_THINKING_POLICY;
}

/**
 * Standard fallback policy for models without an explicitly-recognized reasoning rule.
 * Shared by both standard reasoning models and non-reasoning models, so it is NOT a
 * reliable "supports reasoning" signal on its own (see getDefaultMinimumThinkingLevel).
 */
const DEFAULT_THINKING_POLICY: ThinkingPolicy = ["off", "low", "medium", "high"];

/**
 * Returns the policy for a model that matches an explicit reasoning rule, or `null`
 * when the model falls through to {@link DEFAULT_THINKING_POLICY}.
 *
 * A non-null result means Xum explicitly recognizes the model as a reasoning model,
 * which is the signal used to decide whether to apply a default thinking floor.
 */
function getExplicitThinkingPolicy(modelString: string): ThinkingPolicy | null {
  // Normalize to be robust to provider prefixes, whitespace, gateway wrappers, and version
  // suffixes. Strips both a `provider:` prefix and any upstream-provider path segment that
  // proxies encode (e.g. `mux-gateway:openai/gpt-5.5-pro` -> `gpt-5.5-pro`).
  const withoutProviderNamespace = stripModelProviderPrefixes(modelString);

  // Mythos-class models (Fable/Mythos) cannot disable thinking — the API rejects
  // `thinking: { type: "disabled" }` and always thinks (adaptive by default) — so
  // "off" is not offered and requests for it clamp up to "low".
  if (anthropicRejectsDisabledThinking(modelString)) {
    return ["low", "medium", "high", "xhigh", "max"];
  }

  // Opus 4.7+ supports all 6 levels: xhigh is a native API effort level distinct from max.
  if (anthropicSupportsNativeXhigh(modelString)) {
    return ["off", "low", "medium", "high", "xhigh", "max"];
  }

  // Claude Opus 4.6 and Sonnet 4.6 support 5 levels including xhigh (mapped to "max" effort)
  if (
    withoutProviderNamespace.includes("opus-4-6") ||
    withoutProviderNamespace.includes("sonnet-4-6")
  ) {
    return ["off", "low", "medium", "high", "xhigh"];
  }

  // GPT-5.1-Codex-Max supports 5 reasoning levels including xhigh (Extra High)
  if (
    withoutProviderNamespace.startsWith("gpt-5.1-codex-max") ||
    withoutProviderNamespace.startsWith("codex-max")
  ) {
    return ["off", "low", "medium", "high", "xhigh"];
  }

  // GPT-5.2/5.3 Codex models (including Spark) support 5 reasoning levels.
  if (/^gpt-5\.[23]-codex(?:-spark)?(?!-[a-z])/.test(withoutProviderNamespace)) {
    return ["off", "low", "medium", "high", "xhigh"];
  }

  // GPT-6 Astra cannot disable reasoning: the API rejects effort "none" with a 400
  // and lists no "minimal", so "off" is not offered and requests for it clamp up to "low".
  if (openaiRejectsDisabledReasoning(withoutProviderNamespace)) {
    return ["low", "medium", "high", "xhigh", "max"];
  }

  // The GPT-5.6 family (Sol/Terra/Luna and the bare gpt-5.6 alias) supports
  // the native "max" reasoning effort introduced at GA.
  if (openaiSupportsNativeMaxEffort(withoutProviderNamespace)) {
    return ["off", "low", "medium", "high", "xhigh", "max"];
  }

  // gpt-5.2-pro and gpt-5.5-pro support medium, high, xhigh reasoning levels
  if (/^gpt-5\.(?:2|5)-pro(?!-[a-z])/.test(withoutProviderNamespace)) {
    return ["medium", "high", "xhigh"];
  }

  // gpt-5.2, gpt-5.5 and the gpt-5.4-mini / gpt-5.4-nano variants support 5 reasoning levels including xhigh.
  if (
    /^gpt-5\.2(?!-[a-z])/.test(withoutProviderNamespace) ||
    /^gpt-5\.(?:4|5)(?:-(?:mini|nano))?(?!-[a-z])/.test(withoutProviderNamespace)
  ) {
    return ["off", "low", "medium", "high", "xhigh"];
  }

  // gpt-5-pro (legacy) only supports high
  if (/^gpt-5-pro(?!-[a-z])/.test(withoutProviderNamespace)) {
    return ["high"];
  }

  // Gemini 3.8 Flash rejects "minimal", so thinking cannot be disabled; "off" clamps to "low".
  if (isGeminiFlashMinimalRejectingModelName(withoutProviderNamespace)) {
    return ["low", "medium", "high"];
  }

  // Older Gemini Flash chat models support minimal/low/medium/high. Xum exposes minimal as "off".
  if (isGeminiFlashThinkingLevelModelName(withoutProviderNamespace)) {
    return ["off", "low", "medium", "high"];
  }

  // Gemini 3 Pro only supports "low" and "high" reasoning levels
  if (withoutProviderNamespace.includes("gemini-3")) {
    return ["low", "high"];
  }

  // Grok Fast switches model variants: it has reasoning off/on, not graded effort.
  if (withoutProviderNamespace === "grok-4-1-fast") {
    return ["off", "high"];
  }

  // Frontier Grok models always reason. Grok 4.6 adds native xhigh effort;
  // Grok 4.5 supports configurable low/medium/high.
  if (isGrok46Model(withoutProviderNamespace)) {
    return ["low", "medium", "high", "xhigh"];
  }
  if (isGrokFrontierModel(withoutProviderNamespace)) {
    return ["low", "medium", "high"];
  }

  // GLM 5.3 always reasons and exposes exactly the effort values accepted by Z.ai.
  if (isGlm53Model(withoutProviderNamespace)) {
    return ["low", "high", "max"];
  }

  // Kimi K3 always reasons and supports only the max reasoning effort, so the
  // policy is a fixed single level.
  if (isKimiK3Model(withoutProviderNamespace)) {
    return ["max"];
  }

  // No explicit reasoning rule matched.
  return null;
}

/** Canonical ordering index for a level (off=0 … max=5). */
function thinkingLevelIndex(level: ThinkingLevel): number {
  return THINKING_LEVELS.indexOf(level);
}

/**
 * Default *minimum* thinking level (floor) for a model.
 *
 * Most users never want off/low thinking, so models Xum explicitly recognizes as
 * reasoning models default to a "medium" floor — hiding off/low in the thinking slider
 * so cycling is more efficient.
 *
 * Models that fall through to the shared default policy keep an "off" floor. That policy
 * is also used by non-reasoning models (e.g. gpt-4o, claude-3.5), and defaulting them to
 * medium would send unsupported reasoning params (buildProviderOptions emits reasoning
 * config whenever the level is non-off). Such models can still be raised per-model on the
 * Models settings page.
 *
 * This is only a default; users can override it per-model on the Models settings page.
 */
export function getDefaultMinimumThinkingLevel(
  modelString: string,
  providersConfig?: ProvidersConfigMap | null
): ThinkingLevel {
  // A binary model must retain its off option unless the user explicitly raises the floor.
  const policy = getThinkingPolicyForModel(modelString, providersConfig);
  if (policy.length === 2 && policy[0] === "off") return THINKING_LEVEL_OFF;
  return hasExplicitThinkingPolicy(modelString, providersConfig)
    ? DEFAULT_THINKING_LEVEL
    : THINKING_LEVEL_OFF;
}

/**
 * True when Xum explicitly recognizes the model's reasoning levels (i.e. it matches a
 * specific rule rather than falling through to the shared default policy).
 *
 * Used to gate the per-model minimum-thinking control: only recognized reasoning models
 * expose a floor selector and default to medium. Unrecognized / non-reasoning models keep
 * the legacy off-default behavior.
 */
export function hasExplicitThinkingPolicy(
  modelString: string,
  providersConfig?: ProvidersConfigMap | null
): boolean {
  return (
    getExplicitThinkingPolicy(resolveModelForMetadata(modelString, providersConfig ?? null)) !==
    null
  );
}

/**
 * Resolve the effective minimum thinking level for a model, preferring an explicit
 * per-model override (from config) and otherwise falling back to the built-in default.
 * Always returns a concrete level (never null), so callers can pass the result straight
 * into {@link getAvailableThinkingLevels} / {@link enforceThinkingPolicy}.
 */
export function resolveMinimumThinkingLevel(
  modelString: string,
  override?: ThinkingLevel | null,
  providersConfig?: ProvidersConfigMap | null
): ThinkingLevel {
  return override ?? getDefaultMinimumThinkingLevel(modelString, providersConfig);
}

/**
 * Look up the per-model minimum-thinking-level override for a model string.
 *
 * Reads the gateway-preserving key first (current write format, so an
 * explicit coder:<instance>/<model> floor stays distinct from the direct
 * provider's), then falls back to the legacy name-canonical key: older
 * versions persisted floors through normalizeToCanonical, so a floor set for
 * e.g. coder:openai/<model> lives under openai:<model> until the user edits
 * it again. Without the fallback that configured floor silently stops
 * applying after upgrade.
 */
export function lookupMinThinkingLevelOverride(
  minThinkingLevelByModel: Record<string, ThinkingLevel> | undefined,
  modelString: string
): ThinkingLevel | undefined {
  if (!minThinkingLevelByModel) {
    return undefined;
  }
  const selectedKey = normalizeSelectedModel(modelString);
  const selected = minThinkingLevelByModel[selectedKey];
  if (selected !== undefined) {
    return selected;
  }
  const legacyKey = normalizeToCanonical(modelString);
  return legacyKey === selectedKey ? undefined : minThinkingLevelByModel[legacyKey];
}

/**
 * Resolve the effective thinking level for an outgoing stream request.
 *
 * Most models treat an unset level as "off". Models that reject disabled
 * thinking clamp unset/legacy "off" through their policy so Xum's tracked level
 * matches the provider's always-thinking behavior. This keeps provider options,
 * reasoning metadata, and provider-specific replay transforms consistent.
 *
 * Pass `providersConfig` so configured aliases (`mappedToModel`, e.g.
 * `anthropic:internal-fable` -> `anthropic:claude-fable-5`) are resolved to
 * their capability model before the forced-thinking check, matching how
 * `buildProviderOptions` detects capabilities.
 */
export function resolveEffectiveThinkingLevel(
  modelString: string,
  requested: ThinkingLevel | null | undefined,
  providersConfig?: ProvidersConfigMap | null
): ThinkingLevel {
  const level = requested ?? THINKING_LEVEL_OFF;
  const capabilityModel = resolveModelForMetadata(modelString, providersConfig ?? null);
  // Gemini 3.8 Flash rejects "minimal" and GPT-6 Astra rejects "none", so an
  // unset/"off" level must clamp here too; otherwise the tracked level would say
  // "off" while the adapter sends "low".
  return anthropicRejectsDisabledThinking(capabilityModel) ||
    isGlm53Model(capabilityModel) ||
    openaiRejectsDisabledReasoning(capabilityModel) ||
    isGeminiFlashMinimalRejectingModelName(stripModelProviderPrefixes(capabilityModel))
    ? enforceThinkingPolicy(capabilityModel, level)
    : level;
}

/**
 * Thinking levels available for a model after applying a minimum floor.
 *
 * - `minimum == null` → no floor; returns the raw capability policy.
 * - Otherwise filters the capability policy to levels at or above `minimum` by
 *   canonical ordering. For example a "medium" floor applied to gemini-3's
 *   ["low", "high"] yields ["high"].
 *
 * Invariant: never returns an empty set. If the floor exceeds the model's maximum
 * supported level, it locks to the highest supported level so the slider stays usable.
 */
export function getAvailableThinkingLevels(
  modelString: string,
  minimum?: ThinkingLevel | null,
  providersConfig?: ProvidersConfigMap | null
): ThinkingPolicy {
  const capability = getThinkingPolicyForModel(modelString, providersConfig);
  if (minimum == null) {
    return capability;
  }

  const minIndex = thinkingLevelIndex(minimum);
  const filtered = capability.filter((level) => thinkingLevelIndex(level) >= minIndex);
  if (filtered.length > 0) {
    return filtered;
  }

  // Floor sits above the model's maximum capability: lock to the highest supported level.
  const highest = [...capability]
    .sort((left, right) => thinkingLevelIndex(left) - thinkingLevelIndex(right))
    .at(-1);
  return highest ? [highest] : capability;
}

/**
 * Enforce thinking policy by clamping requested level to allowed set.
 *
 * Fallback strategy:
 * 1. If requested level is allowed, use it.
 * 2. If the request is above the model's maximum, clamp to the highest allowed level.
 * 3. If the request is below the model's minimum, clamp to the lowest allowed level.
 * 4. Otherwise, pick the closest allowed level by order.
 *
 * When `minimum` is provided, the allowed set is the model's capability filtered to that
 * floor (see {@link getAvailableThinkingLevels}). A below-floor request (e.g. a stored
 * "off" with a "medium" floor) therefore clamps up to the floor. Omitting `minimum`
 * preserves the legacy capability-only behavior.
 */
export function enforceThinkingPolicy(
  modelString: string,
  requested: ThinkingLevel,
  minimum?: ThinkingLevel | null,
  providersConfig?: ProvidersConfigMap | null
): ThinkingLevel {
  const allowed = getAvailableThinkingLevels(modelString, minimum, providersConfig);

  if (allowed.includes(requested)) {
    return requested;
  }

  // Legacy low/medium values meant "on" for binary models, not nearest-to-off.
  if (allowed.length === 2 && allowed[0] === "off" && allowed[1] === "high") return "high";

  const orderedAllowed = [...allowed].sort(
    (left, right) => THINKING_LEVELS.indexOf(left) - THINKING_LEVELS.indexOf(right)
  );
  const minAllowed = orderedAllowed[0] ?? "off";
  const maxAllowed = orderedAllowed[orderedAllowed.length - 1] ?? minAllowed;
  const requestedIndex = THINKING_LEVELS.indexOf(requested);

  if (requestedIndex <= THINKING_LEVELS.indexOf(minAllowed)) {
    return minAllowed;
  }

  if (requestedIndex >= THINKING_LEVELS.indexOf(maxAllowed)) {
    return maxAllowed;
  }

  const closest = orderedAllowed.reduce((nearest, level) => {
    const nearestIndex = THINKING_LEVELS.indexOf(nearest);
    const levelIndex = THINKING_LEVELS.indexOf(level);
    return Math.abs(levelIndex - requestedIndex) < Math.abs(nearestIndex - requestedIndex)
      ? level
      : nearest;
  }, minAllowed);

  return closest;
}
/**
 * Whether a thinking-level transition would swap the underlying model instance
 * for xAI's grok-4-1-fast (providerModelFactory maps off → non-reasoning and
 * non-off → reasoning variants at model creation). Such transitions cannot be
 * applied to an in-flight stream via provider options, so mid-turn overrides
 * skip them (the persisted setting still applies to the next turn).
 */
export function isXaiGrokFastVariantSwap(
  modelString: string,
  currentLevel: ThinkingLevel,
  nextLevel: ThinkingLevel
): boolean {
  const [provider, modelId] = modelString.trim().toLowerCase().split(":", 2);
  if (provider !== "xai" || modelId !== "grok-4-1-fast") {
    return false;
  }
  return (currentLevel === "off") !== (nextLevel === "off");
}

/**
 * Resolve a parsed thinking input to a concrete ThinkingLevel for a given model.
 *
 * Named levels are returned as-is (the backend's enforceThinkingPolicy will
 * clamp if needed). Numeric indices are mapped into the model's sorted allowed
 * levels — so 0 always means the model's lowest allowed level (e.g., "medium"
 * for gpt-5.5-pro, "off" for most other models), and the highest index means
 * the model's highest level. Out-of-range indices clamp to min/max.
 */
export function resolveThinkingInput(
  input: ParsedThinkingInput,
  modelString: string,
  providersConfig?: ProvidersConfigMap | null
): ThinkingLevel {
  // Named levels pass through directly
  if (typeof input === "string") return input;

  // Numeric: index into the model's allowed levels (sorted lowest → highest).
  // providersConfig resolves mapped aliases (mappedToModel) to their target's
  // policy so indices map into the real ladder (e.g. GPT-5.6 native max).
  const policy = getThinkingPolicyForModel(modelString, providersConfig);
  const sorted = [...policy].sort(
    (a, b) => THINKING_LEVELS.indexOf(a) - THINKING_LEVELS.indexOf(b)
  );
  const clamped = Math.max(0, Math.min(input, sorted.length - 1));
  return sorted[clamped] ?? sorted[0] ?? "off";
}

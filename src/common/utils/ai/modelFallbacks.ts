import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { resolveCoderWireCanonicalModel } from "@/common/constants/coderOAuth";
import { isCustomProviderConfig } from "@/common/utils/providers/customProviders";
import type { ModelFallbacks } from "@/common/config/schemas/appConfigOnDisk";

/**
 * Maximum fallback models per chain. Each chain entry is attempted at most once
 * per turn, so this bounds the worst case to 1 + 3 provider calls per refusal.
 */
export const MODEL_FALLBACK_CHAIN_LIMIT = 3;

/**
 * Default refusal-fallback chains shipped with the app. Fable 5 safeguards
 * may refuse requests the current Opus tier can serve, so retrying on Opus is
 * the sensible out-of-the-box behavior.
 *
 * Seeded into the config exactly once, guarded by
 * migrations.defaultModelFallbacksSeeded (plus the one-shot
 * defaultModelFallbacksSeededFable51 re-seed for the key move to Fable 5.1)
 * — on versions that know the flag,
 * user edits or deletions of these chains are never overridden by updates.
 * (Versions predating the flag strip it on save, so a downgrade→save→
 * re-upgrade round-trip re-seeds a deleted chain; bounded to re-adding this
 * benign, re-deletable default.)
 */
export const DEFAULT_MODEL_FALLBACKS: ModelFallbacks = {
  [KNOWN_MODELS.FABLE.id]: { models: [KNOWN_MODELS.OPUS.id] },
};

/**
 * Legacy default chain for the pre-5.1 fable id, seeded alongside
 * DEFAULT_MODEL_FALLBACKS whenever the original seed pass runs (fresh installs
 * and configs that never completed it). Those configs mark
 * defaultModelFallbacksSeeded, so a downgrade to a build whose FABLE is
 * Fable 5 would skip its own seed; carrying this chain keeps the old build's
 * refusal fallback intact.
 */
export const LEGACY_DEFAULT_MODEL_FALLBACKS: ModelFallbacks = {
  "anthropic:claude-fable-5": { models: [KNOWN_MODELS.OPUS.id] },
};
// Deep-freeze: entries are spread by reference into live configs (fresh-install
// defaults, seed merge). Accidental in-place mutation must crash fast instead
// of silently corrupting the process-wide default.
for (const entry of [
  ...Object.values(Object.freeze(DEFAULT_MODEL_FALLBACKS)),
  ...Object.values(Object.freeze(LEGACY_DEFAULT_MODEL_FALLBACKS)),
]) {
  Object.freeze(entry);
  Object.freeze(entry.models);
}

/**
 * Sanitize one persisted fallback model string. Coder gateway strings stay
 * VERBATIM: name-based canonicalization would rewrite coder:openai/<model> to
 * openai:<model> even when the instance is cross-typed ({name: "openai",
 * type: "anthropic"}), merging a gateway-scoped chain into the direct
 * provider's — and sanitize runs on every config read, where instance
 * metadata may be temporarily missing (logged out), so a metadata-aware
 * rewrite here could silently corrupt stored keys. Metadata-aware
 * canonicalization happens at lookup/editor time (normalizeFallbackModelKey).
 */
export function sanitizeFallbackModelString(model: string): string {
  const trimmed = model.trim();
  return trimmed.startsWith("coder:") ? trimmed : normalizeToCanonical(trimmed);
}

/**
 * Metadata-aware fallback key for a model selection. Coder strings on the
 * default canonical routes (coder:anthropic/x, coder:openai/x) share their
 * chain with the direct provider ONLY when the instance metadata agrees with
 * the name (name === type, the default convention). Cross-typed instances
 * ({name: "openai", type: "anthropic"}) and shadowed prefixes keep the
 * gateway-scoped key: their refusal behavior is a property of the gateway
 * selection, not of the direct provider the name resembles.
 */
export function normalizeFallbackModelKey(
  modelString: string,
  providersConfig?: Record<string, unknown> | null
): string {
  const trimmed = modelString.trim();
  if (!trimmed.startsWith("coder:")) {
    return normalizeToCanonical(trimmed);
  }
  const canonical = normalizeToCanonical(trimmed);
  if (canonical === trimmed) {
    return trimmed; // non-canonical instance names are already gateway-scoped
  }
  const coderSection = providersConfig?.coder;
  if (isCustomProviderConfig(coderSection)) {
    return trimmed; // custom provider shadows the prefix; raw IS the identity
  }
  const wire = resolveCoderWireCanonicalModel(
    trimmed.slice("coder:".length),
    coderSection as { discoveredProviders?: unknown; additionalProviders?: unknown } | undefined
  );
  const canonicalOrigin = canonical.slice(0, canonical.indexOf(":"));
  return wire?.providerType === canonicalOrigin ? canonical : trimmed;
}

/**
 * Sanitize one fallback chain relative to its source model: canonicalize every
 * entry (Coder strings stay gateway-scoped, see sanitizeFallbackModelString),
 * drop self-fallbacks and duplicates, and cap the length. Used both when
 * persisting from the settings editor (strict-on-write) and when resolving at
 * request time (lenient-on-read, so malformed config self-heals instead of
 * breaking sends).
 */
export function sanitizeModelFallbackChain(
  sourceModel: string,
  models: readonly unknown[]
): string[] {
  const canonicalSource = sanitizeFallbackModelString(sourceModel);
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const model of models) {
    if (typeof model !== "string") {
      continue;
    }
    const canonical = sanitizeFallbackModelString(model);
    if (!canonical || canonical === canonicalSource || seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    chain.push(canonical);
    if (chain.length >= MODEL_FALLBACK_CHAIN_LIMIT) {
      break;
    }
  }
  return chain;
}

/**
 * Resolve the effective refusal-fallback chain for a model. Returns [] when no
 * chain applies (no entry, disabled, trigger mismatch, or empty after
 * sanitization). Only the source model's own chain is consulted per turn —
 * fallback models' chains are never chased, so chains cannot loop at runtime.
 */
export function resolveModelFallbackChain(
  modelFallbacks: ModelFallbacks | undefined,
  modelString: string,
  providersConfig?: Record<string, unknown> | null
): string[] {
  if (!modelFallbacks) {
    return [];
  }

  // Raw-first: an explicit gateway-scoped chain always wins for that exact
  // selection (and stays reachable even when instance metadata is missing).
  // The metadata-aware key then lets default-typed canonical-route Coder
  // selections share the direct provider's chain, while cross-typed ones do
  // NOT fall through to it.
  const rawSource = modelString.trim();
  const canonicalSource = modelFallbacks[rawSource]
    ? rawSource
    : normalizeFallbackModelKey(modelString, providersConfig);
  const entry = modelFallbacks[canonicalSource];
  if (!entry || entry.enabled === false || !Array.isArray(entry.models)) {
    return [];
  }
  // Refusal is the only trigger today; entries restricted to other (future)
  // triggers must not fire on refusals.
  if (entry.triggers !== undefined && !entry.triggers.includes("model_refusal")) {
    return [];
  }

  return sanitizeModelFallbackChain(canonicalSource, entry.models);
}

/**
 * Sanitize a full fallback map for persistence: canonical keys, sanitized
 * chains, entries with empty chains dropped. Later duplicate keys win (matches
 * object-spread semantics in the editor).
 */
export function sanitizeModelFallbacks(modelFallbacks: ModelFallbacks): ModelFallbacks {
  const next: ModelFallbacks = {};
  for (const [sourceModel, entry] of Object.entries(modelFallbacks)) {
    const canonicalSource = sanitizeFallbackModelString(sourceModel);
    if (!canonicalSource || !entry || !Array.isArray(entry.models)) {
      continue;
    }
    const chain = sanitizeModelFallbackChain(canonicalSource, entry.models);
    if (chain.length === 0) {
      continue;
    }
    next[canonicalSource] = {
      ...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
      ...(entry.triggers !== undefined ? { triggers: entry.triggers } : {}),
      models: chain,
    };
  }
  return next;
}

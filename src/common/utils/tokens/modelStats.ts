import type { ProvidersConfigMap } from "@/common/orpc/types";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";
import modelsData from "./models.json";
import { modelsExtra } from "./models-extra";
import { normalizeToCanonical } from "../ai/models";

export interface ModelStats {
  max_input_tokens: number;
  max_output_tokens?: number;
  input_cost_per_token: number;
  output_cost_per_token: number;
  input_cost_per_token_above_200k_tokens?: number;
  output_cost_per_token_above_200k_tokens?: number;
  cache_creation_input_token_cost?: number;
  cache_creation_input_token_cost_above_200k_tokens?: number;
  cache_read_input_token_cost?: number;
  cache_read_input_token_cost_above_200k_tokens?: number;
  tiered_pricing_threshold_tokens?: number;
}

interface RawModelData {
  max_input_tokens?: number | string | null;
  max_output_tokens?: number | string | null;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  input_cost_per_image_token?: number;
  output_cost_per_image_token?: number;
  cache_read_input_image_token_cost?: number;
  input_cost_per_token_above_200k_tokens?: number;
  output_cost_per_token_above_200k_tokens?: number;
  cache_creation_input_token_cost?: number;
  cache_creation_input_token_cost_above_200k_tokens?: number;
  cache_read_input_token_cost?: number;
  cache_read_input_token_cost_above_200k_tokens?: number;
  tiered_pricing_threshold_tokens?: number | string | null;
  [key: string]: unknown;
}

const PROVIDER_KEY_ALIASES: Record<string, string> = {
  // GitHub Copilot keys in models.json use underscores for LiteLLM provider names.
  "github-copilot": "github_copilot",
};

/**
 * Runtime numeric semantics for raw catalog values (accepts numeric strings
 * with comma separators). Exported so update-models validation compares
 * magnitudes exactly as getModelStats would parse them.
 */
export function parseNum(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, "").trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

const DEFAULT_TIERED_PRICING_THRESHOLD_TOKENS = 200_000;

function parseOptionalNumber(value: unknown): number | undefined {
  return parseNum(value) ?? undefined;
}

function hasTieredPricing(data: RawModelData): boolean {
  return (
    parseOptionalNumber(data.input_cost_per_token_above_200k_tokens) != null ||
    parseOptionalNumber(data.output_cost_per_token_above_200k_tokens) != null ||
    parseOptionalNumber(data.cache_creation_input_token_cost_above_200k_tokens) != null ||
    parseOptionalNumber(data.cache_read_input_token_cost_above_200k_tokens) != null
  );
}

/**
 * Whether raw model metadata is usable for stats resolution. Exported so the
 * update-models validation applies the same bar as getModelStats.
 */
export function hasUsableTokenLimits(data: RawModelData): boolean {
  const maxInputTokens = parseNum(data.max_input_tokens);
  return maxInputTokens != null && maxInputTokens > 0;
}

/**
 * Extracts ModelStats from validated raw data
 */
function extractModelStats(data: RawModelData): ModelStats {
  const tieredPricingThresholdTokens =
    parseOptionalNumber(data.tiered_pricing_threshold_tokens) ??
    // LiteLLM names long-context rates with `_above_200k_tokens` but does not ship a
    // separate threshold field. Keep 200K as the compatibility default unless an override
    // (like GPT-5.5's published 272K boundary) is provided explicitly.
    (hasTieredPricing(data) ? DEFAULT_TIERED_PRICING_THRESHOLD_TOKENS : undefined);

  return {
    max_input_tokens: parseNum(data.max_input_tokens) ?? 0,
    max_output_tokens: parseNum(data.max_output_tokens) ?? undefined,
    // Subscription providers like GitHub Copilot omit per-token costs.
    input_cost_per_token:
      typeof data.input_cost_per_token === "number" ? data.input_cost_per_token : 0,
    // Image generation tool usage reports generated image tokens as outputTokens, so
    // image model stats use the image-output price in the generic output slot.
    output_cost_per_token:
      data.mode === "image_generation" && typeof data.output_cost_per_image_token === "number"
        ? data.output_cost_per_image_token
        : typeof data.output_cost_per_token === "number"
          ? data.output_cost_per_token
          : 0,
    input_cost_per_token_above_200k_tokens: parseOptionalNumber(
      data.input_cost_per_token_above_200k_tokens
    ),
    output_cost_per_token_above_200k_tokens: parseOptionalNumber(
      data.output_cost_per_token_above_200k_tokens
    ),
    cache_creation_input_token_cost:
      typeof data.cache_creation_input_token_cost === "number"
        ? data.cache_creation_input_token_cost
        : undefined,
    cache_creation_input_token_cost_above_200k_tokens: parseOptionalNumber(
      data.cache_creation_input_token_cost_above_200k_tokens
    ),
    cache_read_input_token_cost:
      typeof data.cache_read_input_token_cost === "number"
        ? data.cache_read_input_token_cost
        : undefined,
    cache_read_input_token_cost_above_200k_tokens: parseOptionalNumber(
      data.cache_read_input_token_cost_above_200k_tokens
    ),
    tiered_pricing_threshold_tokens: tieredPricingThresholdTokens,
  };
}

function stripVersionDateSuffix(modelName: string): string {
  return modelName.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, "");
}

function stripLatestSuffix(modelName: string): string {
  return modelName.replace(/-latest$/, "");
}

/**
 * Generates lookup keys for a model string with multiple naming patterns.
 * Handles LiteLLM conventions like "ollama/model-cloud" and "provider/model".
 * Exported so capability resolution shares the exact same key preference:
 * provider-scoped entries must win over bare-name entries in both lookups,
 * otherwise a model can inherit stats and capabilities from different entries.
 */
export function generateModelLookupKeys(modelString: string): string[] {
  const colonIndex = modelString.indexOf(":");
  const provider = colonIndex !== -1 ? modelString.slice(0, colonIndex) : "";
  const modelName = colonIndex !== -1 ? modelString.slice(colonIndex + 1) : modelString;
  // Keep the original catalog key first — LiteLLM ships mixed-case ids like
  // `deepinfra/Qwen/Qwen3-14B`. Lowercase variants are only fallbacks so
  // user-facing ids like `XAI:Grok-4.5` still resolve.
  const litellmProvider = PROVIDER_KEY_ALIASES[provider] ?? provider;
  const lowercaseProvider = litellmProvider.toLowerCase();
  const unversionedModelName = stripVersionDateSuffix(modelName);
  const familyModelName = stripLatestSuffix(unversionedModelName);
  const lowercaseModelName = modelName.toLowerCase();
  const lowercaseUnversionedModelName = unversionedModelName.toLowerCase();
  const lowercaseFamilyModelName = familyModelName.toLowerCase();

  const keys: string[] = [];
  const seen = new Set<string>();
  const push = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  };
  const pushProviderScoped = (providerKey: string, name: string) => {
    push(`${providerKey}/${name}`);
    push(`${providerKey}/${name}-cloud`);
  };

  // Prefer provider-scoped matches first so provider-specific limits win over generic entries.
  if (provider) {
    pushProviderScoped(litellmProvider, modelName);

    // Version-pinned model IDs like gpt-5.5-2026-04-23 should fall back to the
    // base model entry when models-extra/models.json only publish the family key.
    if (unversionedModelName !== modelName) {
      pushProviderScoped(litellmProvider, unversionedModelName);
    }

    // Servable rolling aliases like grok-4.5-latest inherit the family entry.
    if (familyModelName !== unversionedModelName) {
      pushProviderScoped(litellmProvider, familyModelName);
    }

    // Fallback: strip size suffix for base model lookup
    // "ollama:gpt-oss:20b" → "ollama/gpt-oss"
    if (modelName.includes(":")) {
      const baseModel = modelName.split(":")[0];
      push(`${litellmProvider}/${baseModel}`);
    }

    // Case-insensitive fallbacks after exact catalog keys.
    if (lowercaseProvider !== litellmProvider || lowercaseModelName !== modelName) {
      pushProviderScoped(lowercaseProvider, lowercaseModelName);
    }
    if (lowercaseUnversionedModelName !== lowercaseModelName) {
      pushProviderScoped(lowercaseProvider, lowercaseUnversionedModelName);
    }
    if (lowercaseFamilyModelName !== lowercaseUnversionedModelName) {
      pushProviderScoped(lowercaseProvider, lowercaseFamilyModelName);
    }
    if (lowercaseModelName.includes(":")) {
      push(`${lowercaseProvider}/${lowercaseModelName.split(":")[0]}`);
    }
  }

  push(modelName);
  if (unversionedModelName !== modelName) {
    push(unversionedModelName);
  }
  if (familyModelName !== unversionedModelName) {
    push(familyModelName);
  }
  if (lowercaseModelName !== modelName) {
    push(lowercaseModelName);
  }
  if (lowercaseUnversionedModelName !== lowercaseModelName) {
    push(lowercaseUnversionedModelName);
  }
  if (lowercaseFamilyModelName !== lowercaseUnversionedModelName) {
    push(lowercaseFamilyModelName);
  }

  return keys;
}

export interface ResolvedRawModelEntry {
  /** The models-extra/models.json key the stats actually come from. */
  key: string;
  data: RawModelData;
}

/**
 * Resolves the raw override/catalog entry backing a model string, preserving
 * getModelStats' precedence: models-extra across every lookup key first, then
 * models.json. Exported so the Treat-as catalog can exclude ids whose stats
 * would resolve from a different entry than the row represents.
 */
export function resolveRawModelEntry(modelString: string): ResolvedRawModelEntry | null {
  const normalized = normalizeToCanonical(modelString);
  const lookupKeys = generateModelLookupKeys(normalized);

  // Check models-extra.ts first (overrides for models with incorrect upstream data)
  for (const key of lookupKeys) {
    const data = (modelsExtra as Record<string, RawModelData>)[key];
    if (data && hasUsableTokenLimits(data)) {
      return { key, data };
    }
  }

  // Fall back to main models.json
  for (const key of lookupKeys) {
    const data = (modelsData as Record<string, RawModelData>)[key];
    if (data && hasUsableTokenLimits(data)) {
      return { key, data };
    }
  }

  return null;
}

/**
 * Gets model statistics for a given Vercel AI SDK model string
 * @param modelString - Format: "provider:model-name" (e.g., "anthropic:claude-opus-4-1", "ollama:gpt-oss:20b")
 * @returns ModelStats or null if model not found
 */
export function getModelStats(modelString: string): ModelStats | null {
  const entry = resolveRawModelEntry(modelString);
  return entry === null ? null : extractModelStats(entry.data);
}

export function getModelStatsResolved(
  modelString: string,
  providersConfig: ProvidersConfigMap | null
): ModelStats | null {
  const metadataModel = resolveModelForMetadata(modelString, providersConfig);
  return getModelStats(metadataModel);
}

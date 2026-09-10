/**
 * Helper functions for accumulating usage and provider metadata across multi-step tool calls.
 *
 * For multi-step tool calls, the AI SDK reports usage per-step. We need to:
 * - Sum usage across all steps for cost calculation
 * - Track last step's usage for context window display (inputTokens = actual context size)
 * - Accumulate provider-specific metadata (e.g., Anthropic cache creation tokens)
 */

import type { LanguageModelV2Usage } from "@ai-sdk/provider";

/**
 * Structural view of usage objects across AI SDK versions.
 *
 * AI SDK 7 moved `cachedInputTokens`/`reasoningTokens` into nested
 * `inputTokenDetails`/`outputTokenDetails`, and moved Anthropic cache-write
 * tokens from `providerMetadata.anthropic.cacheCreationInputTokens` into
 * `inputTokenDetails.cacheWriteTokens`. Xum persists (and sends over IPC) the
 * flat V2 shape, so live SDK usage must pass through {@link normalizeUsage}
 * before it is stored or displayed.
 */
export interface AiSdkUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  // AI SDK <= 6 flat fields (also mux's persisted shape)
  reasoningTokens?: number;
  cachedInputTokens?: number;
  // AI SDK 7 nested details
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  outputTokenDetails?: {
    textTokens?: number;
    reasoningTokens?: number;
  };
}

/**
 * Normalize an AI SDK usage object (v6 flat or v7 nested) into mux's persisted
 * flat V2 shape. Nested v7 details win when present; flat fields are kept as a
 * fallback so already-normalized/persisted usage passes through unchanged.
 */
export function normalizeUsage(usage: AiSdkUsageLike): LanguageModelV2Usage;
export function normalizeUsage(usage: AiSdkUsageLike | undefined): LanguageModelV2Usage | undefined;
export function normalizeUsage(
  usage: AiSdkUsageLike | undefined
): LanguageModelV2Usage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens,
    cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens,
  };
}

/** Cache-write tokens reported by AI SDK 7 usage (0 for v6/normalized usage). */
export function getCacheWriteTokens(usage: AiSdkUsageLike | undefined): number {
  return usage?.inputTokenDetails?.cacheWriteTokens ?? 0;
}

/**
 * Merge AI SDK 7 cache-write tokens into provider metadata under
 * `anthropic.cacheCreationInputTokens`.
 *
 * AI SDK 7 removed that field from `providerMetadata.anthropic`; mux's persisted
 * metadata schema, pricing (createDisplayUsage), and historical rows all key off
 * it, so we synthesize it from usage at ingestion instead of migrating every
 * consumer. No-op when the usage reports no cache writes.
 */
export function withCacheWriteMetadata(
  metadata: Record<string, unknown> | undefined,
  usage: AiSdkUsageLike | undefined
): Record<string, unknown> | undefined {
  const cacheWriteTokens = getCacheWriteTokens(usage);
  if (cacheWriteTokens === 0) return metadata;
  return {
    ...(metadata ?? {}),
    anthropic: {
      ...(metadata?.anthropic as Record<string, unknown> | undefined),
      cacheCreationInputTokens: cacheWriteTokens,
    },
  };
}

/**
 * Add two LanguageModelV2Usage values together.
 * Handles undefined first argument and undefined fields within usage objects.
 */
export function addUsage(
  a: LanguageModelV2Usage | undefined,
  b: LanguageModelV2Usage
): LanguageModelV2Usage {
  return {
    inputTokens: (a?.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b.outputTokens ?? 0),
    totalTokens: (a?.totalTokens ?? 0) + (b.totalTokens ?? 0),
    cachedInputTokens: (a?.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
    reasoningTokens: (a?.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
  };
}

/**
 * Accumulate provider metadata across steps for additive billing metadata.
 *
 * Anthropic cache creation tokens and xAI exact-cost ticks are reported per request/step
 * and must be summed. Other provider metadata is taken from the latest step.
 */
export function accumulateProviderMetadata(
  existing: Record<string, unknown> | undefined,
  step: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!step) return existing;
  if (!existing) return step;

  // Extract cache creation tokens from both
  const existingCacheCreate =
    (existing.anthropic as { cacheCreationInputTokens?: number } | undefined)
      ?.cacheCreationInputTokens ?? 0;
  const stepCacheCreate =
    (step.anthropic as { cacheCreationInputTokens?: number } | undefined)
      ?.cacheCreationInputTokens ?? 0;

  const totalCacheCreate = existingCacheCreate + stepCacheCreate;
  const existingXaiCostTicks =
    (existing.xai as { costInUsdTicks?: number } | undefined)?.costInUsdTicks ?? 0;
  const stepXaiCostTicks =
    (step.xai as { costInUsdTicks?: number } | undefined)?.costInUsdTicks ?? 0;
  const totalXaiCostTicks = existingXaiCostTicks + stepXaiCostTicks;

  if (totalCacheCreate === 0 && totalXaiCostTicks === 0) {
    return step;
  }

  return {
    ...step,
    ...(totalCacheCreate > 0 && {
      anthropic: {
        ...(step.anthropic as Record<string, unknown> | undefined),
        cacheCreationInputTokens: totalCacheCreate,
      },
    }),
    ...(totalXaiCostTicks > 0 && {
      xai: {
        ...(step.xai as Record<string, unknown> | undefined),
        costInUsdTicks: totalXaiCostTicks,
      },
    }),
  };
}

/**
 * Fold per-step provider metadata from an AI SDK stream result into a single
 * record via {@link accumulateProviderMetadata}.
 *
 * `streamResult.providerMetadata` alone only reflects the LAST step: on
 * multi-step tool loops it drops earlier steps' Anthropic cache-write tokens
 * (`cacheCreationInputTokens`), which then get priced as ordinary input.
 * Headless callers (status generation, memory sweeps) use this before
 * recordHeadlessUsage so cache writes price as cache-create spend.
 */
export function accumulateStepsProviderMetadata(
  steps: ReadonlyArray<{ providerMetadata?: Record<string, unknown>; usage?: AiSdkUsageLike }>
): Record<string, unknown> | undefined {
  let accumulated: Record<string, unknown> | undefined;
  for (const step of steps) {
    // AI SDK 7 reports cache writes on step usage instead of provider metadata;
    // re-inject per step so the accumulation keeps summing across steps.
    accumulated = accumulateProviderMetadata(
      accumulated,
      withCacheWriteMetadata(step.providerMetadata, step.usage)
    );
  }
  return accumulated;
}

/**
 * Gateway stream normalization utilities.
 *
 * The @ai-sdk/gateway SDK declares specificationVersion "v3", so the AI SDK
 * core expects v3-format stream events. But the mux gateway server may send
 * "finish" events with flat v2-style usage or plain string finishReason.
 * These utilities detect and convert to v3 format so the AI SDK can extract
 * usage (inputTokens, outputTokens, etc.) correctly.
 *
 * Without this normalization, asLanguageModelUsage() does usage.inputTokens.total
 * which yields undefined when inputTokens is a number (flat v2 format), causing
 * the Cost panel to show 0 tokens.
 */

/**
 * V3 specification protocol usage format (nested).
 * The AI SDK core's asLanguageModelUsage() expects this shape.
 */
export interface V3Usage {
  inputTokens: { total?: number; noCache?: number; cacheRead?: number; cacheWrite?: number };
  outputTokens: { total?: number; text?: number; reasoning?: number };
  raw?: unknown;
}

/**
 * Check whether a usage value is already in v3 nested format.
 * V3 usage has inputTokens as an object with a `total` field;
 * v2/flat usage has inputTokens as a number.
 */
export function isV3Usage(usage: unknown): usage is V3Usage {
  if (typeof usage !== "object" || usage == null) return false;
  const u = usage as Record<string, unknown>;
  return typeof u.inputTokens === "object" && u.inputTokens != null;
}

/** Options for converting flat gateway usage to v3 nested format. */
export interface FlatUsageOptions {
  /**
   * The gateway forwards each upstream provider's flat usage semantics as-is.
   * OpenAI-style flat usage reports outputTokens INCLUSIVE of reasoning, but
   * Google forwards candidatesTokenCount, which EXCLUDES thoughts. Set this for
   * google/* gateway models so text/total are derived correctly.
   */
  outputExcludesReasoning?: boolean;
}

// Non-finite counts (NaN/Infinity from a malformed gateway payload) must not
// leak into SDK usage/cost arithmetic; treat them the same as missing.
function finiteTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Convert flat (v2-style) usage to v3 nested format.
 */
export function flatUsageToV3(usage: Record<string, unknown>, options?: FlatUsageOptions): V3Usage {
  const inputTokens = finiteTokenCount(usage.inputTokens);
  const outputTokens = finiteTokenCount(usage.outputTokens);
  const cachedInputTokens = finiteTokenCount(usage.cachedInputTokens);
  const reasoningTokens = finiteTokenCount(usage.reasoningTokens);

  const outputExcludesReasoning = options?.outputExcludesReasoning === true;
  const outputTotal =
    outputExcludesReasoning && outputTokens != null
      ? outputTokens + (reasoningTokens ?? 0)
      : outputTokens;
  const outputText = outputExcludesReasoning
    ? outputTokens
    : outputTokens != null && reasoningTokens != null
      ? outputTokens - reasoningTokens
      : undefined;

  return {
    inputTokens: {
      total: inputTokens,
      noCache:
        inputTokens != null && cachedInputTokens != null
          ? inputTokens - cachedInputTokens
          : undefined,
      cacheRead: cachedInputTokens,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputTotal,
      text: outputText,
      reasoning: reasoningTokens,
    },
    raw: usage,
  };
}

/**
 * Normalize a finish-reason value to v3 format { unified, raw }.
 * The gateway server may send a plain string instead of the nested object.
 */
export function normalizeFinishReason(fr: unknown): { unified: string; raw: unknown } | undefined {
  if (fr == null) return undefined;
  if (typeof fr === "object" && "unified" in (fr as Record<string, unknown>)) {
    return fr as { unified: string; raw: unknown };
  }
  // Plain string → convert to v3 object
  const str = typeof fr === "string" ? fr : "other";
  return { unified: str === "unknown" ? "other" : str, raw: str };
}

function normalizeGatewayUsage(
  usage: unknown,
  providerMetadata: unknown,
  options?: FlatUsageOptions
): V3Usage | null | undefined {
  if (usage == null) return usage;
  const normalized = isV3Usage(usage)
    ? usage
    : flatUsageToV3(usage as Record<string, unknown>, options);

  // Gateway OpenAI responses can report cache writes only in provider metadata.
  // Recover them before SDK aggregation so writes do not appear as uncached input.
  // Explicit SDK counts take precedence, including zero, to prevent double counting.
  if (normalized.inputTokens.cacheWrite != null) return normalized;
  const metadata = providerMetadata as
    | { openai?: { usage?: { cacheWriteTokens?: unknown } } }
    | undefined;
  const cacheWrite = finiteTokenCount(metadata?.openai?.usage?.cacheWriteTokens);
  if (cacheWrite == null || cacheWrite < 0) return normalized;

  const total = finiteTokenCount(normalized.inputTokens.total);
  const cacheRead = finiteTokenCount(normalized.inputTokens.cacheRead);
  return {
    ...normalized,
    inputTokens: {
      ...normalized.inputTokens,
      cacheWrite,
      noCache: total != null ? Math.max(0, total - (cacheRead ?? 0) - cacheWrite) : undefined,
    },
  };
}

/**
 * Normalize a doGenerate result from the gateway.
 * Converts flat usage and plain-string finishReason to v3 nested format.
 */
export function normalizeGatewayGenerateResult<T extends Record<string, unknown>>(
  result: T,
  options?: FlatUsageOptions
): T {
  const normalized: Record<string, unknown> = { ...result };

  if (result.usage != null) {
    normalized.usage = normalizeGatewayUsage(result.usage, result.providerMetadata, options);
  }

  if (result.finishReason != null) {
    const fr = normalizeFinishReason(result.finishReason);
    if (fr) normalized.finishReason = fr;
  }

  return normalized as T;
}

/**
 * TransformStream that normalizes gateway SSE stream events.
 *
 * Only transforms "finish" events; all other chunks pass through unchanged.
 */
export function normalizeGatewayStreamUsage(options?: FlatUsageOptions): TransformStream {
  return new TransformStream({
    transform(chunk: unknown, controller: TransformStreamDefaultController) {
      if (typeof chunk !== "object" || chunk == null) {
        controller.enqueue(chunk);
        return;
      }

      const c = chunk as Record<string, unknown>;
      if (c.type !== "finish") {
        controller.enqueue(chunk);
        return;
      }

      const usage = normalizeGatewayUsage(c.usage, c.providerMetadata, options);

      // Normalize finishReason: convert string → { unified, raw } if needed
      const finishReason = normalizeFinishReason(c.finishReason);

      controller.enqueue({
        ...c,
        ...(usage != null && { usage }),
        ...(finishReason != null && { finishReason }),
      });
    },
  });
}

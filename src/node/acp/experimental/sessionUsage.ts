import type { Usage } from "@agentclientprotocol/sdk";

interface MuxUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

function toNonNegativeInt(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Math.trunc(value);
}

/**
 * Convert Xum usage fields into ACP's usage shape.
 *
 * Xum primarily uses inputTokens/outputTokens/totalTokens, while some integrations may still pass
 * promptTokens/completionTokens aliases.
 */
export function convertToAcpUsage(muxUsage: MuxUsageLike): Usage {
  const inputTokens = toNonNegativeInt(muxUsage.inputTokens ?? muxUsage.promptTokens);
  const outputTokens = toNonNegativeInt(muxUsage.outputTokens ?? muxUsage.completionTokens);
  const totalTokens = toNonNegativeInt(muxUsage.totalTokens ?? inputTokens + outputTokens);
  const thoughtTokens = toNonNegativeInt(muxUsage.reasoningTokens);
  const cachedReadTokens = toNonNegativeInt(muxUsage.cachedInputTokens);

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    thoughtTokens: thoughtTokens > 0 ? thoughtTokens : undefined,
    cachedReadTokens: cachedReadTokens > 0 ? cachedReadTokens : undefined,
  };
}

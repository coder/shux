import type { ProvidersConfigMap } from "@/common/orpc/types";
import { getEffectiveContextLimit } from "@/common/utils/compaction/contextLimit";
import type { CodexOauthRoutingOptions } from "@/common/utils/providers/codexOauthRouting";
import type { ChatUsageDisplay } from "./usageAggregator";

// NOTE: Provide theme-matching fallbacks so token meters render consistently
// even if a host environment doesn't define the CSS variables (e.g., an embedded UI).
export const TOKEN_COMPONENT_COLORS = {
  cached: "var(--color-token-cached, hsl(0 0% 50%))",
  cacheCreate: "var(--color-token-cache-create, hsl(140 20% 55%))",
  input: "var(--color-token-input, hsl(120 40% 35%))",
  output: "var(--color-token-output, hsl(207 100% 40%))",
  thinking: "var(--color-thinking-mode, hsl(271 76% 53%))",
} as const;

export interface TokenSegment {
  type: "cached" | "cacheCreate" | "input" | "output" | "reasoning";
  tokens: number;
  percentage: number;
  color: string;
}

export interface TokenMeterData {
  segments: TokenSegment[];
  totalTokens: number;
  maxTokens?: number;
  totalPercentage: number;
}

interface SegmentDef {
  type: TokenSegment["type"];
  key: "input" | "cached" | "cacheCreate" | "output" | "reasoning";
  color: string;
  label: string;
}

const SEGMENT_DEFS: SegmentDef[] = [
  { type: "cached", key: "cached", color: TOKEN_COMPONENT_COLORS.cached, label: "Cache Read" },
  {
    type: "cacheCreate",
    key: "cacheCreate",
    color: TOKEN_COMPONENT_COLORS.cacheCreate,
    label: "Cache Create",
  },
  { type: "input", key: "input", color: TOKEN_COMPONENT_COLORS.input, label: "Input" },
  { type: "output", key: "output", color: TOKEN_COMPONENT_COLORS.output, label: "Output" },
  {
    type: "reasoning",
    key: "reasoning",
    color: TOKEN_COMPONENT_COLORS.thinking,
    label: "Thinking",
  },
];

/**
 * Calculate token meter data. When verticalProportions is true, segments are sized
 * proportionally to the request (e.g., 50% cached, 30% input) rather than context window.
 */
export function calculateTokenMeterData(
  usage: ChatUsageDisplay | undefined,
  model: string,
  use1M: boolean,
  verticalProportions = false,
  providersConfig: ProvidersConfigMap | null = null,
  routingOptions?: CodexOauthRoutingOptions,
  effectiveContextLimit?: number | null
): TokenMeterData {
  if (!usage) {
    return {
      segments: [],
      totalTokens: 0,
      totalPercentage: 0,
      maxTokens: effectiveContextLimit ?? undefined,
    };
  }

  // Live usage keeps the accepted request limit. Idle callers omit the override.
  const maxTokens =
    (effectiveContextLimit !== undefined
      ? effectiveContextLimit
      : getEffectiveContextLimit(model, use1M, providersConfig, routingOptions)) ?? undefined;

  // Total tokens used in the request.
  // For Anthropic prompt caching, cacheCreate tokens are reported separately but still
  // count toward total input tokens for the request.
  const totalUsed =
    usage.input.tokens +
    usage.cached.tokens +
    usage.cacheCreate.tokens +
    usage.output.tokens +
    usage.reasoning.tokens;

  const toPercentage = (tokens: number) => {
    if (verticalProportions) {
      return totalUsed > 0 ? (tokens / totalUsed) * 100 : 0;
    }
    return maxTokens ? (tokens / maxTokens) * 100 : totalUsed > 0 ? (tokens / totalUsed) * 100 : 0;
  };

  const segments = SEGMENT_DEFS.filter((def) => usage[def.key].tokens > 0).map((def) => ({
    type: def.type,
    tokens: usage[def.key].tokens,
    percentage: toPercentage(usage[def.key].tokens),
    color: def.color,
  }));

  const contextPercentage = maxTokens ? (totalUsed / maxTokens) * 100 : 100;

  return {
    segments,
    totalTokens: totalUsed,
    maxTokens,
    totalPercentage: verticalProportions
      ? maxTokens
        ? (totalUsed / maxTokens) * 100
        : 0
      : contextPercentage,
  };
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`;
  }
  return tokens.toLocaleString();
}

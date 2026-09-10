/**
 * Auto-compaction threshold checking
 *
 * Determines whether auto-compaction should trigger based on current token usage
 * as a percentage of the model's context window.
 *
 * Auto-compaction triggers when:
 * - Usage data is available (has at least one API response)
 * - Model has known max_input_tokens
 * - Usage exceeds threshold (default 70%)
 *
 * Safe defaults:
 * - Returns false if no usage data (first message)
 * - Returns false if model stats unavailable (unknown model)
 * - Never triggers in edit mode (caller's responsibility to check)
 */

import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import {
  DEFAULT_AUTO_COMPACTION_THRESHOLD,
  FORCE_COMPACTION_BUFFER_PERCENT,
} from "@/common/constants/ui";
import { getEffectiveContextLimit } from "./contextLimit";
import type { CodexOauthRoutingOptions } from "@/common/utils/providers/codexOauthRouting";

/**
 * Get context window tokens (input only).
 * Output and reasoning tokens are excluded because they represent the model's
 * response, not the context window size. This prevents compaction loops with
 * Extended Thinking models where high reasoning token counts (50k+) would
 * incorrectly inflate context usage calculations.
 */
function getContextTokens(usage: ChatUsageDisplay): number {
  return usage.input.tokens + usage.cached.tokens + usage.cacheCreate.tokens;
}

export interface AutoCompactionCheckResult {
  shouldShowWarning: boolean;
  /** True when usage exceeds threshold + buffer (gives user control before force-compact) */
  shouldForceCompact: boolean;
  /** Current usage percentage - live when streaming, otherwise last completed */
  usagePercentage: number;
  thresholdPercentage: number;
  contextTokens: number;
  /** Undefined means the model limit is unknown, never unlimited. */
  maxTokens: number | undefined;
}

/**
 * Minimal usage state required for compaction checks.
 *
 * Both frontend and backend can provide this shape directly without depending on
 * renderer-only workspace store types.
 */
export interface AutoCompactionUsageState {
  totalTokens?: number;
  lastContextUsage?: ChatUsageDisplay;
  liveUsage?: ChatUsageDisplay;
}

// Show warning this many percentage points before threshold
export const WARNING_ADVANCE_PERCENT = 10;

/**
 * Check if auto-compaction should trigger based on token usage
 *
 * Uses the last usage entry (most recent API call) to calculate current context size.
 * This matches the UI token meter display and excludes historical usage from compaction,
 * preventing infinite compaction loops after the first compaction completes.
 *
 * @param usage - Current context usage state (live + last completed)
 * @param model - Current model string (optional - returns safe default if not provided)
 * @param use1M - Whether 1M context is enabled
 * @param threshold - Usage percentage threshold (0.0-1.0, default 0.7 = 70%). If >= 1.0, auto-compaction is considered disabled.
 * @param warningAdvancePercent - Show warning this many percentage points before threshold (default 10)
 * @param providersConfig - Provider config used for custom model context overrides
 * @param routingOptions - Request-level routing inputs (backend send path only)
 * @returns Check result with warning flag and usage percentage
 */
export function checkAutoCompaction(
  usage: AutoCompactionUsageState | undefined,
  model: string | null,
  use1M: boolean,
  threshold: number = DEFAULT_AUTO_COMPACTION_THRESHOLD,
  warningAdvancePercent: number = WARNING_ADVANCE_PERCENT,
  providersConfig: ProvidersConfigMap | null = null,
  routingOptions?: CodexOauthRoutingOptions
): AutoCompactionCheckResult {
  const thresholdPercentage = threshold * 100;
  const isEnabled = threshold < 1.0;

  const currentUsage = usage?.liveUsage ?? usage?.lastContextUsage;
  const contextTokens = currentUsage ? getContextTokens(currentUsage) : 0;
  const maxTokens = model
    ? (getEffectiveContextLimit(model, use1M, providersConfig, routingOptions) ?? undefined)
    : undefined;

  // Short-circuit if auto-compaction is disabled or missing required data
  if (!isEnabled || !model || !usage) {
    return {
      shouldShowWarning: false,
      shouldForceCompact: false,
      usagePercentage: 0,
      thresholdPercentage,
      contextTokens,
      maxTokens,
    };
  }

  // No max tokens known - safe default (can't calculate percentage)
  if (!maxTokens) {
    return {
      shouldShowWarning: false,
      shouldForceCompact: false,
      usagePercentage: 0,
      thresholdPercentage,
      contextTokens,
      maxTokens,
    };
  }

  // Current usage: live when streaming, else last completed
  const lastUsage = usage.lastContextUsage;

  // Usage percentage from current context (live when streaming, otherwise last completed)
  const usagePercentage = currentUsage ? (getContextTokens(currentUsage) / maxTokens) * 100 : 0;

  // Force-compact when usage exceeds threshold + buffer
  const forceCompactThreshold = thresholdPercentage + FORCE_COMPACTION_BUFFER_PERCENT;
  const shouldForceCompact = usagePercentage >= forceCompactThreshold;

  // Warning uses max of last completed and current (live when streaming)
  // This ensures warning shows when live usage spikes above threshold mid-stream
  const lastUsagePercentage = lastUsage ? (getContextTokens(lastUsage) / maxTokens) * 100 : 0;
  const shouldShowWarning =
    Math.max(lastUsagePercentage, usagePercentage) >= thresholdPercentage - warningAdvancePercent;

  return {
    shouldShowWarning,
    shouldForceCompact,
    usagePercentage,
    thresholdPercentage,
    contextTokens,
    maxTokens,
  };
}

import { countTokens, countTokensBatch } from "@/node/utils/main/tokenizer";
import { calculateTokenStats } from "@/common/utils/tokens/tokenStatsCalculator";
import type { MuxMessage } from "@/common/types/message";
import type { ChatStats } from "@/common/types/chatStats";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import assert from "@/common/utils/assert";
import { computeProvidersConfigFingerprint } from "@/common/utils/providers/configFingerprint";
import { getToolAvailabilityOptions } from "@/common/utils/tools/toolAvailability";
import { sliceMessagesForProviderFromLatestContextBoundary } from "@/common/utils/messages/compactionBoundary";
import type { SessionUsageService, SessionUsageTokenStatsCacheV1 } from "./sessionUsageService";
import { log } from "./log";
import type { AIService } from "./aiService";
import type { ProviderService } from "./providerService";

function getMaxHistorySequence(messages: MuxMessage[]): number | undefined {
  let max: number | undefined;
  for (const message of messages) {
    const seq = message.metadata?.historySequence;
    if (typeof seq !== "number") {
      continue;
    }
    if (max === undefined || seq > max) {
      max = seq;
    }
  }
  return max;
}

export class TokenizerService {
  private readonly sessionUsageService: SessionUsageService;

  // Token stats calculations can overlap for a single workspace (e.g., rapid tool events).
  // The renderer ignores outdated results client-side, but the backend must also avoid
  // persisting stale `tokenStatsCache` data if an older calculation finishes after a newer one.
  private latestCalcIdByWorkspace = new Map<string, number>();
  private nextCalcId = 0;

  constructor(
    sessionUsageService: SessionUsageService,
    private readonly aiService: Pick<AIService, "getWorkspaceMetadata">,
    private readonly providerService: Pick<ProviderService, "getConfig">
  ) {
    this.sessionUsageService = sessionUsageService;
  }

  async calculateWorkspaceStats(input: {
    workspaceId: string;
    messages: MuxMessage[];
    model: string;
  }): Promise<ChatStats> {
    const metadata = await this.aiService.getWorkspaceMetadata(input.workspaceId);
    return this.calculateStats(
      input.workspaceId,
      input.messages,
      input.model,
      this.providerService.getConfig(),
      metadata.success ? (metadata.data.parentWorkspaceId ?? null) : null
    );
  }

  /**
   * Count tokens for a single string
   */
  async countTokens(model: string, text: string): Promise<number> {
    assert(
      typeof model === "string" && model.length > 0,
      "Tokenizer countTokens requires model name"
    );
    assert(typeof text === "string", "Tokenizer countTokens requires text");
    return countTokens(model, text);
  }

  /**
   * Count tokens for a batch of strings
   */
  async countTokensBatch(model: string, texts: string[]): Promise<number[]> {
    assert(
      typeof model === "string" && model.length > 0,
      "Tokenizer countTokensBatch requires model name"
    );
    assert(Array.isArray(texts), "Tokenizer countTokensBatch requires an array of strings");
    return countTokensBatch(model, texts);
  }

  /**
   * Calculate detailed token statistics for a chat history.
   */
  async calculateStats(
    workspaceId: string,
    messages: MuxMessage[],
    model: string,
    providersConfig: ProvidersConfigMap | null = null,
    parentWorkspaceId: string | null = null
  ): Promise<ChatStats> {
    assert(
      typeof workspaceId === "string" && workspaceId.length > 0,
      "Tokenizer calculateStats requires workspaceId"
    );
    assert(Array.isArray(messages), "Tokenizer calculateStats requires an array of messages");
    assert(
      typeof model === "string" && model.length > 0,
      "Tokenizer calculateStats requires model name"
    );

    const calcId = ++this.nextCalcId;
    this.latestCalcIdByWorkspace.set(workspaceId, calcId);
    const activeContextMessages = sliceMessagesForProviderFromLatestContextBoundary(messages);

    const stats = await calculateTokenStats(
      activeContextMessages,
      model,
      providersConfig,
      getToolAvailabilityOptions({ workspaceId, parentWorkspaceId })
    );

    // Only persist the cache for the most recently-started calculation.
    // Older calculations can finish later and would otherwise overwrite a newer cache.
    if (this.latestCalcIdByWorkspace.get(workspaceId) !== calcId) {
      return stats;
    }

    const cache: SessionUsageTokenStatsCacheV1 = {
      version: 1,
      computedAt: Date.now(),
      providersConfigVersion: computeProvidersConfigFingerprint(providersConfig),
      model: stats.model,
      tokenizerName: stats.tokenizerName,
      history: {
        messageCount: activeContextMessages.length,
        maxHistorySequence: getMaxHistorySequence(activeContextMessages),
      },
      consumers: stats.consumers,
      totalTokens: stats.totalTokens,
      topFilePaths: stats.topFilePaths,
    };

    // Defensive: keep cache invariants tight so we don't persist corrupt state.
    // Prefer returning stats over crashing the UI - if something is off, log and skip persisting.
    try {
      assert(cache.totalTokens >= 0, "Tokenizer calculateStats: cache.totalTokens must be >= 0");
      assert(
        cache.history.messageCount === activeContextMessages.length,
        "Tokenizer calculateStats: cache.history.messageCount must match active context length"
      );
      for (const consumer of cache.consumers) {
        assert(
          typeof consumer.tokens === "number" && consumer.tokens >= 0,
          `Tokenizer calculateStats: consumer.tokens must be >= 0 (${consumer.name})`
        );
      }

      const sumConsumerTokens = cache.consumers.reduce((sum, consumer) => sum + consumer.tokens, 0);
      assert(
        sumConsumerTokens === cache.totalTokens,
        `Tokenizer calculateStats: totalTokens mismatch (sum=${sumConsumerTokens}, total=${cache.totalTokens})`
      );
    } catch (error) {
      log.warn("[TokenizerService] Token stats cache invariant check failed; skipping persist", {
        workspaceId,
        error,
      });
      return stats;
    }

    try {
      await this.sessionUsageService.setTokenStatsCache(workspaceId, cache);
    } catch (error) {
      log.warn("[TokenizerService] Failed to persist token stats cache", { workspaceId, error });
    }

    return stats;
  }
}

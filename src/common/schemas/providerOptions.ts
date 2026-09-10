import { z } from "zod";

import {
  CacheTtlSchema,
  ServiceTierSchema,
  XAIServiceTierSchema,
} from "../config/schemas/providersConfig";

export const MuxProviderOptionsSchema = z.object({
  anthropic: z
    .object({
      // Deprecated: prefer use1MContextModels for per-model control.
      // Kept for backward compat with agentSession auto-retry which sets it directly.
      use1MContext: z.boolean().optional().meta({
        description:
          "Enable Anthropic's beta 1M context window globally (deprecated: use use1MContextModels)",
      }),
      use1MContextModels: z.array(z.string()).optional().meta({
        description:
          "Model IDs with Anthropic beta 1M enabled (e.g. ['anthropic:claude-sonnet-4-20250514'])",
      }),
      // Anthropic prompt cache TTL. "5m" is the default (free refresh on hit).
      // "1h" costs 2× base input for cache writes but keeps the cache alive longer,
      // useful for agentic workflows where turns take >5 minutes.
      // See: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching#1-hour-cache-duration
      cacheTtl: CacheTtlSchema.nullish().meta({
        description:
          'Anthropic prompt cache TTL: "5m" (default, free refresh) or "1h" (2× write cost, longer cache)',
      }),
      disableBetaFeatures: z.boolean().optional().meta({
        description:
          "Disable Anthropic beta features (beta 1M context for older Sonnet models, prompt caching). Required for ZDR.",
      }),
    })
    .optional(),
  openai: z
    .object({
      serviceTier: ServiceTierSchema.optional().meta({
        description:
          "OpenAI service tier: priority (low-latency), flex (50% cheaper, higher latency), auto/default (standard)",
      }),
      wireFormat: z.enum(["responses", "chatCompletions"]).optional().meta({
        description:
          "OpenAI wire format: responses (default, persistence + built-in tools) or chatCompletions (legacy /chat/completions)",
      }),
      store: z.boolean().optional().meta({
        description: "Whether OpenAI stores responses. Set false for zero data retention (ZDR).",
      }),
      forceContextLimitError: z.boolean().optional().meta({
        description: "Force context limit error (used in integration tests to simulate overflow)",
      }),
      simulateToolPolicyNoop: z.boolean().optional().meta({
        description:
          "Simulate successful response without executing tools (used in tool policy tests)",
      }),
    })
    .optional(),
  google: z.record(z.string(), z.unknown()).optional(),
  ollama: z.record(z.string(), z.unknown()).optional(),
  openrouter: z.record(z.string(), z.unknown()).optional(),
  xai: z
    .object({
      serviceTier: XAIServiceTierSchema.nullish().meta({
        description:
          'xAI processing tier: "priority" requests faster processing at 2× token pricing; "default" uses standard processing',
      }),
      // Request-level escape hatch only. Frontier Grok defaults to store=false in
      // buildProviderOptions so ZDR and non-ZDR share one path (no settings UI).
      store: z.boolean().optional().meta({
        description:
          "Whether xAI stores Responses. Frontier Grok defaults to false (ZDR-safe); set true only to opt back into server storage.",
      }),
      searchParameters: z
        .object({
          mode: z.enum(["auto", "off", "on"]),
          returnCitations: z.boolean().optional(),
          fromDate: z.string().optional(),
          toDate: z.string().optional(),
          maxSearchResults: z.number().optional(),
          sources: z
            .array(
              z.discriminatedUnion("type", [
                z.object({
                  type: z.literal("web"),
                  country: z.string().optional(),
                  excludedWebsites: z.array(z.string()).optional(),
                  allowedWebsites: z.array(z.string()).optional(),
                  safeSearch: z.boolean().optional(),
                }),
                z.object({
                  type: z.literal("x"),
                  excludedXHandles: z.array(z.string()).optional(),
                  includedXHandles: z.array(z.string()).optional(),
                  postFavoriteCount: z.number().optional(),
                  postViewCount: z.number().optional(),
                  xHandles: z.array(z.string()).optional(),
                }),
                z.object({
                  type: z.literal("news"),
                  country: z.string().optional(),
                  excludedWebsites: z.array(z.string()).optional(),
                  safeSearch: z.boolean().optional(),
                }),
                z.object({
                  type: z.literal("rss"),
                  links: z.array(z.string()),
                }),
              ])
            )
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

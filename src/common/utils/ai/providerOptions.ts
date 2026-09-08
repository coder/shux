/**
 * Provider-specific request configuration for AI SDK
 *
 * Builds both `providerOptions` (thinking, reasoning) and per-request HTTP
 * `headers` (e.g. Anthropic 1M context beta) for streamText(). Both builders
 * share the same gateway-normalization logic and provider branching.
 */

import type { AnthropicProviderOptions } from "@ai-sdk/anthropic";
import type { GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
import type { OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import type { JSONValue } from "@ai-sdk/provider";
import type { ZaiLanguageModelChatOptions } from "@ai-sdk/zai";
import type {
  XaiProviderOptions,
  // Chat options alias does not include store; Responses options do (frontier Grok / ZDR).
  XaiResponsesProviderOptions,
} from "@ai-sdk/xai";
import type { ProviderName } from "@/common/constants/providers";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import type { OpenAIReasoningMode, ThinkingLevel } from "@/common/types/thinking";
import {
  getAnthropicEffort,
  anthropicRejectsDisabledThinking,
  anthropicSupportsNativeXhigh,
  ANTHROPIC_THINKING_BUDGETS,
  GEMINI_THINKING_BUDGETS,
  getOpenAIReasoningEffort,
  isGrok46Model,
  isGrokFrontierModel,
  isGlm53Model,
  isKimiK3Model,
  openaiSupportsProMode,
  OPENROUTER_REASONING_EFFORT,
} from "@/common/types/thinking";
import {
  isGeminiFlashMinimalRejectingModelName,
  isGeminiFlashThinkingLevelModelName,
} from "@/common/utils/thinking/policy";
import { openaiExplicitPromptCachingAvailable } from "@/common/utils/ai/cacheStrategy";
import { openaiProModeAvailable } from "./proMode";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";
import { log } from "@/node/services/log";
import type { MuxMessage } from "@/common/types/message";
import {
  normalizeToCanonical,
  resolveProviderOptionsNamespaceKey,
  supports1MContext,
} from "./models";
import { resolveCoderWireCanonicalModel } from "@/common/constants/coderOAuth";
import {
  customProviderWireOrigin,
  isCustomProviderConfig,
} from "@/common/utils/providers/customProviders";

// Re-export for existing consumers (aiService, providerModelFactory, tests):
// the implementations moved to browser-safe modules because this module
// imports node-only logging.
export { resolveProviderOptionsNamespaceKey } from "./models";
export { openaiProModeAvailable } from "./proMode";

/**
 * Canonical model string for OPTION/HEADER building. Same as
 * normalizeToCanonical, except Coder gateway strings
 * (coder:<instance>/<model>) are translated to the WIRE origin derived from
 * the instance's type. The request bytes for coder:prod-anthropic/<model> are
 * Anthropic-shaped, so thinking, cache, and beta-header decisions must run
 * against anthropic:<model> — keying them on the "coder" prefix silently
 * drops them, diverging from the identical model on a default-named instance.
 * Routing identity is NOT affected: only the builders in this module use this
 * translation.
 *
 * The RAW Coder identity is inspected BEFORE generic normalization: a valid
 * instance can use a canonical route name with a different type (e.g.
 * {name: "openai", type: "anthropic"}), and normalizeToCanonical would
 * rewrite coder:openai/<model> to openai:<model> from the name alone —
 * emitting OpenAI options for an Anthropic-wire request. Metadata-aware wire
 * resolution must win over the name convention (which it still falls back to
 * for unknown instances). Mirrors resolveAndCreateModel's raw-prefix shadow
 * check: a custom provider named "coder" owns the prefix,
 * and its model IDs must not get gateway wire treatment.
 */
function resolveOptionsCanonicalModel(
  modelString: string,
  providersConfig?: ProvidersConfigMap | null
): string {
  const colonIndex = modelString.indexOf(":");
  if (colonIndex === -1) {
    return normalizeToCanonical(modelString);
  }
  const prefix = modelString.slice(0, colonIndex);
  const prefixEntry = providersConfig?.[prefix];
  if (isCustomProviderConfig(prefixEntry)) {
    // Custom providers (including ones shadowing built-in ids) speak the wire
    // their providerType selects, so thinking/cache/header decisions must key
    // on that origin. Generic chat-completions providers keep their own
    // identity. Must mirror resolveAndCreateModel's wireProviderName remap.
    const wireOrigin = customProviderWireOrigin(prefixEntry.providerType);
    return wireOrigin ? `${wireOrigin}:${modelString.slice(colonIndex + 1)}` : modelString;
  }
  if (prefix !== "coder") {
    return normalizeToCanonical(modelString);
  }
  const wire = resolveCoderWireCanonicalModel(
    modelString.slice(colonIndex + 1),
    providersConfig?.coder
  );
  return wire ? `${wire.origin}:${wire.modelId}` : normalizeToCanonical(modelString);
}

/**
 * OpenRouter reasoning options
 * @see https://openrouter.ai/docs/use-cases/reasoning-tokens
 */
interface OpenRouterReasoningOptions {
  [key: string]: JSONValue | undefined;
  reasoning?: {
    enabled?: boolean;
    exclude?: boolean;
    // "max" is not in OpenRouter's generic low/medium/high set; it is the only
    // effort Kimi K3 accepts (model metadata supported_efforts: ["max"]).
    effort?: "low" | "medium" | "high" | "max";
  };
}

type OpenAICompatibleGatewayProviderOptions = Pick<
  OpenAIResponsesProviderOptions,
  "reasoningEffort"
>;

/**
 * Moonshot AI provider options (@ai-sdk/moonshotai). Kimi K3 accepts only the
 * literal "max" reasoning effort, matching the SDK's typed options schema.
 */
interface MoonshotAIProviderOptions {
  [key: string]: JSONValue | undefined;
  reasoningEffort?: "max";
}

/**
 * xAI providerOptions payload. Chat models use XaiProviderOptions; frontier Grok
 * Responses also accepts store (ZDR). Union keeps both families assignable.
 */
type XaiBuiltProviderOptions = XaiProviderOptions & Pick<XaiResponsesProviderOptions, "store">;

/**
 * Provider-specific options structure for AI SDK
 */
type ProviderOptions =
  | { anthropic: AnthropicProviderOptions }
  | { openai: OpenAIResponsesProviderOptions }
  | { google: GoogleGenerativeAIProviderOptions }
  | { openrouter: OpenRouterReasoningOptions }
  | { moonshotai: MoonshotAIProviderOptions }
  | { zai: ZaiLanguageModelChatOptions }
  | { xai: XaiBuiltProviderOptions }
  | { "github-copilot": OpenAICompatibleGatewayProviderOptions }
  | Record<string, never>; // Empty object for unsupported providers

const OPENAI_REASONING_SUMMARY_UNSUPPORTED_MODELS = new Set<string>([
  // Codex Spark rejects reasoning.summary with:
  // "Unsupported parameter: 'reasoning.summary' ...".
  "gpt-5.3-codex-spark",
]);

function supportsOpenAIReasoningSummary(modelName: string): boolean {
  return !OPENAI_REASONING_SUMMARY_UNSUPPORTED_MODELS.has(modelName);
}

function resolveAnthropic1MCapabilityModel(
  modelString: string,
  providersConfig?: ProvidersConfigMap | null
): {
  normalizedModel: string;
  capabilityModel: string;
} {
  const normalizedModel = normalizeToCanonical(modelString);
  return {
    normalizedModel,
    // Metadata resolves from the RAW identity for Coder strings: name-based
    // canonicalization rewrites cross-typed instances (coder:openai/x, type
    // anthropic) to a direct-provider string before the instance metadata
    // can map them to their real upstream.
    capabilityModel: resolveModelForMetadata(
      modelString.startsWith("coder:") ? modelString : normalizedModel,
      providersConfig ?? null
    ),
  };
}

function hasAnthropic1MIntentForModel(
  modelString: string,
  capabilityModel: string,
  muxProviderOptions?: MuxProviderOptions
): boolean {
  const anthropicOptions = muxProviderOptions?.anthropic;
  if (!anthropicOptions) {
    return false;
  }

  if (anthropicOptions.use1MContext === true) {
    return true;
  }

  const enabledModels = anthropicOptions.use1MContextModels;
  if (!enabledModels || enabledModels.length === 0) {
    return false;
  }

  const normalizedModel = normalizeToCanonical(modelString);
  const candidateModels = new Set([modelString, normalizedModel, capabilityModel]);
  return enabledModels.some((enabledModel) => candidateModels.has(enabledModel));
}

/**
 * Shared Anthropic 1M beta eligibility check used by request headers, retries, and compaction.
 *
 * Native 1M models expose their larger context through model metadata, so this helper only
 * covers the older Anthropic models that still need explicit beta intent plus the beta header.
 */
export function isAnthropic1MEffectivelyEnabled(
  modelString: string,
  muxProviderOptions?: MuxProviderOptions,
  providersConfig?: ProvidersConfigMap | null
): boolean {
  const anthropicOptions = muxProviderOptions?.anthropic;
  if (!anthropicOptions || anthropicOptions.disableBetaFeatures === true) {
    return false;
  }

  // providersConfig also flows into the gate itself: an unmappable Coder
  // instance keeps its gateway-scoped string, and only the config-aware gate
  // rejects it conclusively instead of name-normalizing it to anthropic:*.
  const { capabilityModel } = resolveAnthropic1MCapabilityModel(modelString, providersConfig);
  // Coder strings go through the gate RAW: getAnthropic1MContextMode resolves
  // the instance conclusively AND rejects wires that cannot carry the
  // anthropic-beta header (vercel/google-typed instances fronting Claude).
  // The pre-resolved capabilityModel (anthropic:*) would bypass that wire gate.
  const gateModel = modelString.startsWith("coder:") ? modelString : capabilityModel;
  if (!supports1MContext(gateModel, providersConfig)) {
    return false;
  }

  return hasAnthropic1MIntentForModel(modelString, capabilityModel, muxProviderOptions);
}

/**
 * Preserve Anthropic 1M beta intent across routed follow-ups only when the source request
 * had effective beta 1M enabled and the target model is also beta-eligible.
 */
export function preserveAnthropic1MContextForFollowUp(
  sourceModelString: string,
  targetModelString: string,
  muxProviderOptions?: MuxProviderOptions,
  providersConfig?: ProvidersConfigMap | null
): MuxProviderOptions | undefined {
  if (!muxProviderOptions) {
    return undefined;
  }

  if (!isAnthropic1MEffectivelyEnabled(sourceModelString, muxProviderOptions, providersConfig)) {
    return muxProviderOptions;
  }

  const anthropicOptions = muxProviderOptions.anthropic;
  if (!anthropicOptions) {
    return muxProviderOptions;
  }

  const { capabilityModel } = resolveAnthropic1MCapabilityModel(targetModelString, providersConfig);
  if (!supports1MContext(capabilityModel, providersConfig)) {
    return muxProviderOptions;
  }

  return {
    ...muxProviderOptions,
    anthropic: {
      ...anthropicOptions,
      use1MContext: true,
    },
  };
}

/**
 * Build provider-specific options for AI SDK based on thinking level
 *
 * This function configures provider-specific options for supported providers:
 * 1. Enable reasoning traces (transparency into model's thought process)
 * 2. Set reasoning level (control depth of reasoning based on task complexity)
 * 3. Enable parallel tool calls (allow concurrent tool execution)
 * 4. Keep provider-specific request knobs consistent with Xum's explicit history model
 *
 * @param modelString - Full model string (e.g., "anthropic:claude-opus-4-1")
 * @param thinkingLevel - Unified thinking level (must be pre-clamped via enforceThinkingPolicy)
 * @param messages - Conversation history being sent to the provider
 * @param _lostResponseIds - Reserved for OpenAI response-state recovery filtering
 * @param muxProviderOptions - Optional provider overrides from config
 * @param workspaceId - Optional for non-OpenAI providers
 * @param openaiTruncationMode - Optional truncation mode for OpenAI responses (auto/disabled)
 * @param providersConfig - Optional providers config for mapped model capability detection
 * @param routeProvider - Optional route provider (gateway/direct) for SDK format selection
 * @param promptCacheScope - Optional stable project-scoped cache routing key
 * @param reasoningMode - Optional OpenAI Responses reasoning mode
 * @returns Provider options object for AI SDK
 */
export function buildProviderOptions(
  modelString: string,
  thinkingLevel: ThinkingLevel,
  messages?: MuxMessage[],
  _lostResponseIds?: (id: string) => boolean,
  muxProviderOptions?: MuxProviderOptions,
  workspaceId?: string, // Optional for non-OpenAI providers
  openaiTruncationMode?: OpenAIResponsesProviderOptions["truncation"],
  providersConfig?: ProvidersConfigMap | null,
  routeProvider?: ProviderName,
  promptCacheScope?: string,
  reasoningMode?: OpenAIReasoningMode
): ProviderOptions {
  // Caller is responsible for enforcing thinking policy before calling this function.
  // agentSession.ts is the canonical enforcement point.
  const effectiveThinking = thinkingLevel;
  // Parse origin from normalized model string
  const normalizedModel = resolveOptionsCanonicalModel(modelString, providersConfig);
  const [origin, modelName] = normalizedModel.split(":", 2);

  if (!origin || !modelName) {
    log.debug("buildProviderOptions: No origin or model name found, returning empty");
    return {};
  }

  const providerOptionsNamespaceKey = resolveProviderOptionsNamespaceKey(origin, routeProvider);

  // SDK payload-family selection: passthrough gateways use origin payloads,
  // while transforming gateways use the route provider's payload schema.
  const formatProvider =
    providerOptionsNamespaceKey === origin ? origin : (routeProvider ?? origin);

  // Resolve aliases to their base model for capability detection while keeping
  // the original modelString for provider routing and metadata lookups.
  // Custom-provider model entries (mappedToModel aliases) live under the raw
  // custom prefix; the wire-remapped identity above is only for namespace and
  // payload-format selection, so metadata must resolve from the raw identity.
  const rawPrefixForMetadata = modelString.slice(0, Math.max(modelString.indexOf(":"), 0));
  const metadataModel = isCustomProviderConfig(providersConfig?.[rawPrefixForMetadata])
    ? modelString
    : normalizedModel;
  const capabilityModel = resolveModelForMetadata(metadataModel, providersConfig ?? null);
  const [, resolvedCapabilityModelName] = capabilityModel.split(":", 2);
  const capModelName = resolvedCapabilityModelName || modelName;

  log.debug("buildProviderOptions", {
    modelString,
    origin,
    routeProvider,
    providerOptionsNamespaceKey,
    formatProvider,
    modelName,
    capabilityModel,
    capModelName,
    thinkingLevel,
  });

  // Build Anthropic-specific options
  if (formatProvider === "anthropic") {
    // Anthropic prompt caching is already applied on Xum's manual cache markers
    // (cached system message, conversation tail, last tool) deeper in the
    // request pipeline. Do not also send top-level cacheControl here: the SDK
    // serializes it to a top-level cache_control block, which adds an extra
    // breakpoint on direct Anthropic requests.

    // Opus 4.5+, Sonnet 4.6, and Sonnet 5 use the effort parameter for reasoning control.
    // Opus 4.6+ / Sonnet 4.6 / Sonnet 5 use adaptive thinking (model decides when/how much).
    // Opus 4.5 uses enabled thinking with a budgetTokens ceiling.
    const isOpus45 = capModelName?.includes("opus-4-5") ?? false;
    const isOpus46 = capModelName?.includes("opus-4-6") ?? false;
    // Opus 4.7+ and Sonnet 5+ — the native-xhigh tier, which also uses adaptive thinking.
    const supportsNativeXhigh = anthropicSupportsNativeXhigh(capabilityModel);
    const isSonnet46 = capModelName?.includes("sonnet-4-6") ?? false;
    const usesAdaptiveThinking = isOpus46 || supportsNativeXhigh || isSonnet46;

    if (isOpus45 || usesAdaptiveThinking) {
      // Model-aware effort: native-xhigh models (Opus 4.7+ / Sonnet 5+ / Mythos)
      // get the native "xhigh" wire value; other adaptive models keep xhigh → "max".
      const effortLevel = getAnthropicEffort(effectiveThinking, capabilityModel);
      const budgetTokens = ANTHROPIC_THINKING_BUDGETS[effectiveThinking];
      // Opus 4.6+ / Sonnet 4.6 / Sonnet 5: adaptive thinking when on, disabled when off
      // Opus 4.5: enabled thinking with budgetTokens ceiling (only when not "off")
      // Mythos-class (Fable/Mythos) rejects `{ type: "disabled" }`. The thinking policy
      // excludes "off" for them and AIService clamps the effective level via
      // resolveEffectiveThinkingLevel, so "off" should not reach here — but if a stray
      // path does, omit `thinking` (API defaults to adaptive) rather than hard-erroring.
      //
      // Opus 5 rejects disabled thinking above high effort. "off" maps to low,
      // so this branch cannot produce that invalid combination.
      //
      // Native-xhigh models require `thinking.display: "summarized"` to return
      // thinking content on adaptive requests; non-native adaptive models
      // (Opus 4.6 / Sonnet 4.6) must not receive `display`.
      // See https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking#summarized-thinking
      const thinking: AnthropicProviderOptions["thinking"] = usesAdaptiveThinking
        ? effectiveThinking === "off"
          ? anthropicRejectsDisabledThinking(capabilityModel)
            ? undefined
            : { type: "disabled" }
          : supportsNativeXhigh
            ? { type: "adaptive", display: "summarized" }
            : { type: "adaptive" }
        : budgetTokens > 0
          ? { type: "enabled", budgetTokens }
          : undefined;

      log.debug("buildProviderOptions: Anthropic effort model config", {
        effort: effortLevel,
        thinking,
        thinkingLevel: effectiveThinking,
      });

      const anthropicOptions: AnthropicProviderOptions = {
        disableParallelToolUse: false,
        sendReasoning: true,
        ...(thinking && { thinking }),
        effort: effortLevel,
      };

      return { anthropic: anthropicOptions };
    }

    // Other Anthropic models: Use thinking parameter with budgetTokens
    const budgetTokens = ANTHROPIC_THINKING_BUDGETS[effectiveThinking];
    log.debug("buildProviderOptions: Anthropic config", {
      budgetTokens,
      thinkingLevel: effectiveThinking,
    });

    const options = {
      anthropic: {
        disableParallelToolUse: false, // Always enable concurrent tool execution
        sendReasoning: true, // Include reasoning traces in requests sent to the model
        // Conditionally add thinking configuration (non-Opus 4.5 models)
        ...(budgetTokens > 0 && {
          thinking: {
            type: "enabled",
            budgetTokens,
          },
        }),
      },
    } satisfies { anthropic: AnthropicProviderOptions };
    log.debug("buildProviderOptions: Returning Anthropic options", options);
    return options;
  }

  // Build OpenAI-specific options
  if (formatProvider === "openai") {
    // Model-aware: native-max models (the GPT-5.6 family and GPT-6 Astra, see
    // openaiSupportsNativeMaxEffort) map ThinkingLevel "max" to the native "max"
    // effort; other OpenAI models keep the max -> "xhigh" downgrade. Use
    // capabilityModel so mapped aliases (mappedToModel) inherit their target's
    // native effort. @ai-sdk/openai 4.0.11 accepts native max on both Responses
    // and Chat Completions, so both wire formats now preserve the selected level.
    // GPT-5.6 "off" remains explicit "none" because omission defaults to medium;
    // Astra rejects "none", so its "off" clamps to "low".
    const reasoningEffort = getOpenAIReasoningEffort(effectiveThinking, capabilityModel);

    // Xum always sends the latest conversation history explicitly. OpenAI's
    // previous_response_id is an alternative state-management path, not an additive one.
    // Chaining it on top of explicit history double-counts prior turns and caused GPT-5.4
    // requests to hit context_exceeded far below the documented native window.

    // Prompt cache key: prefer a unique project-scoped routing key over the
    // workspace-scoped fallback so sibling workspaces (parent + subagents) on
    // the same project share OpenAI's server-side KV cache without colliding
    // with unrelated repos that happen to share the same basename.
    const cacheScope = promptCacheScope ?? workspaceId;
    const promptCacheKey = cacheScope ? `mux-v1-${cacheScope}` : undefined;

    const serviceTier = muxProviderOptions?.openai?.serviceTier;
    const wireFormat = muxProviderOptions?.openai?.wireFormat ?? "responses";
    const store = muxProviderOptions?.openai?.store;
    const isResponses = wireFormat === "responses";
    const routeIsDirect = routeProvider == null || routeProvider === origin;
    const shouldUseProMode =
      isResponses &&
      reasoningMode === "pro" &&
      (routeIsDirect
        ? openaiSupportsProMode(capabilityModel)
        : routeProvider === "coder" &&
          // The route-aware gate preserves scoped aliases without treating an
          // alias's capability identity as the Coder instance's wire type.
          openaiProModeAvailable(modelString, {
            providersConfig,
            resolvedRouteProvider: routeProvider,
          }));
    const truncationMode = openaiTruncationMode ?? "disabled";
    const shouldSendReasoningSummary = supportsOpenAIReasoningSummary(capModelName);

    log.debug("buildProviderOptions: OpenAI config", {
      reasoningEffort,
      shouldSendReasoningSummary,
      thinkingLevel: effectiveThinking,
      historyMessages: messages?.length ?? 0,
      promptCacheKey,
      reasoningMode: shouldUseProMode ? "pro" : undefined,
      truncation: truncationMode,
      wireFormat,
    });

    const options = {
      openai: {
        parallelToolCalls: true, // Always enable concurrent tool execution
        ...(serviceTier != null && { serviceTier }),
        ...(store != null && { store }), // ZDR: pass store flag through to OpenAI SDK
        ...(isResponses && {
          // Default to disabled; allow auto truncation for compaction to avoid context errors
          truncation: truncationMode,
          // Pro mode is a native Responses option in @ai-sdk/openai 4.0.11.
          // Direct OpenAI and Coder Responses forward it; mux-gateway drops
          // this provider option and Codex OAuth strips it.
          ...(shouldUseProMode && { reasoningMode: "pro" as const }),
          // Stable prompt cache key to improve OpenAI cache hit rates
          // See: https://sdk.vercel.ai/providers/ai-sdk-providers/openai#responses-models
          ...(promptCacheKey && { promptCacheKey }),
        }),
        // Chat Completions gets the same stable routing key only for GPT-5.6
        // on the direct official OpenAI API (the stricter explicit-caching
        // gate). The broader legacy Responses behavior above stays unchanged.
        ...(!isResponses &&
          promptCacheKey &&
          openaiExplicitPromptCachingAvailable(
            modelString,
            routeProvider,
            providersConfig ?? null,
            {
              openaiWireFormat: wireFormat,
            }
          ) && { promptCacheKey }),
        // Conditionally add reasoning configuration
        ...(reasoningEffort && {
          reasoningEffort,
          // AI SDK 7 defaults reasoningSummary to "detailed" whenever a
          // reasoning effort is set, so models that reject the parameter must
          // explicitly opt out with null.
          ...(isResponses && {
            reasoningSummary: shouldSendReasoningSummary ? ("detailed" as const) : null,
          }),
          ...(isResponses && {
            // Include reasoning encrypted content to preserve reasoning context across conversation steps
            // Required when using reasoning models (gpt-5, o3, o4-mini) with tool calls
            // See: https://sdk.vercel.ai/providers/ai-sdk-providers/openai#responses-models
            include: ["reasoning.encrypted_content"],
          }),
        }),
      },
    } satisfies { openai: OpenAIResponsesProviderOptions };
    log.info("buildProviderOptions: Returning OpenAI options", options);
    return options;
  }

  // Build Google-specific options
  if (formatProvider === "google") {
    const capBareModelName = capModelName.split("/").at(-1) ?? capModelName;
    const usesGeminiThinkingLevelConfig = capBareModelName.includes("gemini-3");
    const isGeminiFlashThinkingModel = isGeminiFlashThinkingLevelModelName(capBareModelName);
    let thinkingConfig: GoogleGenerativeAIProviderOptions["thinkingConfig"];

    if (isGeminiFlashThinkingModel && effectiveThinking === "off") {
      // Gemini Flash chat models default to medium and do not support true thinking-off;
      // send minimal explicitly so Xum's "off" setting means lowest-effort behavior.
      // Gemini 3.8 Flash rejects "minimal" with a 400 (policy already excludes "off");
      // clamp to "low" here too so a caller bypassing policy cannot trigger the error.
      thinkingConfig = isGeminiFlashMinimalRejectingModelName(capBareModelName)
        ? { includeThoughts: true, thinkingLevel: "low" }
        : { thinkingLevel: "minimal" };
    } else if (effectiveThinking !== "off") {
      thinkingConfig = {
        includeThoughts: true,
      };

      if (usesGeminiThinkingLevelConfig) {
        // Policy enforcement should clamp to valid Google levels before this adapter runs.
        // Avoid leaking xhigh/max to Google if a caller bypasses policy.
        thinkingConfig.thinkingLevel =
          effectiveThinking === "xhigh" || effectiveThinking === "max" ? "high" : effectiveThinking;
      } else {
        // Gemini 2.5 uses thinkingBudget
        const budget = GEMINI_THINKING_BUDGETS[effectiveThinking];
        if (budget > 0) {
          thinkingConfig.thinkingBudget = budget;
        }
      }
    }

    const options = {
      google: {
        thinkingConfig,
      },
    } satisfies { google: GoogleGenerativeAIProviderOptions };
    log.debug("buildProviderOptions: Google options", options);
    return options;
  }

  // Build Moonshot-specific options
  if (formatProvider === "moonshotai") {
    // Kimi K3 always reasons and supports only the max reasoning effort. Send it
    // explicitly rather than relying on the API default.
    if (isKimiK3Model(capabilityModel)) {
      const options = {
        moonshotai: { reasoningEffort: "max" },
      } satisfies { moonshotai: MoonshotAIProviderOptions };
      log.debug("buildProviderOptions: Returning Moonshot options", options);
      return options;
    }
    return {};
  }

  // Build Z.ai-specific options
  if (formatProvider === "zai") {
    if (!isGlm53Model(capabilityModel)) {
      return {};
    }

    const reasoningEffort: ZaiLanguageModelChatOptions["reasoningEffort"] =
      effectiveThinking === "max"
        ? "max"
        : effectiveThinking === "high" || effectiveThinking === "xhigh"
          ? "high"
          : "low";
    const options = {
      zai: {
        thinking: { type: "enabled" },
        reasoningEffort,
        toolStream: true,
      },
    } satisfies { zai: ZaiLanguageModelChatOptions };
    log.debug("buildProviderOptions: Returning Z.ai options", options);
    return options;
  }

  // Build OpenRouter-specific options
  if (formatProvider === "openrouter") {
    // Kimi K3 always reasons and supports only the max reasoning effort. Send it
    // explicitly: `enabled: true` alone falls back to OpenRouter's default (medium)
    // effort, which the model does not support.
    const reasoningEffort = isKimiK3Model(capabilityModel)
      ? "max"
      : OPENROUTER_REASONING_EFFORT[effectiveThinking];

    log.debug("buildProviderOptions: OpenRouter config", {
      reasoningEffort,
      thinkingLevel: effectiveThinking,
    });

    // Only add reasoning config if thinking is enabled
    if (reasoningEffort) {
      const options = {
        openrouter: {
          reasoning: {
            enabled: true,
            effort: reasoningEffort,
            // Don't exclude reasoning content - we want to display it in the UI
            exclude: false,
          },
        },
      } satisfies { openrouter: OpenRouterReasoningOptions };
      log.debug("buildProviderOptions: Returning OpenRouter options", options);
      return options;
    }

    // No reasoning config needed when thinking is off
    log.debug("buildProviderOptions: OpenRouter (thinking off, no provider options)");
    return {};
  }

  // Build xAI-specific options
  if (formatProvider === "xai") {
    // serviceTier is applied by providerModelFactory's fetch wrapper because the
    // current xAI AI SDK provider does not expose service_tier as a typed option.
    const {
      serviceTier: _serviceTier,
      searchParameters,
      store,
      ...overrides
    } = muxProviderOptions?.xai ?? {};
    const isGrokFrontier = isGrokFrontierModel(capabilityModel);
    // Grok 4.6 supports native xhigh effort; Grok 4.5 tops out at high.
    const topEffort = isGrok46Model(capabilityModel) ? "xhigh" : "high";
    const reasoningEffort: XaiProviderOptions["reasoningEffort"] = isGrokFrontier
      ? effectiveThinking === "xhigh" || effectiveThinking === "max"
        ? topEffort
        : effectiveThinking === "off"
          ? "low"
          : effectiveThinking
      : undefined;

    const defaultSearchParameters: XaiProviderOptions["searchParameters"] = {
      mode: "auto",
      returnCitations: true,
    };

    // Frontier Grok Responses: always prefer store=false.
    // Xum already resends full history explicitly and persists encrypted reasoning
    // client-side, so server storage is unnecessary. Forcing store=false means ZDR
    // and non-ZDR orgs share one code path and one quality bar (no settings surface).
    // Explicit muxProviderOptions.xai.store still wins for tests/escapes.
    const effectiveStore = isGrokFrontier ? (store ?? false) : store;

    const options = {
      xai: {
        ...overrides,
        ...(reasoningEffort != null && { reasoningEffort }),
        ...(effectiveStore != null && { store: effectiveStore }),
        // Frontier Grok uses xAI's modern Responses tools; getToolsForModel translates
        // legacy Live Search settings instead of sending deprecated search_parameters.
        ...(!isGrokFrontier && {
          searchParameters: searchParameters ?? defaultSearchParameters,
        }),
      },
    } satisfies { xai: XaiBuiltProviderOptions };
    log.debug("buildProviderOptions: Returning xAI options", options);
    return options;
  }

  if (origin === "openai" && formatProvider !== origin) {
    // capabilityModel keeps mapped aliases consistent with raw ids on the same route.
    // Copilot's Chat Completions upstream has not published native-max or
    // explicit-none support, so degrade native-max models' (GPT-5.6 family, GPT-6
    // Astra) "max" to xhigh (the pre-5.6 top effort) and GPT-5.6's "none" back to
    // omission instead of risking a rejection.
    const nativeReasoningEffort = getOpenAIReasoningEffort(effectiveThinking, capabilityModel);
    const reasoningEffort =
      nativeReasoningEffort === "max"
        ? "xhigh"
        : nativeReasoningEffort === "none"
          ? undefined
          : nativeReasoningEffort;
    if (!reasoningEffort) {
      log.debug(
        "buildProviderOptions: OpenAI-compatible gateway (thinking off, no provider options)",
        {
          formatProvider,
          origin,
          routeProvider,
          providerOptionsNamespaceKey,
        }
      );
      return {};
    }

    const options = {
      "github-copilot": {
        reasoningEffort,
      },
    } satisfies { "github-copilot": OpenAICompatibleGatewayProviderOptions };
    log.debug("buildProviderOptions: Returning OpenAI-compatible gateway options", options);
    return options;
  }

  // No provider-specific options for unsupported providers
  log.debug("buildProviderOptions: Unsupported format provider", {
    formatProvider,
    origin,
    routeProvider,
    providerOptionsNamespaceKey,
  });
  return {};
}

// ---------------------------------------------------------------------------
// Per-request HTTP headers
// ---------------------------------------------------------------------------

/** Header value for Anthropic 1M context beta */
export const ANTHROPIC_1M_CONTEXT_HEADER = "context-1m-2025-08-07";

/**
 * HTTP header sent on AI requests for workspace-level observability.
 * The JS symbol can stay Xum-branded; the wire value remains X-Mux-Workspace-Id
 * so mux-gateway and existing correlation pipelines keep matching.
 */
export const MUX_WORKSPACE_ID_HEADER = "X-Mux-Workspace-Id";

const HTTP_HEADER_VALUE_SAFE_PATTERN = /^[\t\x20-\x7E\x80-\xFF]+$/;

/**
 * Encode workspace IDs that contain non-header-safe bytes.
 *
 * Legacy workspace IDs may include non-Latin-1 characters (e.g., emoji from
 * project/workspace names). Fetch rejects such header values, which would abort
 * the request before it reaches the provider. We keep safe IDs unchanged for
 * readability and encode unsafe ones into a stable URL-safe base64 form.
 */
function toWorkspaceHeaderValue(workspaceId: string): string {
  if (HTTP_HEADER_VALUE_SAFE_PATTERN.test(workspaceId)) {
    return workspaceId;
  }

  return `b64:${Buffer.from(workspaceId, "utf8").toString("base64url")}`;
}

/**
 * Build per-request HTTP headers for provider-specific features.
 *
 * These flow through streamText({ headers }) to the provider SDK, which merges
 * them with provider-creation-time headers via combineHeaders(). This is the
 * single injection site for headers like the workspace correlation header and
 * Anthropic's 1M context beta header, regardless of direct vs gateway routing.
 */
export function buildRequestHeaders(
  modelString: string,
  muxProviderOptions?: MuxProviderOptions,
  workspaceId?: string,
  providersConfig?: ProvidersConfigMap | null,
  routeProvider?: ProviderName
): Record<string, string> | undefined {
  const headers: Record<string, string> = {};

  if (workspaceId != null) {
    headers[MUX_WORKSPACE_ID_HEADER] = toWorkspaceHeaderValue(workspaceId);
  }

  const normalized = resolveOptionsCanonicalModel(modelString, providersConfig);
  const [origin] = normalized.split(":", 2);

  // 1M context header — only when origin supports it AND route is passthrough (or direct)
  const routePassesHeaders =
    origin != null && resolveProviderOptionsNamespaceKey(origin, routeProvider) === origin;

  if (
    origin === "anthropic" &&
    routePassesHeaders &&
    // Wire origin gates WHICH header can be attached; capability is
    // evaluated on the RAW identity. The wire-canonical string mangles
    // metadata-divergent instances (coder:bedrock/anthropic.claude-* becomes
    // anthropic:anthropic.claude-*, which the anchored Claude patterns
    // reject), while the raw string resolves through the provider-type-aware
    // metadata identity — matching the UI/compaction gates AND the raw-keyed
    // per-model 1M intent toggles.
    isAnthropic1MEffectivelyEnabled(modelString, muxProviderOptions, providersConfig)
  ) {
    headers["anthropic-beta"] = ANTHROPIC_1M_CONTEXT_HEADER;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

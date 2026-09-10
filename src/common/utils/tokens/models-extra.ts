/**
 * Extra models not yet in LiteLLM's official models.json
 * This file is consulted as a fallback when a model is not found in the main file.
 * Models should be removed from here once they appear in the upstream LiteLLM repository.
 */

interface ModelData {
  max_input_tokens: number;
  max_output_tokens?: number;
  input_cost_per_token: number;
  output_cost_per_token: number;
  input_cost_per_image_token?: number;
  output_cost_per_image_token?: number;
  cache_read_input_image_token_cost?: number;
  input_cost_per_token_above_200k_tokens?: number;
  output_cost_per_token_above_200k_tokens?: number;
  cache_creation_input_token_cost?: number;
  cache_creation_input_token_cost_above_200k_tokens?: number;
  cache_read_input_token_cost?: number;
  cache_read_input_token_cost_above_200k_tokens?: number;
  // LiteLLM's upstream schema hard-codes the field suffix `_above_200k_tokens`, but
  // some providers publish a different long-context boundary. Omit this to keep the
  // historical 200K default; set it explicitly when the provider documents another cutoff.
  tiered_pricing_threshold_tokens?: number;
  litellm_provider?: string;
  mode?: string;
  supports_function_calling?: boolean;
  supports_vision?: boolean;
  supports_pdf_input?: boolean;
  supports_audio_input?: boolean;
  supports_video_input?: boolean;
  max_pdf_size_mb?: number;
  supports_reasoning?: boolean;
  supports_response_schema?: boolean;
  knowledge_cutoff?: string;
  supported_endpoints?: string[];
}

// GPT-5.6 Sol - Released July 9, 2026 (flagship tier of the GPT-5.6 family).
// GA model page: 1.05M context window, 128K max output, Feb 16 2026 cutoff.
// Base pricing: $5/M input, $30/M output, $0.50/M cached input; cache writes
// billed at 1.25x the active input rate ($6.25/M base). Prompts above 272K
// input tokens bill the full request at 2x input / 1.5x output: $10/M input,
// $45/M output, $1/M cached input, $12.50/M cache writes.
// Shared const: the bare "gpt-5.6" alias is a servable id that OpenAI routes
// to Sol (the response echoes model gpt-5.6-sol), so both ids resolve to the
// same stats — otherwise token meters/compaction/pricing treat the documented
// bare alias as unknown.
const GPT_56_SOL_STATS: ModelData = {
  max_input_tokens: 1050000,
  max_output_tokens: 128000,
  input_cost_per_token: 0.000005, // $5 per million input tokens (<272K prompt tokens)
  input_cost_per_token_above_200k_tokens: 0.00001, // $10 per million input tokens (>272K)
  output_cost_per_token: 0.00003, // $30 per million output tokens (<272K prompt tokens)
  output_cost_per_token_above_200k_tokens: 0.000045, // $45 per million output tokens (>272K)
  cache_read_input_token_cost: 0.0000005, // $0.50 per million cached input tokens (<272K)
  cache_read_input_token_cost_above_200k_tokens: 0.000001, // $1 per million cached input tokens (>272K)
  cache_creation_input_token_cost: 0.00000625, // $6.25 per million tokens (1.25x input)
  cache_creation_input_token_cost_above_200k_tokens: 0.0000125, // $12.50 per million tokens (1.25x long-context input)
  // OpenAI's published long-context boundary is 272K even though LiteLLM's field names say 200K.
  tiered_pricing_threshold_tokens: 272000,
  litellm_provider: "openai",
  mode: "chat",
  supports_function_calling: true,
  supports_vision: true,
  supports_reasoning: true,
  supports_response_schema: true,
  knowledge_cutoff: "2026-02-16",
};

export const modelsExtra: Record<string, ModelData> = {
  // Grok 4.6 - Released August 12, 2026. xAI's frontier coding and agentic model.
  // Same $2/$6 headline rates as Grok 4.5 but a higher cached-input rate ($0.50 vs
  // $0.30). Pricing doubles for prompts above 200K tokens; Priority Processing is a
  // separate request-time 2× multiplier and is therefore not baked into these rates.
  "xai/grok-4.6": {
    max_input_tokens: 500000,
    // Leave max_output_tokens unset: StreamManager forwards it as the request
    // maxOutputTokens default, and xAI publishes no output limit for grok-4.6.
    input_cost_per_token: 0.000002, // $2 per million input tokens
    input_cost_per_token_above_200k_tokens: 0.000004, // $4 per million input tokens
    output_cost_per_token: 0.000006, // $6 per million output tokens
    output_cost_per_token_above_200k_tokens: 0.000012, // $12 per million output tokens
    cache_read_input_token_cost: 0.0000005, // $0.50 per million cached input tokens
    cache_read_input_token_cost_above_200k_tokens: 0.000001, // $1 per million cached input tokens
    litellm_provider: "xai",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_reasoning: true,
    supports_response_schema: true,
    knowledge_cutoff: "2026-02-01",
    supported_endpoints: ["/v1/chat/completions", "/v1/responses"],
  },

  // Grok 4.5 - Released July 2026. Superseded by Grok 4.6 as the curated xAI model;
  // still servable as the custom model string `xai:grok-4.5`.
  // Pricing doubles for prompts above 200K tokens; Priority Processing applies a
  // separate 2× multiplier at request time and is therefore not baked into these rates.
  "xai/grok-4.5": {
    max_input_tokens: 500000,
    // Leave max_output_tokens unset: StreamManager forwards it as the request
    // maxOutputTokens default. The published 500K figure is the context window,
    // not a verified generation cap, so inventing one can reject nonempty prompts.
    input_cost_per_token: 0.000002, // $2 per million input tokens
    input_cost_per_token_above_200k_tokens: 0.000004, // $4 per million input tokens
    output_cost_per_token: 0.000006, // $6 per million output tokens
    output_cost_per_token_above_200k_tokens: 0.000012, // $12 per million output tokens
    cache_read_input_token_cost: 0.0000003, // $0.30 per million cached input tokens
    cache_read_input_token_cost_above_200k_tokens: 0.0000006, // $0.60 per million cached input tokens
    litellm_provider: "xai",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_reasoning: true,
    supports_response_schema: true,
    supported_endpoints: ["/v1/chat/completions", "/v1/responses"],
  },

  // GPT Image 2 - image-generation model not yet in LiteLLM's bundled models.json.
  // OpenAI prices text input at $5/M tokens, image input at $8/M, cached text input at
  // $1.25/M, cached image input at $2/M, and generated image output at $30/M.
  "gpt-image-2": {
    max_input_tokens: 32000,
    input_cost_per_token: 0.000005, // $5 per million text input tokens
    cache_read_input_token_cost: 0.00000125, // $1.25 per million cached text input tokens
    input_cost_per_image_token: 0.000008, // $8 per million image input tokens
    cache_read_input_image_token_cost: 0.000002, // $2 per million cached image input tokens
    output_cost_per_image_token: 0.00003, // $30 per million generated image output tokens
    output_cost_per_token: 0.00003, // Xum maps image output tokens through outputTokens.
    litellm_provider: "openai",
    mode: "image_generation",
    supported_endpoints: ["/v1/images/generations"],
    supports_vision: true,
    supports_pdf_input: true,
  },

  // Claude Fable 5.1 - successor to Fable 5 in the Mythos-class tier at the same
  // input/output pricing: $10/M input, $50/M output, cache write 1.25x input. Cache
  // reads are cheaper than Fable 5 at $0.25/M (0.025x input, a quarter of the old
  // 0.1x ratio). Native 1M context, 128K max output, native xhigh effort level.
  "claude-fable-5-1": {
    max_input_tokens: 1000000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.00001, // $10 per million input tokens
    output_cost_per_token: 0.00005, // $50 per million output tokens
    cache_creation_input_token_cost: 0.0000125, // $12.50 per million tokens (1.25× input)
    cache_read_input_token_cost: 0.00000025, // $0.25 per million tokens (0.025× input)
    litellm_provider: "anthropic",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_pdf_input: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },

  // Claude Fable 5 / Mythos 5 - Released June 9, 2026
  // Mythos-class model (a tier above Opus). Fable 5 (`claude-fable-5`) is the
  // generally-available variant with safeguards; Mythos 5 (`claude-mythos-5`) is the same
  // underlying model with some safeguards lifted, restricted to trusted-access partners.
  // Both are priced identically: $10/M input, $50/M output. Cache pricing is inferred from
  // Anthropic's standard ratios (cache write 1.25× input, cache read 0.1× input), matching
  // the Opus 4.x shape. Native 1M context, 128K max output, native xhigh effort level.
  "claude-fable-5": {
    max_input_tokens: 1000000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.00001, // $10 per million input tokens
    output_cost_per_token: 0.00005, // $50 per million output tokens
    cache_creation_input_token_cost: 0.0000125, // $12.50 per million tokens (1.25× input)
    cache_read_input_token_cost: 0.000001, // $1.00 per million tokens (0.1× input)
    litellm_provider: "anthropic",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_pdf_input: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },

  // Claude Mythos 5.1 - successor to Mythos 5, the restricted-access (Project
  // Glasswing) twin of Fable 5.1 with identical announced specs and pricing:
  // $10/M input, $50/M output, cache write 1.25x input, cache read 0.025x input
  // ($0.25/M, down from Mythos 5's 0.1x), native 1M context, 128K max output,
  // native xhigh effort level.
  "claude-mythos-5-1": {
    max_input_tokens: 1000000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.00001, // $10 per million input tokens
    output_cost_per_token: 0.00005, // $50 per million output tokens
    cache_creation_input_token_cost: 0.0000125, // $12.50 per million tokens (1.25× input)
    cache_read_input_token_cost: 0.00000025, // $0.25 per million tokens (0.025× input)
    litellm_provider: "anthropic",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_pdf_input: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },

  // Same underlying model as Fable 5 (identical pricing/shape); restricted access.
  "claude-mythos-5": {
    max_input_tokens: 1000000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.00001, // $10 per million input tokens
    output_cost_per_token: 0.00005, // $50 per million output tokens
    cache_creation_input_token_cost: 0.0000125, // $12.50 per million tokens (1.25× input)
    cache_read_input_token_cost: 0.000001, // $1.00 per million tokens (0.1× input)
    litellm_provider: "anthropic",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_pdf_input: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },

  // Claude Opus 5 - Released July 24, 2026
  // Same pricing/shape as Opus 4.8: $5/M input, $25/M output, native 1M context
  // (both default and maximum), 128K max output, full effort ladder with native
  // xhigh and max. Thinking is on by default. Fast mode (research preview, Claude
  // API only) is billed at 2x standard rates ($10/$50) and is not exposed as its
  // own first-class entry.
  "claude-opus-5": {
    max_input_tokens: 1000000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.000005, // $5 per million input tokens
    output_cost_per_token: 0.000025, // $25 per million output tokens
    cache_creation_input_token_cost: 0.00000625, // $6.25 per million tokens
    cache_read_input_token_cost: 0.0000005, // $0.50 per million tokens
    litellm_provider: "anthropic",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_pdf_input: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },

  // Claude Opus 4.8 - Released May 28, 2026
  // Same pricing/shape as Opus 4.7: $5/M input, $25/M output, native 1M context,
  // 128K max output, native xhigh effort level. Defaults to high effort on all
  // surfaces; "fast mode" (separate provider tier) is billed at 2× standard rates
  // ($10/$50) and is not exposed as its own first-class entry yet.
  "claude-opus-4-8": {
    max_input_tokens: 1000000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.000005, // $5 per million input tokens
    output_cost_per_token: 0.000025, // $25 per million output tokens
    cache_creation_input_token_cost: 0.00000625, // $6.25 per million tokens
    cache_read_input_token_cost: 0.0000005, // $0.50 per million tokens
    litellm_provider: "anthropic",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_pdf_input: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },

  // Claude Opus 4.7 - Released April 2026
  // Native 1M context at standard pricing: $5/M input, $25/M output.
  // 128K max output tokens. Supports native xhigh effort level.
  "claude-opus-4-7": {
    max_input_tokens: 1000000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.000005, // $5 per million input tokens
    output_cost_per_token: 0.000025, // $25 per million output tokens
    cache_creation_input_token_cost: 0.00000625, // $6.25 per million tokens
    cache_read_input_token_cost: 0.0000005, // $0.50 per million tokens
    litellm_provider: "anthropic",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_pdf_input: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },

  // Claude Opus 4.6 - Released February 2026
  // Native 1M context at standard pricing: $5/M input, $25/M output.
  // 128K max output tokens.
  "claude-opus-4-6": {
    max_input_tokens: 1000000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.000005, // $5 per million input tokens
    output_cost_per_token: 0.000025, // $25 per million output tokens
    cache_creation_input_token_cost: 0.00000625, // $6.25 per million tokens
    cache_read_input_token_cost: 0.0000005, // $0.50 per million tokens
    litellm_provider: "anthropic",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    // User-reported issue: Opus 4.6 should accept PDF attachments like other Claude 4.x models.
    supports_pdf_input: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },

  // Claude Sonnet 5 - Released June 30, 2026
  // Native 1M context. Standard pricing $3/M input, $15/M output (same as Sonnet 4.6).
  // Introductory pricing of $2/$10 per MTok applies through Aug 31, 2026, but we list the
  // standard rate so cost estimates stay correct once the promo ends.
  // 128K max output (up from Sonnet 4.6's 64K); supports adaptive thinking + effort (incl. xhigh).
  "claude-sonnet-5": {
    max_input_tokens: 1000000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.000003, // $3 per million input tokens
    output_cost_per_token: 0.000015, // $15 per million output tokens
    cache_creation_input_token_cost: 0.00000375, // $3.75 per million tokens
    cache_read_input_token_cost: 0.0000003, // $0.30 per million tokens
    litellm_provider: "anthropic",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_pdf_input: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },

  // Claude Sonnet 4.6 - Released February 2026
  // Native 1M context at standard pricing: $3/M input, $15/M output.
  // 64K max output tokens, supports adaptive thinking + effort parameter.
  "claude-sonnet-4-6": {
    max_input_tokens: 1000000,
    max_output_tokens: 64000,
    input_cost_per_token: 0.000003, // $3 per million input tokens
    output_cost_per_token: 0.000015, // $15 per million output tokens
    cache_creation_input_token_cost: 0.00000375, // $3.75 per million tokens
    cache_read_input_token_cost: 0.0000003, // $0.30 per million tokens
    litellm_provider: "anthropic",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_pdf_input: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },

  // Claude Opus 4.5 - Released November 24, 2025
  // $5/M input, $25/M output (price drop from Opus 4.1's $15/$75)
  // 64K max output tokens (matches Sonnet 4.5)
  "claude-opus-4-5": {
    max_input_tokens: 200000,
    max_output_tokens: 64000,
    input_cost_per_token: 0.000005, // $5 per million input tokens
    output_cost_per_token: 0.000025, // $25 per million output tokens
    cache_creation_input_token_cost: 0.00000625, // $6.25 per million tokens (estimated)
    cache_read_input_token_cost: 0.0000005, // $0.50 per million tokens (estimated)
    litellm_provider: "anthropic",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },

  // GPT-5.5 - Released April 23, 2026
  // Public API support covers Responses, Chat Completions, and Batch with a native
  // 1.05M context window and 128K max output. When routed through Codex OAuth, Xum
  // caps the effective window separately at 272K because the ChatGPT routing layer is lower.
  // Base pricing: $5/M input, $30/M output, $0.50/M cached input.
  // Above 272K prompt tokens: $10/M input, $45/M output, $1/M cached input.
  "gpt-5.5": {
    max_input_tokens: 1050000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.000005, // $5 per million input tokens (<272K prompt tokens)
    input_cost_per_token_above_200k_tokens: 0.00001, // $10 per million input tokens (>272K)
    output_cost_per_token: 0.00003, // $30 per million output tokens (<272K prompt tokens)
    output_cost_per_token_above_200k_tokens: 0.000045, // $45 per million output tokens (>272K)
    cache_read_input_token_cost: 0.0000005, // $0.50 per million cached input tokens (<272K)
    cache_read_input_token_cost_above_200k_tokens: 0.000001, // $1 per million cached input tokens (>272K)
    // OpenAI's published long-context boundary is 272K even though LiteLLM's field names say 200K.
    tiered_pricing_threshold_tokens: 272000,
    litellm_provider: "openai",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_reasoning: true,
    supports_response_schema: true,
    knowledge_cutoff: "2025-08-31",
  },

  // GPT-5.6 Sol (see GPT_56_SOL_STATS above for pricing/context details).
  "gpt-5.6-sol": GPT_56_SOL_STATS,
  // Bare GPT-5.6 alias — servable id that OpenAI routes to Sol; same stats.
  "gpt-5.6": GPT_56_SOL_STATS,

  // GPT-5.6 Terra - Released July 9, 2026 (balanced everyday tier).
  // GA docs: 1.05M context window, 128K max output, Feb 16 2026 cutoff (family).
  // Base pricing (OpenAI's July 30, 2026 price cut): $2/M input, $12/M output,
  // $0.20/M cached input; cache writes 1.25x the active input rate ($2.50/M
  // base). Same 272K long-context tier as Sol (2x input / 1.5x output for the
  // full request).
  "gpt-5.6-terra": {
    max_input_tokens: 1050000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.000002, // $2 per million input tokens (<272K prompt tokens)
    input_cost_per_token_above_200k_tokens: 0.000004, // $4 per million input tokens (>272K)
    output_cost_per_token: 0.000012, // $12 per million output tokens (<272K prompt tokens)
    output_cost_per_token_above_200k_tokens: 0.000018, // $18 per million output tokens (>272K)
    cache_read_input_token_cost: 0.0000002, // $0.20 per million cached input tokens (<272K)
    cache_read_input_token_cost_above_200k_tokens: 0.0000004, // $0.40 per million cached input tokens (>272K)
    cache_creation_input_token_cost: 0.0000025, // $2.50 per million tokens (1.25x input)
    cache_creation_input_token_cost_above_200k_tokens: 0.000005, // $5 per million tokens (1.25x long-context input)
    tiered_pricing_threshold_tokens: 272000, // OpenAI's published boundary is 272K (field names say 200K)
    litellm_provider: "openai",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_reasoning: true,
    supports_response_schema: true,
    knowledge_cutoff: "2026-02-16",
  },

  // GPT-5.6 Luna - Released July 9, 2026 (fastest, most cost-efficient tier).
  // GA model page: 1.05M context window (the 400K figure was a stale launch
  // value that caused premature compaction), 128K max output, Feb 16 2026 cutoff.
  // Base pricing (OpenAI's July 30, 2026 price cut): $0.20/M input, $1.20/M
  // output, $0.02/M cached input; cache writes 1.25x the active input rate
  // ($0.25/M base). Same 272K long-context tier as Sol (2x input / 1.5x output
  // for the full request).
  "gpt-5.6-luna": {
    max_input_tokens: 1050000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.0000002, // $0.20 per million input tokens (<272K prompt tokens)
    input_cost_per_token_above_200k_tokens: 0.0000004, // $0.40 per million input tokens (>272K)
    output_cost_per_token: 0.0000012, // $1.20 per million output tokens (<272K prompt tokens)
    output_cost_per_token_above_200k_tokens: 0.0000018, // $1.80 per million output tokens (>272K)
    cache_read_input_token_cost: 0.00000002, // $0.02 per million cached input tokens (<272K)
    cache_read_input_token_cost_above_200k_tokens: 0.00000004, // $0.04 per million cached input tokens (>272K)
    cache_creation_input_token_cost: 0.00000025, // $0.25 per million tokens (1.25x input)
    cache_creation_input_token_cost_above_200k_tokens: 0.0000005, // $0.50 per million tokens (1.25x long-context input)
    tiered_pricing_threshold_tokens: 272000, // OpenAI's published boundary is 272K (field names say 200K)
    litellm_provider: "openai",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_reasoning: true,
    supports_response_schema: true,
    knowledge_cutoff: "2026-02-16",
  },

  // GPT-6 Astra - Released September 3, 2026 (OpenAI's frontier tier above the
  // GPT-5.6 family). Model page: 1.05M context window, 128K max output, Apr 30
  // 2026 cutoff. Base pricing: $10/M input, $50/M output, $1/M cached input;
  // cache writes billed at 1.25x the active input rate ($12.50/M base). Prompts
  // above 272K input tokens bill the full request at 2x input / 1.5x output:
  // $20/M input, $75/M output, $2/M cached input, $25/M cache writes.
  // supports_function_calling holds for the default Responses wire format only:
  // Astra is served on Chat Completions too, but OpenAI's reasoning guide states
  // tool calling requires the Responses API there, so the `chatCompletions`
  // wireFormat opt-in loses tools for this model.
  // Ref: https://developers.openai.com/api/docs/models/gpt-6-astra
  // Ref: https://developers.openai.com/api/docs/pricing
  // Ref: https://developers.openai.com/api/docs/guides/reasoning#reasoning-effort
  "gpt-6-astra": {
    max_input_tokens: 1050000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.00001, // $10 per million input tokens (<272K prompt tokens)
    input_cost_per_token_above_200k_tokens: 0.00002, // $20 per million input tokens (>272K)
    output_cost_per_token: 0.00005, // $50 per million output tokens (<272K prompt tokens)
    output_cost_per_token_above_200k_tokens: 0.000075, // $75 per million output tokens (>272K)
    cache_read_input_token_cost: 0.000001, // $1 per million cached input tokens (<272K)
    cache_read_input_token_cost_above_200k_tokens: 0.000002, // $2 per million cached input tokens (>272K)
    cache_creation_input_token_cost: 0.0000125, // $12.50 per million tokens (1.25x input)
    cache_creation_input_token_cost_above_200k_tokens: 0.000025, // $25 per million tokens (1.25x long-context input)
    tiered_pricing_threshold_tokens: 272000, // OpenAI's published boundary is 272K (field names say 200K)
    litellm_provider: "openai",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_reasoning: true,
    supports_response_schema: true,
    knowledge_cutoff: "2026-04-30",
  },

  // GPT-5.5 Pro - Released April 23, 2026
  // Native 1.05M context, 128K max output; Responses API only.
  // Base pricing: $30/M input, $180/M output; OpenAI has not published cached-input pricing.
  // Above 272K prompt tokens: $60/M input, $270/M output.
  "gpt-5.5-pro": {
    max_input_tokens: 1050000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.00003, // $30 per million input tokens (<272K prompt tokens)
    input_cost_per_token_above_200k_tokens: 0.00006, // $60 per million input tokens (>272K)
    output_cost_per_token: 0.00018, // $180 per million output tokens (<272K prompt tokens)
    output_cost_per_token_above_200k_tokens: 0.00027, // $270 per million output tokens (>272K)
    tiered_pricing_threshold_tokens: 272000,
    knowledge_cutoff: "2025-08-31",
    litellm_provider: "openai",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_reasoning: true,
    supports_response_schema: true,
    supported_endpoints: ["/v1/responses"],
  },

  // GPT-5.4 mini - Released March 11, 2026
  // Smaller/faster gpt-5.4-mini tier with 400K context, 128K max output, and published
  // pricing of $0.75/M input, $4.50/M output, and $0.075/M cached input.
  "gpt-5.4-mini": {
    max_input_tokens: 400000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.00000075, // $0.75 per million input tokens
    output_cost_per_token: 0.0000045, // $4.50 per million output tokens
    cache_read_input_token_cost: 0.000000075, // $0.075 per million cached input tokens
    litellm_provider: "openai",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_reasoning: true,
    supports_response_schema: true,
    knowledge_cutoff: "2025-08-31",
  },

  // GPT-5.4 nano - Released March 17, 2026
  // Cheapest gpt-5.4-nano tier with 400K context, 128K max output, and published
  // pricing of $0.20/M input, $1.25/M output, and $0.02/M cached input.
  "gpt-5.4-nano": {
    max_input_tokens: 400000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.0000002, // $0.20 per million input tokens
    output_cost_per_token: 0.00000125, // $1.25 per million output tokens
    cache_read_input_token_cost: 0.00000002, // $0.02 per million cached input tokens
    litellm_provider: "openai",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_reasoning: true,
    supports_response_schema: true,
    knowledge_cutoff: "2025-08-31",
  },

  // GPT-5.2 / GPT-5.2 Codex - keep aligned
  // LiteLLM reports 400k context for Codex, but it should match GPT-5.2 (272k)
  // $1.75/M input, $14/M output
  // Cached input: $0.175/M
  // Supports off, low, medium, high, xhigh reasoning levels
  "gpt-5.2": {
    max_input_tokens: 272000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.00000175, // $1.75 per million input tokens
    output_cost_per_token: 0.000014, // $14 per million output tokens
    // OpenAI model page lists "cached input" pricing, which corresponds to prompt cache reads.
    cache_read_input_token_cost: 0.000000175, // $0.175 per million cached input tokens
    litellm_provider: "openai",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_reasoning: true,
    supports_response_schema: true,
    knowledge_cutoff: "2025-08-31",
  },
  "gpt-5.2-codex": {
    max_input_tokens: 272000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.00000175, // $1.75 per million input tokens
    output_cost_per_token: 0.000014, // $14 per million output tokens
    // OpenAI model page lists "cached input" pricing, which corresponds to prompt cache reads.
    cache_read_input_token_cost: 0.000000175, // $0.175 per million cached input tokens
    litellm_provider: "openai",
    mode: "responses",
    supports_function_calling: true,
    supports_vision: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },

  // Gemini 3.5 Flash - GA on May 19, 2026. Google AI docs list a stable
  // `gemini-3.5-flash` model ID with 1M context, 65K max output, standard
  // pricing of $1.50/M input, $9/M output, and $0.15/M cached input.
  // Source: Google DeepMind Gemini 3.5 Flash model info and Gemini API pricing docs as of 2026-05-20.
  "gemini-3.5-flash": {
    max_input_tokens: 1048576,
    max_output_tokens: 65536,
    input_cost_per_token: 0.0000015, // $1.50 per million input tokens
    output_cost_per_token: 0.000009, // $9 per million output tokens, including thinking tokens
    cache_read_input_token_cost: 0.00000015, // $0.15 per million cached input tokens
    litellm_provider: "vertex_ai-language-models",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_pdf_input: true,
    supports_audio_input: true,
    supports_video_input: true,
    supports_reasoning: true,
    supports_response_schema: true,
    knowledge_cutoff: "2025-01",
  },

  // Gemini 3.6 Flash - GA on July 21, 2026. Stable `gemini-3.6-flash` model ID with
  // 1M context, 65K max output, $1.50/M input, $7.50/M output. Source: Google AI
  // Gemini API model and latest-model docs as of 2026-07-21. The $0.15/M cached
  // input rate carries over from 3.5 Flash, cross-checked against Artificial
  // Analysis' blended rate for 3.6 Flash.
  "gemini-3.6-flash": {
    max_input_tokens: 1048576,
    max_output_tokens: 65536,
    input_cost_per_token: 0.0000015, // $1.50 per million input tokens
    output_cost_per_token: 0.0000075, // $7.50 per million output tokens, including thinking tokens
    cache_read_input_token_cost: 0.00000015, // $0.15 per million cached input tokens
    litellm_provider: "vertex_ai-language-models",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_pdf_input: true,
    supports_audio_input: true,
    supports_video_input: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },

  // Gemini 3.7 Flash - GA on August 13, 2026. Stable `gemini-3.7-flash` model ID with
  // 1M context, 65K max output. We encode the introductory rates Google actually
  // bills through December 31, 2026 ($0.75/M input, $3.75/M output, $0.075/M cached
  // input) so displayed costs and goal budgets match real charges. TODO(2027-01-01):
  // raise to the standard list rates ($1.50/$7.50/$0.15) when the intro pricing
  // expires. Source: Gemini API pricing docs as of 2026-08-13.
  "gemini-3.7-flash": {
    max_input_tokens: 1048576,
    max_output_tokens: 65536,
    input_cost_per_token: 0.00000075, // $0.75 per million input tokens (intro rate)
    output_cost_per_token: 0.00000375, // $3.75 per million output tokens, including thinking tokens (intro rate)
    cache_read_input_token_cost: 0.000000075, // $0.075 per million cached input tokens (intro rate)
    litellm_provider: "vertex_ai-language-models",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_pdf_input: true,
    supports_audio_input: true,
    supports_video_input: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },

  // Gemini 3.8 Flash - GA on September 2, 2026. Stable `gemini-3.8-flash` model ID with
  // 1M context, 64K max output (DeepMind model card). Like 3.7 Flash, we encode the
  // introductory rates Google actually bills through December 31, 2026 ($0.75/M input,
  // $3.75/M output, $0.075/M cached input) so displayed costs and goal budgets match
  // real charges. TODO(2027-01-01): raise to the standard list rates ($1.50/$7.50/$0.15)
  // when the intro pricing expires. Source: Gemini API pricing docs as of 2026-09-02.
  // Note: 3.8 Flash rejects thinkingLevel "minimal" (see isGeminiFlashMinimalRejectingModelName).
  "gemini-3.8-flash": {
    max_input_tokens: 1048576,
    max_output_tokens: 65536,
    input_cost_per_token: 0.00000075, // $0.75 per million input tokens (intro rate)
    output_cost_per_token: 0.00000375, // $3.75 per million output tokens, including thinking tokens (intro rate)
    cache_read_input_token_cost: 0.000000075, // $0.075 per million cached input tokens (intro rate)
    litellm_provider: "vertex_ai-language-models",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_pdf_input: true,
    supports_audio_input: true,
    supports_video_input: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },

  // Gemini 3.1 Pro Preview - Released February 19, 2026
  // Tiered pricing: ≤200K tokens $2/M input, $12/M output; >200K tokens $4/M input, $18/M output
  // 1M input context, ~64K max output tokens
  "gemini-3.1-pro-preview": {
    max_input_tokens: 1048576,
    max_output_tokens: 65535,
    input_cost_per_token: 0.000002, // $2 per million input tokens (≤200K)
    output_cost_per_token: 0.000012, // $12 per million output tokens (≤200K)
    input_cost_per_token_above_200k_tokens: 0.000004, // $4 per million input tokens (>200K)
    output_cost_per_token_above_200k_tokens: 0.000018, // $18 per million output tokens (>200K)
    cache_read_input_token_cost: 2e-7,
    litellm_provider: "vertex_ai-language-models",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_pdf_input: true,
    supports_reasoning: true,
    supports_response_schema: true,
    knowledge_cutoff: "2025-01",
  },

  // GPT-5.3-Codex (released API id) - same pricing as gpt-5.2-codex
  "gpt-5.3-codex": {
    max_input_tokens: 272000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.00000175, // $1.75 per million input tokens
    output_cost_per_token: 0.000014, // $14 per million output tokens
    cache_read_input_token_cost: 0.000000175, // $0.175 per million cached input tokens
    litellm_provider: "openai",
    mode: "responses",
    supports_function_calling: true,
    supports_vision: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },
  // GPT-5.3-Codex Spark - research preview (text-only) and currently available as 128k-context model.
  // Pricing is not published separately; reuse GPT-5.3-Codex pricing until confirmed.
  "gpt-5.3-codex-spark": {
    max_input_tokens: 128000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.00000175, // $1.75 per million input tokens
    output_cost_per_token: 0.000014, // $14 per million output tokens
    cache_read_input_token_cost: 0.000000175, // $0.175 per million cached input tokens
    litellm_provider: "openai",
    mode: "responses",
    supports_function_calling: true,
    supports_vision: false,
    supports_reasoning: true,
    supports_response_schema: true,
  },
  // GPT-5.2 Pro - Released December 11, 2025
  // $21/M input, $168/M output
  // Supports medium, high, xhigh reasoning levels
  "gpt-5.2-pro": {
    max_input_tokens: 272000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.000021, // $21 per million input tokens
    output_cost_per_token: 0.000168, // $168 per million output tokens
    knowledge_cutoff: "2025-08-31",
    litellm_provider: "openai",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_reasoning: true,
    supports_response_schema: true,
    supported_endpoints: ["/v1/responses"],
  },

  // Claude Haiku 4.5 - Released October 15, 2025
  // $1/M input, $5/M output
  "claude-haiku-4-5": {
    max_input_tokens: 200000,
    max_output_tokens: 8192,
    input_cost_per_token: 0.000001, // $1 per million input tokens
    output_cost_per_token: 0.000005, // $5 per million output tokens
    cache_creation_input_token_cost: 0.00000125, // $1.25 per million tokens
    cache_read_input_token_cost: 0.0000001, // $0.10 per million tokens
    litellm_provider: "anthropic",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_response_schema: true,
  },

  // Z.AI GLM 4.6 via OpenRouter
  // $0.40/M input, $1.75/M output (OpenRouter pricing)
  // 200K context window, supports tool use and reasoning
  "openrouter/z-ai/glm-4.6": {
    max_input_tokens: 202752,
    max_output_tokens: 202752,
    input_cost_per_token: 0.0000004, // $0.40 per million input tokens
    output_cost_per_token: 0.00000175, // $1.75 per million output tokens
    litellm_provider: "openrouter",
    mode: "chat",
    supports_function_calling: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },

  // GLM 5.3 Flash list pricing and limits for the direct Z.ai provider.
  "zai/glm-5.3-flash": {
    max_input_tokens: 1048576,
    max_output_tokens: 131072,
    input_cost_per_token: 0.00000015, // $0.15 per million input tokens
    output_cost_per_token: 0.0000005, // $0.50 per million output tokens
    cache_read_input_token_cost: 0.00000003, // $0.03 per million cached input tokens
    litellm_provider: "zai",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_reasoning: true,
  },

  // Kimi K3 - released July 16, 2026. 1M context, 128K max output, text+image input.
  // Keyed on the direct provider; OpenRouter-routed requests canonicalize to this id.
  "moonshotai/kimi-k3": {
    max_input_tokens: 1048576,
    max_output_tokens: 131072,
    input_cost_per_token: 0.000003, // $3 per million input tokens
    output_cost_per_token: 0.000015, // $15 per million output tokens
    cache_read_input_token_cost: 0.0000003, // $0.30 per million cached input tokens
    litellm_provider: "moonshotai",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },

  // GPT-5.1-Codex-Max - Extended reasoning model with xhigh support
  // Same pricing as gpt-5.1-codex: $1.25/M input, $10/M output
  // Supports 5 reasoning levels: off, low, medium, high, xhigh
  "gpt-5.1-codex-max": {
    max_input_tokens: 272000, // Same as gpt-5.1-codex
    max_output_tokens: 128000, // Same as gpt-5.1-codex
    input_cost_per_token: 0.00000125, // $1.25 per million input tokens
    output_cost_per_token: 0.00001, // $10 per million output tokens
    litellm_provider: "openai",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_reasoning: true,
    supports_response_schema: true,
    supported_endpoints: ["/v1/responses"],
  },

  // DeepSeek V4 Pro - Released April 24, 2026 (Preview)
  // 1.6T total / 49B active MoE params; 1M context, 384K max output.
  // Standard pricing: $1.74/M input, $3.48/M output (full price; an introductory 75%
  // discount runs through 2026/05/05 but we record the post-discount baseline so
  // billing/forecasts don't silently regress when the promo ends).
  // Cache-hit input pricing is documented at 1/10 of input price.
  "deepseek-v4-pro": {
    max_input_tokens: 1000000,
    max_output_tokens: 384000,
    input_cost_per_token: 0.00000174, // $1.74 per million input tokens
    output_cost_per_token: 0.00000348, // $3.48 per million output tokens
    cache_read_input_token_cost: 0.000000174, // 1/10 of input price
    litellm_provider: "deepseek",
    mode: "chat",
    supports_function_calling: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },

  // DeepSeek V4 Flash - Released April 24, 2026 (Preview)
  // 284B total / 13B active MoE params; 1M context, 384K max output.
  // Pricing: $0.14/M input, $0.28/M output. Cache-hit input is 1/10 of input price.
  // Legacy `deepseek-chat` (non-thinking) and `deepseek-reasoner` (thinking) currently
  // route to V4-Flash compatibility modes and retire 2026-07-24.
  "deepseek-v4-flash": {
    max_input_tokens: 1000000,
    max_output_tokens: 384000,
    input_cost_per_token: 0.00000014, // $0.14 per million input tokens
    output_cost_per_token: 0.00000028, // $0.28 per million output tokens
    cache_read_input_token_cost: 0.000000014, // 1/10 of input price
    litellm_provider: "deepseek",
    mode: "chat",
    supports_function_calling: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },
};

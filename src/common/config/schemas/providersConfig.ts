import { z } from "zod";

import { CUSTOM_PROVIDER_TYPES } from "@/common/utils/providers/customProviders";

import { ModelParametersByModelSchema } from "./modelParameters";
import { ProviderModelEntrySchema } from "./providerModelEntry";

export const CacheTtlSchema = z.enum(["5m", "1h"]);
export const ServiceTierSchema = z.enum(["auto", "default", "flex", "priority"]);
export type ServiceTier = z.infer<typeof ServiceTierSchema>;
export const FastModePreviousServiceTierSchema = z.enum(["auto", "default", "flex", "unset"]);
export type FastModePreviousServiceTier = z.infer<typeof FastModePreviousServiceTierSchema>;
export const XAIServiceTierSchema = z.enum(["default", "priority"]);
export type XAIServiceTier = z.infer<typeof XAIServiceTierSchema>;
export const XAIFastModePreviousServiceTierSchema = z.enum(["default", "unset"]);
export const CodexOauthDefaultAuthSchema = z.enum(["oauth", "apiKey"]);

export const BaseProviderConfigSchema = z
  .object({
    apiKey: z.string().optional(),
    apiKeyFile: z.string().optional(),
    baseUrl: z.string().optional(),
    baseURL: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
    providerType: z.enum(CUSTOM_PROVIDER_TYPES).optional(),
    displayName: z.string().min(1).optional(),
    models: z.array(ProviderModelEntrySchema).optional(),
    modelParameters: ModelParametersByModelSchema.optional(),
  })
  .passthrough();

export const AnthropicProviderConfigSchema = BaseProviderConfigSchema.extend({
  cacheTtl: CacheTtlSchema.optional(),
});

export const OpenAIProviderConfigSchema = BaseProviderConfigSchema.extend({
  serviceTier: ServiceTierSchema.optional(),
  fastModePreviousServiceTier: FastModePreviousServiceTierSchema.optional(),
  organization: z.string().optional(),
  codexOauthDefaultAuth: CodexOauthDefaultAuthSchema.optional(),
  codexOauth: z.record(z.string(), z.unknown()).optional(),
  defaultModel: z.string().optional(),
  apiVersion: z.string().optional(),
  webSocketTransportEnabled: z.boolean().optional(),
});

export const BedrockProviderConfigSchema = BaseProviderConfigSchema.extend({
  region: z.string().optional(),
  profile: z.string().optional(),
  bearerToken: z.string().optional(),
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
});

export const OpenRouterProviderConfigSchema = BaseProviderConfigSchema.extend({
  order: z.string().optional(),
  allow_fallbacks: z.boolean().optional(),
  only: z.array(z.string()).optional(),
  ignore: z.array(z.string()).optional(),
  require_parameters: z.boolean().optional(),
  data_collection: z.string().optional(),
  sort: z.string().optional(),
  quantizations: z.array(z.string()).optional(),
  // Static override for the per-workspace session key mux stamps on requests;
  // null disables session tagging entirely (nothing is sent).
  session_id: z.string().nullable().optional(),
});

export const XAIProviderConfigSchema = BaseProviderConfigSchema.extend({
  searchParameters: z.record(z.string(), z.unknown()).optional(),
  serviceTier: XAIServiceTierSchema.optional(),
  fastModePreviousServiceTier: XAIFastModePreviousServiceTierSchema.optional(),
});

export const MuxGatewayProviderConfigSchema = BaseProviderConfigSchema.extend({
  couponCode: z.string().optional(),
  voucher: z.string().optional(),
});

export const CoderProviderConfigSchema = BaseProviderConfigSchema.extend({
  /** Coder deployment access URL (e.g. https://coder.example.com). */
  deploymentUrl: z.string().optional(),
  /** Stored Coder OAuth tokens + dynamic client registration (written by coderOauthService only). */
  coderOauth: z.record(z.string(), z.unknown()).optional(),
  /**
   * Model IDs discovered from the deployment's AI Bridge catalogs (written by
   * coderOauthService only). Doubles as the authoritative-catalog marker for
   * gateway routing (see gatewayModelCatalog.ts) and as the bookkeeping that
   * separates discovered entries from manually added ones in `models`, so
   * user-managed entries survive re-logins and catalog refreshes.
   */
  discoveredModels: z.array(z.string()).optional(),
  /**
   * Model IDs the user removed from the model list (discovered or not —
   * catalog provenance is lossy across re-logins, so every deletion is
   * recorded). User-managed exclusions: catalog refreshes and re-logins must
   * not resurrect them (maintained by ProviderService.setModels, honored by
   * discovery merges).
   */
  removedModels: z.array(z.string()).optional(),
  /**
   * AI Gateway provider instances discovered from the deployment (written by
   * coderOauthService only). `name` is the gateway route segment and model ID
   * prefix (coder:<name>/<model>); `type` decides the wire protocol (see
   * coderGatewayWireProtocol). Purely additive routing metadata — never a
   * gate: names absent here still resolve through additionalProviders and the
   * default name === type convention.
   */
  discoveredProviders: z.array(z.object({ name: z.string(), type: z.string() })).optional(),
  /**
   * User-managed gateway provider metadata, same shape as discoveredProviders
   * and consulted first. Escape hatch for custom-named provider instances on
   * deployments where the member cannot list providers (the providers API is
   * admin-only) and probing default names cannot find them.
   */
  additionalProviders: z.array(z.object({ name: z.string(), type: z.string() })).optional(),
  /**
   * Cross-process disconnect generation (monotonic counter, incremented by
   * coderOauthService.disconnect). Each login flow snapshots the persisted
   * value at start; a flow whose snapshot no longer matches at commit time —
   * in any Xum process sharing the file — refuses to commit, so an in-flight
   * login cannot silently reconnect a just-disconnected account. A counter,
   * not a wall-clock timestamp: clock skew/corrections must not let a
   * pre-disconnect flow commit or lock out post-disconnect logins.
   */
  coderDisconnectGeneration: z.number().optional(),
  /**
   * Cross-process catalog refresh generation (monotonic counter, incremented
   * by every catalog commit in coderOauthService.refreshBridgeModels). Each
   * refresh snapshots the persisted value before fetching; a refresh whose
   * snapshot no longer matches at commit time — in any Xum process sharing
   * the file — refuses to commit, so a slower refresh that captured an older
   * provider list can never overwrite a newer catalog. The in-process
   * catalogRefreshMutex orders only one process's refreshes; this counter
   * orders them across processes. A counter, not a wall-clock timestamp, for
   * the same clock-skew reasons as coderDisconnectGeneration.
   */
  coderCatalogGeneration: z.number().optional(),
});

export const GoogleProviderConfigSchema = BaseProviderConfigSchema;
export const DeepSeekProviderConfigSchema = BaseProviderConfigSchema;
export const MoonshotAIProviderConfigSchema = BaseProviderConfigSchema;
export const ZaiProviderConfigSchema = BaseProviderConfigSchema;
export const OllamaProviderConfigSchema = BaseProviderConfigSchema;
export const GitHubCopilotProviderConfigSchema = BaseProviderConfigSchema;

export const ProvidersConfigSchema = z
  .object({
    anthropic: AnthropicProviderConfigSchema.optional(),
    openai: OpenAIProviderConfigSchema.optional(),
    bedrock: BedrockProviderConfigSchema.optional(),
    openrouter: OpenRouterProviderConfigSchema.optional(),
    xai: XAIProviderConfigSchema.optional(),
    "mux-gateway": MuxGatewayProviderConfigSchema.optional(),
    google: GoogleProviderConfigSchema.optional(),
    deepseek: DeepSeekProviderConfigSchema.optional(),
    moonshotai: MoonshotAIProviderConfigSchema.optional(),
    zai: ZaiProviderConfigSchema.optional(),
    ollama: OllamaProviderConfigSchema.optional(),
    "github-copilot": GitHubCopilotProviderConfigSchema.optional(),
    coder: CoderProviderConfigSchema.optional(),
  })
  .catchall(BaseProviderConfigSchema);

export type BaseProviderConfig = z.infer<typeof BaseProviderConfigSchema>;
export type OpenAIProviderConfig = z.infer<typeof OpenAIProviderConfigSchema>;
export type BedrockProviderConfig = z.infer<typeof BedrockProviderConfigSchema>;
export type MuxGatewayProviderConfig = z.infer<typeof MuxGatewayProviderConfigSchema>;
export type CoderProviderConfig = z.infer<typeof CoderProviderConfigSchema>;

export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;

import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { OpenAIWireFormat } from "@/common/types/providerOptions";
import { isModelAvailable, resolveRoute } from "@/common/routing";
import { isGatewayModelAccessibleFromAuthoritativeCatalog } from "@/common/utils/providers/gatewayModelCatalog";
import { canDirectOpenAIServeModel } from "@/common/utils/providers/codexOauthRouting";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { resolveCoderGatewayMetadataModel } from "@/common/utils/providers/coderGatewayMetadata";
import { isCustomProviderConfig } from "@/common/utils/providers/customProviders";
import { resolveCoderWireCanonicalModel } from "@/common/constants/coderOAuth";
import { PROVIDER_REGISTRY } from "@/common/constants/providers";

/**
 * Provider-configured predicate shared by the routing UI (useRouting) and the
 * send-path availability check below. One definition, two consumers — the
 * Settings picker and the skill-routing verdict must never disagree.
 */
export function isRouteProviderConfigured(
  providersConfig: ProvidersConfigMap,
  provider: string
): boolean {
  return (
    providersConfig[provider]?.isConfigured === true &&
    providersConfig[provider]?.isEnabled !== false
  );
}

/**
 * Gateway-catalog accessibility predicate; see isRouteProviderConfigured.
 *
 * A CUSTOM provider shadowing a built-in gateway id (github-copilot, coder…)
 * is exempt from that gateway's authoritative-catalog rule: its `models` list
 * is a non-exhaustive convenience, and the factory hands arbitrary model ids
 * straight to the custom adapter — an ordinary send would work, so the class
 * verdict must not reject every skill bound to such a model.
 */
export function isRouteGatewayModelAccessible(
  providersConfig: ProvidersConfigMap,
  gateway: string,
  modelId: string
): boolean {
  if (isCustomProviderConfig(providersConfig[gateway])) {
    return true;
  }
  return isGatewayModelAccessibleFromAuthoritativeCatalog(
    gateway,
    modelId,
    providersConfig[gateway]?.models,
    providersConfig[gateway]?.discoveredModels,
    providersConfig[gateway]?.removedModels
  );
}

/**
 * Can the current routing state actually serve this model?
 *
 * Wraps the routing layer's isModelAvailable with the same provider
 * predicates the Settings UI uses (useRouting): a provider counts as
 * configured when `isConfigured` is set and it is not disabled, and gateway
 * accessibility consults the authoritative model catalog. Route priority and
 * per-model overrides are honored, so a gateway that is configured but not in
 * the priority list does not count — matching what a send would really do.
 *
 * Callers that cannot obtain a ProvidersConfigMap (degraded state, minimal
 * test mocks) must skip the check rather than pass an empty map:
 * "cannot determine" is not "unavailable".
 *
 * `openaiWireFormat` is the request's own OpenAI wire format
 * (providerOptions.openai.wireFormat): with no stored format the factory
 * honors it, and Codex-OAuth-only credentials cannot serve a Chat Completions
 * request — send-path callers pass it so the verdict matches model creation.
 *
 * Known one-directional gap: enforced-policy model gating (policyService
 * isModelAllowed, applied inside the node-side gateway checker) is not
 * consulted here, so this can over-report availability for policy-blocked
 * gateway models — the send then fails with the provider's own error rather
 * than the actionable class message. It can never spuriously block.
 */
export function isModelServableWithProvidersConfig(args: {
  canonicalModel: string;
  routePriority?: string[];
  routeOverrides?: Record<string, string>;
  providersConfig: ProvidersConfigMap;
  openaiWireFormat?: OpenAIWireFormat | null;
}): boolean {
  const providersConfig = args.providersConfig;
  // The OAuth gate judges the CANONICAL identity, matching createModel's
  // normalization: an explicit gateway value (openrouter:openai/gpt-5.5)
  // would otherwise read as "not an openai model" and wrongly fail the
  // direct-route check the factory itself would pass.
  const canonicalForDirect = normalizeToCanonical(args.canonicalModel);
  const isConfigured = (provider: string): boolean => {
    if (!isRouteProviderConfigured(providersConfig, provider)) {
      return false;
    }
    // OpenAI's isConfigured can mean Codex-OAuth-only credentials, which
    // serve only the OAuth-allowed model set — a direct route the factory
    // would reject (api_key_not_found) must not win over a later gateway or
    // suppress the actionable class error.
    if (provider === "openai") {
      return canDirectOpenAIServeModel(canonicalForDirect, providersConfig, {
        openaiWireFormat: args.openaiWireFormat,
      });
    }
    return true;
  };

  // Coder values are judged BEFORE any generic routing: the instance segment
  // of coder:<instance>/<model> is a deployment name, not a vendor prefix,
  // but generic canonicalization parses it as one — a cross-typed instance
  // ({name: "anthropic", type: "openai-compat"}) would read as a direct
  // anthropic:<model> and pass through configured Anthropic even though the
  // factory deliberately keeps the raw gateway-scoped seed for it and fails
  // the send with a Coder availability error. A custom provider shadowing
  // the coder id is exempt: its model IDs are their own identity and route
  // generically. Mirrors the factory's routeSeedModelString derivation.
  if (args.canonicalModel.startsWith("coder:") && !isCustomProviderConfig(providersConfig.coder)) {
    const coderGatewayModelId = args.canonicalModel.slice("coder:".length);
    // The coder gateway itself is the preferred explicit route (matching
    // findActiveRouteContext's explicit-gateway-first candidate).
    if (
      isConfigured("coder") &&
      isRouteGatewayModelAccessible(providersConfig, "coder", coderGatewayModelId)
    ) {
      return true;
    }
    // Fallback identity comes from the instance METADATA the factory itself
    // uses (a google-typed coder:vertex/gemini-x falls back to
    // google:gemini-x, not to the wire protocol's openai identity), gated on
    // the prefix being a REGISTERED provider — an unknown vendor
    // (coder:ai-gateway/acme/foo → acme:foo) is not directly routable even
    // if a custom provider happens to share the name.
    const derived = resolveCoderGatewayMetadataModel(args.canonicalModel, providersConfig);
    if (
      derived != null &&
      Object.hasOwn(PROVIDER_REGISTRY, derived.slice(0, derived.indexOf(":")))
    ) {
      return isModelServableWithProvidersConfig({ ...args, canonicalModel: derived });
    }
    const coderMetadata = providersConfig.coder as
      | { discoveredProviders?: unknown; additionalProviders?: unknown }
      | undefined;
    if (resolveCoderWireCanonicalModel(coderGatewayModelId, coderMetadata) != null) {
      // KNOWN but unmappable instance (openai-compat fronts arbitrary
      // upstreams; vendor-less IDs carry no catalog identity): the factory
      // retains the raw Coder seed and rejects the send when the gateway
      // cannot serve it — no generic fallback exists.
      return false;
    }
    // Unknown instance: the factory seeds generic canonicalization — fall
    // through to the same checks below.
  }

  if (
    isModelAvailable(
      args.canonicalModel,
      args.routePriority ?? ["direct"],
      args.routeOverrides ?? {},
      isConfigured,
      (gateway, modelId) => isRouteGatewayModelAccessible(providersConfig, gateway, modelId)
    )
  ) {
    return true;
  }
  // Mirror resolveRoute's FINAL fallback: with the priority list exhausted
  // (including a routePriority that omits "direct" entirely), resolution
  // still lands on the direct provider — an ordinary send succeeds whenever
  // that provider is credentialed, so the class gate must not reject a model
  // the same send-path would serve.
  const fallback = resolveRoute(
    args.canonicalModel,
    args.routePriority ?? ["direct"],
    args.routeOverrides ?? {},
    isConfigured,
    (gateway, modelId) => isRouteGatewayModelAccessible(providersConfig, gateway, modelId)
  );
  // Configuration alone is not enough for catalog-gated routes: an
  // unmappable coder:<instance>/<model> (tombstoned or absent from the
  // discovered AI Bridge catalog) is rejected by the factory with
  // model_not_available even though the instance is configured. The
  // accessibility predicate fails open for providers without a catalog, so
  // applying it unconditionally only ever removes false positives.
  return (
    isConfigured(fallback.routeProvider) &&
    isRouteGatewayModelAccessible(providersConfig, fallback.routeProvider, fallback.routeModelId)
  );
}

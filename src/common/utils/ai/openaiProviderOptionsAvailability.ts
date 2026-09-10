/** Route-aware availability for OpenAI-native request options. */
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { OpenAIWireFormat } from "@/common/types/providerOptions";
import { PROVIDER_DEFINITIONS } from "@/common/constants/providers";
import { getExplicitGatewayPrefix, normalizeToCanonical } from "@/common/utils/ai/models";
import { wouldRouteOpenAIThroughCodexOauth } from "@/common/utils/providers/codexOauthRouting";
import { isGatewayModelAccessibleFromAuthoritativeCatalog } from "@/common/utils/providers/gatewayModelCatalog";
import { resolveCoderWireCanonicalModel } from "@/common/constants/coderOAuth";
import { resolveCoderGatewayMetadataModel } from "@/common/utils/providers/coderGatewayMetadata";
import { isCustomProviderConfig } from "@/common/utils/providers/customProviders";

export interface OpenAIDirectProviderOptionsAvailability {
  /** Settings-resolved route for the canonical model ("direct" = no gateway). */
  resolvedRouteProvider?: string | null;
  /** Providers config for explicit gateway and Codex OAuth route detection. */
  providersConfig?: ProvidersConfigMap | null;
  /** Request-level OpenAI wire format; the stored config value wins when set. */
  openaiWireFormat?: OpenAIWireFormat | null;
}

/** Share explicit-gateway precedence between direct-only options and Pro mode. */
export function resolveProviderOptionsRoute(
  modelString: string,
  options?: OpenAIDirectProviderOptionsAvailability
): string {
  const [origin] = normalizeToCanonical(modelString).split(":", 2);

  // Explicit gateway selections only win while that gateway is configured and
  // enabled. Otherwise the backend falls through to the settings-resolved route.
  const explicitGateway = getExplicitGatewayPrefix(modelString);
  if (explicitGateway != null) {
    const gatewayConfig = options?.providersConfig?.[explicitGateway];
    const gatewayDefinition = PROVIDER_DEFINITIONS[explicitGateway];
    const gatewayWinsRoute =
      options?.providersConfig == null ||
      (gatewayConfig?.isConfigured === true &&
        gatewayConfig.isEnabled !== false &&
        gatewayDefinition.kind === "gateway" &&
        (origin === explicitGateway ||
          (gatewayDefinition.routes as readonly string[]).includes(origin)) &&
        // A removed/catalog-excluded Coder model must use the resolved fallback,
        // even while the gateway itself remains connected.
        (explicitGateway !== "coder" ||
          isGatewayModelAccessibleFromAuthoritativeCatalog(
            explicitGateway,
            modelString.slice(modelString.indexOf(":") + 1),
            gatewayConfig.models,
            gatewayConfig.discoveredModels,
            gatewayConfig.removedModels
          )));
    if (gatewayWinsRoute) {
      return explicitGateway;
    }
  }

  return options?.resolvedRouteProvider ?? "direct";
}

/** Fast shares OpenAI's preference across gateways that forward its service tier. */
export function openaiServiceTierAvailable(
  modelString: string,
  options?: OpenAIDirectProviderOptionsAvailability
): boolean {
  // Policy-filtered configs omit denied providers, including this shared
  // preference's write target. Do not expose Fast or inject a hidden saved tier.
  if (options?.providersConfig != null && options.providersConfig.openai == null) return false;

  const prefix = modelString.split(":", 1)[0];
  const custom = options?.providersConfig?.[prefix];
  if (isCustomProviderConfig(custom)) {
    // The generic compatible SDK does not serialize OpenAI-native service tiers.
    return custom.providerType === "openai-responses";
  }

  const route = resolveProviderOptionsRoute(modelString, options);
  if (route === "coder") {
    const gatewayModelId = modelString.startsWith("coder:")
      ? modelString.slice("coder:".length)
      : normalizeToCanonical(modelString).replace(":", "/");
    const wire = resolveCoderWireCanonicalModel(gatewayModelId, options?.providersConfig?.coder);
    // Other Coder types (e.g. Google) also speak chat completions; that alone
    // cannot establish OpenAI tier support. Unknown instances fail closed.
    return wire?.providerType === "openai" || wire?.providerType === "openai-compat";
  }

  const normalized = modelString.startsWith("coder:")
    ? (resolveCoderGatewayMetadataModel(modelString, options?.providersConfig) ?? modelString)
    : normalizeToCanonical(modelString);
  const [origin, modelId] = normalized.split(":", 2);
  if (origin === "github-copilot") {
    // Copilot's unscoped catalog mixes upstreams; capability mappings cannot
    // turn Claude/Gemini into OpenAI models. Both Copilot adapters forward tiers.
    return /^(?:gpt-\d|o[1-9](?:-|$))/.test(modelId);
  }
  if (origin !== "openai") return false;
  if (route === "openrouter" || route === "mux-gateway" || route === "github-copilot") {
    return true;
  }
  return openaiDirectProviderOptionsAvailable(normalized, {
    ...options,
    resolvedRouteProvider: route,
  });
}

export function openaiDirectProviderOptionsAvailable(
  modelString: string,
  options?: OpenAIDirectProviderOptionsAvailability
): boolean {
  const normalized = normalizeToCanonical(modelString);
  const [origin] = normalized.split(":", 2);
  if (origin !== "openai" || resolveProviderOptionsRoute(modelString, options) !== "direct") {
    return false;
  }

  // Codex OAuth normalizes requests for the ChatGPT backend and strips OpenAI
  // API-only provider options, so toggles for those options must fail closed.
  return !(
    options?.providersConfig != null &&
    wouldRouteOpenAIThroughCodexOauth(normalized, options.providersConfig, {
      openaiWireFormat: options.openaiWireFormat,
    })
  );
}

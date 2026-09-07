/**
 * Shared availability gate for OpenAI-native request options that are not
 * forwarded by gateway or Codex OAuth routes.
 */
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { OpenAIWireFormat } from "@/common/types/providerOptions";
import { PROVIDER_DEFINITIONS } from "@/common/constants/providers";
import { getExplicitGatewayPrefix, normalizeToCanonical } from "@/common/utils/ai/models";
import { wouldRouteOpenAIThroughCodexOauth } from "@/common/utils/providers/codexOauthRouting";
import { isGatewayModelAccessibleFromAuthoritativeCatalog } from "@/common/utils/providers/gatewayModelCatalog";

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

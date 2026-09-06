/**
 * Shared availability gate for OpenAI-native request options that are not
 * forwarded by gateway or Codex OAuth routes.
 */
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { OpenAIWireFormat } from "@/common/types/providerOptions";
import { PROVIDER_DEFINITIONS } from "@/common/constants/providers";
import { getExplicitGatewayPrefix, normalizeToCanonical } from "@/common/utils/ai/models";
import { resolveCodexOauthRouting } from "@/common/utils/providers/codexOauthRouting";

export interface OpenAIDirectProviderOptionsAvailability {
  /** Settings-resolved route for the canonical model ("direct" = no gateway). */
  resolvedRouteProvider?: string | null;
  /** Providers config for explicit gateway and Codex OAuth route detection. */
  providersConfig?: ProvidersConfigMap | null;
  /** Request-level OpenAI wire format; the stored config value wins when set. */
  openaiWireFormat?: OpenAIWireFormat | null;
  codexOauthAccountId?: string;
}

export function openaiDirectProviderOptionsAvailable(
  modelString: string,
  options?: OpenAIDirectProviderOptionsAvailability
): boolean {
  const normalized = normalizeToCanonical(modelString);
  const [origin] = normalized.split(":", 2);
  if (origin !== "openai") {
    return false;
  }

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
        (gatewayDefinition.routes as readonly string[]).includes("openai"));
    if (gatewayWinsRoute) {
      return false;
    }
  }

  const resolvedRouteProvider = options?.resolvedRouteProvider;
  if (resolvedRouteProvider != null && resolvedRouteProvider !== "direct") {
    return false;
  }

  // Codex OAuth normalizes requests for the ChatGPT backend and strips OpenAI
  // API-only provider options, so toggles for those options must fail closed.
  return !(
    options?.providersConfig != null &&
    resolveCodexOauthRouting(normalized, options.providersConfig, {
      openaiWireFormat: options.openaiWireFormat,
      codexOauthAccountId: options.codexOauthAccountId,
    }) !== "other"
  );
}

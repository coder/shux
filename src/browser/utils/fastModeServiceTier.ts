import type { APIClient } from "@/browser/contexts/API";
import type {
  FastModePreviousServiceTier,
  ServiceTier,
} from "@/common/config/schemas/providersConfig";
import { PROVIDER_DEFINITIONS } from "@/common/constants/providers";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { isGrokFrontierModel } from "@/common/types/thinking";
import { getExplicitGatewayPrefix, normalizeToCanonical } from "@/common/utils/ai/models";
import { openaiServiceTierAvailable } from "@/common/utils/ai/openaiProviderOptionsAvailability";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";

export type FastModeProvider = "openai" | "xai";

export interface FastModeServiceTierChange {
  apiValue: ServiceTier | "";
  serviceTier: ServiceTier | undefined;
  previousServiceTier: FastModePreviousServiceTier | undefined;
}

export interface FastModeAvailabilityOptions {
  resolvedRouteProvider?: string | null;
  providersConfig?: ProvidersConfigMap | null;
}

type ProviderConfigWriter = Pick<APIClient["providers"], "setProviderConfig">;

/** Return the provider preference whose priority tier powers Fast mode on this route. */
export function getFastModeProvider(
  modelString: string,
  options?: FastModeAvailabilityOptions
): FastModeProvider | null {
  if (openaiServiceTierAvailable(modelString, options)) {
    return "openai";
  }

  const normalized = normalizeToCanonical(modelString);
  const [origin] = normalized.split(":", 2);
  const capabilityModel = resolveModelForMetadata(normalized, options?.providersConfig ?? null);
  if (origin !== "xai" || !isGrokFrontierModel(capabilityModel)) return null;

  // xAI service_tier is also provider-native and cannot survive a gateway route.
  const explicitGateway = getExplicitGatewayPrefix(modelString);
  if (explicitGateway != null) {
    const gatewayConfig = options?.providersConfig?.[explicitGateway];
    const gatewayDefinition = PROVIDER_DEFINITIONS[explicitGateway];
    const gatewayWinsRoute =
      options?.providersConfig == null ||
      (gatewayConfig?.isConfigured === true &&
        gatewayConfig.isEnabled !== false &&
        gatewayDefinition.kind === "gateway" &&
        (gatewayDefinition.routes as readonly string[]).includes("xai"));
    if (gatewayWinsRoute) return null;
  }

  return options?.resolvedRouteProvider == null || options.resolvedRouteProvider === "direct"
    ? "xai"
    : null;
}

/**
 * Fast mode is a temporary priority-tier override. The restore target lives in
 * providers.jsonc so every browser origin and desktop client observes the same state.
 */
export function getFastModeServiceTierChange(
  provider: FastModeProvider,
  currentServiceTier: ServiceTier | undefined,
  previousServiceTier?: FastModePreviousServiceTier
): FastModeServiceTierChange {
  if (currentServiceTier !== "priority") {
    return {
      apiValue: "priority",
      serviceTier: "priority",
      previousServiceTier: currentServiceTier ?? "unset",
    };
  }

  // Legacy OpenAI priority configs predate the restore field. xAI's only standard
  // tier is default, so its equivalent fallback must not emit unsupported "auto".
  const restoreServiceTier = previousServiceTier ?? (provider === "openai" ? "auto" : "default");
  return {
    apiValue: restoreServiceTier === "unset" ? "" : restoreServiceTier,
    serviceTier: restoreServiceTier === "unset" ? undefined : restoreServiceTier,
    previousServiceTier: undefined,
  };
}

/** Persist the provider-specific restore target and service-tier override in a safe order. */
export async function applyFastModeServiceTierChange(
  providers: ProviderConfigWriter,
  provider: FastModeProvider,
  currentServiceTier: ServiceTier | undefined,
  previousServiceTier?: FastModePreviousServiceTier
): Promise<FastModeServiceTierChange | null> {
  const change = getFastModeServiceTierChange(provider, currentServiceTier, previousServiceTier);

  if (currentServiceTier !== "priority") {
    const rememberResult = await providers.setProviderConfig({
      provider,
      keyPath: ["fastModePreviousServiceTier"],
      value: change.previousServiceTier ?? "unset",
    });
    if (!rememberResult.success) return null;
  }

  const tierResult = await providers.setProviderConfig({
    provider,
    keyPath: ["serviceTier"],
    value: change.apiValue,
  });
  if (!tierResult.success) return null;

  if (currentServiceTier === "priority") {
    const clearResult = await providers.setProviderConfig({
      provider,
      keyPath: ["fastModePreviousServiceTier"],
      value: "",
    });
    if (!clearResult.success) return null;
  }

  return change;
}

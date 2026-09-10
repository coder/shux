import { resolveCoderMetadataCanonicalModel } from "@/common/constants/coderOAuth";
import { isCustomProviderConfig } from "@/common/utils/providers/customProviders";

/**
 * Capability/metadata identity for gateway-scoped Coder strings
 * (coder:<instance>/<model>), derived from the instance's provider type.
 *
 * Distinct from mappedToModel ("Treat as") overrides: the Coder gateway is a
 * transparent proxy, so its models genuinely ARE the upstream models —
 * runtime capabilities (Anthropic 1M beta, pricing, context windows) carry
 * over. Treat-as mappings must NOT confer runtime capabilities, which is why
 * runtime gates apply only this mapping and not resolveModelForMetadata.
 *
 * Returns null for non-coder strings, when a custom
 * provider shadows the coder prefix (its model IDs are their own identity),
 * or when the upstream's catalog identity is unknowable (openai-compat).
 */
export function resolveCoderGatewayMetadataModel(
  fullModelId: string,
  providersConfig: Record<string, unknown> | null | undefined
): string | null {
  if (!fullModelId.startsWith("coder:")) {
    return null;
  }
  const coderSection = providersConfig?.coder;
  if (isCustomProviderConfig(coderSection)) {
    return null;
  }
  return resolveCoderMetadataCanonicalModel(
    fullModelId.slice("coder:".length),
    coderSection as { discoveredProviders?: unknown; additionalProviders?: unknown } | undefined
  );
}

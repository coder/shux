import {
  STANDARD_MODEL_PARAMETER_TO_CALL_SETTING,
  StandardModelParameterOverridesSchema,
  type ResolvedCallSettingsOverrides,
} from "@/common/config/schemas/modelParameters";
import type { ProvidersConfig } from "@/common/config/schemas/providersConfig";
import { stripModelProviderPrefixes } from "@/common/types/thinking";
import { getModelName } from "@/common/utils/ai/models";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";
import { isPlainObject } from "@/common/utils/isPlainObject";

export interface ResolvedModelParameterOverrides {
  standard: ResolvedCallSettingsOverrides;
  providerExtras?: Record<string, unknown>;
}

const SAMPLING_CALL_SETTINGS = ["temperature", "topP", "topK"] as const;

/**
 * Gemini 3.8/3.7/3.6 Flash and Gemini 3.5 Flash-Lite deprecate the sampling parameters
 * temperature/top_p/top_k; Google's migration guides require stripping them from
 * generation configs, so forwarding user overrides would break existing setups
 * (e.g. a wildcard temperature) when the gemini-flash alias repoints.
 *
 * OpenAI reasoning models are deliberately absent even though GPT-6 Astra also
 * rejects temperature/top_p/logprobs: @ai-sdk/openai already drops those from
 * both wire formats for any GPT-5+ id unless the effort is "none", and Astra
 * never receives "none" (see openaiRejectsDisabledReasoning).
 */
export function modelRejectsSamplingParameters(modelString: string): boolean {
  const bareModelId = stripModelProviderPrefixes(modelString);
  return (
    bareModelId.startsWith("gemini-3.8-flash") ||
    bareModelId.startsWith("gemini-3.7-flash") ||
    bareModelId.startsWith("gemini-3.6-flash") ||
    bareModelId.startsWith("gemini-3.5-flash-lite")
  );
}

/**
 * Resolves model parameter overrides from providers.jsonc config.
 *
 * Lookup order (first match wins):
 *   effectiveModelId → canonicalModelId → "*" (wildcard)
 *
 * Standard keys (max_output_tokens, temperature, etc.) are mapped to AI SDK
 * CallSettings names. Unknown keys are returned as providerExtras for merging
 * into providerOptions.
 */
export function resolveModelParameterOverrides(
  providersConfig: ProvidersConfig | null,
  canonicalProviderName: string,
  canonicalModelString: string,
  effectiveModelString?: string
): ResolvedModelParameterOverrides {
  if (!providersConfig) {
    return { standard: {} };
  }

  const providerBlock = providersConfig[canonicalProviderName];
  const modelParams = (providerBlock as Record<string, unknown> | undefined)?.modelParameters as
    | Record<string, unknown>
    | undefined;

  if (!modelParams) {
    return { standard: {} };
  }

  const canonicalModelId = getModelName(canonicalModelString);
  const effectiveModelId =
    effectiveModelString != null ? getModelName(effectiveModelString) : undefined;

  // Build candidates in precedence order; pick the first that is a valid plain object.
  // Malformed entries (strings, arrays, numbers) are silently skipped so the resolver
  // falls through to the next candidate rather than iterating junk.
  const candidates: unknown[] = [
    effectiveModelId != null && effectiveModelId !== canonicalModelId
      ? modelParams[effectiveModelId]
      : undefined,
    modelParams[canonicalModelId],
    modelParams["*"],
  ];

  const entry = candidates.find(isPlainObject);
  if (!entry) {
    return { standard: {} };
  }

  const standard: Record<string, number> = {};
  const providerExtras: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(entry)) {
    if (Object.hasOwn(STANDARD_MODEL_PARAMETER_TO_CALL_SETTING, key)) {
      const standardKey = key as keyof typeof STANDARD_MODEL_PARAMETER_TO_CALL_SETTING;
      const sdkKey = STANDARD_MODEL_PARAMETER_TO_CALL_SETTING[standardKey];

      // Config may be hand-edited; validate each standard key against schema bounds defensively.
      const validator = StandardModelParameterOverridesSchema.shape[standardKey];
      const parsed = validator.safeParse(value);
      if (parsed.success && parsed.data !== undefined) {
        standard[sdkKey] = parsed.data;
      }
      continue;
    }

    providerExtras[key] = value;
  }

  // Resolve mappedToModel aliases so custom entries pointing at a
  // sampling-rejecting model (e.g. team-flash -> gemini-3.8-flash) are stripped too.
  const capabilityModelString = resolveModelForMetadata(
    effectiveModelString ?? canonicalModelString,
    providersConfig
  );
  if (modelRejectsSamplingParameters(capabilityModelString)) {
    for (const key of SAMPLING_CALL_SETTINGS) {
      delete standard[key];
    }
  }

  return {
    standard: standard as ResolvedCallSettingsOverrides,
    ...(Object.keys(providerExtras).length > 0 ? { providerExtras } : {}),
  };
}

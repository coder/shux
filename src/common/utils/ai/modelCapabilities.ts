import type { ProvidersConfigMap } from "@/common/orpc/types";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";
import modelsData from "../tokens/models.json";
import { modelsExtra } from "../tokens/models-extra";
import { generateModelLookupKeys } from "../tokens/modelStats";
import { normalizeToCanonical } from "./models";

interface RawModelCapabilitiesData {
  supports_pdf_input?: boolean;
  supports_vision?: boolean;
  supports_audio_input?: boolean;
  supports_video_input?: boolean;
  max_pdf_size_mb?: number;
  litellm_provider?: string;
  [key: string]: unknown;
}

export interface ModelCapabilities {
  supportsPdfInput: boolean;
  supportsVision: boolean;
  supportsAudioInput: boolean;
  supportsVideoInput: boolean;
  maxPdfSizeMb?: number;
}

export type SupportedInputMediaType = "image" | "pdf" | "audio" | "video";

// Exported for tests: upstream LiteLLM no longer ships max_pdf_size_mb, so the
// inference branches can only be exercised with injected metadata.
export function extractModelCapabilities(data: RawModelCapabilitiesData): ModelCapabilities {
  const maxPdfSizeMb = typeof data.max_pdf_size_mb === "number" ? data.max_pdf_size_mb : undefined;
  const provider = typeof data.litellm_provider === "string" ? data.litellm_provider : undefined;

  return {
    // Some providers omit supports_pdf_input but still include a max_pdf_size_mb field.
    // Treat maxPdfSizeMb as a strong signal that PDF input is supported.
    // OpenAI's vision-capable models also accept PDFs, but our local GPT-5 metadata in
    // models-extra.ts currently omits supports_pdf_input. Infer support here so users
    // don't get a false "does not support PDF input" block for models like openai:gpt-5.5.
    supportsPdfInput:
      data.supports_pdf_input === true ||
      maxPdfSizeMb !== undefined ||
      (provider === "openai" && data.supports_vision === true && data.supports_pdf_input !== false),
    supportsVision: data.supports_vision === true,
    supportsAudioInput: data.supports_audio_input === true,
    supportsVideoInput: data.supports_video_input === true,
    maxPdfSizeMb,
  };
}

export function getModelCapabilities(modelString: string): ModelCapabilities | null {
  const normalized = normalizeToCanonical(modelString);
  // Shared with getModelStats so capabilities and stats resolve from the same
  // catalog entry (provider-scoped keys win over bare-name entries).
  const lookupKeys = generateModelLookupKeys(normalized);

  // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
  const modelsExtraRecord = modelsExtra as unknown as Record<string, RawModelCapabilitiesData>;
  // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
  const modelsDataRecord = modelsData as unknown as Record<string, RawModelCapabilitiesData>;

  // Merge models.json (upstream) + models-extra.ts (local overrides). Extras win.
  // This avoids wiping capabilities (e.g. PDF support) when modelsExtra only overrides
  // pricing/token limits.
  for (const key of lookupKeys) {
    const base = modelsDataRecord[key];
    const extra = modelsExtraRecord[key];

    if (base || extra) {
      const merged: RawModelCapabilitiesData = { ...(base ?? {}), ...(extra ?? {}) };
      return extractModelCapabilities(merged);
    }
  }

  return null;
}

export function getModelCapabilitiesResolved(
  modelString: string,
  providersConfig: ProvidersConfigMap | null
): ModelCapabilities | null {
  const metadataModel = resolveModelForMetadata(modelString, providersConfig);
  return getModelCapabilities(metadataModel);
}

export function getSupportedInputMediaTypes(
  modelString: string
): Set<SupportedInputMediaType> | null {
  const caps = getModelCapabilities(modelString);
  if (!caps) return null;

  const result = new Set<SupportedInputMediaType>();
  if (caps.supportsVision) result.add("image");
  if (caps.supportsPdfInput) result.add("pdf");
  if (caps.supportsAudioInput) result.add("audio");
  if (caps.supportsVideoInput) result.add("video");
  return result;
}

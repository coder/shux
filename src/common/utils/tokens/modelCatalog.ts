/**
 * Full catalog of model ids usable as custom-model metadata mapping targets
 * ("Treat as" in Settings). Exposes every models.json entry with usable
 * chat metadata instead of only the curated KNOWN_MODELS list (#3727).
 */

import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import modelsData from "./models.json";
import { resolveRawModelEntry } from "./modelStats";
import { MAPPABLE_MODES, toCanonicalModelId } from "./updateModelsData";

let cachedIds: string[] | undefined;

/**
 * Canonical `provider:model` ids for every catalog entry with resolvable model
 * stats, unioned with the curated KNOWN_MODELS ids. Sorted. Cached because
 * models.json is static for the process lifetime.
 */
export function listModelCatalogIds(): string[] {
  if (cachedIds === undefined) {
    const ids = new Set<string>();
    for (const model of Object.values(KNOWN_MODELS)) {
      ids.add(model.id);
    }
    for (const [key, metadata] of Object.entries(
      modelsData as Record<string, Record<string, unknown>>
    )) {
      if (typeof metadata.mode !== "string" || !MAPPABLE_MODES.has(metadata.mode)) {
        continue;
      }
      const id = toCanonicalModelId(key, metadata);
      if (id === null) {
        continue;
      }
      // Stats resolution normalizes gateway ids (openrouter:deepseek/x resolves as
      // deepseek:x), so expose the normalized identity and let the Set collapse
      // gateway duplicates; otherwise a gateway row would silently inherit the
      // direct entry's metadata while looking like a distinct option.
      const normalized = normalizeToCanonical(id);
      // Only expose rows whose stats resolve from this very entry (same validity
      // bar as getModelStats). A provider-scoped duplicate like
      // snowflake/claude-sonnet-4-6 loses stats resolution to the bare
      // models-extra override, so selecting it would inherit metadata from a
      // different entry than the row represents; the id stays selectable through
      // whichever entry actually backs it.
      const resolved = resolveRawModelEntry(normalized);
      if (resolved?.key !== key) {
        continue;
      }
      ids.add(normalized);
    }
    cachedIds = [...ids].sort();
  }
  return cachedIds;
}

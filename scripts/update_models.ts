#!/usr/bin/env bun

/**
 * Refreshes src/common/utils/tokens/models.json from LiteLLM. The transform and
 * validation logic lives in src/common/utils/tokens/updateModelsData.ts so unit
 * tests cover it. Writes only when the validated content changed, keeping
 * `make update-models`, `make build UPDATE_MODELS=1`, and the scheduled
 * update-models workflow idempotent (#3727).
 */

import {
  pruneModelData,
  sanitizePricing,
  serializeModelData,
  validateModelData,
  type ModelCatalogData,
} from "../src/common/utils/tokens/updateModelsData";

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OUTPUT_PATH = "src/common/utils/tokens/models.json";

async function updateModels() {
  console.log(`Fetching model data from ${LITELLM_URL}...`);

  const response = await fetch(LITELLM_URL);

  if (!response.ok) {
    throw new Error(`Failed to fetch model data: ${response.status} ${response.statusText}`);
  }

  const sanitized = sanitizePricing(pruneModelData(await response.json()));
  if (sanitized.droppedModelIds.length > 0) {
    console.warn(
      `Dropped ${sanitized.droppedModelIds.length} entries with invalid pricing: ` +
        sanitized.droppedModelIds.slice(0, 10).join(", ")
    );
  }

  const existing = await Bun.file(OUTPUT_PATH)
    .text()
    .catch(() => null);
  // Validate against the vendored catalog so a truncated upstream response, a
  // field rename, or a targeted repricing cannot silently degrade known models.
  let baseline: ModelCatalogData | undefined;
  if (existing !== null) {
    try {
      baseline = JSON.parse(existing) as ModelCatalogData;
    } catch {
      console.warn(`Could not parse existing ${OUTPUT_PATH}; skipping baseline checks`);
    }
  }
  validateModelData(sanitized, baseline);

  const serialized = serializeModelData(sanitized.catalog);
  if (existing === serialized) {
    console.log("✓ models.json already up to date");
    return;
  }

  await Bun.write(OUTPUT_PATH, serialized);
  console.log(`✓ Updated ${OUTPUT_PATH} (${Object.keys(sanitized.catalog).length} models)`);
}

updateModels().catch((error) => {
  console.error("Error updating models:", error);
  process.exit(1);
});

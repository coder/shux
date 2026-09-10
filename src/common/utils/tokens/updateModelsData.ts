/**
 * Pure transform/validation logic for refreshing models.json from LiteLLM's
 * model_prices_and_context_window.json. The fetch/write CLI wrapper lives in
 * scripts/update_models.ts (run via `make update-models`); the logic lives here
 * so `bun test src` covers it (#3727).
 */

import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { normalizeToCanonical } from "../ai/models";
import { modelsExtra } from "./models-extra";
import { generateModelLookupKeys, hasUsableTokenLimits, parseNum } from "./modelStats";

const RETAINED_FIELDS = [
  "max_input_tokens",
  "max_output_tokens",
  "input_cost_per_token",
  "output_cost_per_token",
  "output_cost_per_image_token",
  "input_cost_per_token_above_200k_tokens",
  "output_cost_per_token_above_200k_tokens",
  "cache_creation_input_token_cost",
  "cache_creation_input_token_cost_above_200k_tokens",
  "cache_read_input_token_cost",
  "cache_read_input_token_cost_above_200k_tokens",
  "tiered_pricing_threshold_tokens",
  "mode",
  "litellm_provider",
  "supports_pdf_input",
  "supports_vision",
  "supports_audio_input",
  "supports_video_input",
  "max_pdf_size_mb",
] as const;

const COST_FIELDS = [
  "input_cost_per_token",
  "output_cost_per_token",
  "output_cost_per_image_token",
  "input_cost_per_token_above_200k_tokens",
  "output_cost_per_token_above_200k_tokens",
  "cache_creation_input_token_cost",
  "cache_creation_input_token_cost_above_200k_tokens",
  "cache_read_input_token_cost",
  "cache_read_input_token_cost_above_200k_tokens",
] as const;

// Abort thresholds guarding against truncated or structurally reshaped upstream data.
// The absolute floor catches degenerate payloads; the relative bounds catch partial
// responses or field renames that would silently degrade thousands of known models.
const MIN_USABLE_MAPPABLE_MODELS = 500;
const MAX_BASELINE_SHRINK_FRACTION = 0.1;
// Relative checks only apply to baselines with enough entries for the fraction
// to be signal rather than noise (a 3-entry mode legitimately losing 1 entry
// must not block refreshes forever).
const MIN_BASELINE_FOR_SHRINK_CHECK = 20;
const MAX_INVALID_PRICING_FRACTION = 0.05;
// A poisoned upstream could keep every field present but rescale values
// (prices toward zero, token limits toward 1), silently corrupting cost
// accounting or context handling. Legitimate repricing rarely approaches this
// factor, so both a catalog-wide median shift and a per-entry value shift
// beyond it are treated as corruption.
const MAX_MAGNITUDE_SHIFT_FACTOR = 100;

/** Modes whose metadata applies to chat-style usage; mirrored by the Treat-as catalog. */
export const MAPPABLE_MODES = new Set(["chat", "responses"]);

/**
 * Canonical `provider:model` id for a catalog key. LiteLLM keys are either
 * "provider/model" or a bare model id whose provider lives in litellm_provider;
 * both forms round-trip through getModelStats' lookup keys. Shared with the
 * Treat-as catalog so validation and the UI derive identities identically.
 */
export function toCanonicalModelId(
  catalogKey: string,
  metadata: Record<string, unknown>
): string | null {
  const slashIndex = catalogKey.indexOf("/");
  if (slashIndex > 0) {
    return `${catalogKey.slice(0, slashIndex)}:${catalogKey.slice(slashIndex + 1)}`;
  }
  const provider = metadata.litellm_provider;
  return typeof provider === "string" && provider.length > 0 ? `${provider}:${catalogKey}` : null;
}

export type ModelCatalogData = Record<string, Record<string, unknown>>;

export interface SanitizedModelData {
  catalog: ModelCatalogData;
  /** Catalog keys dropped because a present cost field was not a finite non-negative number. */
  droppedModelIds: string[];
}

export function pruneModelData(data: unknown): ModelCatalogData {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Expected LiteLLM model metadata object");
  }

  const pruned: ModelCatalogData = {};
  for (const [modelId, rawMetadata] of Object.entries(data)) {
    if (!rawMetadata || typeof rawMetadata !== "object" || Array.isArray(rawMetadata)) {
      continue;
    }

    const metadata = rawMetadata as Record<string, unknown>;
    const retained: Record<string, unknown> = {};
    // Keep models.json small: Xum only reads pricing, token limits, provider, mode, and media
    // capability fields, while upstream LiteLLM ships many provider-specific fields we never use.
    for (const field of RETAINED_FIELDS) {
      if (metadata[field] !== undefined) {
        retained[field] = metadata[field];
      }
    }
    pruned[modelId] = retained;
  }

  return pruned;
}

function hasValidPricing(metadata: Record<string, unknown>): boolean {
  return COST_FIELDS.every((field) => {
    const value = metadata[field];
    // Absent costs are fine (e.g. subscription providers); present costs must be
    // usable numbers, otherwise cost tracking would silently misprice the model.
    return (
      value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0)
    );
  });
}

export function sanitizePricing(pruned: ModelCatalogData): SanitizedModelData {
  const catalog: ModelCatalogData = {};
  const droppedModelIds: string[] = [];

  for (const [modelId, metadata] of Object.entries(pruned)) {
    if (hasValidPricing(metadata)) {
      catalog[modelId] = metadata;
    } else {
      droppedModelIds.push(modelId);
    }
  }

  return { catalog, droppedModelIds };
}

function providesUsableMetadata(entry: unknown): boolean {
  return (
    typeof entry === "object" &&
    entry !== null &&
    hasUsableTokenLimits(entry as Record<string, unknown>)
  );
}

/**
 * Curated models that would lose token/pricing metadata under the given catalog.
 * Coverage uses getModelStats' own lookup keys and usability bar, so any key
 * form the runtime can resolve (bare, provider-scoped, models-extra override)
 * counts, and an entry that loses its token limits still counts as missing.
 */
export function findMissingKnownModels(
  catalog: ModelCatalogData,
  extra: Record<string, unknown> = modelsExtra
): string[] {
  const missing: string[] = [];
  for (const model of Object.values(KNOWN_MODELS)) {
    const covered = generateModelLookupKeys(model.id).some(
      (key) => providesUsableMetadata(catalog[key]) || providesUsableMetadata(extra[key])
    );
    if (!covered) {
      missing.push(model.id);
    }
  }
  return missing;
}

export interface ModeCoverage {
  /** Entries in this mode. */
  entries: number;
  /** Entries passing getModelStats' usability bar (usable token limits). */
  usable: number;
  /**
   * Per retained field, entries carrying a consumed value. Every retained
   * field is read somewhere at runtime (stats, pricing, capabilities) and most
   * are optional per entry, so coverage is tracked per field and per mode:
   * an upstream removal or rename of any one field registers as shrinkage
   * instead of hiding behind counts of the surviving fields.
   */
  fields: Record<string, number>;
}

export interface NumericFieldStats {
  /** Mappable-mode entries carrying a positive value for the field. */
  samples: number;
  /** Median of those positive values (0 when none). */
  median: number;
}

export interface CatalogSummary {
  totalEntries: number;
  /** Coverage per mode string, spanning every mode (not just mappable ones). */
  modes: Record<string, ModeCoverage>;
  /** Magnitude stats per numeric retained field across mappable entries. */
  numericFields: Record<string, NumericFieldStats>;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Booleans count only when true: capability flags are consumed as "absent ==
// unsupported", so a catalog-wide flip to false is equivalent to removal.
function hasConsumedValue(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  return typeof value === "string" && value.length > 0;
}

export function summarizeCatalog(catalog: ModelCatalogData): CatalogSummary {
  const summary: CatalogSummary = { totalEntries: 0, modes: {}, numericFields: {} };
  const numericSamples = new Map<string, number[]>();
  for (const metadata of Object.values(catalog)) {
    summary.totalEntries++;
    const mode = typeof metadata.mode === "string" ? metadata.mode : "unknown";
    const coverage = (summary.modes[mode] ??= { entries: 0, usable: 0, fields: {} });
    coverage.entries++;
    // Usability applies getModelStats' bar: entries without usable token limits
    // never resolve, so losing max_input_tokens must register as shrinkage.
    if (hasUsableTokenLimits(metadata)) {
      coverage.usable++;
    }
    for (const field of RETAINED_FIELDS) {
      if (field === "mode") {
        continue; // the bucket key itself; `entries` already counts it
      }
      const value = metadata[field];
      if (hasConsumedValue(value)) {
        coverage.fields[field] = (coverage.fields[field] ?? 0) + 1;
      }
      // parseNum mirrors runtime parsing, so a numeric string like "128000"
      // contributes its real magnitude instead of reading as a collapse.
      const numeric = parseNum(value);
      if (MAPPABLE_MODES.has(mode) && numeric !== null && numeric > 0) {
        let samples = numericSamples.get(field);
        if (samples === undefined) {
          samples = [];
          numericSamples.set(field, samples);
        }
        samples.push(numeric);
      }
    }
  }
  for (const [field, samples] of numericSamples) {
    summary.numericFields[field] = { samples: samples.length, median: median(samples) };
  }
  return summary;
}

/**
 * The entry a catalog would serve for a model id, using getModelStats' own
 * lookup preference and usability bar. Alias-shadowing corruption is only
 * visible through this resolution, never through raw key comparison.
 */
function resolveCatalogEntry(
  catalog: ModelCatalogData,
  modelId: string
): Record<string, unknown> | undefined {
  for (const key of generateModelLookupKeys(modelId)) {
    const entry = catalog[key];
    if (entry !== undefined && hasUsableTokenLimits(entry)) {
      return entry;
    }
  }
  return undefined;
}

function belowBaseline(count: number, baseline: number): boolean {
  return (
    baseline >= MIN_BASELINE_FOR_SHRINK_CHECK &&
    count < Math.ceil(baseline * (1 - MAX_BASELINE_SHRINK_FRACTION))
  );
}

/**
 * Throws when the sanitized upstream data is unfit to replace the vendored
 * models.json. `baselineCatalog` is the currently vendored catalog (defaults
 * to empty when unavailable, disabling the relative checks).
 */
export function validateModelData(
  sanitized: SanitizedModelData,
  baselineCatalog: ModelCatalogData = {}
): void {
  const { catalog, droppedModelIds } = sanitized;
  const errors: string[] = [];

  const summary = summarizeCatalog(catalog);
  const baseline = summarizeCatalog(baselineCatalog);
  const usableMappableModels = [...MAPPABLE_MODES].reduce(
    (count, mode) => count + (summary.modes[mode]?.usable ?? 0),
    0
  );
  if (usableMappableModels < MIN_USABLE_MAPPABLE_MODELS) {
    errors.push(
      `only ${usableMappableModels} usable chat/responses models found ` +
        `(expected at least ${MIN_USABLE_MAPPABLE_MODELS})`
    );
  }

  // Fields are optional per entry (e.g. subscription providers omit costs), so
  // an upstream rename or wholesale omission of any retained field, or of a
  // whole mode, would sail through the per-entry checks; comparing every mode's
  // entry/usable counts and every retained field's per-mode coverage against
  // the vendored baseline keeps a refresh from silently dropping, zero-pricing,
  // or de-capability-ing whole slices of the catalog.
  const shrinkChecks: Array<[label: string, count: number, baselineCount: number]> = [
    ["total entry count", summary.totalEntries, baseline.totalEntries],
  ];
  const emptyCoverage: ModeCoverage = { entries: 0, usable: 0, fields: {} };
  for (const [mode, baselineCoverage] of Object.entries(baseline.modes)) {
    const coverage = summary.modes[mode] ?? emptyCoverage;
    shrinkChecks.push(
      [`${mode} entry count`, coverage.entries, baselineCoverage.entries],
      [`${mode} usable model count`, coverage.usable, baselineCoverage.usable]
    );
    for (const [field, baselineCount] of Object.entries(baselineCoverage.fields)) {
      shrinkChecks.push([`${mode} ${field} coverage`, coverage.fields[field] ?? 0, baselineCount]);
    }
  }
  // Numeric magnitudes are guarded too, not just field presence: a poisoned
  // catalog could retain every field while rescaling values (prices toward
  // zero or absurdly high, token limits toward 1). A collapsed sample count
  // (e.g. every price zeroed) fails both the sample shrink and the median
  // check, since a zero median is more than MAX_MEDIAN_SHIFT_FACTOR below any
  // positive baseline.
  for (const [field, baselineStats] of Object.entries(baseline.numericFields)) {
    if (baselineStats.samples < MIN_BASELINE_FOR_SHRINK_CHECK || baselineStats.median <= 0) {
      continue;
    }
    const candidate = summary.numericFields[field] ?? { samples: 0, median: 0 };
    shrinkChecks.push([`${field} positive-value count`, candidate.samples, baselineStats.samples]);
    const ratio = candidate.median / baselineStats.median;
    if (ratio > MAX_MAGNITUDE_SHIFT_FACTOR || ratio < 1 / MAX_MAGNITUDE_SHIFT_FACTOR) {
      errors.push(
        `${field} median shifted from ${baselineStats.median} to ${candidate.median} ` +
          `(more than ${MAX_MAGNITUDE_SHIFT_FACTOR}x from the vendored baseline; possible corruption)`
      );
    }
  }
  for (const [label, count, baselineCount] of shrinkChecks) {
    if (belowBaseline(count, baselineCount)) {
      errors.push(
        `${label} shrank from ${baselineCount} to ${count} ` +
          `(more than ${MAX_BASELINE_SHRINK_FRACTION * 100}% below the vendored baseline)`
      );
    }
  }

  // Catalog-wide counts and medians cannot see targeted single-row corruption,
  // and raw-key comparison cannot see alias shadowing: a poisoned catalog can
  // add a higher-precedence key (openai/gpt-4o-mini over a baseline
  // gpt-4o-mini) or move a row to such an alias, leaving every count and
  // median intact while runtime lookups resolve the poisoned entry. Entries
  // are therefore compared by runtime identity: for every model id either
  // catalog can serve, the entry each catalog resolves through getModelStats'
  // own lookup preference must keep positive numeric fields present and
  // within the magnitude factor (runtime parseNum semantics, so numeric
  // strings compare by value) and keep baseline-true capability flags (runtime
  // treats absent/false as unsupported). Legitimate changes beyond these
  // bounds fail closed: delete models.json and rerun to deliberately accept a
  // full refresh.
  const entryShifts: string[] = [];
  const identities = new Set<string>();
  for (const source of [baselineCatalog, catalog]) {
    for (const [key, metadata] of Object.entries(source)) {
      identities.add(normalizeToCanonical(toCanonicalModelId(key, metadata) ?? key));
    }
  }
  for (const id of identities) {
    const baselineEntry = resolveCatalogEntry(baselineCatalog, id);
    if (baselineEntry === undefined) {
      continue; // genuinely new identity; nothing vendored to compare against
    }
    const entry = resolveCatalogEntry(catalog, id);
    if (entry === undefined) {
      continue; // fully removed identities are governed by the coverage baselines
    }
    for (const field of RETAINED_FIELDS) {
      const baselineValue = baselineEntry[field];
      if (baselineValue === true) {
        if (entry[field] !== true) {
          entryShifts.push(`${id} ${field}: true -> ${JSON.stringify(entry[field]) ?? "absent"}`);
        }
        continue;
      }
      const baselineNum = typeof baselineValue === "boolean" ? null : parseNum(baselineValue);
      if (baselineNum === null || baselineNum <= 0) {
        continue;
      }
      const candidateNum = parseNum(entry[field]);
      const ratio = candidateNum === null ? 0 : candidateNum / baselineNum;
      if (ratio > MAX_MAGNITUDE_SHIFT_FACTOR || ratio < 1 / MAX_MAGNITUDE_SHIFT_FACTOR) {
        entryShifts.push(`${id} ${field}: ${baselineNum} -> ${candidateNum ?? "absent"}`);
      }
    }
  }
  if (entryShifts.length > 0) {
    errors.push(
      `${entryShifts.length} resolved model identities regressed a retained field beyond the ` +
        `vendored baseline (e.g. ${entryShifts.slice(0, 5).join("; ")})`
    );
  }

  const total = Object.keys(catalog).length + droppedModelIds.length;
  if (total > 0 && droppedModelIds.length / total > MAX_INVALID_PRICING_FRACTION) {
    errors.push(
      `${droppedModelIds.length}/${total} entries have invalid pricing ` +
        `(e.g. ${droppedModelIds.slice(0, 5).join(", ")})`
    );
  }

  const missingKnownModels = findMissingKnownModels(catalog);
  if (missingKnownModels.length > 0) {
    errors.push(`curated known models missing from upstream: ${missingKnownModels.join(", ")}`);
  }

  if (errors.length > 0) {
    throw new Error(`Refusing to update models.json:\n- ${errors.join("\n- ")}`);
  }
}

export function serializeModelData(catalog: ModelCatalogData): string {
  // Sort keys so upstream object reordering never shows up as a diff (the CLI
  // and the scheduled workflow treat byte-identical output as "no update").
  const sorted = Object.fromEntries(
    Object.entries(catalog).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

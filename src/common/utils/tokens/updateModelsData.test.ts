import { describe, test, expect } from "@jest/globals";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import modelsJson from "./models.json";
import {
  findMissingKnownModels,
  pruneModelData,
  sanitizePricing,
  serializeModelData,
  summarizeCatalog,
  validateModelData,
} from "./updateModelsData";

function chatEntries(
  count: number,
  overrides: Record<string, unknown> = {},
  prefix = "provider/model"
): Record<string, Record<string, unknown>> {
  const entries: Record<string, Record<string, unknown>> = {};
  for (let i = 0; i < count; i++) {
    entries[`${prefix}-${i}`] = {
      mode: "chat",
      max_input_tokens: 128000,
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000002,
      ...overrides,
    };
  }
  return entries;
}

// Covers every curated model so only the guard under test can fail validation.
const curatedCoverage = Object.fromEntries(
  Object.values(KNOWN_MODELS).map((model) => [
    model.providerModelId,
    { mode: "chat", max_input_tokens: 200000 },
  ])
);

describe("pruneModelData", () => {
  test("rejects non-object payloads", () => {
    expect(() => pruneModelData(null)).toThrow("Expected LiteLLM model metadata object");
    expect(() => pruneModelData([1, 2])).toThrow("Expected LiteLLM model metadata object");
  });

  test("keeps only retained fields and drops non-object entries", () => {
    const pruned = pruneModelData({
      "provider/model-a": {
        max_input_tokens: 1000,
        input_cost_per_token: 0.001,
        litellm_provider: "provider",
        source: "https://example.com",
        deprecation_date: "2027-01-01",
      },
      bogus: "not-an-object",
    });

    expect(pruned["provider/model-a"]).toEqual({
      max_input_tokens: 1000,
      input_cost_per_token: 0.001,
      litellm_provider: "provider",
    });
    expect(pruned.bogus).toBeUndefined();
  });
});

describe("sanitizePricing", () => {
  test("drops entries whose present cost fields are unusable", () => {
    const { catalog, droppedModelIds } = sanitizePricing({
      good: { input_cost_per_token: 0.001, output_cost_per_token: 0 },
      // Subscription providers legitimately omit costs entirely.
      "no-costs": { max_input_tokens: 1000 },
      negative: { input_cost_per_token: -0.001 },
      "not-a-number": { output_cost_per_token: "0.001" },
      infinite: { cache_read_input_token_cost: Number.POSITIVE_INFINITY },
    });

    expect(Object.keys(catalog).sort()).toEqual(["good", "no-costs"]);
    expect(droppedModelIds.sort()).toEqual(["infinite", "negative", "not-a-number"]);
  });
});

describe("findMissingKnownModels", () => {
  const usable = { max_input_tokens: 256000 };

  test("reports all curated models against an empty catalog and no overrides", () => {
    const missing = findMissingKnownModels({}, {});
    expect(missing.sort()).toEqual(
      Object.values(KNOWN_MODELS)
        .map((model) => model.id)
        .sort()
    );
  });

  test("any runtime-resolvable key form satisfies coverage, unrelated keys do not", () => {
    const grok = Object.values(KNOWN_MODELS).find((model) => model.provider === "xai");
    if (!grok) throw new Error("expected a curated xai model");

    // Coverage mirrors getModelStats' lookup keys: both the provider-prefixed
    // form LiteLLM uses for xAI and the bare fallback resolve at runtime.
    expect(findMissingKnownModels({ [`xai/${grok.providerModelId}`]: usable }, {})).not.toContain(
      grok.id
    );
    expect(findMissingKnownModels({ [grok.providerModelId]: usable }, {})).not.toContain(grok.id);
    expect(
      findMissingKnownModels({ [`unrelated/${grok.providerModelId}x`]: usable }, {})
    ).toContain(grok.id);
  });

  test("a retained key with unusable token limits still counts as missing", () => {
    const anthropic = Object.values(KNOWN_MODELS).find((model) => model.provider === "anthropic");
    if (!anthropic) throw new Error("expected a curated anthropic model");

    // Key presence is not coverage: getModelStats would reject these entries.
    expect(findMissingKnownModels({ [anthropic.providerModelId]: {} }, {})).toContain(anthropic.id);
    expect(
      findMissingKnownModels({ [anthropic.providerModelId]: { max_input_tokens: 0 } }, {})
    ).toContain(anthropic.id);
  });

  test("models-extra overrides satisfy models absent upstream", () => {
    const anthropic = Object.values(KNOWN_MODELS).find((model) => model.provider === "anthropic");
    if (!anthropic) throw new Error("expected a curated anthropic model");

    expect(findMissingKnownModels({}, { [anthropic.providerModelId]: usable })).not.toContain(
      anthropic.id
    );
  });
});

describe("validateModelData", () => {
  test("accepts the current vendored models.json against its own baseline", () => {
    const vendored = modelsJson as Record<string, Record<string, unknown>>;
    const sanitized = sanitizePricing(vendored);
    expect(sanitized.droppedModelIds).toEqual([]);
    expect(() => validateModelData(sanitized, vendored)).not.toThrow();
  });

  test("rejects truncated upstream data", () => {
    expect(() => validateModelData({ catalog: chatEntries(10), droppedModelIds: [] })).toThrow(
      /only 10 usable chat\/responses models found/
    );
  });

  test("rejects a large shrink below the vendored baseline even above the floor", () => {
    const sanitized = {
      catalog: { ...chatEntries(600), ...curatedCoverage },
      droppedModelIds: [],
    };
    expect(() => validateModelData(sanitized, chatEntries(2000))).toThrow(
      /chat usable model count shrank from 2000/
    );
    // A small decrease within the bound is acceptable (e.g. upstream pruning).
    expect(() => validateModelData(sanitized, chatEntries(650))).not.toThrow();
  });

  test("rejects the loss of one pricing field even when the other survives", () => {
    // An upstream rename of just output_cost_per_token keeps every entry
    // input-priced, so aggregated priced coverage would hide the regression.
    const outputless = chatEntries(700, { output_cost_per_token: undefined }, "prov/outputless");
    const sanitized = { catalog: { ...outputless, ...curatedCoverage }, droppedModelIds: [] };
    expect(() => validateModelData(sanitized, chatEntries(700))).toThrow(
      /chat output_cost_per_token coverage shrank from 700 to 0/
    );
  });

  test("rejects pricing loss confined to a smaller mode", () => {
    // Stripping costs from every responses row barely moves aggregate priced
    // counts, so each mode compares against its own baseline.
    const responses = (overrides: Record<string, unknown>) =>
      chatEntries(60, { mode: "responses", ...overrides }, "prov/responses");
    const baseline = { ...chatEntries(700), ...responses({}) };
    const sanitized = {
      catalog: {
        ...chatEntries(700),
        ...responses({ input_cost_per_token: undefined, output_cost_per_token: undefined }),
        ...curatedCoverage,
      },
      droppedModelIds: [],
    };
    expect(() => validateModelData(sanitized, baseline)).toThrow(
      /responses input_cost_per_token coverage shrank from 60 to 0/
    );
  });

  test("rejects wholesale omission of a non-mappable mode", () => {
    // A partial payload that keeps chat/responses but drops image_generation
    // rows must trip that mode's own entry-count baseline.
    const baseline = {
      ...chatEntries(700),
      ...chatEntries(300, { mode: "image_generation", max_input_tokens: undefined }, "prov/image"),
    };
    const sanitized = {
      catalog: { ...chatEntries(700), ...curatedCoverage },
      droppedModelIds: [],
    };
    expect(() => validateModelData(sanitized, baseline)).toThrow(
      /image_generation entry count shrank from 300 to 0/
    );
  });

  test("rejects removal of a cost field beyond the base input/output pair", () => {
    // Wiping output_cost_per_image_token leaves the base pair intact; the
    // runtime would silently fall back to (much lower) generic output rates.
    const image = (overrides: Record<string, unknown>) =>
      chatEntries(300, { mode: "image_generation", ...overrides }, "prov/image");
    const baseline = {
      ...chatEntries(700),
      ...image({ output_cost_per_image_token: 0.00002 }),
    };
    const sanitized = {
      catalog: { ...chatEntries(700), ...image({}), ...curatedCoverage },
      droppedModelIds: [],
    };
    expect(() => validateModelData(sanitized, baseline)).toThrow(
      /image_generation output_cost_per_image_token coverage shrank from 300 to 0/
    );
  });

  test("rejects a catalog-wide loss of capability flags", () => {
    // Runtime treats missing/false capability flags as unsupported, so both a
    // field removal and a mass flip to false must register as coverage loss.
    const baseline = chatEntries(700, { supports_pdf_input: true });
    const flipped = {
      catalog: { ...chatEntries(700, { supports_pdf_input: false }), ...curatedCoverage },
      droppedModelIds: [],
    };
    const removed = {
      catalog: { ...chatEntries(700), ...curatedCoverage },
      droppedModelIds: [],
    };
    for (const sanitized of [flipped, removed]) {
      expect(() => validateModelData(sanitized, baseline)).toThrow(
        /chat supports_pdf_input coverage shrank from 700 to 0/
      );
    }
  });

  test("rejects a catalog-wide loss of token limits even when pricing survives", () => {
    // Entries keep mode + pricing but lose max_input_tokens: getModelStats
    // rejects them, so usable coverage must register the collapse.
    const limitless = chatEntries(700, { max_input_tokens: undefined }, "prov/limitless");
    const sanitized = { catalog: { ...limitless, ...curatedCoverage }, droppedModelIds: [] };
    expect(() => validateModelData(sanitized, chatEntries(700))).toThrow(
      /chat usable model count shrank from 700/
    );
  });

  test("rejects a catalog-wide token-limit magnitude collapse", () => {
    // max_input_tokens: 1 still passes the usability bar and every coverage
    // count, so only the magnitude median can catch mass-shrunk context sizes.
    const tiny = chatEntries(700, { max_input_tokens: 1 }, "prov/tiny");
    const sanitized = { catalog: { ...tiny, ...curatedCoverage }, droppedModelIds: [] };
    expect(() => validateModelData(sanitized, chatEntries(700))).toThrow(
      /max_input_tokens median shifted/
    );
  });

  test("summarizes per-mode field coverage and mappable numeric magnitudes", () => {
    expect(
      summarizeCatalog({
        usableChat: {
          mode: "chat",
          max_input_tokens: 128000,
          input_cost_per_token: 0.000001,
          supports_vision: true,
        },
        usableResponses: {
          mode: "responses",
          max_input_tokens: 128000,
          input_cost_per_token: 0.000002,
          output_cost_per_token: 0.000008,
        },
        // supports_vision: false counts as absent (runtime treats it as unsupported).
        limitlessChat: { mode: "chat", input_cost_per_token: 0.000001, supports_vision: false },
        embedding: { mode: "embedding", max_input_tokens: 8192, input_cost_per_token: 0.0000001 },
      })
    ).toEqual({
      totalEntries: 4,
      modes: {
        chat: {
          entries: 2,
          usable: 1,
          fields: { max_input_tokens: 1, input_cost_per_token: 2, supports_vision: 1 },
        },
        responses: {
          entries: 1,
          usable: 1,
          fields: { max_input_tokens: 1, input_cost_per_token: 1, output_cost_per_token: 1 },
        },
        embedding: {
          entries: 1,
          usable: 1,
          fields: { max_input_tokens: 1, input_cost_per_token: 1 },
        },
      },
      // Magnitudes span mappable entries only, so the embedding cost is excluded.
      numericFields: {
        max_input_tokens: { samples: 2, median: 128000 },
        input_cost_per_token: { samples: 3, median: 0.000001 },
        output_cost_per_token: { samples: 1, median: 0.000008 },
      },
    });
  });

  test("rejects a catalog-wide price magnitude collapse", () => {
    // Every field survives and all counters match, but rates are scaled by
    // 1e-9; only the median magnitude guard can catch this.
    const scaled = chatEntries(
      700,
      { input_cost_per_token: 0.000001e-9, output_cost_per_token: 0.000002e-9 },
      "prov/scaled"
    );
    const sanitized = { catalog: { ...scaled, ...curatedCoverage }, droppedModelIds: [] };
    expect(() => validateModelData(sanitized, chatEntries(700))).toThrow(
      /input_cost_per_token median shifted/
    );
  });

  test("rejects a catalog-wide zeroing of prices", () => {
    // Zero is a valid per-entry price and keeps field coverage intact, but a
    // catalog-wide zero-out must fail the magnitude check (median collapses to
    // 0), not slip past it because the ratio guard only ran on positive values.
    const free = chatEntries(
      700,
      { input_cost_per_token: 0, output_cost_per_token: 0 },
      "prov/free"
    );
    const sanitized = { catalog: { ...free, ...curatedCoverage }, droppedModelIds: [] };
    expect(() => validateModelData(sanitized, chatEntries(700))).toThrow(
      /input_cost_per_token median shifted from 0.000001 to 0/
    );
  });

  test("rejects a targeted single-row price shift that no catalog-wide guard sees", () => {
    const poison = (overrides: Record<string, unknown>) => {
      const catalog = { ...chatEntries(700), ...curatedCoverage };
      catalog["provider/model-3"] = { ...catalog["provider/model-3"], ...overrides };
      return { catalog, droppedModelIds: [] };
    };
    // Scaling (or deleting) one row's price moves no count and no median; only
    // the per-identity magnitude bound can catch it.
    expect(() =>
      validateModelData(poison({ input_cost_per_token: 0.000001e-9 }), chatEntries(700))
    ).toThrow(/provider:model-3 input_cost_per_token: 0.000001 -> 1e-15/);
    expect(() =>
      validateModelData(poison({ input_cost_per_token: undefined }), chatEntries(700))
    ).toThrow(/provider:model-3 input_cost_per_token: 0.000001 -> absent/);
    // Ordinary per-row repricing within the factor is accepted.
    expect(() =>
      validateModelData(poison({ input_cost_per_token: 0.00001 }), chatEntries(700))
    ).not.toThrow();
  });

  test("rejects a poisoned higher-precedence alias shadowing a baseline row", () => {
    // Adding openai/x on top of a baseline bare x (or moving the row there)
    // leaves every count and median intact, but runtime lookup prefers the
    // scoped key; comparison must follow resolved identities, not raw keys.
    const bare = {
      mode: "chat",
      max_input_tokens: 128000,
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000002,
      litellm_provider: "acme",
    };
    const poisonedAlias = { ...bare, input_cost_per_token: 0.000001e-9 };
    const baseline = { ...chatEntries(700), "acme-chat-1": bare };
    for (const catalog of [
      // Attack 1: new alias added while the original row survives.
      { ...baseline, "acme/acme-chat-1": poisonedAlias },
      // Attack 2: original key removed, row substituted under the alias.
      { ...chatEntries(700), "acme/acme-chat-1": poisonedAlias },
    ]) {
      const sanitized = { catalog: { ...catalog, ...curatedCoverage }, droppedModelIds: [] };
      expect(() => validateModelData(sanitized, baseline)).toThrow(
        /acme:acme-chat-1 input_cost_per_token: 0.000001 -> 1e-15/
      );
    }
  });

  test("rejects a targeted capability-flag flip on a single row", () => {
    // One true -> false flip is far inside the aggregate 10% allowance, but
    // runtime would start rejecting valid attachments for that model.
    const baseline = chatEntries(700, { supports_pdf_input: true });
    const catalog = { ...baseline, ...curatedCoverage };
    catalog["provider/model-3"] = { ...catalog["provider/model-3"], supports_pdf_input: false };
    expect(() => validateModelData({ catalog, droppedModelIds: [] }, baseline)).toThrow(
      /provider:model-3 supports_pdf_input: true -> false/
    );
  });

  test("accepts runtime-parseable numeric strings as equal magnitudes", () => {
    // getModelStats parses "128000" like 128000, so a representation change
    // must not read as a >100x collapse and block the refresh.
    const catalog = { ...chatEntries(700), ...curatedCoverage };
    catalog["provider/model-3"] = { ...catalog["provider/model-3"], max_input_tokens: "128000" };
    expect(() =>
      validateModelData({ catalog, droppedModelIds: [] }, chatEntries(700))
    ).not.toThrow();
  });

  test("rejects data where too many entries had invalid pricing", () => {
    // 100 dropped out of 700 total (14%) exceeds the 5% abort threshold.
    const dropped = Array.from({ length: 100 }, (_, i) => `dropped-${i}`);
    expect(() =>
      validateModelData({ catalog: chatEntries(600), droppedModelIds: dropped })
    ).toThrow(/entries have invalid pricing/);
  });

  test("rejects data missing curated known models", () => {
    // A large catalog that satisfies the size floor but carries none of the
    // curated model keys that models-extra does not already cover.
    expect(() => validateModelData({ catalog: chatEntries(600), droppedModelIds: [] })).toThrow(
      /curated known models missing from upstream/
    );
  });
});

describe("serializeModelData", () => {
  test("sorts keys so upstream reordering produces no diff", () => {
    const forward = serializeModelData({ b: { mode: "chat" }, a: { mode: "chat" } });
    const reversed = serializeModelData({ a: { mode: "chat" }, b: { mode: "chat" } });
    expect(forward).toBe(reversed);
    expect(forward.indexOf('"a"')).toBeLessThan(forward.indexOf('"b"'));
  });
});

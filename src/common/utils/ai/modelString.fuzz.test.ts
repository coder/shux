/**
 * Fuzz tests for model-string parsing, normalization, and routing helpers.
 *
 * Model strings come from user input, persisted config, and gateway catalogs;
 * these invariants ensure hostile inputs (prototype-pollution keys, lone
 * surrogates, repeated separators) never throw, and that normalization is
 * idempotent so repeated persistence round-trips cannot drift.
 */
import { describe, test, expect } from "bun:test";
import {
  resolveModelAlias,
  isValidModelFormat,
  normalizeToCanonical,
  normalizeSelectedModel,
  getExplicitGatewayPrefix,
  modelSelectionEqualityKey,
  getModelName,
  getModelProvider,
  getAnthropic1MContextMode,
  resolveProviderOptionsNamespaceKey,
} from "./models";
import { normalizeModelInput } from "./normalizeModelInput";
import { PROVIDER_DEFINITIONS, type ProviderName } from "@/common/constants/providers";
import {
  mulberry32,
  randomFragmentString,
  randomHostileValue,
} from "@/common/utils/testing/fuzzHelpers";

const SEED = 0xdead1;
const ITERATIONS = 5000;

describe("model string fuzz", () => {
  test(`parsing pipeline never throws and honors format invariants (seed=${SEED})`, () => {
    const rng = mulberry32(SEED);
    for (let i = 0; i < ITERATIONS; i++) {
      const raw = randomFragmentString(rng);

      const aliasResolved = resolveModelAlias(raw);
      expect(typeof aliasResolved).toBe("string");

      const result = normalizeModelInput(raw);
      if (result.model !== null) {
        // Accepted models must be well-formed provider:model strings.
        expect(isValidModelFormat(result.model)).toBe(true);
        // And must not smuggle a leading double-colon model id.
        const sep = result.model.indexOf(":");
        expect(result.model.slice(sep + 1).startsWith(":")).toBe(false);
      }

      // Normalization must be idempotent (persist/reload cannot drift).
      const canonical = normalizeToCanonical(raw);
      expect(normalizeToCanonical(canonical)).toBe(canonical);

      const selected = normalizeSelectedModel(raw);
      expect(normalizeSelectedModel(selected)).toBe(selected);

      const equalityKey = modelSelectionEqualityKey(raw);
      expect(modelSelectionEqualityKey(equalityKey)).toBe(equalityKey);

      // Gateway prefix detection must only report actual gateway providers.
      const gatewayPrefix = getExplicitGatewayPrefix(raw);
      if (gatewayPrefix !== undefined) {
        expect(PROVIDER_DEFINITIONS[gatewayPrefix]?.kind).toBe("gateway");
      }

      expect(typeof getModelName(raw)).toBe("string");
      expect(typeof getModelProvider(raw)).toBe("string");

      // Capability probing with junk providersConfig must not throw.
      const providersConfig =
        rng() < 0.5 ? (randomHostileValue(rng) as Record<string, unknown> | null) : null;
      const mode = getAnthropic1MContextMode(
        raw,
        typeof providersConfig === "object" ? providersConfig : null
      );
      expect(["none", "beta", "native"]).toContain(mode);
    }
  });

  test(`resolveProviderOptionsNamespaceKey never throws for arbitrary provider pairs (seed=${SEED})`, () => {
    const rng = mulberry32(SEED + 1);
    for (let i = 0; i < ITERATIONS; i++) {
      const canonical = randomFragmentString(rng, 2);
      const route = randomFragmentString(rng, 2) as ProviderName;
      const key = resolveProviderOptionsNamespaceKey(canonical, rng() < 0.5 ? route : undefined);
      expect(typeof key).toBe("string");
    }
  });

  test("prototype-pollution keys resolve as plain strings, not object members", () => {
    for (const hostile of ["__proto__", "constructor", "prototype", "toString"]) {
      // Alias resolution must not dereference Object.prototype members.
      expect(resolveModelAlias(hostile)).toBe(hostile);
      // provider lookup paths must treat them as unknown providers.
      expect(normalizeToCanonical(`${hostile}:model`)).toBe(`${hostile}:model`);
      expect(getExplicitGatewayPrefix(`${hostile}:model`)).toBeUndefined();
      const result = normalizeModelInput(`${hostile}:model`);
      expect(result.model).toBe(`${hostile}:model`);
    }
    // Global prototype must remain unpolluted after all lookups.
    expect(Object.prototype).not.toHaveProperty("model");
  });
});

/**
 * Fuzz tests for refusal-fallback chain resolution.
 *
 * Fallback maps are persisted config that is resolved lenient-on-read at
 * request time; these invariants ensure malformed or hostile persisted data
 * (prototype-pollution keys, cycles, junk members) self-heals instead of
 * throwing mid-send, and that runtime chains stay bounded and acyclic.
 */
import { describe, test, expect } from "bun:test";
import {
  MODEL_FALLBACK_CHAIN_LIMIT,
  resolveModelFallbackChain,
  sanitizeModelFallbacks,
  sanitizeModelFallbackChain,
  sanitizeFallbackModelString,
  normalizeFallbackModelKey,
} from "./modelFallbacks";
import type { ModelFallbacks } from "@/common/config/schemas/appConfigOnDisk";
import {
  mulberry32,
  randomFragmentString,
  randomHostileValue,
  randInt,
  pick,
  type Rng,
} from "@/common/utils/testing/fuzzHelpers";

const SEED = 0xfa11;
const ITERATIONS = 2000;

function randomFallbacks(rng: Rng): ModelFallbacks {
  const map: ModelFallbacks = {};
  const entries = randInt(rng, 5);
  for (let i = 0; i < entries; i++) {
    const key =
      rng() < 0.2
        ? pick(rng, ["__proto__", "constructor", "prototype", "toString"])
        : randomFragmentString(rng, 4);
    const models: unknown[] = [];
    const len = randInt(rng, 6);
    for (let j = 0; j < len; j++) {
      // Mix valid strings, the key itself (self-fallback), and junk.
      const kind = rng();
      if (kind < 0.5) models.push(randomFragmentString(rng, 4));
      else if (kind < 0.7) models.push(key);
      else models.push(randomHostileValue(rng));
    }
    map[key] = {
      ...(rng() < 0.5 ? { enabled: rng() < 0.5 } : {}),
      ...(rng() < 0.3 ? { triggers: ["model_refusal" as const] } : {}),
      models: models as string[],
    };
  }
  return map;
}

describe("modelFallbacks fuzz", () => {
  test(`sanitize + resolve never throw; chains stay bounded, deduped, acyclic (seed=${SEED})`, () => {
    const rng = mulberry32(SEED);
    for (let i = 0; i < ITERATIONS; i++) {
      const fallbacks = randomFallbacks(rng);
      const sanitized = sanitizeModelFallbacks(fallbacks);
      for (const [source, entry] of Object.entries(sanitized)) {
        expect(entry.models.length).toBeGreaterThan(0);
        expect(entry.models.length).toBeLessThanOrEqual(MODEL_FALLBACK_CHAIN_LIMIT);
        // No self-fallbacks and no duplicates after sanitization.
        expect(entry.models).not.toContain(source);
        expect(new Set(entry.models).size).toBe(entry.models.length);
      }

      const probe =
        rng() < 0.5
          ? randomFragmentString(rng, 4)
          : pick(rng, ["__proto__", "constructor", ...Object.keys(fallbacks), "missing:model"]);
      const chain = resolveModelFallbackChain(fallbacks, probe, null);
      expect(Array.isArray(chain)).toBe(true);
      expect(chain.length).toBeLessThanOrEqual(MODEL_FALLBACK_CHAIN_LIMIT);
      for (const model of chain) {
        expect(typeof model).toBe("string");
        expect(model.length).toBeGreaterThan(0);
      }

      // Sanitization must be idempotent.
      expect(sanitizeModelFallbacks(sanitized)).toEqual(sanitized);
    }
    // The whole campaign must leave Object.prototype unpolluted.
    expect(Object.prototype).not.toHaveProperty("models");
    expect(Object.prototype).not.toHaveProperty("enabled");
  });

  test("prototype keys never resolve inherited Object.prototype members as chains", () => {
    for (const hostile of ["__proto__", "constructor", "prototype", "toString", "valueOf"]) {
      expect(resolveModelFallbackChain({}, hostile, null)).toEqual([]);
      expect(resolveModelFallbackChain(undefined, hostile, null)).toEqual([]);
    }
  });

  test(`key/string sanitizers never throw on hostile strings (seed=${SEED})`, () => {
    const rng = mulberry32(SEED + 1);
    for (let i = 0; i < ITERATIONS; i++) {
      const raw = randomFragmentString(rng);
      expect(typeof sanitizeFallbackModelString(raw)).toBe("string");
      const providersConfig =
        rng() < 0.5 ? (randomHostileValue(rng) as Record<string, unknown>) : null;
      const key = normalizeFallbackModelKey(
        raw,
        typeof providersConfig === "object" ? providersConfig : null
      );
      expect(typeof key).toBe("string");
      // Chain sanitization tolerates arbitrary member values.
      const chain = sanitizeModelFallbackChain(raw, [
        randomHostileValue(rng),
        randomFragmentString(rng),
        randomHostileValue(rng),
      ] as unknown[]);
      expect(chain.length).toBeLessThanOrEqual(MODEL_FALLBACK_CHAIN_LIMIT);
    }
  });
});

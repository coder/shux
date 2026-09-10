/**
 * Fuzz tests for pure route resolution.
 *
 * Route priority lists and per-model overrides are persisted, hand-editable
 * config; model inputs come from users and catalogs. Resolution runs on every
 * send, so it must never throw and must always yield a structurally valid
 * route context regardless of configuration garbage.
 */
import { describe, test, expect } from "bun:test";
import { resolveRoute, isModelAvailable, availableRoutes } from "./resolve";
import { GATEWAY_PROVIDERS, PROVIDER_DEFINITIONS } from "@/common/constants/providers";
import {
  mulberry32,
  randomFragmentString,
  randInt,
  pick,
  type Rng,
} from "@/common/utils/testing/fuzzHelpers";

const SEED = 0x40757e;
const ITERATIONS = 3000;

function randomProviderToken(rng: Rng): string {
  return rng() < 0.5
    ? pick(rng, [
        "direct",
        "anthropic",
        "openai",
        "mux-gateway",
        "openrouter",
        "coder",
        "bedrock",
        "github-copilot",
        "__proto__",
        "constructor",
      ])
    : randomFragmentString(rng, 2);
}

describe("route resolution fuzz", () => {
  test(`resolveRoute never throws and returns structurally valid contexts (seed=${SEED})`, () => {
    const rng = mulberry32(SEED);
    for (let i = 0; i < ITERATIONS; i++) {
      const modelInput = randomFragmentString(rng);
      const routePriority = Array.from({ length: randInt(rng, 4) }, () => randomProviderToken(rng));
      const routeOverrides: Record<string, string> = {};
      for (let j = randInt(rng, 3); j > 0; j--) {
        routeOverrides[randomFragmentString(rng, 3)] = randomProviderToken(rng);
      }
      // Random but deterministic-per-call configuration predicate.
      const configuredRoll = rng();
      const isConfigured = (provider: string) =>
        (provider.length * 31 + i) % 7 < configuredRoll * 7;
      const accessibility =
        rng() < 0.5
          ? undefined
          : (gateway: string, modelId: string) => (gateway.length + modelId.length) % 2 === 0;

      const context = resolveRoute(
        modelInput,
        routePriority,
        routeOverrides,
        isConfigured,
        accessibility
      );
      expect(typeof context.canonical).toBe("string");
      expect(typeof context.origin).toBe("string");
      expect(typeof context.originModelId).toBe("string");
      expect(typeof context.routeProvider).toBe("string");
      expect(typeof context.routeModelId).toBe("string");
      // Canonical identity is always origin:originModelId.
      expect(context.canonical).toBe(`${context.origin}:${context.originModelId}`);
      // The route provider is either the origin itself (direct fallback) or a
      // known gateway definition — never an arbitrary override token.
      if (context.routeProvider !== context.origin) {
        expect(
          PROVIDER_DEFINITIONS[context.routeProvider as keyof typeof PROVIDER_DEFINITIONS]?.kind
        ).toBe("gateway");
      }

      // isModelAvailable and availableRoutes must be equally total.
      expect(typeof isModelAvailable(modelInput, routePriority, routeOverrides, isConfigured)).toBe(
        "boolean"
      );
      const routes = availableRoutes(modelInput, isConfigured, accessibility);
      for (const route of routes) {
        expect(
          route.route === "direct" || (GATEWAY_PROVIDERS as readonly string[]).includes(route.route)
        ).toBe(true);
      }
    }
  });

  test("explicit configured gateway routing preserves the caller's gateway model id", () => {
    const isConfigured = () => true;
    const context = resolveRoute("openrouter:openai/gpt-5", [], {}, isConfigured);
    expect(context.routeProvider).toBe("openrouter");
    // The explicit suffix is preserved verbatim (no double origin prefix).
    expect(context.routeModelId).toBe("openai/gpt-5");
  });

  test("hostile override keys/values cannot inject non-gateway routes", () => {
    const isConfigured = () => true;
    for (const hostile of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const context = resolveRoute(
        "openai:gpt-5",
        [hostile],
        { "openai:gpt-5": hostile },
        isConfigured
      );
      // Inherited Object.prototype members must never be treated as gateway
      // definitions; resolution falls back to a direct route.
      expect(context.routeProvider).toBe("openai");
    }
  });
});

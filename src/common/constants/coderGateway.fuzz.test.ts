/**
 * Fuzz tests for Coder AI Gateway catalog parsing and model-ID mapping.
 *
 * The provider list comes from a remote deployment (or hand-edited config),
 * and gateway model IDs come from catalogs — all attacker-influenceable.
 * Parsers must be total (never throw), and identity mappers must be
 * consistent: to→from roundtrips must not corrupt model identity.
 */
import { describe, test, expect } from "bun:test";
import {
  parseCoderGatewayProviders,
  resolveCoderGatewayProvider,
  resolveCoderWireCanonicalModel,
  resolveCoderMetadataCanonicalModel,
  coderGatewayWireProtocol,
} from "./coderOAuth";
import { PROVIDER_DEFINITIONS, type ProviderName } from "./providers";
import {
  mulberry32,
  randomFragmentString,
  randomHostileValue,
  pick,
} from "@/common/utils/testing/fuzzHelpers";

const SEED = 0xc0de4;
const ITERATIONS = 3000;

describe("coder gateway fuzz", () => {
  test(`catalog parsing and wire resolution are total (seed=${SEED})`, () => {
    const rng = mulberry32(SEED);
    for (let i = 0; i < ITERATIONS; i++) {
      const providers = parseCoderGatewayProviders(randomHostileValue(rng));
      for (const provider of providers) {
        expect(typeof provider.name).toBe("string");
        expect(provider.name.length).toBeGreaterThan(0);
        expect(typeof provider.type).toBe("string");
      }

      const name = randomFragmentString(rng, 3);
      const resolved = resolveCoderGatewayProvider(name, providers, providers);
      if (resolved) {
        expect(typeof resolved.type).toBe("string");
      }

      const wire = coderGatewayWireProtocol(randomFragmentString(rng, 2));
      expect([null, "anthropic", "openai-responses", "openai-chat"]).toContain(wire);

      const metadata = {
        discoveredProviders: randomHostileValue(rng),
        additionalProviders: randomHostileValue(rng),
      };
      const gatewayModelId = randomFragmentString(rng);
      const wireCanonical = resolveCoderWireCanonicalModel(gatewayModelId, metadata);
      if (wireCanonical) {
        expect(["anthropic", "openai"]).toContain(wireCanonical.origin);
        expect(wireCanonical.modelId.length).toBeGreaterThan(0);
      }
      const metadataCanonical = resolveCoderMetadataCanonicalModel(gatewayModelId, metadata);
      if (metadataCanonical !== null) {
        // Catalog identities must be well-formed provider:model strings.
        const colonIndex = metadataCanonical.indexOf(":");
        expect(colonIndex).toBeGreaterThan(0);
        expect(colonIndex).toBeLessThan(metadataCanonical.length - 1);
      }
    }
  });

  test(`gateway model-id mappers roundtrip canonical identities (seed=${SEED})`, () => {
    const rng = mulberry32(SEED + 1);
    const gatewayNames = (Object.keys(PROVIDER_DEFINITIONS) as ProviderName[]).filter(
      (name) => PROVIDER_DEFINITIONS[name].kind === "gateway"
    );
    for (let i = 0; i < ITERATIONS; i++) {
      for (const gateway of gatewayNames) {
        const def = PROVIDER_DEFINITIONS[gateway];
        const from = "fromGatewayModelId" in def ? def.fromGatewayModelId : undefined;
        const to = "toGatewayModelId" in def ? def.toGatewayModelId : undefined;

        // Parsing arbitrary catalog IDs must never throw, and parsed results
        // must have non-empty origins and model ids (empty parts would
        // produce invalid ":model" / "origin:" canonical strings downstream).
        const junkId = randomFragmentString(rng);
        if (from) {
          const parsed = from(junkId);
          if (parsed) {
            expect(parsed.origin.length).toBeGreaterThan(0);
            expect(parsed.modelId.length).toBeGreaterThan(0);
          }
        }

        // Roundtrip: a slash/dot-free origin+model pair must survive to→from
        // whenever the gateway can parse its own encoding.
        if (to && from) {
          const origin = pick(rng, ["anthropic", "openai", "google", "xai"]);
          const modelId = `m${i % 50}-${randomFragmentString(rng, 2).replace(/[/.]/g, "") || "x"}`;
          const encoded = to(origin, modelId);
          const roundtripped = from(encoded);
          if (roundtripped) {
            expect(roundtripped.origin).toBe(origin);
            expect(roundtripped.modelId).toBe(modelId);
          }
        }
      }
    }
  });
});

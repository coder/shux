/**
 * Fuzz tests for error extraction, clamping, and 429 classification.
 *
 * Provider failures hand these helpers arbitrary thrown values (Proxies,
 * cyclic cause chains, megabyte payload dumps, BigInt-bearing JSON). They run
 * in the stream failure path, so a throw here would replace a useful error
 * with a crash — invariants: never throw, always return bounded strings.
 */
import { describe, test, expect } from "bun:test";
import { getErrorMessage, clampErrorMessage } from "@/common/utils/errors";
import { classify429Capacity } from "./classify429Capacity";
import {
  mulberry32,
  randomFragmentString,
  randomHostileValue,
  randInt,
} from "@/common/utils/testing/fuzzHelpers";

const SEED = 0xe4404;
const ITERATIONS = 3000;

describe("error handling fuzz", () => {
  test(`getErrorMessage never throws and always returns a string (seed=${SEED})`, () => {
    const rng = mulberry32(SEED);
    for (let i = 0; i < ITERATIONS; i++) {
      const kind = rng();
      let input: unknown;
      if (kind < 0.4) {
        input = randomHostileValue(rng);
      } else if (kind < 0.6) {
        // Error with a randomized (possibly cyclic) cause chain.
        const err = new Error(randomFragmentString(rng));
        let current: Error = err;
        const depth = randInt(rng, 5);
        for (let d = 0; d < depth; d++) {
          const cause = new Error(randomFragmentString(rng));
          current.cause = cause;
          current = cause;
        }
        if (rng() < 0.3) current.cause = err; // close the cycle
        input = err;
      } else if (kind < 0.8) {
        // Proxy that throws on every property access.
        input = new Proxy(
          {},
          {
            get() {
              throw new Error("proxy trap");
            },
          }
        );
      } else {
        // Object whose toJSON throws or returns undefined.
        input = {
          toJSON:
            rng() < 0.5
              ? () => undefined
              : () => {
                  throw new Error("toJSON boom");
                },
        };
      }
      const message = getErrorMessage(input);
      expect(typeof message).toBe("string");
    }
  });

  test(`clampErrorMessage bounds output for arbitrary sizes (seed=${SEED})`, () => {
    const rng = mulberry32(SEED + 1);
    for (let i = 0; i < ITERATIONS; i++) {
      const message = randomFragmentString(rng) + "y".repeat(randInt(rng, 20000));
      const maxChars = randInt(rng, 8192) + 8;
      const clamped = clampErrorMessage(message, maxChars);
      if (message.length <= maxChars) {
        expect(clamped).toBe(message);
      } else {
        // Bounded: maxChars of content plus a short omission marker line.
        expect(clamped.length).toBeLessThanOrEqual(maxChars + 64);
        expect(clamped).toContain("chars omitted");
      }
    }
  });

  test(`classify429Capacity never throws and returns a valid kind (seed=${SEED})`, () => {
    const rng = mulberry32(SEED + 2);
    for (let i = 0; i < ITERATIONS; i++) {
      const result = classify429Capacity({
        message: rng() < 0.5 ? randomFragmentString(rng) : null,
        data: randomHostileValue(rng),
        responseBody: rng() < 0.5 ? randomFragmentString(rng) : null,
      });
      expect(["quota", "rate_limit"]).toContain(result);
    }
    // Cyclic data must classify as transient rate limit, not crash.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(classify429Capacity({ message: null, data: cyclic, responseBody: null })).toBe(
      "rate_limit"
    );
    // BigInt in data (JSON.stringify throws) must also fall back gracefully.
    expect(
      classify429Capacity({ message: "insufficient_quota", data: { n: 1n }, responseBody: null })
    ).toBe("quota");
  });
});

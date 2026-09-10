/**
 * Fuzz tests for gateway stream normalization.
 *
 * The mux gateway forwards upstream provider payloads mostly as-is, so a
 * faulty upstream can hand us arbitrary usage/finishReason shapes. These
 * invariants ensure normalization never throws and always yields a v3-shaped
 * usage object the AI SDK can consume without crashing the stream loop.
 */
import { describe, test, expect } from "bun:test";
import {
  flatUsageToV3,
  isV3Usage,
  normalizeFinishReason,
  normalizeGatewayGenerateResult,
  normalizeGatewayStreamUsage,
} from "./gatewayStreamNormalization";
import { mulberry32, randomHostileValue, randInt, pick } from "@/common/utils/testing/fuzzHelpers";

const SEED = 0xc0ffee;
const ITERATIONS = 2000;

describe("gatewayStreamNormalization fuzz", () => {
  test(`flatUsageToV3 never throws and always produces v3 shape (seed=${SEED})`, () => {
    const rng = mulberry32(SEED);
    for (let i = 0; i < ITERATIONS; i++) {
      const usage: Record<string, unknown> = {
        inputTokens: randomHostileValue(rng),
        outputTokens: randomHostileValue(rng),
        cachedInputTokens: randomHostileValue(rng),
        reasoningTokens: randomHostileValue(rng),
        [`extra${i % 5}`]: randomHostileValue(rng),
      };
      const options = rng() < 0.5 ? { outputExcludesReasoning: rng() < 0.5 } : undefined;
      const v3 = flatUsageToV3(usage, options);
      expect(isV3Usage(v3)).toBe(true);
      // Numeric fields must be finite numbers or undefined — NaN/Infinity from
      // malformed gateway payloads must not leak into usage/cost arithmetic.
      for (const value of [
        v3.inputTokens.total,
        v3.inputTokens.noCache,
        v3.inputTokens.cacheRead,
        v3.outputTokens.total,
        v3.outputTokens.text,
        v3.outputTokens.reasoning,
      ]) {
        expect(value === undefined || Number.isFinite(value)).toBe(true);
      }
    }
  });

  test(`normalizeFinishReason never throws; nullish maps to undefined (seed=${SEED})`, () => {
    const rng = mulberry32(SEED + 1);
    for (let i = 0; i < ITERATIONS; i++) {
      const input = randomHostileValue(rng);
      const result = normalizeFinishReason(input);
      if (input == null) {
        expect(result).toBeUndefined();
      } else {
        expect(result).toBeDefined();
      }
    }
  });

  test(`normalizeGatewayGenerateResult never throws and normalizes usage (seed=${SEED})`, () => {
    const rng = mulberry32(SEED + 2);
    for (let i = 0; i < ITERATIONS; i++) {
      const result: Record<string, unknown> = {
        usage: randomHostileValue(rng),
        finishReason: randomHostileValue(rng),
        content: randomHostileValue(rng),
      };
      const normalized = normalizeGatewayGenerateResult(result);
      if (normalized.usage != null) {
        expect(isV3Usage(normalized.usage)).toBe(true);
      }
    }
  });

  test(`normalizeGatewayStreamUsage transform preserves chunk count and never throws (seed=${SEED})`, async () => {
    const rng = mulberry32(SEED + 3);
    for (let iter = 0; iter < 50; iter++) {
      const chunkCount = randInt(rng, 20) + 1;
      const chunks: unknown[] = [];
      for (let i = 0; i < chunkCount; i++) {
        const kind = rng();
        if (kind < 0.3) {
          chunks.push(randomHostileValue(rng));
        } else if (kind < 0.6) {
          chunks.push({
            type: "finish",
            usage: randomHostileValue(rng),
            finishReason: randomHostileValue(rng),
          });
        } else {
          chunks.push({
            type: pick(rng, ["text-delta", "reasoning-delta", "tool-call", "weird-type", ""]),
            payload: randomHostileValue(rng),
          });
        }
      }

      const transform = normalizeGatewayStreamUsage(
        rng() < 0.5 ? { outputExcludesReasoning: true } : undefined
      );
      const writer = transform.writable.getWriter();
      const outputs: unknown[] = [];
      const readAll = (async () => {
        const reader = transform.readable.getReader() as ReadableStreamDefaultReader<unknown>;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          outputs.push(value);
        }
      })();
      for (const chunk of chunks) {
        await writer.write(chunk);
      }
      await writer.close();
      await readAll;

      expect(outputs.length).toBe(chunks.length);
      for (let i = 0; i < outputs.length; i++) {
        const input = chunks[i];
        const output = outputs[i];
        const isFinish =
          typeof input === "object" &&
          input != null &&
          (input as Record<string, unknown>).type === "finish";
        if (!isFinish) {
          // Non-finish chunks must pass through by identity.
          expect(output).toBe(input);
        } else {
          const out = output as Record<string, unknown>;
          if (out.usage != null) {
            expect(isV3Usage(out.usage)).toBe(true);
          }
        }
      }
    }
  });
});

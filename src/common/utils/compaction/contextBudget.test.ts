import { describe, expect, test } from "bun:test";
import { tool, jsonSchema } from "ai";
import { z } from "zod";
import {
  IMAGE_TOKEN_ESTIMATE,
  OUTPUT_RESERVE_TOKENS,
  WARNING_ADVANCE_MIN_TOKENS,
  WARNING_RESERVE_TOKENS,
} from "@/common/constants/contextBudget";
import {
  evaluateStepBudget,
  getContextBudgetHardCeiling,
  estimateFreshRequestTokens,
  estimateAssembledRequestTokens,
  estimateToolResultSize,
  checkAssembledRequestBudget,
  type StepBudgetInput,
} from "./contextBudget";

function evaluate(overrides: Partial<StepBudgetInput> = {}) {
  return evaluateStepBudget({
    contextTokens: 0,
    outputTokens: 0,
    toolResultChars: 0,
    imageParts: 0,
    modelContextLimit: 100_000,
    threshold: 0.7,
    warningEmitted: false,
    ...overrides,
  });
}

describe("step budget decisions", () => {
  test.each([
    [59_999, "continue"],
    [60_000, "warn"],
    [74_999, "warn"],
    [75_000, "rollover"],
  ] as const)("threshold boundary at %d", (contextTokens, decision) => {
    const result = evaluate({ contextTokens });
    expect(result.decision).toBe(decision);
    expect(result.flushOpportunity).toBe(decision !== "continue");
  });

  test("projects output, rounded tool text, and media without dropping the context baseline", () => {
    const result = evaluate({
      contextTokens: 55_000,
      outputTokens: 4_000,
      toolResultChars: 5,
      imageParts: 1,
    });
    expect(result.projected).toBe(55_000 + 4_000 + 2 + IMAGE_TOKEN_ESTIMATE);
    expect(result.decision).toBe("warn");
    expect(evaluate({ contextTokens: result.projected, warningEmitted: true }).decision).toBe(
      "continue"
    );
    expect(evaluate({ contextTokens: 75_000, warningEmitted: true }).decision).toBe("rollover");
  });

  test("rollover flush opportunity requires reserve headroom below the hard ceiling", () => {
    const hardCeiling = 100_000 - OUTPUT_RESERVE_TOKENS;
    expect(evaluate({ contextTokens: hardCeiling - WARNING_RESERVE_TOKENS - 1 })).toMatchObject({
      decision: "rollover",
      flushOpportunity: true,
    });
    expect(evaluate({ contextTokens: hardCeiling - WARNING_RESERVE_TOKENS })).toMatchObject({
      decision: "rollover",
      flushOpportunity: false,
    });
    // Real-encoding tool tokens can exceed the chars/4 heuristic and consume the reserve.
    expect(
      evaluate({
        contextTokens: hardCeiling - WARNING_RESERVE_TOKENS - 100,
        toolResultChars: 4,
        toolResultTokens: 100,
      })
    ).toMatchObject({ decision: "rollover", flushOpportunity: false });
  });

  test("hard ceiling overrides a higher configured threshold", () => {
    const hardCeiling = 100_000 - OUTPUT_RESERVE_TOKENS;
    expect(evaluate({ contextTokens: hardCeiling, threshold: 0.99 })).toMatchObject({
      decision: "rollover",
      flushOpportunity: false,
    });
    expect(
      evaluate({ contextTokens: hardCeiling - 1, threshold: 0.99, warningEmitted: true }).decision
    ).toBe("continue");
  });

  test("warning must fit strictly below the hard ceiling", () => {
    const contextTokens = 100_000 - OUTPUT_RESERVE_TOKENS - WARNING_RESERVE_TOKENS;
    expect(evaluate({ contextTokens, threshold: 0.99 })).toMatchObject({
      decision: "rollover",
      flushOpportunity: false,
    });
    expect(evaluate({ contextTokens: contextTokens - 1, threshold: 0.99 })).toMatchObject({
      decision: "warn",
      flushOpportunity: true,
    });
  });

  test.each([undefined, null, 0, -1, NaN, Infinity])(
    "unknown/invalid limit %s never invents an unlimited window",
    (modelContextLimit) => {
      expect(evaluate({ modelContextLimit, contextTokens: 1_000_000 })).toMatchObject({
        decision: "continue",
        hardCeiling: undefined,
        flushOpportunity: false,
      });
    }
  );

  test("disabled auto-compaction blocks the hard ceiling without proactive rollover", () => {
    expect(evaluate({ contextTokens: 1_000_000, threshold: 1 })).toMatchObject({
      decision: "block",
      hardCeiling: 100_000 - OUTPUT_RESERVE_TOKENS,
    });
  });
});

describe("context budget reserve bounds", () => {
  test.each([1, 3, 5, 4096, 8192, 32767, 32768, 100_000, 1_000_000])(
    "leaves at least three quarters of a %d-token window usable",
    (limit) => {
      const ceiling = getContextBudgetHardCeiling(limit);
      expect(ceiling).toBeGreaterThan(0);
      expect(ceiling).toBeLessThanOrEqual(limit);
      expect(limit - ceiling).toBeLessThanOrEqual(Math.floor(limit / 4));
      expect(limit - ceiling).toBeLessThanOrEqual(OUTPUT_RESERVE_TOKENS);
      if (limit >= OUTPUT_RESERVE_TOKENS * 4) {
        expect(ceiling).toBe(limit - OUTPUT_RESERVE_TOKENS);
      }
    }
  );

  test.each([0, -1, NaN, Infinity, -Infinity])(
    "rejects invalid known context limit %s",
    (modelContextLimit) => {
      expect(() => getContextBudgetHardCeiling(modelContextLimit)).toThrow();
      expect(() => estimateFreshRequestTokens({ userText: "hello", modelContextLimit })).toThrow();
    }
  );

  test("preserves the default system floor for unknown and large model windows", () => {
    const defaultEstimate = estimateFreshRequestTokens({ userText: "hello" });
    expect(estimateFreshRequestTokens({ userText: "hello", modelContextLimit: 100_000 })).toBe(
      defaultEstimate
    );
    expect(estimateFreshRequestTokens({ userText: "hello", modelContextLimit: 1_000_000 })).toBe(
      defaultEstimate
    );
  });
});

describe("small-model context budgets", () => {
  test.each([4096, 8192])(
    "keeps fitting requests usable with a %d-token window",
    (modelContextLimit) => {
      const hardCeiling = modelContextLimit * 0.75;
      expect(evaluate({ contextTokens: 100, modelContextLimit })).toMatchObject({
        decision: "continue",
        hardCeiling,
      });
      const fitting = { system: "instructions", messages: [{ role: "user", content: "hello" }] };
      expect(
        checkAssembledRequestBudget(fitting, { model: "small-model", modelContextLimit })
      ).toBeUndefined();
      const freshInput = { userText: "hello", modelContextLimit };
      expect(estimateFreshRequestTokens(freshInput)).toBeLessThan(hardCeiling);

      const oversized = {
        messages: [{ role: "user", content: "x".repeat(modelContextLimit * 4) }],
      };
      expect(
        checkAssembledRequestBudget(oversized, { model: "small-model", modelContextLimit })
      ).toEqual({
        type: "context_budget_exceeded",
        model: "small-model",
        estimate: estimateAssembledRequestTokens(oversized),
        hardCeiling,
      });
      expect(
        estimateFreshRequestTokens({ ...freshInput, userText: "x".repeat(modelContextLimit * 4) })
      ).toBeGreaterThan(hardCeiling);
      expect(
        evaluate({ modelContextLimit, contextTokens: hardCeiling, warningEmitted: true })
      ).toMatchObject({ decision: "rollover", flushOpportunity: false });
      expect(
        evaluate({ modelContextLimit, contextTokens: hardCeiling - 1, warningEmitted: true })
      ).toMatchObject({ decision: "continue" });
    }
  );

  test.each([4096, 8192])(
    "scales only the unknown system floor for %d tokens",
    (modelContextLimit) => {
      const input = { userText: "hello", modelContextLimit };
      const textTokens = estimateFreshRequestTokens({ ...input, systemFloorTokens: 0 });
      expect(estimateFreshRequestTokens(input) - textTokens).toBe(modelContextLimit / 2);
      expect(estimateFreshRequestTokens({ ...input, systemFloorTokens: 8192 }) - textTokens).toBe(
        8192
      );
      expect(estimateFreshRequestTokens({ ...input, systemFloorTokens: 100 }) - textTokens).toBe(
        100
      );
    }
  );

  test.each([4096, 8192])(
    "rolls over without a flush if the warning cannot fit in %d tokens",
    (modelContextLimit) => {
      expect(
        evaluate({ modelContextLimit, contextTokens: Math.ceil(modelContextLimit * 0.6) })
      ).toMatchObject({
        decision: "rollover",
        flushOpportunity: false,
      });
    }
  );
});

describe("absolute warning advance floor", () => {
  test("large windows keep the percent-based warning point", () => {
    expect(evaluate({ modelContextLimit: 128_000, contextTokens: 76_799 }).decision).toBe(
      "continue"
    );
    expect(evaluate({ modelContextLimit: 128_000, contextTokens: 76_800 }).decision).toBe("warn");
  });

  test("small windows warn at least the floor ahead of the ceiling-anchored rollover", () => {
    // hardCeiling = 32_768 - min(8_192, 8_192) = 24_576 = forceAt at 75%; percent rule ~19_661.
    const warnAt = 24_576 - WARNING_ADVANCE_MIN_TOKENS;
    expect(evaluate({ modelContextLimit: 32_768, contextTokens: warnAt - 1 }).decision).toBe(
      "continue"
    );
    expect(evaluate({ modelContextLimit: 32_768, contextTokens: warnAt })).toMatchObject({
      decision: "warn",
      flushOpportunity: true,
    });
  });

  test("the hard ceiling anchors the floor when it precedes the force point", () => {
    // forceAt = 64_000 at 100%, hardCeiling = 55_808; percent rule would warn at 54_400.
    const warnAt = 55_808 - WARNING_ADVANCE_MIN_TOKENS;
    expect(
      evaluate({ modelContextLimit: 64_000, threshold: 0.95, contextTokens: warnAt - 1 }).decision
    ).toBe("continue");
    expect(
      evaluate({ modelContextLimit: 64_000, threshold: 0.95, contextTokens: warnAt }).decision
    ).toBe("warn");
  });

  test("a tiny window keeps its first half usable and then rolls over without a flush", () => {
    // hardCeiling = 3_000 < WARNING_ADVANCE_MIN_TOKENS: the floor is clamped to half the
    // rollover point (1_500), where the reserve no longer fits, so the outcome is rollover.
    expect(evaluate({ modelContextLimit: 4_000, contextTokens: 1_499 }).decision).toBe("continue");
    expect(evaluate({ modelContextLimit: 4_000, contextTokens: 1_500 })).toMatchObject({
      decision: "rollover",
      flushOpportunity: false,
    });
  });
});

test("measured dense tool tokens enforce the hard ceiling while ordinary proactive estimates remain conservative", () => {
  expect(
    evaluate({ threshold: 1, contextTokens: 1000, toolResultChars: 100, toolResultTokens: 100000 })
  ).toMatchObject({ decision: "block", flushOpportunity: false });
  expect(
    evaluate({ contextTokens: 55000, toolResultChars: 20000, toolResultTokens: 10 }).decision
  ).toBe("warn");
});

describe("request estimates", () => {
  test("fresh-request estimate includes lead-in, text attachments, and system floor", () => {
    const base = estimateFreshRequestTokens({ userText: "task", systemFloorTokens: 100 });
    expect(
      estimateFreshRequestTokens({
        userText: "task",
        leadIn: "l".repeat(350),
        attachments: [{ type: "text", text: "a".repeat(350) }],
        systemFloorTokens: 100,
      })
    ).toBeGreaterThanOrEqual(base + 200);
  });

  test("nested tool data counts text but not encoded media payloads", () => {
    const result = (data: string) => ({
      data: {
        content: [
          { type: "text", text: "visible facts" },
          { type: "media", data, mediaType: "image/png" },
        ],
      },
    });
    const small = estimateToolResultSize(result("abc"));
    const large = estimateToolResultSize(result("x".repeat(100_000)));
    expect(large).toEqual(small);
    expect(large.imageParts).toBe(1);
    expect(large.toolResultChars).toBeGreaterThan("visible facts".length);
    expect(
      estimateToolResultSize({ data: "x".repeat(1000) }).toolResultChars
    ).toBeGreaterThanOrEqual(1000);
  });

  test("images, data URLs and binary payloads have bounded size independent of base64 length", () => {
    const estimate = (data: string) =>
      estimateFreshRequestTokens({
        userText: "task",
        attachments: [
          { type: "file", mediaType: "image/png", url: `data:image/png;base64,${data}` },
        ],
        systemFloorTokens: 0,
      });
    expect(estimate("x".repeat(100_000))).toBe(estimate("abc"));
    expect(estimate("abc")).toBeGreaterThanOrEqual(IMAGE_TOKEN_ESTIMATE);
    expect(estimateToolResultSize({ nested: new Uint8Array(100) }).imageParts).toBe(0);
    expect(
      estimateFreshRequestTokens({
        userText: "task",
        systemFloorTokens: 0,
        attachments: [{ type: "image", image: new Uint8Array(100_000) }],
      })
    ).toBeLessThan(IMAGE_TOKEN_ESTIMATE + 100);
  });

  test("PDF media and display-only tool attachments never count raw base64 as text", () => {
    for (const type of ["media", "display_file"]) {
      const result = (data: string) => ({ nested: { type, data, mediaType: "application/pdf" } });
      const small = estimateToolResultSize(result("abc"));
      expect(estimateToolResultSize(result("x".repeat(100000)))).toEqual(small);
      expect(small.imageParts).toBe(type === "media" ? 1 : 0);
    }
  });

  test("repeated object references count each serialized occurrence; cycles terminate", () => {
    const value = { text: "x".repeat(350) };
    expect(estimateToolResultSize([value, value]).toolResultChars).toBeGreaterThanOrEqual(700);
    const cyclic: { text: string; child?: unknown } = { text: "visible" };
    cyclic.child = cyclic;
    expect(estimateToolResultSize(cyclic).toolResultChars).toBeGreaterThan(0);
  });

  test("assembled estimate accounts for system, all messages and normalized tool schemas", () => {
    const messages = [{ role: "user", content: "task" }];
    const base = estimateAssembledRequestTokens({ messages });
    const system = "s".repeat(3500);
    const description = "d".repeat(3500);
    const schemaDescription = "p".repeat(3500);
    for (const inputSchema of [
      z.object({ argument: z.string().describe(schemaDescription) }),
      jsonSchema({
        type: "object",
        properties: { argument: { type: "string", description: schemaDescription } },
      }),
    ]) {
      const estimate = estimateAssembledRequestTokens({
        system,
        messages: [...messages, { role: "assistant", content: "a".repeat(3500) }],
        tools: { test: tool({ description, inputSchema }) },
      });
      expect(estimate).toBeGreaterThanOrEqual(base + 4000);
    }
  });

  test("per-attempt preflight blocks smaller fallback windows and includes exact-ceiling semantics", () => {
    const payload = {
      system: "s".repeat(1000),
      messages: [{ role: "user", content: "u".repeat(350_000) }],
    };
    const estimate = estimateAssembledRequestTokens(payload);
    expect(
      checkAssembledRequestBudget(payload, {
        model: "large",
        modelContextLimit: estimate + OUTPUT_RESERVE_TOKENS,
      })
    ).toBeUndefined();
    expect(
      checkAssembledRequestBudget(payload, {
        model: "fallback",
        modelContextLimit: estimate + OUTPUT_RESERVE_TOKENS - 1,
      })
    ).toEqual({
      type: "context_budget_exceeded",
      model: "fallback",
      estimate,
      hardCeiling: estimate - 1,
    });
    expect(
      checkAssembledRequestBudget(payload, { model: "unknown", modelContextLimit: undefined })
    ).toBeUndefined();
  });
});

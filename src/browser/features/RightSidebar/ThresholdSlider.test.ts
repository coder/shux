import { describe, expect, test } from "bun:test";
import {
  evaluateStepBudget,
  getContextBudgetHardCeiling,
} from "@/common/utils/compaction/contextBudget";
import { getAutoCompactionLabel, type AutoCompactionConfig } from "./ThresholdSlider";

function displayedThreshold(config: AutoCompactionConfig): number {
  const percentage = /(\d+)%/.exec(getAutoCompactionLabel(config))?.[1];
  expect(percentage).toBeDefined();
  return Number(percentage);
}

function evaluateAt(contextTokens: number, threshold: number, modelContextLimit = 1_000_000) {
  return evaluateStepBudget({
    contextTokens,
    outputTokens: 0,
    toolResultChars: 0,
    imageParts: 0,
    modelContextLimit,
    threshold: threshold / 100,
    warningEmitted: true,
  });
}

describe("automatic context threshold labels", () => {
  test("tracks the evaluator's force threshold as the configured slider threshold changes", () => {
    const config: AutoCompactionConfig = {
      threshold: 50,
      rolloverEnabled: true,
      setThreshold: () => undefined,
    };
    for (const threshold of [50, 70, 90]) {
      config.threshold = threshold;
      const forceTokens = (displayedThreshold(config) / 100) * 1_000_000;
      expect(evaluateAt(forceTokens - 1, threshold).decision).toBe("continue");
      expect(evaluateAt(forceTokens, threshold).decision).toBe("rollover");
    }
  });

  test("the displayed rollover bound allows a smaller model's hard ceiling to win", () => {
    const threshold = 90;
    const modelContextLimit = 16_384;
    const displayedPercent = displayedThreshold({
      threshold,
      rolloverEnabled: true,
      setThreshold: () => undefined,
    });
    const evaluation = evaluateAt(
      getContextBudgetHardCeiling(modelContextLimit),
      threshold,
      modelContextLimit
    );
    expect(evaluation.decision).toBe("rollover");
    expect((evaluation.projected / modelContextLimit) * 100).toBeLessThan(displayedPercent);
  });

  test.each([false, undefined])(
    "legacy compaction keeps the configured threshold (%s)",
    (rolloverEnabled) => {
      for (const threshold of [50, 70, 90]) {
        expect(
          displayedThreshold({ threshold, rolloverEnabled, setThreshold: () => undefined })
        ).toBe(threshold);
      }
    }
  );

  test.each([true, false])("off has no advertised threshold (%s)", (rolloverEnabled) => {
    expect(
      getAutoCompactionLabel({ threshold: 100, rolloverEnabled, setThreshold: () => undefined })
    ).not.toMatch(/\d+%/);
    // Off disables automatic rollover, not the token-budget hard ceiling.
    const hardCeiling = getContextBudgetHardCeiling(1_000_000);
    expect(evaluateAt(hardCeiling - 1, 100).decision).toBe("continue");
    expect(evaluateAt(hardCeiling, 100).decision).toBe("block");
  });
});

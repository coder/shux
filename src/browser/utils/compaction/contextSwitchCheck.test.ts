import { describe, expect, test } from "bun:test";
import { checkContextSwitch } from "./contextSwitchCheck";
import { getEffectiveContextLimit } from "@/common/utils/compaction/contextLimit";

const OPTIONS = {
  providersConfig: null,
  policy: null,
  routePriority: ["direct"],
  routeOverrides: {},
};

describe("checkContextSwitch", () => {
  test("returns null when target model matches previous model", () => {
    const targetModel = "openai:gpt-5.2-codex";
    const limit = getEffectiveContextLimit(targetModel, false);
    expect(limit).not.toBeNull();
    if (!limit) return;

    const warning = checkContextSwitch(
      Math.floor(limit * 0.95),
      targetModel,
      targetModel,
      false,
      OPTIONS
    );
    expect(warning).toBeNull();
  });

  test("allows same-model warnings when the effective limit changes", () => {
    const targetModel = "anthropic:claude-sonnet-4-5";
    const baseLimit = getEffectiveContextLimit(targetModel, false);
    const expandedLimit = getEffectiveContextLimit(targetModel, true);
    expect(baseLimit).not.toBeNull();
    expect(expandedLimit).not.toBeNull();
    if (!baseLimit || !expandedLimit) return;

    expect(expandedLimit).toBeGreaterThan(baseLimit);

    const warning = checkContextSwitch(
      Math.floor(baseLimit * 0.95),
      targetModel,
      targetModel,
      false,
      OPTIONS,
      { allowSameModel: true }
    );
    expect(warning).not.toBeNull();
    expect(warning?.targetModel).toBe(targetModel);
  });

  test("returns warning when switching to a smaller context model", () => {
    const targetModel = "openai:gpt-5.2-codex";
    const limit = getEffectiveContextLimit(targetModel, false);
    expect(limit).not.toBeNull();
    if (!limit) return;

    const warning = checkContextSwitch(
      Math.floor(limit * 0.95),
      targetModel,
      "anthropic:claude-sonnet-4-5",
      false,
      OPTIONS
    );
    expect(warning).not.toBeNull();
    expect(warning?.targetModel).toBe(targetModel);
  });

  test("uses custom context overrides for unknown custom models", () => {
    const targetModel = "openai:custom-context-model";
    const warning = checkContextSwitch(95_000, targetModel, "anthropic:claude-sonnet-4-5", false, {
      providersConfig: {
        openai: {
          apiKeySet: true,
          isEnabled: true,
          isConfigured: true,
          models: [{ id: "custom-context-model", contextWindowTokens: 100_000 }],
        },
      },
      policy: null,
      routePriority: ["direct"],
      routeOverrides: {},
    });

    expect(warning).not.toBeNull();
    expect(warning?.targetModel).toBe(targetModel);
    expect(warning?.targetLimit).toBe(100_000);
  });

  test("evaluates switches between a Coder gateway route and the direct model", () => {
    // coder:openai/<model> (instance type decides the upstream) and the
    // direct openai:<model> are distinct selections with potentially
    // different effective limits (e.g. 1M on an Anthropic-typed route), so
    // the switch must be evaluated, not suppressed as same-model.
    const targetModel = "openai:gpt-5.2-codex";
    const limit = getEffectiveContextLimit(targetModel, false);
    expect(limit).not.toBeNull();
    if (!limit) return;

    const warning = checkContextSwitch(
      Math.floor(limit * 0.95),
      targetModel,
      "coder:openai/gpt-5.2-codex",
      false,
      OPTIONS
    );
    expect(warning).not.toBeNull();
    expect(warning?.targetModel).toBe(targetModel);
  });

  test("still suppresses passthrough gateway aliases of the same model", () => {
    const targetModel = "mux-gateway:openai/gpt-5.2-codex";
    const canonical = "openai:gpt-5.2-codex";
    const limit = getEffectiveContextLimit(canonical, false);
    expect(limit).not.toBeNull();
    if (!limit) return;

    const warning = checkContextSwitch(
      Math.floor(limit * 0.95),
      targetModel,
      canonical,
      false,
      OPTIONS
    );
    expect(warning).toBeNull();
  });
});

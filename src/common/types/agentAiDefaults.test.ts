import { describe, expect, test } from "bun:test";
import { normalizeAgentAiDefaults } from "./agentAiDefaults";

describe("normalizeAgentAiDefaults reasoningMode", () => {
  test("keeps an entry that only sets reasoningMode", () => {
    const result = normalizeAgentAiDefaults({ exec: { reasoningMode: "pro" } });
    expect(result.exec?.reasoningMode).toBe("pro");
  });

  test("drops an invalid reasoningMode and the then-empty entry", () => {
    const result = normalizeAgentAiDefaults({ exec: { reasoningMode: "ultra" } });
    expect(result.exec).toBeUndefined();
  });

  test("drops an invalid reasoningMode while keeping other fields", () => {
    const result = normalizeAgentAiDefaults({
      exec: { modelString: "openai:gpt-5.6-sol", reasoningMode: "ultra" },
    });
    expect(result.exec?.modelString).toBe("openai:gpt-5.6-sol");
    expect(result.exec?.reasoningMode).toBeUndefined();
  });
});

describe("normalizeAgentAiDefaults nested subagent profiles", () => {
  test("keeps a nested profile that only sets reasoningMode", () => {
    const result = normalizeAgentAiDefaults({
      explore: { subagent: { reasoningMode: "pro" } },
    });
    expect(result.explore?.subagent?.reasoningMode).toBe("pro");
  });

  test("drops an invalid nested reasoningMode and the then-empty entry", () => {
    const result = normalizeAgentAiDefaults({
      explore: { subagent: { reasoningMode: "ultra" } },
    });
    expect(result.explore).toBeUndefined();
  });

  test("prunes non-Exec nested fields equal to the base entry", () => {
    const result = normalizeAgentAiDefaults({
      explore: {
        modelString: "openai:gpt-5.6-sol",
        thinkingLevel: "high",
        subagent: {
          modelString: "openai:gpt-5.6-sol",
          thinkingLevel: "xhigh",
        },
      },
    });

    expect(result.explore).toEqual({
      modelString: "openai:gpt-5.6-sol",
      thinkingLevel: "high",
      subagent: { thinkingLevel: "xhigh" },
    });
  });

  test("keeps explicit Exec fields equal to global defaults", () => {
    const profile = {
      modelString: "openai:gpt-5.6-sol",
      thinkingLevel: "high" as const,
      reasoningMode: "standard" as const,
    };
    const result = normalizeAgentAiDefaults({ exec: { ...profile, subagent: profile } });
    expect(result.exec?.subagent).toEqual(profile);
  });

  test("drops an empty nested subagent object", () => {
    const result = normalizeAgentAiDefaults({
      exec: { modelString: "openai:gpt-5.6-sol", subagent: {} },
    });

    expect(result.exec).toEqual({ modelString: "openai:gpt-5.6-sol" });
  });

  test("coerces invalid nested values away", () => {
    const result = normalizeAgentAiDefaults({
      exec: {
        enabled: true,
        subagent: { modelString: "   ", thinkingLevel: "invalid", reasoningMode: "ultra" },
      },
    });

    expect(result.exec).toEqual({ enabled: true });
  });
});

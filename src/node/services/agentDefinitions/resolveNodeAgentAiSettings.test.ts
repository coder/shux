import { describe, expect, it } from "bun:test";

import { resolveAgentAiSettings } from "@/common/utils/ai/resolveAgentAiSettings";

import { collectDefinitionLayers, resolveNodeAgentAiSettings } from "./resolveNodeAgentAiSettings";

// Unrecognized providers avoid capability clamping (see resolveAgentAiSettings.test.ts).
const MODEL_A = "custom:model-a";
const MODEL_B = "custom:model-b";

describe("collectDefinitionLayers", () => {
  it("merges same-ID scope refinements into the target layer field-wise", () => {
    // Project exec.md (base: exec) refines the global exec.md: the closer
    // scope wins per field, gaps fall through to the further scope.
    const layers = collectDefinitionLayers("exec", [
      { id: "exec", ai: { thinkingLevel: "high" } },
      { id: "exec", ai: { model: MODEL_A, thinkingLevel: "low" } },
    ]);
    expect(layers.targetDefinitionAiDefaults).toEqual({ model: MODEL_A, thinkingLevel: "high" });
    expect(layers.ancestors).toEqual([]);
  });

  it("merges duplicate same-ID ancestors instead of dropping them", () => {
    const layers = collectDefinitionLayers("researcher", [
      { id: "researcher" },
      { id: "exec", ai: { thinkingLevel: "high" } },
      { id: "exec", ai: { model: MODEL_A } },
    ]);
    expect(layers.targetDefinitionAiDefaults).toBeUndefined();
    expect(layers.ancestors).toEqual([
      { agentId: "exec", definitionAiDefaults: { model: MODEL_A, thinkingLevel: "high" } },
    ]);
  });

  it("keeps distinct ancestors in chain order", () => {
    const layers = collectDefinitionLayers("worker", [
      { id: "worker", ai: { model: MODEL_A } },
      { id: "researcher", ai: { thinkingLevel: "low" } },
      { id: "exec", ai: { model: MODEL_B } },
    ]);
    expect(layers.targetDefinitionAiDefaults).toEqual({ model: MODEL_A, thinkingLevel: undefined });
    expect(layers.ancestors).toEqual([
      { agentId: "researcher", definitionAiDefaults: { model: undefined, thinkingLevel: "low" } },
      { agentId: "exec", definitionAiDefaults: { model: MODEL_B, thinkingLevel: undefined } },
    ]);
  });

  it("same-ID base definition fields survive resolution", () => {
    // A project exec.md that only refines the prompt must not erase the
    // global exec.md's ai defaults from the definition tier.
    const layers = collectDefinitionLayers("exec", [
      { id: "exec" },
      { id: "exec", ai: { model: MODEL_A, thinkingLevel: "high" } },
    ]);
    const resolved = resolveAgentAiSettings({
      targetAgentId: "exec",
      profile: "interactive",
      ...layers,
    });
    expect(resolved.selected.model).toBe(MODEL_A);
    expect(resolved.selected.thinkingLevel).toBe("high");
    expect(resolved.sources.model).toEqual({ tier: "definition", agentId: "exec" });
  });
});

describe("calling workspace adapter context", () => {
  it("forwards Exec context without changing the gateway identity", async () => {
    const model = "coder:openai/gpt-5.6";
    const result = await resolveNodeAgentAiSettings({
      agentId: "exec",
      profile: "subagent",
      cfg: { agentAiDefaults: { exec: { modelString: MODEL_A } } },
      parentWorkspaceExecSettings: { model, thinkingLevel: "high" },
    });
    expect(result.selected.model).toBe(model);
    expect(result.sources.model).toEqual({ tier: "parent-workspace-exec", agentId: "exec" });
  });
});

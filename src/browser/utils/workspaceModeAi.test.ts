import { describe, expect, test } from "bun:test";
import type { OpenAIReasoningMode, ThinkingLevel } from "@/common/types/thinking";
import { resolveWorkspaceAiSettingsForAgent } from "./workspaceModeAi";

describe("resolveWorkspaceAiSettingsForAgent", () => {
  test("uses global agent defaults when configured", () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {
        exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "high" },
      },
      fallbackModel: "openai:gpt-5.2",
      existingModel: "anthropic:claude-opus-4-6",
      existingThinking: "off",
    });

    expect(result).toEqual({
      resolvedModel: "openai:gpt-5.3-codex",
      resolvedThinking: "high",
      resolvedReasoningMode: "standard",
    });
  });

  test("inherits existing workspace settings when global defaults are unset", () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {},
      fallbackModel: "openai:gpt-5.2",
      existingModel: "anthropic:claude-opus-4-6",
      existingThinking: "medium",
    });

    expect(result).toEqual({
      resolvedModel: "anthropic:claude-opus-4-6",
      resolvedThinking: "medium",
      resolvedReasoningMode: "standard",
    });
  });

  test("uses workspace-by-agent fallback when explicitly enabled", () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: { exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "high" } },
      workspaceByAgent: {
        exec: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
      },
      useWorkspaceByAgentFallback: true,
      fallbackModel: "openai:gpt-5.2-mini",
      existingModel: "anthropic:claude-opus-4-6",
      existingThinking: "off",
    });

    expect(result).toEqual({
      resolvedModel: "openai:gpt-5.2",
      resolvedThinking: "medium",
      resolvedReasoningMode: "standard",
    });
  });

  test("ignores workspace-by-agent fallback when disabled", () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: { exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "high" } },
      workspaceByAgent: {
        exec: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
      },
      useWorkspaceByAgentFallback: false,
      fallbackModel: "openai:gpt-5.2-mini",
      existingModel: "anthropic:claude-opus-4-6",
      existingThinking: "off",
    });

    expect(result).toEqual({
      resolvedModel: "anthropic:claude-opus-4-6",
      resolvedThinking: "off",
      resolvedReasoningMode: "standard",
    });
  });

  test('treats empty modelString as "inherit"', () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {
        exec: { modelString: "  " },
      },
      fallbackModel: "openai:gpt-5.2",
      existingModel: "anthropic:claude-opus-4-6",
      existingThinking: "low",
    });

    expect(result).toEqual({
      resolvedModel: "anthropic:claude-opus-4-6",
      resolvedThinking: "low",
      resolvedReasoningMode: "standard",
    });
  });

  test("guards non-string global default model values", () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {
        exec: { modelString: 42 as unknown as string },
      },
      fallbackModel: "openai:gpt-5.2-mini",
      existingModel: "anthropic:claude-opus-4-6",
      existingThinking: "off",
    });

    expect(result).toEqual({
      resolvedModel: "anthropic:claude-opus-4-6",
      resolvedThinking: "off",
      resolvedReasoningMode: "standard",
    });
  });

  // Per-agent pro-mode restore: explicit switches (useWorkspaceByAgentFallback)
  // must restore the agent's saved reasoningMode alongside model/thinking;
  // background sync inherits the workspace's current mode.
  test("restores the agent's saved pro mode on explicit switches", () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {},
      workspaceByAgent: {
        exec: { model: "openai:gpt-5.6-sol", thinkingLevel: "medium", reasoningMode: "pro" },
      },
      useWorkspaceByAgentFallback: true,
      fallbackModel: "openai:gpt-5.2-mini",
      existingModel: "openai:gpt-5.6-sol",
      existingThinking: "off",
      existingReasoningMode: "standard",
    });

    expect(result.resolvedReasoningMode).toBe("pro");
  });

  test("a workspace bucket toggled to standard beats a configured pro default on reload", () => {
    // UAT regression: Settings exec default = Pro, user toggles the workspace
    // to Standard (bucket entry records it), then reloads. Background sync
    // must keep the workspace's explicit Standard instead of re-applying the
    // configured Pro.
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {
        exec: { modelString: "openai:gpt-5.6-sol", reasoningMode: "pro" },
      },
      workspaceByAgent: {
        exec: { model: "openai:gpt-5.6-sol", thinkingLevel: "high", reasoningMode: "standard" },
      },
      useWorkspaceByAgentFallback: false,
      fallbackModel: "openai:gpt-5.2-mini",
      existingModel: "openai:gpt-5.6-sol",
      existingThinking: "high",
      existingReasoningMode: "standard",
    });

    expect(result.resolvedReasoningMode).toBe("standard");
  });

  test("a workspace bucket toggled to standard beats a configured pro default on explicit switches", () => {
    // Same regression via the switch-away-and-back path: the bucket's saved
    // Standard must survive an explicit switch back to the agent.
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {
        exec: { modelString: "openai:gpt-5.6-sol", reasoningMode: "pro" },
      },
      workspaceByAgent: {
        exec: { model: "openai:gpt-5.6-sol", thinkingLevel: "high", reasoningMode: "standard" },
      },
      useWorkspaceByAgentFallback: true,
      fallbackModel: "openai:gpt-5.2-mini",
      existingModel: "openai:gpt-5.6-sol",
      existingThinking: "high",
      existingReasoningMode: "pro",
    });

    expect(result.resolvedReasoningMode).toBe("standard");
  });

  test("applies a configured agent-default pro mode over the workspace's current mode", () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {
        exec: { modelString: "openai:gpt-5.6-sol", reasoningMode: "pro" },
      },
      fallbackModel: "openai:gpt-5.2-mini",
      existingModel: "openai:gpt-5.6-sol",
      existingThinking: "off",
      existingReasoningMode: "standard",
    });

    expect(result.resolvedReasoningMode).toBe("pro");
  });

  test("inherits a base agent's pro default through the base chain", () => {
    // Custom agent (base: exec) with no own entry; exec's configured pro must
    // apply, matching ACP resolution and the Settings card display.
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "researcher",
      agentAiDefaults: {
        exec: { reasoningMode: "pro" },
      },
      fallbackModel: "openai:gpt-5.2-mini",
      existingModel: "openai:gpt-5.6-sol",
      existingThinking: "off",
      existingReasoningMode: "standard",
      agentBaseById: new Map([["researcher", "exec"]]),
    });

    expect(result.resolvedReasoningMode).toBe("pro");
  });

  test("inherits the base agent's model and thinking alongside its pro default", () => {
    // The base supplies GPT-5.6 + pro while the workspace runs Anthropic;
    // persisting pro alongside the Anthropic model would let request gating
    // silently drop it, diverging from Settings/ACP which show GPT-5.6 Pro.
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "researcher",
      agentAiDefaults: {
        exec: { modelString: "openai:gpt-5.6-sol", thinkingLevel: "high", reasoningMode: "pro" },
      },
      fallbackModel: "openai:gpt-5.2-mini",
      existingModel: "anthropic:claude-sonnet-4-6",
      existingThinking: "off",
      existingReasoningMode: "standard",
      agentBaseById: new Map([["researcher", "exec"]]),
    });

    expect(result.resolvedModel).toBe("openai:gpt-5.6-sol");
    expect(result.resolvedThinking).toBe("high");
    expect(result.resolvedReasoningMode).toBe("pro");
  });

  test("an explicit standard override beats a base agent's pro default", () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "researcher",
      agentAiDefaults: {
        exec: { reasoningMode: "pro" },
        researcher: { reasoningMode: "standard" },
      },
      fallbackModel: "openai:gpt-5.2-mini",
      existingModel: "openai:gpt-5.6-sol",
      existingThinking: "off",
      existingReasoningMode: "pro",
    });

    expect(result.resolvedReasoningMode).toBe("standard");
  });

  test("survives a base-chain cycle without recursing forever", () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "a",
      agentAiDefaults: {},
      fallbackModel: "openai:gpt-5.2-mini",
      existingModel: "openai:gpt-5.6-sol",
      existingThinking: "off",
      existingReasoningMode: "pro",
      agentBaseById: new Map([
        ["a", "b"],
        ["b", "a"],
      ]),
    });

    expect(result.resolvedReasoningMode).toBe("pro");
  });

  test("agent defaults without reasoningMode fall through to the workspace mode", () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {
        exec: { modelString: "openai:gpt-5.6-sol" },
      },
      fallbackModel: "openai:gpt-5.2-mini",
      existingModel: "openai:gpt-5.6-sol",
      existingThinking: "off",
      existingReasoningMode: "pro",
    });

    expect(result.resolvedReasoningMode).toBe("pro");
  });

  test("inherits the workspace's current pro mode during background sync", () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {},
      workspaceByAgent: {
        exec: { model: "openai:gpt-5.6-sol", thinkingLevel: "medium", reasoningMode: "standard" },
      },
      useWorkspaceByAgentFallback: false,
      fallbackModel: "openai:gpt-5.2-mini",
      existingModel: "openai:gpt-5.6-sol",
      existingThinking: "off",
      existingReasoningMode: "pro",
    });

    expect(result.resolvedReasoningMode).toBe("pro");
  });

  test("defaults legacy per-agent entries without reasoningMode to standard on explicit switches", () => {
    // A workspaceByAgent entry saved before pro mode shipped has no
    // reasoningMode field. Explicitly switching to that agent must not inherit
    // the previous agent's pro mode — absent means "standard" (same semantics
    // as WorkspaceContext seeding).
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {},
      workspaceByAgent: {
        exec: { model: "openai:gpt-5.6-sol", thinkingLevel: "medium" },
      },
      useWorkspaceByAgentFallback: true,
      fallbackModel: "openai:gpt-5.2-mini",
      existingModel: "openai:gpt-5.6-sol",
      existingThinking: "off",
      existingReasoningMode: "pro",
    });

    expect(result.resolvedReasoningMode).toBe("standard");
  });

  test("inherits the workspace mode on explicit switches without a per-agent entry", () => {
    // No workspaceByAgent entry at all: nothing saved for this agent, so the
    // workspace's current mode carries over (distinct from the legacy-entry case).
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {},
      useWorkspaceByAgentFallback: true,
      fallbackModel: "openai:gpt-5.2-mini",
      existingModel: "openai:gpt-5.6-sol",
      existingThinking: "off",
      existingReasoningMode: "pro",
    });

    expect(result.resolvedReasoningMode).toBe("pro");
  });

  test("self-heals a corrupt saved reasoning mode to standard", () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {},
      workspaceByAgent: {
        exec: {
          model: "openai:gpt-5.6-sol",
          thinkingLevel: "medium",
          reasoningMode: "ultra" as unknown as OpenAIReasoningMode,
        },
      },
      useWorkspaceByAgentFallback: true,
      fallbackModel: "openai:gpt-5.2-mini",
      existingModel: "openai:gpt-5.6-sol",
      existingThinking: "off",
      existingReasoningMode: "corrupt" as unknown as OpenAIReasoningMode,
    });

    expect(result.resolvedReasoningMode).toBe("standard");
  });

  test("self-heals invalid inherited workspace settings", () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {},
      fallbackModel: "openai:gpt-5.2",
      existingModel: "   ",
      existingThinking: "legacy-invalid" as unknown as ThinkingLevel,
    });

    expect(result).toEqual({
      resolvedModel: "openai:gpt-5.2",
      resolvedThinking: "off",
      resolvedReasoningMode: "standard",
    });
  });

  test.each([undefined, "", "bogus", 42, "openai:gpt-5.2"])(
    "invalid cached fields use configured defaults (%s)",
    (model) => {
      const result = resolveWorkspaceAiSettingsForAgent({
        agentId: "exec",
        agentAiDefaults: { exec: { modelString: "openai:gpt-5.2", thinkingLevel: "high" } },
        workspaceByAgent: {
          exec: {
            model: model as string,
            thinkingLevel: "invalid" as ThinkingLevel,
          },
        },
        useWorkspaceByAgentFallback: true,
        fallbackModel: "openai:gpt-5.2-mini",
        existingModel: "anthropic:claude-opus-4-6",
        existingThinking: "off",
      });
      expect(result.resolvedModel).toBe("openai:gpt-5.2");
      expect(result.resolvedThinking).toBe("high");
    }
  );

  test("guards non-string persisted model values", () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {},
      fallbackModel: "openai:gpt-5.2",
      existingModel: 42 as unknown as string,
      existingThinking: "off",
    });

    expect(result).toEqual({
      resolvedModel: "openai:gpt-5.2",
      resolvedThinking: "off",
      resolvedReasoningMode: "standard",
    });
  });
});

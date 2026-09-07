import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

import { AgentProvider } from "@/browser/contexts/AgentContext";
import { consumeWorkspaceModelChange } from "@/browser/utils/modelChange";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  AGENT_AI_DEFAULTS_KEY,
  getModelKey,
  getThinkingLevelKey,
  getWorkspaceAISettingsByAgentKey,
} from "@/common/constants/storage";

import { WorkspaceModeAISync } from "../WorkspaceModeAISync/WorkspaceModeAISync";

let workspaceCounter = 0;

let cleanupDom: (() => void) | null = null;

function nextWorkspaceId(): string {
  workspaceCounter += 1;
  return `workspace-mode-ai-sync-test-${workspaceCounter}`;
}

const noop = () => {
  // intentional noop for tests
};

function SyncHarness(props: { workspaceId: string; agentId: string }) {
  return (
    <AgentProvider
      value={{
        agentId: props.agentId,
        setAgentId: noop,
        currentAgent: undefined,
        agents: [],
        loaded: true,
        loadFailed: false,
        refresh: () => Promise.resolve(),
        refreshing: false,
        disableWorkspaceAgents: false,
        setDisableWorkspaceAgents: noop,
      }}
    >
      <WorkspaceModeAISync workspaceId={props.workspaceId} />
    </AgentProvider>
  );
}

function renderSync(props: { workspaceId: string; agentId: string }) {
  return render(<SyncHarness workspaceId={props.workspaceId} agentId={props.agentId} />);
}

describe("WorkspaceModeAISync", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    globalThis.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("only records explicit model changes when agentId changes", async () => {
    const workspaceId = nextWorkspaceId();

    const execModel = "openai:gpt-4o-mini";
    const planModel = "anthropic:claude-3-5-sonnet-latest";

    updatePersistedState(AGENT_AI_DEFAULTS_KEY, {
      exec: { modelString: execModel },
      plan: { modelString: planModel },
    });

    // Start with a different model so the mount sync performs an update.
    updatePersistedState(getModelKey(workspaceId), "some-legacy-model");

    const { rerender } = renderSync({ workspaceId, agentId: "exec" });

    // Mount sync should update the model but NOT record an explicit change entry.
    await waitFor(() => {
      expect(readPersistedState(getModelKey(workspaceId), "")).toBe(execModel);
    });
    expect(consumeWorkspaceModelChange(workspaceId, execModel)).toBeNull();

    // Switching agents (within the same workspace) should be treated as explicit.
    rerender(<SyncHarness workspaceId={workspaceId} agentId="plan" />);

    await waitFor(() => {
      expect(readPersistedState(getModelKey(workspaceId), "")).toBe(planModel);
    });
    expect(consumeWorkspaceModelChange(workspaceId, planModel)).toBe("agent");
  });

  test("preserves unsent workspace choices over configured agent defaults", async () => {
    const workspaceId = nextWorkspaceId();

    const configuredModel = "anthropic:claude-haiku-4-5";
    const configuredThinking = "off";
    const workspaceModel = "openai:gpt-5.2";
    const workspaceThinking = "high";

    updatePersistedState(AGENT_AI_DEFAULTS_KEY, {
      exec: { modelString: configuredModel, thinkingLevel: configuredThinking },
    });
    updatePersistedState(getWorkspaceAISettingsByAgentKey(workspaceId), {
      exec: { model: workspaceModel, thinkingLevel: workspaceThinking },
    });

    updatePersistedState(getModelKey(workspaceId), "some-legacy-model");
    updatePersistedState(getThinkingLevelKey(workspaceId), "medium");

    renderSync({ workspaceId, agentId: "exec" });

    await waitFor(() => {
      expect(readPersistedState(getModelKey(workspaceId), "")).toBe("some-legacy-model");
      expect(readPersistedState(getThinkingLevelKey(workspaceId), "high")).toBe("medium");
    });
  });

  test("ignores workspace-by-agent values when settings are inherit", async () => {
    const workspaceId = nextWorkspaceId();

    const existingModel = "some-legacy-model";
    const existingThinking = "off";

    // Inherit in Settings removes explicit per-agent defaults from AGENT_AI_DEFAULTS_KEY.
    updatePersistedState(AGENT_AI_DEFAULTS_KEY, {});
    updatePersistedState(getWorkspaceAISettingsByAgentKey(workspaceId), {
      exec: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
    });

    updatePersistedState(getModelKey(workspaceId), existingModel);
    updatePersistedState(getThinkingLevelKey(workspaceId), existingThinking);

    renderSync({ workspaceId, agentId: "exec" });

    await waitFor(() => {
      expect(readPersistedState(getModelKey(workspaceId), "")).toBe(existingModel);
      expect(readPersistedState(getThinkingLevelKey(workspaceId), "off")).toBe(existingThinking);
    });
  });

  test("restores workspace-by-agent override on explicit agent switch when defaults inherit", async () => {
    const workspaceId = nextWorkspaceId();

    const planModel = "anthropic:claude-sonnet-4-5";
    const planThinking = "high";
    const execWorkspaceModel = "openai:gpt-5.2-pro";
    const execWorkspaceThinking = "medium";

    updatePersistedState(AGENT_AI_DEFAULTS_KEY, {});
    updatePersistedState(getWorkspaceAISettingsByAgentKey(workspaceId), {
      exec: { model: execWorkspaceModel, thinkingLevel: execWorkspaceThinking },
    });

    updatePersistedState(getModelKey(workspaceId), planModel);
    updatePersistedState(getThinkingLevelKey(workspaceId), planThinking);

    const { rerender } = renderSync({ workspaceId, agentId: "plan" });

    await waitFor(() => {
      expect(readPersistedState(getModelKey(workspaceId), "")).toBe(planModel);
      expect(readPersistedState(getThinkingLevelKey(workspaceId), "off")).toBe(planThinking);
    });

    rerender(<SyncHarness workspaceId={workspaceId} agentId="exec" />);

    await waitFor(() => {
      expect(readPersistedState(getModelKey(workspaceId), "")).toBe(execWorkspaceModel);
      expect(readPersistedState(getThinkingLevelKey(workspaceId), "off")).toBe(
        execWorkspaceThinking
      );
    });

    expect(consumeWorkspaceModelChange(workspaceId, execWorkspaceModel)).toBe("agent");
  });

  test("ignores same-agent workspace overrides when agent defaults are missing", async () => {
    const workspaceId = nextWorkspaceId();

    const existingModel = "some-legacy-model";
    const existingThinking = "high";

    updatePersistedState(AGENT_AI_DEFAULTS_KEY, {
      exec: { modelString: "anthropic:claude-haiku-4-5", thinkingLevel: "off" },
    });
    updatePersistedState(getWorkspaceAISettingsByAgentKey(workspaceId), {
      custom: { model: "openai:gpt-5.2-pro", thinkingLevel: "medium" },
    });

    updatePersistedState(getModelKey(workspaceId), existingModel);
    updatePersistedState(getThinkingLevelKey(workspaceId), existingThinking);

    renderSync({ workspaceId, agentId: "custom" });

    await waitFor(() => {
      expect(readPersistedState(getModelKey(workspaceId), "")).toBe(existingModel);
      expect(readPersistedState(getThinkingLevelKey(workspaceId), "off")).toBe(existingThinking);
    });
  });

  test("keeps the user's model when per-agent settings change without an agent switch", async () => {
    const workspaceId = nextWorkspaceId();

    const configuredModel = "anthropic:claude-haiku-4-5";
    const userModel = "anthropic:claude-sonnet-4-5";

    updatePersistedState(AGENT_AI_DEFAULTS_KEY, {
      exec: { modelString: configuredModel },
    });
    updatePersistedState(getModelKey(workspaceId), configuredModel);
    updatePersistedState(getThinkingLevelKey(workspaceId), "off");

    renderSync({ workspaceId, agentId: "exec" });

    await waitFor(() => {
      expect(readPersistedState(getModelKey(workspaceId), "")).toBe(configuredModel);
    });

    // Picking a model writes both the model key and the per-agent settings cache.
    act(() => {
      updatePersistedState(getModelKey(workspaceId), userModel);
      updatePersistedState(getWorkspaceAISettingsByAgentKey(workspaceId), {
        exec: { model: userModel, thinkingLevel: "off" },
      });
    });

    expect(readPersistedState(getModelKey(workspaceId), "")).toBe(userModel);

    // Changing the thinking level rewrites the same per-agent cache entry.
    act(() => {
      updatePersistedState(getThinkingLevelKey(workspaceId), "high");
      updatePersistedState(getWorkspaceAISettingsByAgentKey(workspaceId), {
        exec: { model: userModel, thinkingLevel: "high" },
      });
    });

    expect(readPersistedState(getModelKey(workspaceId), "")).toBe(userModel);
    expect(readPersistedState(getThinkingLevelKey(workspaceId), "")).toBe("high");
  });

  test("does not inherit base defaults when selected agent has its own partial settings entry", async () => {
    const workspaceId = nextWorkspaceId();

    const customConfiguredModel = "anthropic:claude-haiku-4-5";
    const baseConfiguredThinking = "off";

    updatePersistedState(AGENT_AI_DEFAULTS_KEY, {
      custom: { modelString: customConfiguredModel },
      exec: { thinkingLevel: baseConfiguredThinking },
    });

    updatePersistedState(getModelKey(workspaceId), "some-legacy-model");
    updatePersistedState(getThinkingLevelKey(workspaceId), "high");

    // Unknown non-plan agent IDs still use exec as fallback agent; this verifies
    // a partial custom settings entry blocks inheriting exec thinking defaults.
    renderSync({ workspaceId, agentId: "custom" });

    await waitFor(() => {
      expect(readPersistedState(getModelKey(workspaceId), "")).toBe(customConfiguredModel);
      expect(readPersistedState(getThinkingLevelKey(workspaceId), "off")).toBe("high");
    });
  });
});

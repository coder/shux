import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import { DEFAULT_HIDDEN_MODELS, KNOWN_MODELS } from "../../src/common/constants/knownModels";
import {
  AGENT_MODE_CONFIG_ID,
  buildConfigOptions,
  handleSetConfigOption,
} from "../../src/node/acp/configOptions";
import type { ORPCClient } from "../../src/node/acp/serverConnection";

interface WorkspaceAiSettings {
  model: string;
  thinkingLevel: "off" | "low" | "medium" | "high" | "xhigh" | "max";
  reasoningMode?: "standard" | "pro";
}

interface WorkspaceState {
  agentId: string;
  aiSettings: WorkspaceAiSettings;
  aiSettingsByAgent: Record<string, WorkspaceAiSettings>;
}

type WorkspaceInfo = NonNullable<Awaited<ReturnType<ORPCClient["workspace"]["getInfo"]>>>;

type AgentDescriptor = Awaited<ReturnType<ORPCClient["agents"]["list"]>>[number];

const DEFAULT_AGENT_DESCRIPTORS: Awaited<ReturnType<ORPCClient["agents"]["list"]>> = [
  {
    id: "exec",
    scope: "built-in",
    name: "Exec",
    description: "Implement changes in the repository",
    uiSelectable: true,
    subagentRunnable: true,
  },
  {
    id: "plan",
    scope: "built-in",
    name: "Plan",
    description: "Create a plan before coding",
    uiSelectable: true,
    subagentRunnable: true,
  },
  {
    id: "explore",
    scope: "built-in",
    name: "Explore",
    description: "Read-only exploration",
    uiSelectable: false,
    subagentRunnable: true,
  },
];

function createHarness(
  initial: WorkspaceState,
  options?: {
    agents?: AgentDescriptor[];
    hiddenModels?: string[];
  }
): {
  client: ORPCClient;
  getWorkspaceState: () => WorkspaceState;
  updateModeCalls: Array<{
    workspaceId: string;
    mode: "exec" | "plan";
    aiSettings: WorkspaceAiSettings;
  }>;
  updateAgentCalls: Array<{
    workspaceId: string;
    agentId: string;
    aiSettings: WorkspaceAiSettings;
  }>;
} {
  let workspaceState: WorkspaceState = {
    agentId: initial.agentId,
    aiSettings: { ...initial.aiSettings },
    aiSettingsByAgent: { ...initial.aiSettingsByAgent },
  };

  const updateModeCalls: Array<{
    workspaceId: string;
    mode: "exec" | "plan";
    aiSettings: WorkspaceAiSettings;
  }> = [];
  const updateAgentCalls: Array<{
    workspaceId: string;
    agentId: string;
    aiSettings: WorkspaceAiSettings;
  }> = [];

  const availableAgents = options?.agents ?? DEFAULT_AGENT_DESCRIPTORS;

  const client = {
    config: { getConfig: async () => ({ hiddenModels: options?.hiddenModels }) },
    workspace: {
      getInfo: async (): Promise<WorkspaceInfo> => ({
        id: "ws-1",
        name: "ws-1",
        title: "ws-1",
        projectName: "project",
        projectPath: "/tmp/project",
        runtimeConfig: { type: "local" },
        namedWorkspacePath: "/tmp/project/.mux/ws-1",
        agentId: workspaceState.agentId,
        aiSettings: workspaceState.aiSettings,
        aiSettingsByAgent: workspaceState.aiSettingsByAgent,
      }),
      updateModeAISettings: async (input: {
        workspaceId: string;
        mode: "exec" | "plan";
        aiSettings: WorkspaceAiSettings;
      }) => {
        updateModeCalls.push(input);

        workspaceState = {
          ...workspaceState,
          agentId: input.mode,
          aiSettings: { ...input.aiSettings },
          aiSettingsByAgent: {
            ...workspaceState.aiSettingsByAgent,
            [input.mode]: { ...input.aiSettings },
          },
        };

        return { success: true as const, data: undefined };
      },
      updateAgentAISettings: async (input: {
        workspaceId: string;
        agentId: string;
        aiSettings: WorkspaceAiSettings;
      }) => {
        updateAgentCalls.push(input);

        workspaceState = {
          ...workspaceState,
          agentId: input.agentId,
          aiSettings: { ...input.aiSettings },
          aiSettingsByAgent: {
            ...workspaceState.aiSettingsByAgent,
            [input.agentId]: { ...input.aiSettings },
          },
        };

        return { success: true as const, data: undefined };
      },
    },
    agents: {
      list: async () => availableAgents,
    },
  } as unknown as ORPCClient;

  return {
    client,
    getWorkspaceState: () => workspaceState,
    updateModeCalls,
    updateAgentCalls,
  };
}

function getSelectConfigOption(
  options: SessionConfigOption[],
  id: string
): Extract<SessionConfigOption, { type: "select" }> {
  const option = options.find((candidate) => candidate.id === id);
  if (option == null || option.type !== "select") {
    throw new Error(`Expected select config option '${id}'`);
  }
  return option;
}

function flattenSelectOptions(
  option: Extract<SessionConfigOption, { type: "select" }>
): SessionConfigSelectOption[] {
  return option.options.flatMap((entry) => ("options" in entry ? entry.options : [entry]));
}

describe("ACP config options", () => {
  it.each([
    { hiddenModels: undefined, current: KNOWN_MODELS.GPT.id, blue: false, red: false },
    {
      hiddenModels: [...DEFAULT_HIDDEN_MODELS],
      current: KNOWN_MODELS.GPT.id,
      blue: false,
      red: false,
    },
    { hiddenModels: [], current: KNOWN_MODELS.GPT.id, blue: true, red: true },
    {
      hiddenModels: [KNOWN_MODELS.DAYBREAK_BLUE.id],
      current: KNOWN_MODELS.GPT.id,
      blue: false,
      red: true,
    },
    {
      hiddenModels: [KNOWN_MODELS.DAYBREAK_RED.id],
      current: KNOWN_MODELS.GPT.id,
      blue: true,
      red: false,
    },
    {
      hiddenModels: [...DEFAULT_HIDDEN_MODELS],
      current: KNOWN_MODELS.DAYBREAK_BLUE.id,
      blue: true,
      red: false,
    },
  ])("respects model visibility while retaining the current selection: %j", async (scenario) => {
    const harness = createHarness(
      {
        agentId: "exec",
        aiSettings: { model: scenario.current, thinkingLevel: "high" },
        aiSettingsByAgent: {},
      },
      { hiddenModels: scenario.hiddenModels }
    );
    const option = getSelectConfigOption(await buildConfigOptions(harness.client, "ws-1"), "model");
    const values = flattenSelectOptions(option).map((entry) => entry.value);
    expect(values.includes(KNOWN_MODELS.DAYBREAK_BLUE.id)).toBe(scenario.blue);
    expect(values.includes(KNOWN_MODELS.DAYBREAK_RED.id)).toBe(scenario.red);
    expect(values).toContain(scenario.current);
    expect(new Set(values).size).toBe(values.length);
    expect(option.currentValue).toBe(scenario.current);
  });

  it("includes agent mode descriptions and model-aware thinking labels for Opus 4.6", async () => {
    const harness = createHarness({
      agentId: "exec",
      aiSettings: {
        model: "anthropic:claude-opus-4-6",
        thinkingLevel: "xhigh",
      },
      aiSettingsByAgent: {
        exec: {
          model: "anthropic:claude-opus-4-6",
          thinkingLevel: "xhigh",
        },
      },
    });

    const options = await buildConfigOptions(harness.client, "ws-1", { activeAgentId: "exec" });

    const agentModeOption = getSelectConfigOption(options, AGENT_MODE_CONFIG_ID);
    const agentModeEntries = flattenSelectOptions(agentModeOption);

    expect(agentModeEntries.find((entry) => entry.value === "exec")?.description).toBe(
      "Implement changes in the repository"
    );
    expect(agentModeEntries.find((entry) => entry.value === "plan")?.description).toBe(
      "Create a plan before coding"
    );
    expect(agentModeEntries.map((entry) => entry.value)).toEqual(["exec", "plan"]);

    const thinkingOption = getSelectConfigOption(options, "thinkingLevel");
    const thinkingEntries = flattenSelectOptions(thinkingOption);

    expect(thinkingOption.currentValue).toBe("xhigh");
    expect(thinkingEntries.map((entry) => entry.value)).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(thinkingEntries.map((entry) => entry.name)).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  it("normalizes openai thinking labels and current value to xhigh (not max)", async () => {
    const harness = createHarness({
      agentId: "exec",
      aiSettings: {
        model: "openai:gpt-5.2",
        thinkingLevel: "max",
      },
      aiSettingsByAgent: {
        exec: {
          model: "openai:gpt-5.2",
          thinkingLevel: "max",
        },
      },
    });

    const options = await buildConfigOptions(harness.client, "ws-1", { activeAgentId: "exec" });

    const thinkingOption = getSelectConfigOption(options, "thinkingLevel");
    const thinkingEntries = flattenSelectOptions(thinkingOption);

    expect(thinkingOption.currentValue).toBe("xhigh");
    expect(thinkingEntries.map((entry) => entry.name)).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("preserves pro reasoning mode across agent mode switches", async () => {
    const harness = createHarness({
      agentId: "plan",
      aiSettings: { model: "anthropic:claude-opus-4-6", thinkingLevel: "high" },
      aiSettingsByAgent: {
        plan: { model: "anthropic:claude-opus-4-6", thinkingLevel: "high" },
        exec: { model: "openai:gpt-5.6-sol", thinkingLevel: "high", reasoningMode: "pro" },
      },
    });

    await handleSetConfigOption(harness.client, "ws-1", AGENT_MODE_CONFIG_ID, "exec", {
      activeAgentId: "plan",
    });

    expect(harness.updateModeCalls).toHaveLength(1);
    expect(harness.updateModeCalls[0]?.aiSettings.reasoningMode).toBe("pro");
  });

  it("preserves pro reasoning mode across model and thinking level changes", async () => {
    const harness = createHarness({
      agentId: "exec",
      aiSettings: { model: "openai:gpt-5.6-sol", thinkingLevel: "high", reasoningMode: "pro" },
      aiSettingsByAgent: {
        exec: { model: "openai:gpt-5.6-sol", thinkingLevel: "high", reasoningMode: "pro" },
      },
    });

    await handleSetConfigOption(harness.client, "ws-1", "model", "anthropic:claude-opus-4-6", {
      activeAgentId: "exec",
    });
    expect(harness.updateModeCalls[0]?.aiSettings.reasoningMode).toBe("pro");

    await handleSetConfigOption(harness.client, "ws-1", "thinkingLevel", "medium", {
      activeAgentId: "exec",
    });
    expect(harness.updateModeCalls[1]?.aiSettings.reasoningMode).toBe("pro");
  });

  it("clamps persisted thinking level when model changes", async () => {
    const harness = createHarness({
      agentId: "exec",
      aiSettings: {
        model: "anthropic:claude-opus-4-6",
        thinkingLevel: "xhigh",
      },
      aiSettingsByAgent: {
        exec: {
          model: "anthropic:claude-opus-4-6",
          thinkingLevel: "xhigh",
        },
      },
    });

    const updated = await handleSetConfigOption(
      harness.client,
      "ws-1",
      "model",
      "openai:gpt-5-pro",
      { activeAgentId: "exec" }
    );

    expect(harness.updateModeCalls).toHaveLength(1);
    expect(harness.updateModeCalls[0]?.aiSettings).toEqual({
      model: "openai:gpt-5-pro",
      thinkingLevel: "high",
    });

    const thinkingOption = getSelectConfigOption(updated, "thinkingLevel");
    const thinkingEntries = flattenSelectOptions(thinkingOption);

    expect(thinkingOption.currentValue).toBe("high");
    expect(thinkingEntries.map((entry) => entry.value)).toEqual(["high"]);
    expect(harness.getWorkspaceState().aiSettingsByAgent.exec).toEqual({
      model: "openai:gpt-5-pro",
      thinkingLevel: "high",
    });
  });

  it("maps legacy ask mode to exec when ask is no longer selectable", async () => {
    const harness = createHarness({
      agentId: "ask",
      aiSettings: {
        model: "anthropic:claude-sonnet-4-5",
        thinkingLevel: "high",
      },
      aiSettingsByAgent: {
        ask: {
          model: "anthropic:claude-opus-4-6",
          thinkingLevel: "low",
        },
      },
    });

    const options = await buildConfigOptions(harness.client, "ws-1");
    const agentModeOption = getSelectConfigOption(options, AGENT_MODE_CONFIG_ID);
    expect(agentModeOption.currentValue).toBe("exec");

    const updated = await handleSetConfigOption(harness.client, "ws-1", "thinkingLevel", "off");

    expect(harness.updateModeCalls).toHaveLength(1);
    expect(harness.updateModeCalls[0]?.mode).toBe("exec");

    const updatedThinkingOption = getSelectConfigOption(updated, "thinkingLevel");
    expect(updatedThinkingOption.currentValue).toBe("off");
  });

  it("preserves hidden custom ask agents when resolving the active ACP mode", async () => {
    const harness = createHarness(
      {
        agentId: "ask",
        aiSettings: {
          model: "anthropic:claude-sonnet-4-5",
          thinkingLevel: "high",
        },
        aiSettingsByAgent: {
          ask: {
            model: "anthropic:claude-sonnet-4-5",
            thinkingLevel: "high",
          },
        },
      },
      {
        agents: [
          ...DEFAULT_AGENT_DESCRIPTORS,
          {
            id: "ask",
            scope: "project",
            name: "Ask",
            description: "Custom hidden ask agent",
            uiSelectable: false,
            subagentRunnable: false,
          },
        ],
      }
    );

    const options = await buildConfigOptions(harness.client, "ws-1");
    const agentModeOption = getSelectConfigOption(options, AGENT_MODE_CONFIG_ID);
    expect(agentModeOption.currentValue).toBe("ask");

    const updated = await handleSetConfigOption(harness.client, "ws-1", "thinkingLevel", "off");

    expect(harness.updateAgentCalls).toHaveLength(1);
    expect(harness.updateAgentCalls[0]?.agentId).toBe("ask");

    const updatedThinkingOption = getSelectConfigOption(updated, "thinkingLevel");
    expect(updatedThinkingOption.currentValue).toBe("off");
  });

  it("ignores legacy ask AI settings when legacy ask mode remaps to exec", async () => {
    const harness = createHarness({
      agentId: "ask",
      aiSettings: {
        model: "anthropic:claude-sonnet-4-5",
        thinkingLevel: "high",
      },
      aiSettingsByAgent: {
        ask: {
          model: "anthropic:claude-opus-4-6",
          thinkingLevel: "low",
        },
      },
    });

    const options = await buildConfigOptions(harness.client, "ws-1");
    const modelOption = getSelectConfigOption(options, "model");
    const thinkingOption = getSelectConfigOption(options, "thinkingLevel");

    expect(modelOption.currentValue).toBe("anthropic:claude-sonnet-4-5");
    expect(thinkingOption.currentValue).toBe("high");
  });
});

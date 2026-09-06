import type React from "react";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { installDom } from "../../../../../tests/ui/dom";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import { PolicyProvider } from "@/browser/contexts/PolicyContext";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { getModelKey } from "@/common/constants/storage";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { FALLBACK_AGENTS } from "./TasksSection.agents";

let advisorExperimentEnabled = false;
let experimentValues: Record<string, boolean> = {};

let apiMock: {
  config: {
    getConfig: ReturnType<typeof mock>;
    saveConfig: ReturnType<typeof mock>;
  };
  agents?: {
    list: ReturnType<typeof mock>;
  };
} | null = null;

let selectedWorkspaceMock: { projectPath: string; workspaceId: string } | null = null;

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({ api: apiMock }),
  // Config hooks read the shared store directly; this harness needs no API subscription.
  useOptionalAPI: () => null,
}));

void mock.module("@/browser/contexts/WorkspaceContext", () => ({
  useWorkspaceContext: () => ({ selectedWorkspace: selectedWorkspaceMock }),
}));

void mock.module("@/browser/hooks/useExperiments", () => ({
  useExperimentValue: (id: string) => experimentValues[id] ?? advisorExperimentEnabled,
}));

void mock.module("@/browser/hooks/useModelsFromSettings", () => ({
  getDefaultModel: () => "anthropic:workspace-default",
  useModelsFromSettings: () => ({
    models: [
      "anthropic:foo",
      "anthropic:ui-exec",
      "openai:gpt-5-pro",
      "openai:gpt-5.6-sol",
      "openai:subagent-model",
      "xai:grok-code-fast-1",
    ],
    hiddenModelsForSelector: [],
  }),
}));

void mock.module("@/browser/components/Tooltip/Tooltip", () => ({
  Tooltip: (props: { children: React.ReactNode }) => <>{props.children}</>,
  TooltipTrigger: (props: { children: React.ReactNode }) => <>{props.children}</>,
  TooltipContent: (props: { children: React.ReactNode }) => <div>{props.children}</div>,
}));

void mock.module("@/browser/components/ModelSelector/ModelSelector", () => ({
  ModelSelector: (props: {
    value: string;
    emptyLabel?: string;
    onChange: (value: string) => void;
    models: string[];
  }) => (
    <select
      aria-label="Model"
      value={props.value}
      onChange={(event) => props.onChange(event.currentTarget.value)}
    >
      <option value="">{props.emptyLabel ?? "Inherit"}</option>
      {props.models.map((model) => (
        <option key={model} value={model}>
          {model}
        </option>
      ))}
    </select>
  ),
}));

void mock.module("@/browser/components/SelectPrimitive/SelectPrimitive", () => ({
  Select: (props: {
    value: string;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
  }) => (
    <select
      aria-label="Select"
      value={props.value}
      onChange={(event) => props.onValueChange(event.currentTarget.value)}
    >
      {props.children}
    </select>
  ),
  SelectContent: (props: { children: React.ReactNode }) => <>{props.children}</>,
  SelectItem: (props: { value: string; children: React.ReactNode }) => (
    <option value={props.value}>{props.children}</option>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

import { TasksSection } from "./TasksSection";

interface RenderTasksSectionOptions {
  agentAiDefaults?: AgentAiDefaults;
  /** When set, serves this discovered-agent list instead of FALLBACK_AGENTS. */
  agents?: AgentDefinitionDescriptor[];
  workspaceModel?: string;
}

function renderTasksSection(options: RenderTasksSectionOptions = {}) {
  const saveConfig = mock(() => Promise.resolve(undefined));
  const getConfig = mock(() =>
    Promise.resolve({
      taskSettings: {},
      agentAiDefaults: options.agentAiDefaults ?? {},
    })
  );

  apiMock = {
    config: {
      getConfig,
      saveConfig,
    },
    ...(options.agents || options.workspaceModel
      ? { agents: { list: mock(() => Promise.resolve(options.agents ?? FALLBACK_AGENTS)) } }
      : {}),
  };
  // Discovery only runs for a selected workspace's project.
  selectedWorkspaceMock =
    options.agents || options.workspaceModel ? { projectPath: "/proj", workspaceId: "ws-1" } : null;
  if (options.workspaceModel) {
    updatePersistedState(getModelKey("ws-1"), options.workspaceModel);
  }

  const view = render(
    <PolicyProvider>
      <TasksSection />
    </PolicyProvider>
  );
  return { ...view, getConfig, saveConfig };
}

function getExecSubagentRow(view: ReturnType<typeof renderTasksSection>): HTMLElement {
  return view.getByRole("group", { name: "Exec defaults" });
}

function getAgentCardByName(
  view: ReturnType<typeof renderTasksSection>,
  name: string
): HTMLElement {
  const title = view.getByText(name);
  const card = title.closest(".rounded-md");
  if (!(card instanceof HTMLElement)) {
    throw new Error(`Could not find ${name} agent card`);
  }
  return card;
}

function getLatestSavePayload(saveConfig: ReturnType<typeof mock>) {
  const calls = saveConfig.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0] as {
    agentAiDefaults: AgentAiDefaults;
  };
}

// The Reasoning control is the shared ThinkingSelectorControl (inline menu, not
// a native select), so tests drive it by opening the trigger and clicking rows.
function selectReasoningOption(container: HTMLElement, optionName: string) {
  fireEvent.click(within(container).getByRole("button", { name: "Reasoning" }));
  const listbox = within(container).getByRole("listbox", { name: "Reasoning effort" });
  fireEvent.click(within(listbox).getByRole("option", { name: optionName }));
}

describe("TasksSection Exec subagent defaults", () => {
  let restoreDom: (() => void) | null = null;

  beforeEach(() => {
    restoreDom = installDom();
    getAppConfigStore().updateOptimistically({ minThinkingLevelByModel: {} });
    advisorExperimentEnabled = false;
    experimentValues = {};
    apiMock = null;
    selectedWorkspaceMock = null;
  });

  afterEach(() => {
    cleanup();
    getAppConfigStore().updateOptimistically({ minThinkingLevelByModel: {} });
    apiMock = null;
    restoreDom?.();
    restoreDom = null;
  });

  test.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])("gates the Intuition card on parent=%s and intuition=%s", async (memory, intuition) => {
    advisorExperimentEnabled = true;
    experimentValues = {
      [EXPERIMENT_IDS.MEMORY]: memory,
      [EXPERIMENT_IDS.MEMORY_INTUITION]: intuition,
    };
    const view = renderTasksSection({
      agentAiDefaults: {
        intuition: {
          modelString: "openai:gpt-5.6-sol",
          advisorEnabled: true,
          thinkingLevel: "high",
        },
      },
    });
    await view.findByText("Name Workspace");
    if (!memory || !intuition) {
      expect(view.queryByText("Intuition")).toBeNull();
      return;
    }
    const card = getAgentCardByName(view, "Intuition");
    expect(within(card).getByRole<HTMLSelectElement>("combobox", { name: "Model" }).value).toBe(
      "openai:gpt-5.6-sol"
    );
    expect(within(card).queryByLabelText("Toggle intuition advisor")).toBeNull();
    expect(within(card).getAllByRole("switch")).toHaveLength(1);
    expect(within(card).getAllByRole("combobox")).toHaveLength(1);
    expect(within(card).getByRole("button", { name: "Reasoning" }).textContent).toContain("High");
    expect(
      within(getAgentCardByName(view, "Name Workspace")).getByLabelText(
        "Toggle name_workspace advisor"
      )
    ).toBeTruthy();
    selectReasoningOption(card, "Medium");
    await waitFor(() => {
      expect(getLatestSavePayload(view.saveConfig).agentAiDefaults.intuition).toMatchObject({
        modelString: "openai:gpt-5.6-sol",
        thinkingLevel: "medium",
      });
    });
    expect(within(card).queryByRole("button", { name: /Pro mode/ })).toBeNull();
    const listbox = within(card).getByRole("listbox", { name: "Reasoning effort" });
    fireEvent.click(within(listbox).getByRole("option", { name: "Inherit" }));
    await waitFor(() => {
      const settings = getLatestSavePayload(view.saveConfig).agentAiDefaults.intuition;
      expect(settings?.thinkingLevel).toBeUndefined();
      expect(settings?.modelString).toBe("openai:gpt-5.6-sol");
    });
    expect(
      within(getAgentCardByName(view, "Name Workspace")).getByRole("button", { name: "Reasoning" })
    ).toBeTruthy();
  });

  test("Intuition can display and save Off and Low below the chat minimum", async () => {
    advisorExperimentEnabled = true;
    getAppConfigStore().updateOptimistically({
      minThinkingLevelByModel: { "openai:gpt-5.6-sol": "high" },
    });
    const view = renderTasksSection({
      agentAiDefaults: {
        intuition: { modelString: "openai:gpt-5.6-sol", thinkingLevel: "low" },
        explore: { modelString: "openai:gpt-5.6-sol", thinkingLevel: "low" },
      },
    });
    await view.findByText("Intuition");
    const card = getAgentCardByName(view, "Intuition");
    const reasoning = within(card).getByRole("button", { name: "Reasoning" });
    expect(reasoning.textContent).toContain("Low");
    fireEvent.click(reasoning);
    const listbox = within(card).getByRole("listbox", { name: "Reasoning effort" });
    for (const [label, level] of [
      ["Off", "off"],
      ["Low", "low"],
    ] as const) {
      fireEvent.click(within(listbox).getByRole("option", { name: label }));
      await waitFor(() => {
        expect(getLatestSavePayload(view.saveConfig).agentAiDefaults.intuition?.thinkingLevel).toBe(
          level
        );
      });
      expect(reasoning.textContent).toContain(label);
    }

    // Ordinary task agents still use the chat floor for the same model.
    const explore = getAgentCardByName(view, "Explore");
    const exploreReasoning = within(explore).getByRole("button", { name: "Reasoning" });
    expect(exploreReasoning.textContent).toContain("High");
    fireEvent.click(exploreReasoning);
    expect(within(explore).queryByRole("option", { name: "Off" })).toBeNull();
    expect(within(explore).queryByRole("option", { name: "Low" })).toBeNull();
  });

  test.each([undefined, "openai:gpt-5.6-sol"])(
    "Intuition inherits workspace/default capabilities instead of global Exec (workspace=%s)",
    async (workspaceModel) => {
      advisorExperimentEnabled = true;
      const view = renderTasksSection({
        workspaceModel,
        agentAiDefaults: { exec: { modelString: "openai:gpt-5-pro" } },
      });
      await view.findByText("Intuition");
      const card = getAgentCardByName(view, "Intuition");
      selectReasoningOption(card, "Low");
      const max = within(card).queryByRole("option", { name: "Max" });
      if (workspaceModel) expect(max).toBeTruthy();
      else expect(max).toBeNull();
      await waitFor(() => {
        expect(getLatestSavePayload(view.saveConfig).agentAiDefaults.intuition).toEqual({
          thinkingLevel: "low",
        });
      });
    }
  );

  test.each([undefined, "openai:gpt-5-pro"])(
    "Intuition prefers its own model override to its definition, then the parent (override=%s)",
    async (modelString) => {
      advisorExperimentEnabled = true;
      const view = renderTasksSection({
        agents: FALLBACK_AGENTS.map((agent) =>
          agent.id === "intuition"
            ? { ...agent, aiDefaults: { model: "openai:gpt-5.6-sol" } }
            : agent
        ),
        agentAiDefaults: {
          exec: { modelString: "anthropic:ui-exec" },
          intuition: { modelString },
        },
      });
      await view.findByText("Intuition");
      const card = getAgentCardByName(view, "Intuition");
      fireEvent.click(within(card).getByRole("button", { name: "Reasoning" }));
      const listbox = within(card).getByRole("listbox", { name: "Reasoning effort" });
      expect(within(listbox).getByRole("option", { name: "High" })).toBeTruthy();
      if (modelString) {
        expect(within(listbox).queryByRole("option", { name: "Low" })).toBeNull();
        expect(within(listbox).queryByRole("option", { name: "Max" })).toBeNull();
      } else {
        expect(within(listbox).getByRole("option", { name: "Low" })).toBeTruthy();
        expect(within(listbox).getByRole("option", { name: "Max" })).toBeTruthy();
      }
    }
  );

  test("renders a distinct Exec subagent row", async () => {
    const view = renderTasksSection();

    await view.findByRole("group", { name: "Exec defaults" });
    expect(within(getExecSubagentRow(view)).getByText("Exec")).toBeTruthy();
    expect(view.getByText("UI agents")).toBeTruthy();
    expect(view.getByText("Sub-agents")).toBeTruthy();
  });

  test("defaults advisor on for Exec and Plan when the experiment is enabled", async () => {
    advisorExperimentEnabled = true;
    const view = renderTasksSection();

    const planAdvisorSwitch = await view.findByRole("switch", { name: "Toggle plan advisor" });
    const execAdvisorSwitch = view.getByRole("switch", { name: "Toggle exec advisor" });

    expect(execAdvisorSwitch.getAttribute("aria-checked")).toBe("true");
    expect(planAdvisorSwitch.getAttribute("aria-checked")).toBe("true");
  });

  test("preserves unchanged nested subagent defaults when saving an agent-only change", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        foo: { enabled: true },
        exec: { subagent: { modelString: "openai:subagent-model" } },
      },
    });

    await view.findByText("Explore");
    fireEvent.click(
      within(getAgentCardByName(view, "Explore")).getByRole("switch", {
        name: "Toggle explore enabled",
      })
    );

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    expect(payload.agentAiDefaults.explore).toEqual({ enabled: false });
    expect(payload.agentAiDefaults.exec?.subagent).toEqual({
      modelString: "openai:subagent-model",
    });
    expect("subagentAiDefaults" in payload).toBe(false);
  });

  test("includes nested subagent defaults when saving a delegated default change", async () => {
    const view = renderTasksSection();
    const row = await view.findByRole("group", { name: "Exec defaults" });

    fireEvent.change(within(row).getByLabelText("Model"), {
      target: { value: "openai:subagent-model" },
    });

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    expect("subagentAiDefaults" in payload).toBe(false);
    expect(payload.agentAiDefaults.exec?.subagent).toEqual({
      modelString: "openai:subagent-model",
    });
  });

  test.each(["openai:gpt-5.6-sol", "xai:grok-code-fast-1"])(
    "does not resolve or persist inherited preferences from global Exec model %s",
    async (modelString) => {
      const view = renderTasksSection({
        agentAiDefaults: { exec: { modelString, thinkingLevel: "medium", reasoningMode: "pro" } },
      });
      const row = await view.findByRole("group", { name: "Exec defaults" });
      const trigger = within(row).getByRole("button", { name: "Reasoning" });
      expect(trigger.textContent).not.toContain("PRO");
      expect(within(row).getByLabelText<HTMLSelectElement>("Model").value).toBe("");
      fireEvent.click(trigger);
      const listbox = within(row).getByRole("listbox", { name: "Reasoning effort" });
      expect(within(listbox).getByRole("option", { selected: true }).textContent).not.toContain(
        "Medium"
      );
      for (const level of ["Off", "Low", "Medium", "High", "Extra High", "Max"]) {
        expect(
          within(listbox).getByRole("option", { name: level }).getAttribute("aria-selected")
        ).toBe("false");
      }
      expect(
        within(row)
          .getByRole("button", { name: /Pro mode/ })
          .getAttribute("aria-pressed")
      ).toBe("mixed");
      expect(within(row).queryByRole("button", { name: /Fast mode/ })).toBeNull();
      expect(view.saveConfig).not.toHaveBeenCalled();
    }
  );

  test("defers inherited-model effort capabilities without persisting a model or mode", async () => {
    const view = renderTasksSection({
      agentAiDefaults: { exec: { modelString: "xai:grok-code-fast-1", reasoningMode: "pro" } },
    });
    const row = await view.findByRole("group", { name: "Exec defaults" });
    selectReasoningOption(row, "Max");
    await waitFor(() =>
      expect(getLatestSavePayload(view.saveConfig).agentAiDefaults.exec?.subagent).toEqual({
        thinkingLevel: "max",
      })
    );
    const trigger = within(row).getByRole("button", { name: "Reasoning" });
    expect(trigger.textContent).toContain("Max");
    expect(trigger.textContent).not.toContain("PRO");
    const listbox = within(row).getByRole("listbox", { name: "Reasoning effort" });
    fireEvent.click(within(listbox).getByRole("option", { name: "Extra High" }));
    await waitFor(() =>
      expect(getLatestSavePayload(view.saveConfig).agentAiDefaults.exec?.subagent).toEqual({
        thinkingLevel: "xhigh",
      })
    );
    expect(trigger.textContent).toContain("Extra High");
  });

  test("explicit subagent models use their capabilities while mode remains inherited", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        exec: {
          reasoningMode: "pro",
          subagent: { modelString: "openai:gpt-5.6-sol", thinkingLevel: "high" },
        },
      },
    });
    const row = await view.findByRole("group", { name: "Exec defaults" });
    fireEvent.click(within(row).getByRole("button", { name: "Reasoning" }));
    expect(
      within(row)
        .getByRole("button", { name: /Pro mode/ })
        .getAttribute("aria-pressed")
    ).toBe("mixed");
    fireEvent.change(within(row).getByLabelText("Model"), {
      target: { value: "xai:grok-code-fast-1" },
    });
    expect(within(row).queryByRole("button", { name: /Pro mode/ })).toBeNull();
    expect(within(row).queryByRole("option", { name: "Max" })).toBeNull();
    await waitFor(() =>
      expect(
        getLatestSavePayload(view.saveConfig).agentAiDefaults.exec?.subagent?.reasoningMode
      ).toBeUndefined()
    );
  });

  test("setting only the Exec subagent model writes only the sparse subagent model", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        exec: { modelString: "anthropic:ui-exec", thinkingLevel: "medium" },
      },
    });
    const row = await view.findByRole("group", { name: "Exec defaults" });

    fireEvent.change(within(row).getByLabelText("Model"), {
      target: { value: "openai:subagent-model" },
    });

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    expect(payload.agentAiDefaults.exec).toEqual({
      modelString: "anthropic:ui-exec",
      thinkingLevel: "medium",
      subagent: { modelString: "openai:subagent-model" },
    });
    expect(payload.agentAiDefaults.exec?.subagent?.thinkingLevel).toBeUndefined();
  });

  test("setting only the Exec subagent thinking writes only the sparse subagent thinking", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        exec: { modelString: "anthropic:ui-exec", thinkingLevel: "medium" },
      },
    });
    const row = await view.findByRole("group", { name: "Exec defaults" });

    selectReasoningOption(row, "High");

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    expect(payload.agentAiDefaults.exec).toEqual({
      modelString: "anthropic:ui-exec",
      thinkingLevel: "medium",
      subagent: { thinkingLevel: "high" },
    });
    expect("modelString" in (payload.agentAiDefaults.exec?.subagent ?? {})).toBe(false);
  });

  test("resetting one Exec subagent field removes only that field", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        exec: {
          subagent: { modelString: "openai:subagent-model", thinkingLevel: "high" },
        },
      },
    });
    const row = await view.findByRole("group", { name: "Exec defaults" });

    fireEvent.click(within(row).getAllByRole("button", { name: "Reset" })[0]);

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    expect(payload.agentAiDefaults.exec?.subagent).toEqual({ thinkingLevel: "high" });
  });

  test("resetting the last Exec subagent field removes the exec entry", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        exec: { subagent: { modelString: "openai:subagent-model" } },
      },
    });
    const row = await view.findByRole("group", { name: "Exec defaults" });

    fireEvent.click(within(row).getByRole("button", { name: "Reset" }));

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    expect(payload.agentAiDefaults.exec).toBeUndefined();
  });

  test("toggling Pro mode persists the agent default", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        explore: { modelString: "openai:gpt-5.6-sol" },
      },
    });

    await view.findByText("Explore");
    const card = getAgentCardByName(view, "Explore");
    fireEvent.click(within(card).getByRole("button", { name: "Reasoning" }));
    const proToggle = card.querySelector('[data-component="ProModeToggle"]');
    if (!(proToggle instanceof HTMLElement)) throw new Error("Pro mode toggle not rendered");
    fireEvent.click(proToggle);

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    expect(payload.agentAiDefaults.explore?.reasoningMode).toBe("pro");
  });

  test("toggling Pro mode off removes the persisted reasoning mode", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        explore: { modelString: "openai:gpt-5.6-sol", reasoningMode: "pro" },
      },
    });

    await view.findByText("Explore");
    const card = getAgentCardByName(view, "Explore");
    fireEvent.click(within(card).getByRole("button", { name: "Reasoning" }));
    const proToggle = card.querySelector('[data-component="ProModeToggle"]');
    if (!(proToggle instanceof HTMLElement)) throw new Error("Pro mode toggle not rendered");
    expect(proToggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(proToggle);

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    expect(payload.agentAiDefaults.explore?.reasoningMode).toBeUndefined();
    expect(payload.agentAiDefaults.explore?.modelString).toBe("openai:gpt-5.6-sol");
  });

  test.each(["standard", "pro"] as const)(
    "cycles inherited mode through explicit Pro and Standard regardless of global %s",
    async (reasoningMode) => {
      const view = renderTasksSection({
        agentAiDefaults: { exec: { modelString: "openai:gpt-5.6-sol", reasoningMode } },
      });
      const row = await view.findByRole("group", { name: "Exec defaults" });
      const trigger = within(row).getByRole("button", { name: "Reasoning" });
      fireEvent.click(trigger);
      const proToggle = within(row).getByRole("button", { name: /Pro mode/ });
      expect(proToggle.getAttribute("aria-pressed")).toBe("mixed");
      for (const mode of ["pro", "standard", "pro"] as const) {
        fireEvent.click(proToggle);
        await waitFor(() =>
          expect(getLatestSavePayload(view.saveConfig).agentAiDefaults.exec?.subagent).toEqual({
            reasoningMode: mode,
          })
        );
        expect(proToggle.getAttribute("aria-pressed")).toBe(String(mode === "pro"));
        expect(trigger.textContent).toContain(mode.toUpperCase());
        expect(getLatestSavePayload(view.saveConfig).agentAiDefaults.exec?.reasoningMode).toBe(
          reasoningMode
        );
      }
      const listbox = within(row).getByRole("listbox", { name: "Reasoning effort" });
      fireEvent.click(within(listbox).getByRole("option", { selected: true }));
      await waitFor(() =>
        expect(getLatestSavePayload(view.saveConfig).agentAiDefaults.exec?.subagent).toBeUndefined()
      );
      expect(proToggle.getAttribute("aria-pressed")).toBe("mixed");
    }
  );

  test("disabling Pro mode inherited from a base agent persists an explicit standard override", async () => {
    // Explore's base is exec (FALLBACK_AGENTS), so ACP resolution inherits
    // exec's pro; deleting explore's override would silently fall back to pro.
    const view = renderTasksSection({
      agentAiDefaults: {
        exec: { reasoningMode: "pro" },
        explore: { modelString: "openai:gpt-5.6-sol", reasoningMode: "pro" },
      },
    });

    await view.findByText("Explore");
    const card = getAgentCardByName(view, "Explore");
    fireEvent.click(within(card).getByRole("button", { name: "Reasoning" }));
    const proToggle = card.querySelector('[data-component="ProModeToggle"]');
    if (!(proToggle instanceof HTMLElement)) throw new Error("Pro mode toggle not rendered");
    fireEvent.click(proToggle);

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    expect(payload.agentAiDefaults.explore?.reasoningMode).toBe("standard");
    expect(payload.agentAiDefaults.exec?.reasoningMode).toBe("pro");
  });

  test("selecting Inherit clears the reasoning override along with the thinking level", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        exec: { subagent: { thinkingLevel: "high", reasoningMode: "standard" } },
      },
    });

    const row = await view.findByRole("group", { name: "Exec defaults" });
    fireEvent.click(within(row).getByRole("button", { name: /Reasoning/ }));
    const listbox = within(row).getByRole("listbox", { name: "Reasoning effort" });
    fireEvent.click(within(listbox).getByRole("option", { name: "Use calling chat’s Exec" }));

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    // Both fields cleared empties the entry entirely.
    expect(payload.agentAiDefaults.exec).toBeUndefined();
  });

  test("displays base-chain-inherited Pro mode and disables it in one click", async () => {
    // Explore has no direct override; its base exec supplies pro, which ACP
    // resolution applies, so the toggle must start pressed and one click must
    // persist an explicit standard override.
    const view = renderTasksSection({
      agentAiDefaults: {
        exec: { reasoningMode: "pro" },
        explore: { modelString: "openai:gpt-5.6-sol" },
      },
    });

    await view.findByText("Explore");
    const card = getAgentCardByName(view, "Explore");
    fireEvent.click(within(card).getByRole("button", { name: "Reasoning" }));
    const proToggle = card.querySelector('[data-component="ProModeToggle"]');
    if (!(proToggle instanceof HTMLElement)) throw new Error("Pro mode toggle not rendered");
    expect(proToggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(proToggle);

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    expect(payload.agentAiDefaults.explore?.reasoningMode).toBe("standard");
  });

  test("gates Pro on the base-chain-inherited model, not the ambient default", async () => {
    // Explore inherits exec's GPT-5.6 (pro-capable) with no direct model
    // override; the ambient default (anthropic:workspace-default) is not.
    // The toggle must appear (and show inherited pro) so it can be disabled
    // without first overriding the model.
    const view = renderTasksSection({
      agentAiDefaults: {
        exec: { modelString: "openai:gpt-5.6-sol", reasoningMode: "pro" },
      },
    });

    await view.findByText("Explore");
    const card = getAgentCardByName(view, "Explore");
    fireEvent.click(within(card).getByRole("button", { name: "Reasoning" }));
    const proToggle = card.querySelector('[data-component="ProModeToggle"]');
    if (!(proToggle instanceof HTMLElement)) throw new Error("Pro mode toggle not rendered");
    expect(proToggle.getAttribute("aria-pressed")).toBe("true");
  });

  test("gates Pro on the agent definition's pinned model when Settings has no override", async () => {
    // The definition pins ai.model to GPT-5.6 (pro-capable) while Settings has
    // no model override anywhere in the chain and the ambient default is
    // Anthropic. ACP/task resolution runs the definition model, so the card
    // must gate Pro against it, not the ambient fallback.
    const view = renderTasksSection({
      agents: [
        {
          id: "researcher",
          scope: "project",
          name: "Researcher",
          uiSelectable: false,
          subagentRunnable: true,
          aiDefaults: { model: "openai:gpt-5.6-sol" },
        },
      ],
    });

    await view.findByText("Researcher");
    const card = getAgentCardByName(view, "Researcher");
    fireEvent.click(within(card).getByRole("button", { name: "Reasoning" }));
    expect(card.querySelector('[data-component="ProModeToggle"]')).not.toBeNull();
  });

  test("hides the Pro mode toggle on the Name Workspace card even for pro-capable models", async () => {
    // Name generation runs raw streamText (workspaceTitleGenerator) and never
    // applies reasoningMode, same headless class as Dream.
    const view = renderTasksSection({
      agentAiDefaults: {
        name_workspace: { modelString: "openai:gpt-5.6-sol" },
      },
    });

    await view.findByText("Name Workspace");
    const card = getAgentCardByName(view, "Name Workspace");
    fireEvent.click(within(card).getByRole("button", { name: "Reasoning" }));

    expect(within(card).getByRole("listbox", { name: "Reasoning effort" })).toBeTruthy();
    expect(card.querySelector('[data-component="ProModeToggle"]')).toBeNull();
  });

  test("hides the Pro mode toggle on the Dream card even for pro-capable models", async () => {
    // Dream's headless requests (raw streamText) never apply reasoningMode,
    // so the card must not offer a toggle that cannot affect them.
    advisorExperimentEnabled = true; // shared experiment mock also enables memory consolidation
    const view = renderTasksSection({
      agentAiDefaults: {
        dream: { modelString: "openai:gpt-5.6-sol" },
      },
    });

    await view.findByText("Dream");
    const card = getAgentCardByName(view, "Dream");
    fireEvent.click(within(card).getByRole("button", { name: "Reasoning" }));

    expect(within(card).getByRole("listbox", { name: "Reasoning effort" })).toBeTruthy();
    expect(card.querySelector('[data-component="ProModeToggle"]')).toBeNull();
  });

  test("hides the Pro mode toggle for models without pro support", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        explore: { modelString: "anthropic:foo" },
      },
    });

    await view.findByText("Explore");
    const card = getAgentCardByName(view, "Explore");
    fireEvent.click(within(card).getByRole("button", { name: "Reasoning" }));

    expect(within(card).getByRole("listbox", { name: "Reasoning effort" })).toBeTruthy();
    expect(card.querySelector('[data-component="ProModeToggle"]')).toBeNull();
  });
});

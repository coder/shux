import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import * as ActualMinThinkingLevelsModule from "@/browser/hooks/useMinThinkingLevels";
import * as ActualRoutingModule from "@/browser/hooks/useRouting";
import * as ActualSelectPrimitiveModule from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { DEFAULT_TASK_SETTINGS, type TaskSettings } from "@/common/types/tasks";
import {
  THINKING_LEVEL_OFF,
  type ThinkingLevel,
  type OpenAIReasoningMode,
} from "@/common/types/thinking";
import { installDom } from "../../../../../tests/ui/dom";
import { createSelectPrimitiveDouble } from "../../../../../tests/ui/selectPrimitiveDouble";

interface MockConfig {
  taskSettings: TaskSettings;
  advisorModelString: string | null;
  advisorThinkingLevel: ThinkingLevel | null | undefined;
  advisorReasoningMode?: OpenAIReasoningMode | null;
  advisorMaxUsesPerTurn: number | null | undefined;
  advisorMaxOutputTokens: number | null | undefined;
}

interface SaveConfigInput {
  taskSettings: TaskSettings;
  advisorModelString?: string | null;
  advisorThinkingLevel?: ThinkingLevel | null;
  advisorReasoningMode?: OpenAIReasoningMode | null;
  advisorMaxUsesPerTurn?: number | null;
  advisorMaxOutputTokens?: number | null;
}

interface MockAPIClient {
  config: {
    getConfig: () => Promise<MockConfig>;
    saveConfig: (input: SaveConfigInput) => Promise<void>;
  };
}

// Capture before installing module mocks; mock.restore() does not undo them.
const actualMinThinkingLevelsModule = { ...ActualMinThinkingLevelsModule };
const actualRoutingModule = { ...ActualRoutingModule };

let mockApi: MockAPIClient;
let providersConfig: ProvidersConfigMap | null = null;
let minimumThinkingLevel: ThinkingLevel = THINKING_LEVEL_OFF;
let experimentValues: Record<string, boolean>;

void mock.module("@/browser/components/SelectPrimitive/SelectPrimitive", () =>
  createSelectPrimitiveDouble()
);

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: mockApi,
    status: "connected" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

void mock.module("@/browser/contexts/ExperimentsContext", () => ({
  useExperiment: (experimentId: string) => [
    experimentValues[experimentId] ?? false,
    (enabled: boolean) => {
      experimentValues[experimentId] = enabled;
    },
  ],
  useExperimentValue: (experimentId: string) => experimentValues[experimentId] ?? false,
}));

void mock.module("@/browser/hooks/useModelsFromSettings", () => ({
  useModelsFromSettings: () => ({
    models: ["openai:gpt-4o", "anthropic:claude-sonnet-4-5"],
    hiddenModelsForSelector: ["hidden:model"],
  }),
}));

void mock.module("@/browser/components/ModelSelector/ModelSelector", () => ({
  ModelSelector: (props: {
    value: string;
    onChange: (value: string) => void;
    models: string[];
    emptyLabel?: string;
  }) => (
    <button
      type="button"
      aria-label="Advisor model selector"
      onClick={() => props.onChange(props.models[0] ?? "")}
    >
      {props.value !== "" ? props.value : (props.emptyLabel ?? "Select model")}
    </button>
  ),
}));

void mock.module("@/browser/hooks/useTelemetry", () => ({
  useTelemetry: () => ({
    experimentOverridden: () => undefined,
  }),
}));

void mock.module("@/browser/hooks/useMinThinkingLevels", () => ({
  useMinThinkingLevels: () => ({ getMinimum: () => minimumThinkingLevel }),
}));
void mock.module("@/browser/hooks/useProvidersConfig", () => ({
  useProvidersConfig: () => ({ config: providersConfig }),
}));
void mock.module("@/browser/hooks/useRouting", () => ({
  useRouting: () => ({
    resolveRoute: () => ({ route: "direct" }),
    resolveEffectiveRoute: () => "direct",
  }),
}));

import { ExperimentsSection } from "./ExperimentsSection";

function createMockAPI(configOverrides: Partial<MockConfig> = {}) {
  const config: MockConfig = {
    taskSettings: DEFAULT_TASK_SETTINGS,
    advisorModelString: null,
    advisorThinkingLevel: undefined,
    advisorMaxUsesPerTurn: undefined,
    advisorMaxOutputTokens: undefined,
    ...configOverrides,
  };

  const getConfigMock = mock(() =>
    Promise.resolve({
      taskSettings: config.taskSettings,
      advisorModelString: config.advisorModelString,
      advisorThinkingLevel: config.advisorThinkingLevel,
      advisorReasoningMode: config.advisorReasoningMode,
      advisorMaxUsesPerTurn: config.advisorMaxUsesPerTurn,
      advisorMaxOutputTokens: config.advisorMaxOutputTokens,
    })
  );

  const saveConfigMock = mock((input: SaveConfigInput) => {
    config.taskSettings = input.taskSettings;
    config.advisorModelString = input.advisorModelString?.trim()
      ? input.advisorModelString.trim()
      : null;
    config.advisorThinkingLevel = input.advisorThinkingLevel ?? null;
    config.advisorReasoningMode = input.advisorReasoningMode;
    config.advisorMaxUsesPerTurn = input.advisorMaxUsesPerTurn ?? null;
    config.advisorMaxOutputTokens = input.advisorMaxOutputTokens ?? null;
    return Promise.resolve();
  });

  return {
    api: {
      config: {
        getConfig: getConfigMock,
        saveConfig: saveConfigMock,
      },
    },
    getConfigMock,
    saveConfigMock,
  };
}

describe("ExperimentsSection advisor config", () => {
  let cleanupDom: (() => void) | null = null;

  afterAll(async () => {
    await mock.module("@/browser/hooks/useMinThinkingLevels", () => actualMinThinkingLevelsModule);
    await mock.module("@/browser/hooks/useRouting", () => actualRoutingModule);
  });

  beforeEach(() => {
    cleanupDom = installDom();
    window.api = { platform: "linux", versions: {} };
    experimentValues = {};
    providersConfig = null;
    minimumThinkingLevel = THINKING_LEVEL_OFF;
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    void mock.module(
      "@/browser/components/SelectPrimitive/SelectPrimitive",
      () => ActualSelectPrimitiveModule
    );
    cleanupDom?.();
    cleanupDom = null;
  });

  function renderExperimentsSection(params?: {
    advisorEnabled?: boolean;
    configOverrides?: Partial<MockConfig>;
  }) {
    const { advisorEnabled = true, configOverrides = {} } = params ?? {};
    experimentValues = {
      [EXPERIMENT_IDS.ADVISOR_TOOL]: advisorEnabled,
    };

    const { api, getConfigMock, saveConfigMock } = createMockAPI(configOverrides);
    mockApi = api;

    const view = render(
      <ThemeProvider forcedTheme="dark">
        <ExperimentsSection />
      </ThemeProvider>
    );

    return { view, getConfigMock, saveConfigMock };
  }

  function getSelectTrigger(view: ReturnType<typeof render>, label: string): HTMLElement {
    const labelElement = view.getByText(label);
    let container: HTMLElement | null = labelElement.parentElement;

    while (container && !container.querySelector('[role="combobox"]')) {
      container = container.parentElement;
    }

    const trigger = container?.querySelector('[role="combobox"]');
    if (!(trigger instanceof window.HTMLElement)) {
      throw new Error(`Could not find select trigger for ${label}`);
    }

    return trigger;
  }

  function chooseSelectOption(view: ReturnType<typeof render>, label: string, optionText: string) {
    const trigger = getSelectTrigger(view, label);
    const row = trigger.parentElement?.parentElement;
    if (!(row instanceof window.HTMLElement)) {
      throw new Error(`Could not find row for ${label}`);
    }

    fireEvent.pointerDown(trigger);

    const option = within(row)
      .getAllByRole("button", { name: optionText })
      .find((element) => element !== trigger);
    if (!(option instanceof window.HTMLElement)) {
      throw new Error(`Could not find ${optionText} option for ${label}`);
    }

    fireEvent.click(option);
  }

  test("keeps the advisor row toggle-only when the experiment is disabled", async () => {
    const { view, getConfigMock } = renderExperimentsSection({ advisorEnabled: false });

    await waitFor(() => {
      expect(view.getByText("Advisor Tool")).toBeDefined();
    });

    expect(getConfigMock).not.toHaveBeenCalled();
    expect(view.queryByText("Advisor Model")).toBeNull();
    expect(view.queryByText("Max Uses / Turn")).toBeNull();
  });

  test("shows the advisor inline config when the experiment is enabled", async () => {
    const { view, getConfigMock } = renderExperimentsSection({ advisorEnabled: true });

    await waitFor(() => {
      expect(getConfigMock).toHaveBeenCalledTimes(1);
      expect(view.getByText("Advisor Model")).toBeDefined();
      expect(view.getByText("Max Uses / Turn")).toBeDefined();
    });
  });

  test("shows and saves advisor effort without applying the chat minimum", async () => {
    minimumThinkingLevel = "high";
    const { view, saveConfigMock } = renderExperimentsSection({
      configOverrides: { advisorModelString: "openai:gpt-6-astra", advisorThinkingLevel: "low" },
    });
    const trigger = await view.findByRole("button", { name: "Reasoning" });
    expect(trigger.textContent).toContain("Low");
    fireEvent.click(trigger);
    expect(view.getByRole("option", { name: "Low" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(view.getByRole("button", { name: /Pro mode/ }));
    await waitFor(() =>
      expect(saveConfigMock.mock.calls.at(-1)?.[0]).toMatchObject({
        advisorThinkingLevel: "low",
        advisorReasoningMode: "pro",
      })
    );
    fireEvent.click(view.getByRole("option", { name: "Medium" }));
    await waitFor(() =>
      expect(saveConfigMock.mock.calls.at(-1)?.[0]).toMatchObject({
        advisorThinkingLevel: "medium",
        advisorReasoningMode: "pro",
      })
    );
  });

  test.each(["openai:gpt-6-astra", "openai:team-astra"])(
    "saves Pro independently of effort and restores it after remount for %s",
    async (model) => {
      providersConfig = {
        openai: {
          apiKeySet: true,
          isEnabled: true,
          isConfigured: true,
          models: [{ id: "team-astra", mappedToModel: "openai:gpt-6-astra" }],
        },
      };
      const { view, saveConfigMock } = renderExperimentsSection({
        configOverrides: { advisorModelString: model, advisorThinkingLevel: "high" },
      });
      fireEvent.click(await view.findByRole("button", { name: "Reasoning" }));
      const pro = view.getByRole("button", { name: /Pro mode/ });
      expect(pro.getAttribute("aria-pressed")).toBe("false");
      fireEvent.click(pro);
      await waitFor(() => {
        expect(saveConfigMock.mock.calls.at(-1)?.[0]).toMatchObject({
          advisorReasoningMode: "pro",
          advisorThinkingLevel: "high",
        });
      });
      view.unmount();
      const restored = render(
        <ThemeProvider forcedTheme="dark">
          <ExperimentsSection />
        </ThemeProvider>
      );
      fireEvent.click(await restored.findByRole("button", { name: "Reasoning" }));
      expect(restored.getByRole("button", { name: /Pro mode/ }).getAttribute("aria-pressed")).toBe(
        "true"
      );
      fireEvent.click(restored.getByRole("option", { name: "Max" }));
      await waitFor(() => {
        expect(saveConfigMock.mock.calls.at(-1)?.[0]).toMatchObject({
          advisorReasoningMode: "pro",
          advisorThinkingLevel: "max",
        });
      });
      fireEvent.click(restored.getByRole("button", { name: /Pro mode/ }));
      await waitFor(() =>
        expect(saveConfigMock.mock.calls.at(-1)?.[0].advisorReasoningMode).toBe("standard")
      );
    }
  );

  test("hides Pro for unsupported advisor models while preserving the saved preference", async () => {
    const { view, saveConfigMock } = renderExperimentsSection({
      configOverrides: {
        advisorModelString: "openai:gpt-6-astra",
        advisorThinkingLevel: "high",
        advisorReasoningMode: "pro",
      },
    });
    fireEvent.click(await view.findByRole("button", { name: "Advisor model selector" }));
    fireEvent.click(view.getByRole("button", { name: "Reasoning" }));
    expect(view.queryByRole("button", { name: /Pro mode/ })).toBeNull();
    await waitFor(() =>
      expect(saveConfigMock.mock.calls.at(-1)?.[0]).toMatchObject({
        advisorModelString: "openai:gpt-4o",
        advisorReasoningMode: "pro",
      })
    );
  });

  test("seeds limited mode with 3 when switching from unlimited", async () => {
    const { view, saveConfigMock } = renderExperimentsSection();

    const initialLimitInput = (await waitFor(() =>
      view.getByLabelText("Advisor max uses per turn")
    )) as HTMLInputElement;

    expect(initialLimitInput.value).toBe("3");

    chooseSelectOption(view, "Max Uses / Turn", "Unlimited");

    await waitFor(() => {
      expect(saveConfigMock.mock.calls.at(-1)?.[0]).toEqual({
        taskSettings: DEFAULT_TASK_SETTINGS,
        advisorModelString: null,
        advisorThinkingLevel: THINKING_LEVEL_OFF,
        advisorReasoningMode: "standard",
        advisorMaxUsesPerTurn: null,
        advisorMaxOutputTokens: null,
      });
    });

    chooseSelectOption(view, "Max Uses / Turn", "Limited");

    const restoredInput = (await waitFor(() =>
      view.getByLabelText("Advisor max uses per turn")
    )) as HTMLInputElement;

    expect(restoredInput.value).toBe("3");

    await waitFor(() => {
      expect(saveConfigMock.mock.calls.at(-1)?.[0]).toEqual({
        taskSettings: DEFAULT_TASK_SETTINGS,
        advisorModelString: null,
        advisorThinkingLevel: THINKING_LEVEL_OFF,
        advisorReasoningMode: "standard",
        advisorMaxUsesPerTurn: 3,
        advisorMaxOutputTokens: null,
      });
    });
  });

  test("restores the existing limit after toggling back from unlimited", async () => {
    const { view, saveConfigMock } = renderExperimentsSection({
      configOverrides: { advisorMaxUsesPerTurn: 5 },
    });

    const limitInput = (await waitFor(() =>
      view.getByLabelText("Advisor max uses per turn")
    )) as HTMLInputElement;

    expect(limitInput.value).toBe("5");

    chooseSelectOption(view, "Max Uses / Turn", "Unlimited");

    await waitFor(() => {
      expect(saveConfigMock.mock.calls.at(-1)?.[0]).toEqual({
        taskSettings: DEFAULT_TASK_SETTINGS,
        advisorModelString: null,
        advisorThinkingLevel: THINKING_LEVEL_OFF,
        advisorReasoningMode: "standard",
        advisorMaxUsesPerTurn: null,
        advisorMaxOutputTokens: null,
      });
    });

    chooseSelectOption(view, "Max Uses / Turn", "Limited");

    const restoredInput = (await waitFor(() =>
      view.getByLabelText("Advisor max uses per turn")
    )) as HTMLInputElement;

    expect(restoredInput.value).toBe("5");
  });
});

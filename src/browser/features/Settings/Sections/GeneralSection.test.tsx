import React from "react";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requireTestModule } from "@/browser/testUtils";
import type * as APIModule from "@/browser/contexts/API";
import type * as ExperimentsModule from "@/browser/contexts/ExperimentsContext";
import type * as GeneralModule from "./GeneralSection";
import {
  EXPERIMENT_IDS,
  getExperimentKey,
  type ExperimentId,
} from "@/common/constants/experiments";
import { installDom } from "../../../../../tests/ui/dom";
import { BASH_COLLAPSED_SUMMARY_MODE_KEY, SIDEBAR_FLAT_MODE_KEY } from "@/common/constants/storage";
import {
  DEFAULT_CODER_ARCHIVE_BEHAVIOR,
  type CoderWorkspaceArchiveBehavior,
} from "@/common/config/coderArchiveBehavior";
import {
  DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
  type WorktreeArchiveBehavior,
} from "@/common/config/worktreeArchiveBehavior";

interface MockConfig {
  coderWorkspaceArchiveBehavior: CoderWorkspaceArchiveBehavior;
  worktreeArchiveBehavior: WorktreeArchiveBehavior;
  chatTranscriptFullWidth: boolean;
  llmDebugLogs: boolean;
}

type ExperimentOverrides = Partial<Record<ExperimentId, boolean>>;

interface MockAPIClient {
  experiments: {
    getOverrides: () => Promise<ExperimentOverrides>;
    setOverride: (input: { experimentId: ExperimentId; enabled: boolean }) => Promise<void>;
  };
  config: {
    getConfig: () => Promise<MockConfig>;
    updateCoderPrefs: (input: {
      coderWorkspaceArchiveBehavior: CoderWorkspaceArchiveBehavior;
      worktreeArchiveBehavior: WorktreeArchiveBehavior;
    }) => Promise<void>;
    updateChatTranscriptFullWidth: (input: { enabled: boolean }) => Promise<void>;
    updateLlmDebugLogs: (input: { enabled: boolean }) => Promise<void>;
  };
  server: {
    getSshHost: () => Promise<string | null>;
    setSshHost: (input: { sshHost: string | null }) => Promise<void>;
  };
  projects: {
    getDefaultProjectDir: () => Promise<string>;
    setDefaultProjectDir: (input: { path: string }) => Promise<void>;
  };
}

let mockApi: MockAPIClient;
const experimentOverriddenMock = mock<(experimentId: string, enabled: boolean) => void>(
  () => undefined
);

const mockSelectPrimitive = (() => {
  const SelectContext = React.createContext<{
    value?: string;
    disabled?: boolean;
    open: boolean;
    options: Map<string, React.ReactNode>;
    onValueChange?: (value: string) => void;
    setOpen: (open: boolean) => void;
  } | null>(null);

  function collectOptions(children: React.ReactNode, options = new Map<string, React.ReactNode>()) {
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement<{ value?: string; children?: React.ReactNode }>(child)) {
        return;
      }

      if (typeof child.props.value === "string") {
        options.set(child.props.value, child.props.children);
      }

      if (child.props.children) {
        collectOptions(child.props.children, options);
      }
    });

    return options;
  }

  function Select(props: {
    value?: string;
    disabled?: boolean;
    onValueChange?: (value: string) => void;
    children: React.ReactNode;
  }) {
    const [open, setOpen] = React.useState(false);
    const options = React.useMemo(() => collectOptions(props.children), [props.children]);
    return (
      <SelectContext.Provider
        value={{
          value: props.value,
          disabled: props.disabled,
          open,
          options,
          onValueChange: props.onValueChange,
          setOpen,
        }}
      >
        {props.children}
      </SelectContext.Provider>
    );
  }

  const SelectTrigger = React.forwardRef<
    HTMLButtonElement,
    React.ComponentPropsWithoutRef<"button">
  >((props, ref) => {
    const context = React.useContext(SelectContext);
    return (
      <button
        {...props}
        ref={ref}
        type="button"
        role="combobox"
        disabled={context?.disabled}
        aria-expanded={context?.open ?? false}
        onPointerDown={(event) => {
          props.onPointerDown?.(event);
          if (!context?.disabled) {
            context?.setOpen(true);
          }
        }}
      >
        {props.children}
      </button>
    );
  });
  SelectTrigger.displayName = "MockSelectTrigger";

  function SelectValue() {
    const context = React.useContext(SelectContext);
    return <span>{context?.options.get(context?.value ?? "") ?? context?.value ?? ""}</span>;
  }

  function SelectContent(props: { children: React.ReactNode }) {
    const context = React.useContext(SelectContext);
    return context?.open ? <div>{props.children}</div> : null;
  }

  function SelectItem(props: { value: string; children: React.ReactNode }) {
    const context = React.useContext(SelectContext);
    return (
      <button
        type="button"
        onClick={() => {
          context?.onValueChange?.(props.value);
          context?.setOpen(false);
        }}
      >
        {props.children}
      </button>
    );
  }

  return {
    Select,
    SelectTrigger,
    SelectValue,
    SelectContent,
    SelectItem,
  };
})();

let APIProvider: typeof APIModule.APIProvider;
let ExperimentsProvider: typeof ExperimentsModule.ExperimentsProvider;
let useExperiment: typeof ExperimentsModule.useExperiment;
let GeneralSection: typeof GeneralModule.GeneralSection;
let isolatedModuleDir: string;

beforeAll(async () => {
  // Isolate the real provider and its consumer from other suites' global hook mocks.
  const root = join(process.cwd(), ".tmp");
  await mkdir(root, { recursive: true });
  isolatedModuleDir = await mkdtemp(join(root, "general-section-test-"));
  await copyFile("src/browser/contexts/API.tsx", join(isolatedModuleDir, "API.tsx"));
  for (const [sourcePath, filename] of [
    ["src/browser/contexts/ExperimentsContext.tsx", "ExperimentsContext.tsx"],
    ["src/browser/features/Settings/Sections/GeneralSection.tsx", "GeneralSection.tsx"],
  ]) {
    const source = await readFile(sourcePath, "utf8");
    const isolatedSource = source
      .replace('from "@/browser/contexts/API";', 'from "./API";')
      .replace('from "@/browser/hooks/useTelemetry";', 'from "./Telemetry";')
      .replace('from "@/browser/contexts/ExperimentsContext";', 'from "./ExperimentsContext";')
      .replace('from "@/browser/components/SelectPrimitive/SelectPrimitive";', 'from "./Select";');
    expect(isolatedSource).not.toBe(source);
    await writeFile(join(isolatedModuleDir, filename), isolatedSource);
  }
  const selectPath = join(isolatedModuleDir, "Select.tsx");
  await writeFile(selectPath, "export {};\n");
  void mock.module(selectPath, () => mockSelectPrimitive);
  const telemetryPath = join(isolatedModuleDir, "Telemetry.ts");
  await writeFile(telemetryPath, "export {};\n");
  void mock.module(telemetryPath, () => ({
    useTelemetry: () => ({ experimentOverridden: experimentOverriddenMock }),
  }));
  ({ APIProvider } = requireTestModule<typeof APIModule>(join(isolatedModuleDir, "API.tsx")));
  ({ ExperimentsProvider, useExperiment } = requireTestModule<typeof ExperimentsModule>(
    join(isolatedModuleDir, "ExperimentsContext.tsx")
  ));
  ({ GeneralSection } = requireTestModule<typeof GeneralModule>(
    join(isolatedModuleDir, "GeneralSection.tsx")
  ));
});

afterAll(async () => {
  await rm(isolatedModuleDir, { recursive: true, force: true });
});

function TestProviders(props: { children: React.ReactNode }) {
  return (
    <APIProvider client={mockApi as APIModule.APIClient}>
      <ExperimentsProvider>
        <ThemeProvider forcedTheme="dark">{props.children}</ThemeProvider>
      </ExperimentsProvider>
    </APIProvider>
  );
}

interface RenderGeneralSectionOptions {
  coderWorkspaceArchiveBehavior?: CoderWorkspaceArchiveBehavior;
  worktreeArchiveBehavior?: WorktreeArchiveBehavior;
  chatTranscriptFullWidth?: boolean;
  localOverrides?: ExperimentOverrides;
  backendOverrides?: ExperimentOverrides;
  children?: React.ReactNode;
}

interface MockAPISetup {
  api: MockAPIClient;
  backendOverrides: ExperimentOverrides;
  setOverrideMock: ReturnType<typeof mock<MockAPIClient["experiments"]["setOverride"]>>;
  getOverridesMock: ReturnType<typeof mock<MockAPIClient["experiments"]["getOverrides"]>>;
  getConfigMock: ReturnType<typeof mock<() => Promise<MockConfig>>>;
  updateCoderPrefsMock: ReturnType<
    typeof mock<
      (input: {
        coderWorkspaceArchiveBehavior: CoderWorkspaceArchiveBehavior;
        worktreeArchiveBehavior: WorktreeArchiveBehavior;
      }) => Promise<void>
    >
  >;
  updateChatTranscriptFullWidthMock: ReturnType<
    typeof mock<(input: { enabled: boolean }) => Promise<void>>
  >;
}

function createMockAPI(
  configOverrides: Partial<MockConfig> = {},
  experimentOverrides: ExperimentOverrides = {}
): MockAPISetup {
  const backendOverrides = { ...experimentOverrides };
  const getOverridesMock = mock(() => Promise.resolve({ ...backendOverrides }));
  const setOverrideMock = mock(
    ({ experimentId, enabled }: { experimentId: ExperimentId; enabled: boolean }) => {
      backendOverrides[experimentId] = enabled;
      return Promise.resolve();
    }
  );
  const config: MockConfig = {
    coderWorkspaceArchiveBehavior: DEFAULT_CODER_ARCHIVE_BEHAVIOR,
    worktreeArchiveBehavior: DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
    chatTranscriptFullWidth: false,
    llmDebugLogs: false,
    ...configOverrides,
  };

  const getConfigMock = mock(() => Promise.resolve({ ...config }));
  const updateCoderPrefsMock = mock(
    (input: {
      coderWorkspaceArchiveBehavior: CoderWorkspaceArchiveBehavior;
      worktreeArchiveBehavior: WorktreeArchiveBehavior;
    }) => {
      config.coderWorkspaceArchiveBehavior = input.coderWorkspaceArchiveBehavior;
      config.worktreeArchiveBehavior = input.worktreeArchiveBehavior;

      return Promise.resolve();
    }
  );

  const updateChatTranscriptFullWidthMock = mock(({ enabled }: { enabled: boolean }) => {
    config.chatTranscriptFullWidth = enabled;

    return Promise.resolve();
  });

  return {
    api: {
      experiments: { getOverrides: getOverridesMock, setOverride: setOverrideMock },
      config: {
        getConfig: getConfigMock,
        updateCoderPrefs: updateCoderPrefsMock,
        updateChatTranscriptFullWidth: updateChatTranscriptFullWidthMock,
        updateLlmDebugLogs: mock(({ enabled }: { enabled: boolean }) => {
          config.llmDebugLogs = enabled;

          return Promise.resolve();
        }),
      },
      server: {
        getSshHost: mock(() => Promise.resolve(null)),
        setSshHost: mock((_input: { sshHost: string | null }) => Promise.resolve()),
      },
      projects: {
        getDefaultProjectDir: mock(() => Promise.resolve("")),
        setDefaultProjectDir: mock((_input: { path: string }) => Promise.resolve()),
      },
    },
    backendOverrides,
    setOverrideMock,
    getOverridesMock,
    getConfigMock,
    updateCoderPrefsMock,
    updateChatTranscriptFullWidthMock,
  };
}

describe("GeneralSection", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    experimentOverriddenMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  function renderGeneralSection(options: RenderGeneralSectionOptions = {}) {
    for (const [id, enabled] of Object.entries(options.localOverrides ?? {})) {
      window.localStorage.setItem(getExperimentKey(id as ExperimentId), JSON.stringify(enabled));
    }
    const setup = createMockAPI(
      {
        chatTranscriptFullWidth: options.chatTranscriptFullWidth,
        coderWorkspaceArchiveBehavior: options.coderWorkspaceArchiveBehavior,
        worktreeArchiveBehavior: options.worktreeArchiveBehavior,
      },
      options.backendOverrides
    );
    mockApi = setup.api;

    const view = render(
      <TestProviders>
        <GeneralSection />
        {options.children}
      </TestProviders>
    );

    return { ...setup, view };
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

  async function chooseSelectOption(
    view: ReturnType<typeof render>,
    label: string,
    optionText: string
  ): Promise<void> {
    const trigger = getSelectTrigger(view, label);
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    const portalRoot = view.baseElement.ownerDocument.body;
    const option = await waitFor(() => {
      const button = within(portalRoot)
        .getAllByText(optionText)
        .find(
          (element): element is HTMLButtonElement => element instanceof window.HTMLButtonElement
        );
      if (!button) {
        throw new Error(`Could not find select option ${optionText}`);
      }
      return button;
    });
    fireEvent.click(option);
    await waitFor(() => {
      expect(trigger.textContent).toContain(optionText);
    });
  }

  const legacyStrategies = [
    { continuous: false, budget: false, label: "Summarize" },
    { continuous: true, budget: false, label: "Continuous" },
    { continuous: false, budget: true, label: "Token Budget" },
    { continuous: true, budget: true, label: "Continuous" },
  ];

  async function hydrateExperiments(setup: MockAPISetup) {
    await act(async () => {
      await waitFor(() => expect(setup.getOverridesMock).toHaveBeenCalledTimes(1));
    });
  }

  for (const source of ["localOverrides", "backendOverrides"] as const) {
    test.each(legacyStrategies)(
      `displays ${source} continuous=$continuous budget=$budget without normalizing on mount`,
      async ({ continuous, budget, label }) => {
        const overrides = {
          [EXPERIMENT_IDS.CONTINUOUS_COMPACTION]: continuous,
          [EXPERIMENT_IDS.TOKEN_BUDGET]: budget,
        };
        const setup = renderGeneralSection({ [source]: overrides });
        await hydrateExperiments(setup);
        expect(setup.view.getByRole("combobox", { name: "Compaction strategy" }).textContent).toBe(
          label
        );
        expect(setup.backendOverrides).toEqual(overrides);
        expect(experimentOverriddenMock).not.toHaveBeenCalled();
        // The provider uploads explicit local values; mounting the dropdown must add no writes.
        if (source === "localOverrides") {
          for (const [experimentId, enabled] of Object.entries(overrides)) {
            expect(setup.setOverrideMock).toHaveBeenCalledWith({ experimentId, enabled });
          }
        }
        expect(setup.setOverrideMock).toHaveBeenCalledTimes(source === "localOverrides" ? 2 : 0);
        for (const [id, enabled] of Object.entries(overrides)) {
          expect(window.localStorage.getItem(getExperimentKey(id as ExperimentId))).toBe(
            source === "localOverrides" ? JSON.stringify(enabled) : null
          );
        }
      }
    );
  }

  test("defaults to Summarize without persisting an implicit choice", async () => {
    const setup = renderGeneralSection();
    await hydrateExperiments(setup);
    expect(setup.view.getByRole("combobox", { name: "Compaction strategy" }).textContent).toBe(
      "Summarize"
    );
    expect(setup.setOverrideMock).not.toHaveBeenCalled();
    expect(setup.backendOverrides).toEqual({});
    expect(
      window.localStorage.getItem(getExperimentKey(EXPERIMENT_IDS.CONTINUOUS_COMPACTION))
    ).toBeNull();
    expect(window.localStorage.getItem(getExperimentKey(EXPERIMENT_IDS.TOKEN_BUDGET))).toBeNull();
  });

  test.each([
    {
      local: { [EXPERIMENT_IDS.CONTINUOUS_COMPACTION]: false },
      backend: {
        [EXPERIMENT_IDS.CONTINUOUS_COMPACTION]: true,
        [EXPERIMENT_IDS.TOKEN_BUDGET]: true,
      },
      label: "Token Budget",
    },
    {
      local: { [EXPERIMENT_IDS.TOKEN_BUDGET]: false },
      backend: { [EXPERIMENT_IDS.TOKEN_BUDGET]: true },
      label: "Summarize",
    },
    {
      local: { [EXPERIMENT_IDS.TOKEN_BUDGET]: true },
      backend: { [EXPERIMENT_IDS.CONTINUOUS_COMPACTION]: true },
      label: "Continuous",
    },
  ])(
    "resolves local overrides before backend values and defaults ($label)",
    async ({ local, backend, label }) => {
      const setup = renderGeneralSection({ localOverrides: local, backendOverrides: backend });
      await hydrateExperiments(setup);
      expect(setup.view.getByRole("combobox", { name: "Compaction strategy" }).textContent).toBe(
        label
      );
      expect(setup.backendOverrides).toEqual({ ...backend, ...local });
      expect(setup.setOverrideMock).toHaveBeenCalledTimes(Object.keys(local).length);
    }
  );

  for (const initial of legacyStrategies) {
    test.each(legacyStrategies.slice(0, 3).filter((next) => next.label !== initial.label))(
      `selecting $label from continuous=${initial.continuous} budget=${initial.budget} persists both flags only`,
      async ({ continuous, budget, label }) => {
        const unrelated = {
          [EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING]: true,
          [EXPERIMENT_IDS.RLM]: true,
          [EXPERIMENT_IDS.MEMORY]: true,
        };
        const setup = renderGeneralSection({
          backendOverrides: {
            ...unrelated,
            [EXPERIMENT_IDS.CONTINUOUS_COMPACTION]: initial.continuous,
            [EXPERIMENT_IDS.TOKEN_BUDGET]: initial.budget,
          },
        });
        await hydrateExperiments(setup);
        await chooseSelectOption(setup.view, "Compaction strategy", label);
        await waitFor(() =>
          expect(setup.backendOverrides).toEqual({
            ...unrelated,
            [EXPERIMENT_IDS.CONTINUOUS_COMPACTION]: continuous,
            [EXPERIMENT_IDS.TOKEN_BUDGET]: budget,
          })
        );
        expect(setup.setOverrideMock).toHaveBeenCalledTimes(2);
        expect(experimentOverriddenMock).toHaveBeenCalledTimes(2);
        expect(experimentOverriddenMock).toHaveBeenCalledWith(
          EXPERIMENT_IDS.CONTINUOUS_COMPACTION,
          continuous
        );
        expect(experimentOverriddenMock).toHaveBeenCalledWith(EXPERIMENT_IDS.TOKEN_BUDGET, budget);
        expect(
          window.localStorage.getItem(getExperimentKey(EXPERIMENT_IDS.CONTINUOUS_COMPACTION))
        ).toBe(JSON.stringify(continuous));
        expect(window.localStorage.getItem(getExperimentKey(EXPERIMENT_IDS.TOKEN_BUDGET))).toBe(
          JSON.stringify(budget)
        );
        expect(Boolean(setup.view.queryByRole("status"))).toBe(label === "Token Budget");
      }
    );
  }

  test("keeps Token Budget selectable and tracks live PTC/RLM conflicts without changing the strategy", async () => {
    function ConflictToggles() {
      const [ptc, setPtc] = useExperiment(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING);
      const [rlm, setRlm] = useExperiment(EXPERIMENT_IDS.RLM);
      return (
        <>
          <button onClick={() => setPtc(!ptc)}>Toggle PTC fixture</button>
          <button onClick={() => setRlm(!rlm)}>Toggle RLM fixture</button>
        </>
      );
    }
    const setup = renderGeneralSection({ children: <ConflictToggles /> });
    await hydrateExperiments(setup);
    await chooseSelectOption(setup.view, "Compaction strategy", "Token Budget");
    const trigger = setup.view.getByRole("combobox", { name: "Compaction strategy" });
    expect(setup.view.queryByRole("status")).toBeNull();
    fireEvent.click(setup.view.getByRole("button", { name: "Toggle RLM fixture" }));
    expect(setup.view.queryByRole("status")).toBeNull();
    fireEvent.click(setup.view.getByRole("button", { name: "Toggle PTC fixture" }));
    const warning = setup.view.getByRole("status");
    expect(trigger.getAttribute("aria-describedby")).toBe(warning.id);
    fireEvent.click(setup.view.getByRole("button", { name: "Toggle RLM fixture" }));
    expect(setup.view.queryByRole("status")).toBeNull();
    fireEvent.click(setup.view.getByRole("button", { name: "Toggle RLM fixture" }));
    expect(setup.view.getByRole("status")).toBeTruthy();
    fireEvent.click(setup.view.getByRole("button", { name: "Toggle PTC fixture" }));
    expect(setup.view.queryByRole("status")).toBeNull();
    expect(trigger.textContent).toBe("Token Budget");
    await waitFor(() =>
      expect(setup.backendOverrides).toEqual({
        [EXPERIMENT_IDS.CONTINUOUS_COMPACTION]: false,
        [EXPERIMENT_IDS.TOKEN_BUDGET]: true,
        [EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING]: false,
        [EXPERIMENT_IDS.RLM]: true,
      })
    );
  });

  test("persists flat chat list mode from the Sidebar group", () => {
    const { view } = renderGeneralSection();
    const sidebarHeading = view.getByRole("heading", { name: "Sidebar" });
    const sidebarGroup = sidebarHeading.parentElement;
    expect(sidebarGroup).not.toBeNull();
    const toggle = within(sidebarGroup!).getByLabelText("Toggle flat chat list");

    fireEvent.click(toggle);

    expect(window.localStorage.getItem(SIDEBAR_FLAT_MODE_KEY)).toBe("true");
  });

  test("persists the collapsed bash summaries display mode", async () => {
    const { view } = renderGeneralSection();

    await waitFor(() => {
      expect(getSelectTrigger(view, "Collapsed bash summaries").textContent).toContain(
        "Intent and command"
      );
    });

    await chooseSelectOption(view, "Collapsed bash summaries", "Intent");

    expect(window.localStorage.getItem(BASH_COLLAPSED_SUMMARY_MODE_KEY)).toBe(
      JSON.stringify("intent")
    );
  });

  test("loads and persists the full-width chat transcript toggle", async () => {
    const { updateChatTranscriptFullWidthMock, view } = renderGeneralSection({
      chatTranscriptFullWidth: true,
    });

    const toggle = view.getByRole("switch", { name: "Toggle full-width chat transcript" });
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("true");
    });

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      expect(updateChatTranscriptFullWidthMock).toHaveBeenCalledWith({ enabled: false });
    });
  });

  test("renders the worktree archive behavior copy and loads the saved value", async () => {
    const { view } = renderGeneralSection({
      coderWorkspaceArchiveBehavior: "delete",
      worktreeArchiveBehavior: "delete",
    });

    expect(view.getByText("Worktree archive behavior")).toBeTruthy();
    expect(view.getByText(/snapshotted so they can be restored on unarchive/i)).toBeTruthy();

    await waitFor(() => {
      expect(getSelectTrigger(view, "Worktree archive behavior").textContent).toContain(
        "Delete checkout"
      );
    });
  });

  test("persists the selected worktree archive behavior with the current coder behavior", async () => {
    const { updateCoderPrefsMock, view } = renderGeneralSection({
      coderWorkspaceArchiveBehavior: "delete",
      worktreeArchiveBehavior: DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
    });

    await waitFor(() => {
      expect(getSelectTrigger(view, "Worktree archive behavior").textContent).toContain(
        "Keep checkout"
      );
    });

    await chooseSelectOption(view, "Worktree archive behavior", "Snapshot and delete");

    await waitFor(() => {
      expect(updateCoderPrefsMock).toHaveBeenCalledWith({
        coderWorkspaceArchiveBehavior: "delete",
        worktreeArchiveBehavior: "snapshot",
      });
    });
  });

  test("serializes rapid worktree archive behavior writes so only the latest value is persisted", async () => {
    const { api, updateCoderPrefsMock } = createMockAPI();
    let resolveFirstUpdate: (() => void) | undefined;
    let resolveSecondUpdate: (() => void) | undefined;

    api.config.updateCoderPrefs = updateCoderPrefsMock.mockImplementation(
      ({
        coderWorkspaceArchiveBehavior: _coderWorkspaceArchiveBehavior,
        worktreeArchiveBehavior: _worktreeArchiveBehavior,
      }: {
        coderWorkspaceArchiveBehavior: CoderWorkspaceArchiveBehavior;
        worktreeArchiveBehavior: WorktreeArchiveBehavior;
      }) =>
        new Promise<void>((resolve) => {
          if (!resolveFirstUpdate) {
            resolveFirstUpdate = resolve;
            return;
          }

          resolveSecondUpdate = resolve;
        })
    );
    mockApi = api;

    const view = render(
      <TestProviders>
        <GeneralSection />
      </TestProviders>
    );

    await waitFor(() => {
      expect(getSelectTrigger(view, "Worktree archive behavior").textContent).toContain(
        "Keep checkout"
      );
    });

    await chooseSelectOption(view, "Worktree archive behavior", "Delete checkout");

    await waitFor(() => {
      expect(updateCoderPrefsMock).toHaveBeenCalledTimes(1);
      expect(updateCoderPrefsMock).toHaveBeenNthCalledWith(1, {
        coderWorkspaceArchiveBehavior: DEFAULT_CODER_ARCHIVE_BEHAVIOR,
        worktreeArchiveBehavior: "delete",
      });
    });

    await chooseSelectOption(view, "Worktree archive behavior", "Snapshot and delete");
    expect(updateCoderPrefsMock).toHaveBeenCalledTimes(1);

    resolveFirstUpdate?.();

    await waitFor(() => {
      expect(updateCoderPrefsMock).toHaveBeenCalledTimes(2);
      expect(updateCoderPrefsMock).toHaveBeenNthCalledWith(2, {
        coderWorkspaceArchiveBehavior: DEFAULT_CODER_ARCHIVE_BEHAVIOR,
        worktreeArchiveBehavior: "snapshot",
      });
    });

    resolveSecondUpdate?.();
  });

  test("re-enables archive settings with defaults after config load errors", async () => {
    const { api, updateCoderPrefsMock } = createMockAPI({
      worktreeArchiveBehavior: DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
    });
    let rejectGetConfig: ((error?: unknown) => void) | undefined;
    api.config.getConfig = mock(
      () =>
        new Promise<MockConfig>((_resolve, reject) => {
          rejectGetConfig = reject;
        })
    );
    mockApi = api;

    const view = render(
      <TestProviders>
        <GeneralSection />
      </TestProviders>
    );

    await waitFor(() => {
      expect(rejectGetConfig).toBeDefined();
    });

    const trigger = getSelectTrigger(view, "Worktree archive behavior");
    expect(trigger.hasAttribute("disabled")).toBe(true);

    rejectGetConfig?.(new Error("config read failed"));

    await waitFor(() => {
      expect(trigger.hasAttribute("disabled")).toBe(false);
    });

    await chooseSelectOption(view, "Worktree archive behavior", "Delete checkout");

    await waitFor(() => {
      expect(updateCoderPrefsMock).toHaveBeenCalledWith({
        coderWorkspaceArchiveBehavior: DEFAULT_CODER_ARCHIVE_BEHAVIOR,
        worktreeArchiveBehavior: "delete",
      });
    });
  });

  test("disables archive settings until config finishes loading", async () => {
    const { api, getConfigMock, updateCoderPrefsMock } = createMockAPI({
      worktreeArchiveBehavior: DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
    });
    const loadedConfig = await getConfigMock();
    let resolveGetConfig: ((value: MockConfig) => void) | undefined;
    api.config.getConfig = mock(
      () =>
        new Promise<MockConfig>((resolve) => {
          resolveGetConfig = resolve;
        })
    );
    mockApi = api;

    const view = render(
      <TestProviders>
        <GeneralSection />
      </TestProviders>
    );

    await waitFor(() => {
      expect(resolveGetConfig).toBeDefined();
    });

    const trigger = getSelectTrigger(view, "Worktree archive behavior");
    expect(trigger.hasAttribute("disabled")).toBe(true);

    fireEvent.mouseDown(trigger);
    expect(updateCoderPrefsMock).not.toHaveBeenCalled();

    resolveGetConfig?.({
      ...loadedConfig,
      coderWorkspaceArchiveBehavior: "delete",
      worktreeArchiveBehavior: DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
    });

    await waitFor(() => {
      expect(updateCoderPrefsMock).not.toHaveBeenCalled();
      expect(trigger.hasAttribute("disabled")).toBe(false);
    });
  });
});

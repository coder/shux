import React from "react";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import * as ActualSelectPrimitiveModule from "@/browser/components/SelectPrimitive/SelectPrimitive";
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
  telemetryEnabled: boolean;
  telemetryDisabledByEnv: boolean;
}

interface MockAPIClient {
  config: {
    getConfig: () => Promise<MockConfig>;
    updateCoderPrefs: (input: {
      coderWorkspaceArchiveBehavior: CoderWorkspaceArchiveBehavior;
      worktreeArchiveBehavior: WorktreeArchiveBehavior;
    }) => Promise<void>;
    updateChatTranscriptFullWidth: (input: { enabled: boolean }) => Promise<void>;
    updateLlmDebugLogs: (input: { enabled: boolean }) => Promise<void>;
    updateTelemetryEnabled: (input: { enabled: boolean }) => Promise<void>;
    onConfigChanged?: (
      input: undefined,
      opts: { signal?: AbortSignal }
    ) => Promise<AsyncGenerator<unknown>>;
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

let mockApi: MockAPIClient | null;

void mock.module("@/browser/components/SelectPrimitive/SelectPrimitive", () => {
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
});

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: mockApi,
    status: "connected" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

import { GeneralSection } from "./GeneralSection";

interface RenderGeneralSectionOptions {
  coderWorkspaceArchiveBehavior?: CoderWorkspaceArchiveBehavior;
  worktreeArchiveBehavior?: WorktreeArchiveBehavior;
  chatTranscriptFullWidth?: boolean;
  telemetryEnabled?: boolean;
  telemetryDisabledByEnv?: boolean;
}

interface MockAPISetup {
  api: MockAPIClient;
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
  updateTelemetryEnabledMock: ReturnType<
    typeof mock<(input: { enabled: boolean }) => Promise<void>>
  >;
}

function createMockAPI(configOverrides: Partial<MockConfig> = {}): MockAPISetup {
  const config: MockConfig = {
    coderWorkspaceArchiveBehavior: DEFAULT_CODER_ARCHIVE_BEHAVIOR,
    worktreeArchiveBehavior: DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
    chatTranscriptFullWidth: false,
    llmDebugLogs: false,
    telemetryEnabled: true,
    telemetryDisabledByEnv: false,
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

  const updateTelemetryEnabledMock = mock(({ enabled }: { enabled: boolean }) => {
    config.telemetryEnabled = enabled;

    return Promise.resolve();
  });

  return {
    api: {
      config: {
        getConfig: getConfigMock,
        updateCoderPrefs: updateCoderPrefsMock,
        updateChatTranscriptFullWidth: updateChatTranscriptFullWidthMock,
        updateLlmDebugLogs: mock(({ enabled }: { enabled: boolean }) => {
          config.llmDebugLogs = enabled;

          return Promise.resolve();
        }),
        updateTelemetryEnabled: updateTelemetryEnabledMock,
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
    getConfigMock,
    updateCoderPrefsMock,
    updateChatTranscriptFullWidthMock,
    updateTelemetryEnabledMock,
  };
}

describe("GeneralSection", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
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

  function renderGeneralSection(options: RenderGeneralSectionOptions = {}) {
    const {
      api,
      updateCoderPrefsMock,
      updateChatTranscriptFullWidthMock,
      updateTelemetryEnabledMock,
    } = createMockAPI({
      chatTranscriptFullWidth: options.chatTranscriptFullWidth,
      coderWorkspaceArchiveBehavior: options.coderWorkspaceArchiveBehavior,
      worktreeArchiveBehavior: options.worktreeArchiveBehavior,
      ...(options.telemetryEnabled !== undefined
        ? { telemetryEnabled: options.telemetryEnabled }
        : {}),
      ...(options.telemetryDisabledByEnv !== undefined
        ? { telemetryDisabledByEnv: options.telemetryDisabledByEnv }
        : {}),
    });
    mockApi = api;

    const view = render(
      <ThemeProvider forcedTheme="dark">
        <GeneralSection />
      </ThemeProvider>
    );

    return {
      updateCoderPrefsMock,
      updateChatTranscriptFullWidthMock,
      updateTelemetryEnabledMock,
      view,
    };
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

  test("loads the telemetry opt-out and persists re-enabling it", async () => {
    const { updateTelemetryEnabledMock, view } = renderGeneralSection({
      telemetryEnabled: false,
    });

    const toggle = view.getByRole("switch", { name: "Toggle Usage Telemetry" });
    // A persisted opt-out must render unchecked (default is enabled).
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("false");
    });

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      expect(updateTelemetryEnabledMock).toHaveBeenCalledWith({ enabled: true });
    });
  });

  test("renders the telemetry switch hard-disabled when the environment overrides it", async () => {
    const { updateTelemetryEnabledMock, view } = renderGeneralSection({
      telemetryEnabled: true,
      telemetryDisabledByEnv: true,
    });

    const toggle = view.getByRole("switch", { name: "Toggle Usage Telemetry" });
    // Env override wins over the config value: switch shows off and cannot be flipped.
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      expect(toggle.hasAttribute("disabled")).toBe(true);
    });
    expect(view.getByText(/Disabled by the environment/i)).toBeTruthy();

    fireEvent.click(toggle);
    expect(updateTelemetryEnabledMock).not.toHaveBeenCalled();
  });

  test("reverts the telemetry switch when persisting the change fails", async () => {
    const { api, updateTelemetryEnabledMock } = createMockAPI({ telemetryEnabled: true });
    api.config.updateTelemetryEnabled = updateTelemetryEnabledMock.mockImplementation(() =>
      Promise.reject(new Error("write failed"))
    );
    mockApi = api;

    const view = render(
      <ThemeProvider forcedTheme="dark">
        <GeneralSection />
      </ThemeProvider>
    );

    const toggle = view.getByRole("switch", { name: "Toggle Usage Telemetry" });
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("true");
    });

    fireEvent.click(toggle);

    // A privacy control must not read "off" while the backend still collects:
    // the failed write reloads the backend truth (still enabled).
    await waitFor(() => {
      expect(updateTelemetryEnabledMock).toHaveBeenCalledWith({ enabled: false });
      expect(toggle.getAttribute("aria-checked")).toBe("true");
    });
  });

  test("syncs the telemetry switch when another client changes the config", async () => {
    const setup = createMockAPI({ telemetryEnabled: true });
    const { api } = setup;

    // Drivable config-change stream: pushEvent() delivers one notification.
    let pushEvent: (() => void) | undefined;
    api.config.onConfigChanged = (_input: undefined, _opts: { signal?: AbortSignal }) => {
      const generator = (async function* () {
        for (;;) {
          await new Promise<void>((resolve) => {
            pushEvent = resolve;
          });
          yield {};
        }
      })();
      return Promise.resolve(generator);
    };
    mockApi = api;

    const view = render(
      <ThemeProvider forcedTheme="dark">
        <GeneralSection />
      </ThemeProvider>
    );

    const toggle = view.getByRole("switch", { name: "Toggle Usage Telemetry" });
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      expect(pushEvent).toBeDefined();
    });

    // Another window persists an opt-out; this pane only learns via the stream.
    api.config.getConfig = mock(() =>
      Promise.resolve({
        coderWorkspaceArchiveBehavior: DEFAULT_CODER_ARCHIVE_BEHAVIOR,
        worktreeArchiveBehavior: DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
        chatTranscriptFullWidth: false,
        llmDebugLogs: false,
        telemetryEnabled: false,
        telemetryDisabledByEnv: false,
      })
    );
    pushEvent?.();

    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("false");
    });
  });

  test("re-syncs telemetry state for changes that land before the subscription connects", async () => {
    const setup = createMockAPI({ telemetryEnabled: true });
    const { api } = setup;

    // Hold the subscription unestablished so a config change can land in the
    // gap between the initial snapshot and the listener coming online.
    let resolveSubscribe: ((generator: AsyncGenerator<unknown>) => void) | undefined;
    api.config.onConfigChanged = (_input: undefined, _opts: { signal?: AbortSignal }) =>
      new Promise<AsyncGenerator<unknown>>((resolve) => {
        resolveSubscribe = resolve;
      });
    mockApi = api;

    const view = render(
      <ThemeProvider forcedTheme="dark">
        <GeneralSection />
      </ThemeProvider>
    );

    const toggle = view.getByRole("switch", { name: "Toggle Usage Telemetry" });
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      expect(resolveSubscribe).toBeDefined();
    });

    // Another client opts out while this pane has no listener yet.
    api.config.getConfig = mock(() =>
      Promise.resolve({
        coderWorkspaceArchiveBehavior: DEFAULT_CODER_ARCHIVE_BEHAVIOR,
        worktreeArchiveBehavior: DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
        chatTranscriptFullWidth: false,
        llmDebugLogs: false,
        telemetryEnabled: false,
        telemetryDisabledByEnv: false,
      })
    );

    // Connecting the subscription must trigger a re-sync — no event is ever
    // pushed for the change that already happened.
    resolveSubscribe?.(
      (async function* () {
        await new Promise<void>(() => {
          // Never yields; the post-connect refresh is what syncs.
        });
        yield {};
      })()
    );

    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("false");
    });
  });

  test("replays a config notification that arrived while a local write was in flight", async () => {
    const setup = createMockAPI({ telemetryEnabled: true });
    const { api, updateTelemetryEnabledMock } = setup;

    let pushEvent: (() => void) | undefined;
    api.config.onConfigChanged = (_input: undefined, _opts: { signal?: AbortSignal }) => {
      const generator = (async function* () {
        for (;;) {
          await new Promise<void>((resolve) => {
            pushEvent = resolve;
          });
          yield {};
        }
      })();
      return Promise.resolve(generator);
    };

    let resolveUpdate: (() => void) | undefined;
    api.config.updateTelemetryEnabled = updateTelemetryEnabledMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveUpdate = resolve;
        })
    );
    mockApi = api;

    const view = render(
      <ThemeProvider forcedTheme="dark">
        <GeneralSection />
      </ThemeProvider>
    );

    const toggle = view.getByRole("switch", { name: "Toggle Usage Telemetry" });
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      expect(pushEvent).toBeDefined();
    });

    // Local opt-out is in flight when another client re-enables telemetry.
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(resolveUpdate).toBeDefined();
    });
    api.config.getConfig = mock(() =>
      Promise.resolve({
        coderWorkspaceArchiveBehavior: DEFAULT_CODER_ARCHIVE_BEHAVIOR,
        worktreeArchiveBehavior: DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
        chatTranscriptFullWidth: false,
        llmDebugLogs: false,
        telemetryEnabled: true,
        telemetryDisabledByEnv: false,
      })
    );
    pushEvent?.();

    // The notification must not be dropped: once the write settles, the pane
    // reconciles against the shared config (the other client's enable won).
    resolveUpdate?.();
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("true");
    });
  });

  test("replays a deferred notification through the replacement API client", async () => {
    const setupA = createMockAPI({ telemetryEnabled: true });
    const apiA = setupA.api;

    let pushEventA: (() => void) | undefined;
    apiA.config.onConfigChanged = (_input: undefined, _opts: { signal?: AbortSignal }) => {
      const generator = (async function* () {
        for (;;) {
          await new Promise<void>((resolve) => {
            pushEventA = resolve;
          });
          yield {};
        }
      })();
      return Promise.resolve(generator);
    };

    let rejectWriteA: ((error: Error) => void) | undefined;
    apiA.config.updateTelemetryEnabled = setupA.updateTelemetryEnabledMock.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectWriteA = reject;
        })
    );
    mockApi = apiA;

    const view = render(
      <ThemeProvider forcedTheme="dark">
        <GeneralSection />
      </ThemeProvider>
    );

    const toggle = view.getByRole("switch", { name: "Toggle Usage Telemetry" });
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      expect(pushEventA).toBeDefined();
    });

    // Local opt-out in flight on client A; a change notification arrives and
    // is deferred behind the pending write.
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(rejectWriteA).toBeDefined();
    });
    pushEventA?.();

    // APIProvider replaces the client while the old write is still pending.
    // The replacement's config says telemetry is enabled (the other client's
    // enable won).
    const setupB = createMockAPI({ telemetryEnabled: true });
    mockApi = setupB.api;
    view.rerender(
      <ThemeProvider forcedTheme="dark">
        <GeneralSection />
      </ThemeProvider>
    );

    // The old write settles AFTER the replacement: the deferred notification
    // must replay through client B, not the disconnected client A.
    rejectWriteA?.(new Error("connection dropped"));

    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("true");
    });
  });

  test("disables the telemetry switch while the API is unavailable", () => {
    // Browser-mode outage: APIProvider keeps settings mounted with api: null.
    mockApi = null;

    const view = render(
      <ThemeProvider forcedTheme="dark">
        <GeneralSection />
      </ThemeProvider>
    );

    const toggle = view.getByRole("switch", { name: "Toggle Usage Telemetry" });
    // A privacy toggle must not accept a change it cannot deliver: the switch
    // is disabled and a click leaves the conservative ON state untouched.
    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  test("renders the telemetry switch ON when backend truth is unreachable after a failed write", async () => {
    const { api, updateTelemetryEnabledMock } = createMockAPI({ telemetryEnabled: true });
    api.config.updateTelemetryEnabled = updateTelemetryEnabledMock.mockImplementation(() =>
      Promise.reject(new Error("connection dropped"))
    );
    mockApi = api;

    const view = render(
      <ThemeProvider forcedTheme="dark">
        <GeneralSection />
      </ThemeProvider>
    );

    const toggle = view.getByRole("switch", { name: "Toggle Usage Telemetry" });
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("true");
    });

    // After the initial load, make the reconciliation getConfig fail too, so
    // the disable attempt ends with no confirmed backend state.
    api.config.getConfig = mock(() => Promise.reject(new Error("connection dropped")));

    fireEvent.click(toggle);

    // Indeterminate outcome must render ON: the disable may not have landed,
    // and a privacy switch must not read "off" while collection may continue.
    await waitFor(() => {
      expect(updateTelemetryEnabledMock).toHaveBeenCalledWith({ enabled: false });
      expect(toggle.getAttribute("aria-checked")).toBe("true");
    });
  });

  test("a superseded telemetry write failure does not clobber the latest choice", async () => {
    const { api, updateTelemetryEnabledMock } = createMockAPI({ telemetryEnabled: false });
    const deferred: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    api.config.updateTelemetryEnabled = updateTelemetryEnabledMock.mockImplementation(
      () =>
        new Promise<void>((resolve, reject) => {
          deferred.push({ resolve, reject });
        })
    );
    mockApi = api;

    const view = render(
      <ThemeProvider forcedTheme="dark">
        <GeneralSection />
      </ThemeProvider>
    );

    const toggle = view.getByRole("switch", { name: "Toggle Usage Telemetry" });
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("false");
    });

    // Rapid on → off → on; writes are serialized so only the first is in flight.
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await waitFor(() => {
      expect(deferred.length).toBe(1);
    });

    // The first write fails only after later intents were queued: its failure
    // handling is superseded and must not touch the switch.
    deferred[0].reject(new Error("write failed"));

    await waitFor(() => {
      expect(deferred.length).toBe(2);
    });
    deferred[1].resolve();
    await waitFor(() => {
      expect(deferred.length).toBe(3);
    });
    deferred[2].resolve();

    await waitFor(() => {
      expect(updateTelemetryEnabledMock).toHaveBeenCalledTimes(3);
      expect(updateTelemetryEnabledMock).toHaveBeenLastCalledWith({ enabled: true });
      expect(toggle.getAttribute("aria-checked")).toBe("true");
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
      <ThemeProvider forcedTheme="dark">
        <GeneralSection />
      </ThemeProvider>
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
      <ThemeProvider forcedTheme="dark">
        <GeneralSection />
      </ThemeProvider>
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
      <ThemeProvider forcedTheme="dark">
        <GeneralSection />
      </ThemeProvider>
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

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import * as ActualAPIModule from "@/browser/contexts/API";
import * as ActualExperimentsModule from "@/browser/contexts/ExperimentsContext";
import * as ActualTelemetryModule from "@/browser/hooks/useTelemetry";

// Snapshot values, not Bun's live module namespaces, before installing overrides.
const actualAPI = { ...ActualAPIModule };
const actualExperiments = { ...ActualExperimentsModule };
const actualTelemetry = { ...ActualTelemetryModule };

afterAll(() => {
  void mock.module("@/browser/contexts/API", () => actualAPI);
  void mock.module("@/browser/contexts/ExperimentsContext", () => actualExperiments);
  void mock.module("@/browser/hooks/useTelemetry", () => actualTelemetry);
});

type PrereqStatus =
  | { available: true }
  | { available: false; reason: "binary_not_found" | "unsupported_platform" | "startup_failed" };

interface MockApiClient {
  desktop: {
    getPrereqStatus: () => Promise<PrereqStatus>;
  };
  general: {
    restartApp: () => Promise<{ supported: true } | { supported: false; message: string }>;
  };
  config?: {
    getConfig: () => Promise<{
      goalDefaults?: unknown;
      heartbeatDefaultPrompt?: string;
      heartbeatDefaultIntervalMs?: number;
    }>;
    updateGoalDefaults: (input: { goalDefaults: unknown }) => Promise<void>;
    updateHeartbeatDefaultPrompt: (input: { defaultPrompt?: string | null }) => Promise<void>;
    updateHeartbeatDefaultIntervalMs: (input: { intervalMs?: number | null }) => Promise<void>;
  };
  server?: {
    setApiServerSettings: (input: {
      bindHost: string | null;
      port: number | null;
      serveWebUi: boolean | null;
    }) => Promise<unknown>;
    getApiServerStatus: () => Promise<unknown>;
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let mockApi: MockApiClient;
let experimentEnabled = false;
let experimentValues: Record<string, boolean> = {};

void mock.module("@/browser/contexts/API", () => ({
  ...actualAPI,
  useAPI: () => ({
    api: mockApi,
    status: "connected" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

void mock.module("@/browser/contexts/ExperimentsContext", () => ({
  ...actualExperiments,
  useExperiment: (experimentId: string) => [
    experimentValues[experimentId] ?? experimentEnabled,
    (enabled: boolean) => {
      experimentValues[experimentId] = enabled;
    },
  ],
  useExperimentValue: (experimentId: string) => experimentValues[experimentId] ?? experimentEnabled,
}));

void mock.module("@/browser/hooks/useTelemetry", () => ({
  ...actualTelemetry,
  useTelemetry: () => ({
    experimentOverridden: mock(() => undefined),
  }),
}));

import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { ExperimentsSection, PortableDesktopExperimentWarning } from "./ExperimentsSection";

let originalWindow: typeof globalThis.window;
let originalDocument: typeof globalThis.document;
let originalLocalStorage: typeof globalThis.localStorage;
let originalLocation: typeof globalThis.location;
let originalStorageEvent: typeof globalThis.StorageEvent;
let originalCustomEvent: typeof globalThis.CustomEvent;
let originalSetTimeout: typeof globalThis.setTimeout;
let originalClearTimeout: typeof globalThis.clearTimeout;
let originalSetInterval: typeof globalThis.setInterval;
let originalClearInterval: typeof globalThis.clearInterval;

function renderWarning() {
  return render(<PortableDesktopExperimentWarning />);
}

describe("PortableDesktopExperimentWarning", () => {
  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalLocalStorage = globalThis.localStorage;
    originalLocation = globalThis.location;
    originalStorageEvent = globalThis.StorageEvent;
    originalCustomEvent = globalThis.CustomEvent;
    originalSetTimeout = globalThis.setTimeout;
    originalClearTimeout = globalThis.clearTimeout;
    originalSetInterval = globalThis.setInterval;
    originalClearInterval = globalThis.clearInterval;

    const dom = new GlobalWindow({ url: "https://example.com/settings/experiments" });
    globalThis.window = dom as unknown as Window & typeof globalThis;
    globalThis.document = dom.document as unknown as Document;
    globalThis.localStorage = dom.localStorage;
    globalThis.location = dom.location as unknown as Location;
    globalThis.StorageEvent = dom.StorageEvent as unknown as typeof StorageEvent;
    globalThis.CustomEvent = dom.CustomEvent as unknown as typeof CustomEvent;
    globalThis.setTimeout = dom.setTimeout.bind(dom) as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = dom.clearTimeout.bind(
      dom
    ) as unknown as typeof globalThis.clearTimeout;
    globalThis.setInterval = dom.setInterval.bind(dom) as unknown as typeof globalThis.setInterval;
    globalThis.clearInterval = dom.clearInterval.bind(
      dom
    ) as unknown as typeof globalThis.clearInterval;

    globalThis.window.api = { platform: "linux", versions: {} };
    experimentEnabled = true;
    experimentValues = {};
    mockApi = {
      desktop: {
        getPrereqStatus: mock(() => Promise.resolve({ available: true as const })),
      },
      general: {
        restartApp: mock(() => Promise.resolve({ supported: true as const })),
      },
      config: {
        getConfig: mock(() => Promise.resolve({})),
        updateGoalDefaults: mock(() => Promise.resolve()),
        updateHeartbeatDefaultPrompt: mock(() => Promise.resolve()),
        updateHeartbeatDefaultIntervalMs: mock(() => Promise.resolve()),
      },
      server: {
        setApiServerSettings: mock(() => Promise.resolve({})),
        getApiServerStatus: mock(() =>
          Promise.resolve({
            running: false,
            baseUrl: null,
            token: null,
            networkBaseUrls: [],
            configuredBindHost: null,
            configuredServeWebUi: false,
            configuredPort: null,
          })
        ),
      },
    };
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
    globalThis.location = originalLocation;
    globalThis.StorageEvent = originalStorageEvent;
    globalThis.CustomEvent = originalCustomEvent;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });

  test.each([false, true])(
    "hides compaction switches even when their stored flags are %s",
    (enabled) => {
      experimentEnabled = false;
      experimentValues = {
        [EXPERIMENT_IDS.CONTINUOUS_COMPACTION]: enabled,
        [EXPERIMENT_IDS.TOKEN_BUDGET]: enabled,
      };
      const view = render(<ExperimentsSection />);
      expect(view.queryByLabelText("Toggle Continuous Compaction")).toBeNull();
      expect(view.queryByLabelText("Toggle Token-budget context windows")).toBeNull();
      for (const name of [
        "Programmatic Tool Calling",
        "Agent Memory",
        "Multi-project workspaces",
        "Workspace Heartbeats",
      ]) {
        expect(view.getByRole("switch", { name: `Toggle ${name}` })).toBeTruthy();
      }
      expect(experimentValues).toEqual({
        [EXPERIMENT_IDS.CONTINUOUS_COMPACTION]: enabled,
        [EXPERIMENT_IDS.TOKEN_BUDGET]: enabled,
      });
    }
  );

  test("shows heartbeat defaults inline only when its experiment is enabled", async () => {
    // Goal defaults moved out of ExperimentsSection into the Goal tab
    // (`GoalDefaultsSection`); goals graduated to GA so it is no longer
    // shown here at all. Heartbeat defaults remain inline here for now.
    experimentEnabled = false;
    experimentValues = {
      [EXPERIMENT_IDS.WORKSPACE_HEARTBEATS]: false,
    };

    const view = render(<ExperimentsSection />);

    expect(view.queryByLabelText("Default goal budget in dollars")).toBeNull();
    expect(view.queryByLabelText("Default heartbeat threshold in minutes")).toBeNull();

    experimentValues = {
      [EXPERIMENT_IDS.WORKSPACE_HEARTBEATS]: true,
    };
    view.rerender(<ExperimentsSection />);

    await waitFor(() => {
      expect(view.getByLabelText("Default heartbeat threshold in minutes")).toBeTruthy();
    });
    // Goal defaults are no longer rendered in the Experiments panel —
    // they live in the Goal tab now.
    expect(view.queryByLabelText("Default goal budget in dollars")).toBeNull();
  });

  test("hides Memory Intuition when Agent Memory is off without clearing its toggle", () => {
    experimentEnabled = false;
    experimentValues = {
      [EXPERIMENT_IDS.MEMORY]: false,
      [EXPERIMENT_IDS.MEMORY_INTUITION]: true,
    };
    const view = render(<ExperimentsSection />);
    expect(view.queryByLabelText("Toggle Memory Intuition")).toBeNull();

    fireEvent.click(view.getByLabelText("Toggle Agent Memory"));
    view.rerender(<ExperimentsSection />);
    expect(view.getByLabelText("Toggle Memory Intuition").getAttribute("aria-checked")).toBe(
      "true"
    );

    fireEvent.click(view.getByLabelText("Toggle Agent Memory"));
    view.rerender(<ExperimentsSection />);
    expect(view.queryByLabelText("Toggle Memory Intuition")).toBeNull();
    expect(experimentValues[EXPERIMENT_IDS.MEMORY_INTUITION]).toBe(true);
  });

  test("shows RLM Mode nested under Programmatic Tool Calling only when PTC is enabled", () => {
    experimentEnabled = false;
    experimentValues = {
      [EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING]: false,
    };

    const view = render(<ExperimentsSection />);

    // Hidden from the flat list and no nested panel while the parent is off.
    expect(view.queryByLabelText("Toggle RLM Mode")).toBeNull();

    experimentValues = {
      [EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING]: true,
    };
    view.rerender(<ExperimentsSection />);

    expect(view.getByLabelText("Toggle RLM Mode")).toBeTruthy();
  });

  test("reloads experiment settings when inline controls remount", async () => {
    // Only the heartbeat panel still triggers an inline `getConfig`.
    experimentEnabled = false;
    experimentValues = {
      [EXPERIMENT_IDS.WORKSPACE_HEARTBEATS]: true,
    };

    const view = render(<ExperimentsSection />);

    await waitFor(() => {
      expect(view.getByLabelText("Default heartbeat threshold in minutes")).toBeTruthy();
    });
    expect(mockApi.config?.getConfig).toHaveBeenCalledTimes(1);

    experimentValues = {
      [EXPERIMENT_IDS.WORKSPACE_HEARTBEATS]: false,
    };
    view.rerender(<ExperimentsSection />);

    expect(view.queryByLabelText("Default heartbeat threshold in minutes")).toBeNull();

    experimentValues = {
      [EXPERIMENT_IDS.WORKSPACE_HEARTBEATS]: true,
    };
    view.rerender(<ExperimentsSection />);

    await waitFor(() => {
      expect(mockApi.config?.getConfig).toHaveBeenCalledTimes(2);
    });
  });

  test("starts a fresh settings load when the API client changes", async () => {
    experimentEnabled = false;
    experimentValues = {
      [EXPERIMENT_IDS.WORKSPACE_HEARTBEATS]: true,
    };

    const staleConfig = createDeferred<{
      goalDefaults?: unknown;
      heartbeatDefaultPrompt?: string;
      heartbeatDefaultIntervalMs?: number;
    }>();
    const staleGetConfig = mock(() => staleConfig.promise);
    mockApi = {
      ...mockApi,
      config: {
        getConfig: staleGetConfig,
        updateGoalDefaults: mock(() => Promise.resolve()),
        updateHeartbeatDefaultPrompt: mock(() => Promise.resolve()),
        updateHeartbeatDefaultIntervalMs: mock(() => Promise.resolve()),
      },
    };

    const view = render(<ExperimentsSection />);

    await waitFor(() => {
      expect(staleGetConfig).toHaveBeenCalledTimes(1);
    });

    const freshConfig = createDeferred<{
      goalDefaults?: unknown;
      heartbeatDefaultPrompt?: string;
      heartbeatDefaultIntervalMs?: number;
    }>();
    const freshGetConfig = mock(() => freshConfig.promise);
    mockApi = {
      ...mockApi,
      config: {
        getConfig: freshGetConfig,
        updateGoalDefaults: mock(() => Promise.resolve()),
        updateHeartbeatDefaultPrompt: mock(() => Promise.resolve()),
        updateHeartbeatDefaultIntervalMs: mock(() => Promise.resolve()),
      },
    };

    view.rerender(<ExperimentsSection />);

    await waitFor(() => {
      expect(freshGetConfig).toHaveBeenCalledTimes(1);
    });
  });

  test("loads prereq status on mount and shows the missing-binary warning when needed", async () => {
    const getPrereqStatus = mock(() =>
      Promise.resolve({ available: false as const, reason: "binary_not_found" as const })
    );
    mockApi = {
      desktop: { getPrereqStatus },
      general: {
        restartApp: mock(() => Promise.resolve({ supported: true as const })),
      },
    };

    const view = renderWarning();

    await waitFor(() => {
      expect(getPrereqStatus).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(view.container.textContent).toContain("Portable Desktop is currently disabled");
    });
  });

  test("clicking Check again re-runs the prereq lookup and hides the warning after recovery", async () => {
    let callCount = 0;
    const getPrereqStatus = mock(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve({ available: false as const, reason: "binary_not_found" as const });
      }

      return Promise.resolve({ available: true as const });
    });
    mockApi = {
      desktop: { getPrereqStatus },
      general: {
        restartApp: mock(() => Promise.resolve({ supported: true as const })),
      },
    };

    const view = renderWarning();

    await waitFor(() => {
      expect(view.container.textContent).toContain("Portable Desktop is currently disabled");
    });

    fireEvent.click(view.getByRole("button", { name: "Check again" }));

    await waitFor(() => {
      expect(getPrereqStatus).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(view.container.textContent).not.toContain("Portable Desktop is currently disabled");
    });
  });

  test("ignores stale Check again responses when a newer lookup finishes later", async () => {
    const staleRequest = createDeferred<PrereqStatus>();
    const freshRequest = createDeferred<PrereqStatus>();
    let callCount = 0;
    const getPrereqStatus = mock(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve({ available: false as const, reason: "binary_not_found" as const });
      }
      if (callCount === 2) {
        return staleRequest.promise;
      }
      if (callCount === 3) {
        return freshRequest.promise;
      }
      return Promise.resolve({ available: true as const });
    });
    mockApi = {
      desktop: { getPrereqStatus },
      general: {
        restartApp: mock(() => Promise.resolve({ supported: true as const })),
      },
    };

    const view = renderWarning();

    await waitFor(() => {
      expect(view.container.textContent).toContain("Portable Desktop is currently disabled");
    });

    const checkAgainButton = view.getByRole("button", { name: "Check again" });
    fireEvent.click(checkAgainButton);
    fireEvent.click(checkAgainButton);

    await waitFor(() => {
      expect(getPrereqStatus).toHaveBeenCalledTimes(3);
    });

    await act(async () => {
      freshRequest.resolve({ available: true as const });
      await freshRequest.promise;
    });

    await waitFor(() => {
      expect(view.container.textContent).not.toContain("Portable Desktop is currently disabled");
    });

    await act(async () => {
      staleRequest.resolve({ available: false as const, reason: "binary_not_found" as const });
      await staleRequest.promise;
    });

    expect(view.container.textContent).not.toContain("Portable Desktop is currently disabled");
  });

  test("keeps the restart path available when re-check still reports a missing binary", async () => {
    const getPrereqStatus = mock(() =>
      Promise.resolve({ available: false as const, reason: "binary_not_found" as const })
    );
    const restartApp = mock(() => Promise.resolve({ supported: true as const }));
    mockApi = {
      desktop: { getPrereqStatus },
      general: { restartApp },
    };

    const view = renderWarning();

    await waitFor(() => {
      expect(view.container.textContent).toContain("Portable Desktop is currently disabled");
    });

    fireEvent.click(view.getByRole("button", { name: "Check again" }));

    await waitFor(() => {
      expect(getPrereqStatus).toHaveBeenCalledTimes(2);
    });
    expect(view.getByRole("button", { name: "Restart Xum" })).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Restart Xum" }));

    await waitFor(() => {
      expect(restartApp).toHaveBeenCalledTimes(1);
    });
  });

  test("shows a graceful message when restart is unavailable in this runtime", async () => {
    const getPrereqStatus = mock(() =>
      Promise.resolve({ available: false as const, reason: "binary_not_found" as const })
    );
    const restartApp = mock(() =>
      Promise.resolve({
        supported: false as const,
        message: "Restart is only available in the desktop app.",
      })
    );
    mockApi = {
      desktop: { getPrereqStatus },
      general: { restartApp },
    };

    const view = renderWarning();

    await waitFor(() => {
      expect(view.container.textContent).toContain("Portable Desktop is currently disabled");
    });

    fireEvent.click(view.getByRole("button", { name: "Restart Xum" }));

    await waitFor(() => {
      expect(view.container.textContent).toContain("Restart is only available in the desktop app.");
    });
  });

  test("keeps the warning hidden when Portable Desktop prerequisites are available", async () => {
    const getPrereqStatus = mock(() => Promise.resolve({ available: true as const }));
    mockApi = {
      desktop: { getPrereqStatus },
      general: {
        restartApp: mock(() => Promise.resolve({ supported: true as const })),
      },
    };

    const view = renderWarning();

    await waitFor(() => {
      expect(getPrereqStatus).toHaveBeenCalledTimes(1);
    });
    expect(view.container.textContent).not.toContain("Portable Desktop is currently disabled");
  });
});

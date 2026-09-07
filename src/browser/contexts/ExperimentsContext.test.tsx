import { wrapAsyncIterator } from "@orpc/shared";
import { createAsyncMessageQueue } from "@/common/utils/asyncMessageQueue";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalWindow } from "happy-dom";
import {
  EXPERIMENT_IDS,
  getExperimentKey,
  getLegacyPtcExclusiveExperimentKey,
} from "@/common/constants/experiments";
import { requireTestModule, type RecursivePartial } from "@/browser/testUtils";
import type * as APIModule from "./API";
import type { APIClient } from "./API";
import type * as ExperimentsContextModule from "./ExperimentsContext";

// Keep the API client local to each render so this suite does not leak a process-global
// mock.module override into ProjectContext and other later context tests.
let currentClientMock: RecursivePartial<APIClient> = {};

let APIProvider!: typeof APIModule.APIProvider;
let ExperimentsProvider!: typeof ExperimentsContextModule.ExperimentsProvider;
let useExperiment!: typeof ExperimentsContextModule.useExperiment;
let useExperimentValue!: typeof ExperimentsContextModule.useExperimentValue;
let isolatedModuleDir: string | null = null;

const contextsDir = dirname(fileURLToPath(import.meta.url));

// Import unique temp copies of the real modules so leaked Bun mock.module registrations and
// module cache entries from earlier suites cannot replace the API/Experiments implementations.
async function importIsolatedExperimentModules() {
  const isolatedModulesRoot = join(process.cwd(), ".tmp");
  await mkdir(isolatedModulesRoot, { recursive: true });
  const tempDir = await mkdtemp(join(isolatedModulesRoot, "experiments-context-test-"));
  const isolatedApiPath = join(tempDir, "API.real.tsx");
  const isolatedExperimentsPath = join(tempDir, "ExperimentsContext.real.tsx");

  await copyFile(join(contextsDir, "API.tsx"), isolatedApiPath);

  const experimentsSource = await readFile(join(contextsDir, "ExperimentsContext.tsx"), "utf8");
  const isolatedExperimentsSource = experimentsSource.replace(
    'from "@/browser/contexts/API";',
    'from "./API.real.tsx";'
  );

  if (isolatedExperimentsSource === experimentsSource) {
    throw new Error("Failed to rewrite ExperimentsContext API import for the isolated test copy");
  }

  await writeFile(isolatedExperimentsPath, isolatedExperimentsSource);

  ({ APIProvider } = requireTestModule<{ APIProvider: typeof APIModule.APIProvider }>(
    isolatedApiPath
  ));
  ({ ExperimentsProvider, useExperiment, useExperimentValue } = requireTestModule<{
    ExperimentsProvider: typeof ExperimentsContextModule.ExperimentsProvider;
    useExperiment: typeof ExperimentsContextModule.useExperiment;
    useExperimentValue: typeof ExperimentsContextModule.useExperimentValue;
  }>(isolatedExperimentsPath));

  return tempDir;
}

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

describe("ExperimentsProvider", () => {
  beforeEach(async () => {
    isolatedModuleDir = await importIsolatedExperimentModules();

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

    const dom = new GlobalWindow({ url: "https://example.com/" });
    globalThis.window = dom as unknown as Window & typeof globalThis;
    globalThis.document = dom.document as unknown as Document;

    // Broader browser runs can leave bare globals, event constructors, and timer functions pointed
    // at stale or fake implementations from earlier suites. Rebind the globals
    // ExperimentsProvider reaches through indirectly so each case runs against the fresh
    // happy-dom window installed for it.
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
    globalThis.localStorage.clear();
  });

  afterEach(async () => {
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
    currentClientMock = {};

    if (isolatedModuleDir) {
      await rm(isolatedModuleDir, { recursive: true, force: true });
      isolatedModuleDir = null;
    }
  });

  test.each([true, false])(
    "Design disable waits for backend acknowledgement (success=%s)",
    async (success) => {
      let backendEnabled = true;
      const updates = createAsyncMessageQueue<{ enabled: boolean; revision: number }>();
      updates.push({ enabled: true, revision: 0 });
      let finish!: () => void;
      let reject!: (error: Error) => void;
      const pending = new Promise<void>((resolve, fail) => {
        finish = () => {
          backendEnabled = false;
          updates.push({ enabled: false, revision: 1 });
          resolve();
        };
        reject = fail;
      });
      const setOverride = mock(() => pending);
      currentClientMock = {
        experiments: {
          onDesignChange: (_input, { signal } = {}) => {
            signal?.addEventListener("abort", updates.end, { once: true });
            return Promise.resolve(wrapAsyncIterator(updates.iterate(), {}));
          },
          getOverrides: () =>
            Promise.resolve({ [EXPERIMENT_IDS.CLAUDE_DESIGN_MCP]: backendEnabled }),
          setOverride,
        },
      };
      function Toggle() {
        const [enabled, setEnabled] = useExperiment(EXPERIMENT_IDS.CLAUDE_DESIGN_MCP);
        return <button onClick={() => setEnabled(false)}>{String(enabled)}</button>;
      }
      const view = render(
        <APIProvider client={currentClientMock as APIClient}>
          <ExperimentsProvider>
            <Toggle />
          </ExperimentsProvider>
        </APIProvider>
      );
      await waitFor(() => expect(view.getByRole("button").textContent).toBe("true"));
      fireEvent.click(view.getByRole("button"));
      expect(setOverride).toHaveBeenCalledTimes(1);
      expect(view.getByRole("button").textContent).toBe("true");
      expect(
        window.localStorage.getItem(getExperimentKey(EXPERIMENT_IDS.CLAUDE_DESIGN_MCP))
      ).toBeNull();
      await act(async () => {
        if (success) finish();
        else reject(new Error("offline"));
        await pending.catch(() => undefined);
      });
      expect(view.getByRole("button").textContent).toBe(String(!success));
    }
  );

  test("ordered Design updates win over delayed reads, toggle acknowledgements, and old revisions", async () => {
    const updates = createAsyncMessageQueue<{ enabled: boolean; revision: number }>();
    updates.push({ enabled: true, revision: 1 });
    let acknowledge!: () => void;
    const setOverride = mock(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        })
    );
    let finishRead!: () => void;
    const getOverrides = mock(
      () =>
        new Promise<{ "claude-design-mcp": boolean }>((resolve) => {
          finishRead = () => resolve({ "claude-design-mcp": false });
        })
    );
    currentClientMock = {
      experiments: {
        setOverride,
        getOverrides,
        onDesignChange: (_input, { signal } = {}) => {
          signal?.addEventListener("abort", updates.end, { once: true });
          return Promise.resolve(wrapAsyncIterator(updates.iterate(), {}));
        },
      },
    };
    function Toggle() {
      const [enabled, setEnabled] = useExperiment(EXPERIMENT_IDS.CLAUDE_DESIGN_MCP);
      return <button onClick={() => setEnabled(false)}>{String(enabled)}</button>;
    }
    const view = render(
      <APIProvider client={currentClientMock as APIClient}>
        <ExperimentsProvider>
          <Toggle />
        </ExperimentsProvider>
      </APIProvider>
    );
    await waitFor(() => expect(view.getByRole("button").textContent).toBe("true"));
    fireEvent.click(view.getByRole("button"));
    await act(async () => {
      updates.push({ enabled: false, revision: 2 });
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByRole("button").textContent).toBe("false"));
    await act(async () => {
      updates.push({ enabled: true, revision: 3 });
      updates.push({ enabled: false, revision: 2 });
      finishRead();
      acknowledge();
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByRole("button").textContent).toBe("true"));
    expect(getOverrides).toHaveBeenCalledTimes(1);
  });

  test("stale local Design enablement is neither uploaded nor displayed on reconnect", async () => {
    window.localStorage.setItem(getExperimentKey(EXPERIMENT_IDS.CLAUDE_DESIGN_MCP), "true");
    const setOverride = mock(() => Promise.resolve());
    currentClientMock = {
      experiments: {
        setOverride,
        getOverrides: () => Promise.resolve({ [EXPERIMENT_IDS.CLAUDE_DESIGN_MCP]: false }),
      },
    };
    function Observer() {
      return <div>{String(useExperimentValue(EXPERIMENT_IDS.CLAUDE_DESIGN_MCP))}</div>;
    }
    const view = render(
      <APIProvider client={currentClientMock as APIClient}>
        <ExperimentsProvider>
          <Observer />
        </ExperimentsProvider>
      </APIProvider>
    );
    await waitFor(() => expect(view.getByText("false")).toBeDefined());
    expect(setOverride).not.toHaveBeenCalled();
  });

  test("syncs existing local overrides to the backend on connect", async () => {
    globalThis.window.localStorage.setItem(
      getExperimentKey(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES),
      JSON.stringify(true)
    );

    const setOverrideMock = mock(() => Promise.resolve());
    currentClientMock = {
      experiments: {
        setOverride: setOverrideMock,
        getOverrides: mock(() => Promise.resolve({})),
      },
    };

    render(
      <APIProvider client={currentClientMock as APIClient}>
        <ExperimentsProvider>
          <div />
        </ExperimentsProvider>
      </APIProvider>
    );

    await waitFor(() => {
      expect(setOverrideMock).toHaveBeenCalledWith({
        experimentId: EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES,
        enabled: true,
      });
    });
  });

  test("adopts a backend override when this client has no local state, and clears nothing", async () => {
    const setOverrideMock = mock(() => Promise.resolve());
    currentClientMock = {
      experiments: {
        setOverride: setOverrideMock,
        getOverrides: mock(() =>
          Promise.resolve({ [EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES]: true })
        ),
      },
    };

    function Observer() {
      const enabled = useExperimentValue(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES);
      return <div data-testid="enabled">{String(enabled)}</div>;
    }

    const { getByTestId } = render(
      <APIProvider client={currentClientMock as APIClient}>
        <ExperimentsProvider>
          <Observer />
        </ExperimentsProvider>
      </APIProvider>
    );

    await waitFor(() => {
      expect(getByTestId("enabled").textContent).toBe("true");
    });

    expect(setOverrideMock).not.toHaveBeenCalled();
  });

  test("returns false for a platform-restricted experiment on unsupported platforms", () => {
    const windowApi: WindowApi = { platform: "darwin", versions: {} };
    globalThis.window.api = windowApi;
    globalThis.window.localStorage.setItem(
      getExperimentKey(EXPERIMENT_IDS.PORTABLE_DESKTOP),
      JSON.stringify(true)
    );

    function Observer() {
      const enabled = useExperimentValue(EXPERIMENT_IDS.PORTABLE_DESKTOP);
      return <div data-testid="enabled">{String(enabled)}</div>;
    }

    const { getByTestId } = render(
      <APIProvider client={currentClientMock as APIClient}>
        <ExperimentsProvider>
          <Observer />
        </ExperimentsProvider>
      </APIProvider>
    );

    expect(getByTestId("enabled").textContent).toBe("false");
  });

  test("persists backend overrides when a user toggles an experiment", async () => {
    const setOverrideMock = mock(() => Promise.resolve());
    currentClientMock = {
      experiments: {
        setOverride: setOverrideMock,
        getOverrides: mock(() => Promise.resolve({})),
      },
    };

    function Toggle() {
      const [enabled, setEnabled] = useExperiment(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES);
      return (
        <button data-testid="toggle" onClick={() => setEnabled(!enabled)}>
          {String(enabled)}
        </button>
      );
    }

    const { getByTestId } = render(
      <APIProvider client={currentClientMock as APIClient}>
        <ExperimentsProvider>
          <Toggle />
        </ExperimentsProvider>
      </APIProvider>
    );

    fireEvent.click(getByTestId("toggle"));

    await waitFor(() => {
      expect(setOverrideMock).toHaveBeenCalledWith({
        experimentId: EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES,
        enabled: true,
      });
      expect(getByTestId("toggle").textContent).toBe("true");
    });
  });

  test("initialization stamps the legacy mirror over a stale explicit false", async () => {
    // An old renderer can leave ptc:true beside a stale legacy exclusive
    // `false`; upgrading without touching the toggle previously never rewrote
    // the mirror, and a downgraded renderer treats the stale explicit key as
    // an override that wins over the backend flag — resuming the removed
    // supplement posture (r33). Initialization reconciles it.
    currentClientMock = {
      experiments: {
        setOverride: mock(() => Promise.resolve()),
        getOverrides: mock(() => Promise.resolve({})),
      },
    };

    globalThis.window.localStorage.setItem(
      getExperimentKey(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING),
      JSON.stringify(true)
    );
    globalThis.window.localStorage.setItem(
      getLegacyPtcExclusiveExperimentKey(),
      JSON.stringify(false)
    );

    function Probe() {
      const enabled = useExperimentValue(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING);
      return <div data-testid="probe">{String(enabled)}</div>;
    }

    const { getByTestId } = render(
      <APIProvider client={currentClientMock as APIClient}>
        <ExperimentsProvider>
          <Probe />
        </ExperimentsProvider>
      </APIProvider>
    );

    expect(getByTestId("probe").textContent).toBe("true");
    await waitFor(() => {
      expect(globalThis.window.localStorage.getItem(getLegacyPtcExclusiveExperimentKey())).toBe(
        "true"
      );
    });
  });

  test("stale legacy exclusive true reads as PTC on, and toggling PTC rewrites the legacy key", async () => {
    currentClientMock = {
      experiments: {
        setOverride: mock(() => Promise.resolve()),
        getOverrides: mock(() => Promise.resolve({})),
      },
    };

    // Pre-merge state: "PTC Exclusive Mode" enabled — exactly the posture
    // merged PTC activates, so the upgrade must keep PTC on.
    globalThis.window.localStorage.setItem(
      getLegacyPtcExclusiveExperimentKey(),
      JSON.stringify(true)
    );

    function Toggle() {
      const [enabled, setEnabled] = useExperiment(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING);
      return (
        <button data-testid="toggle" onClick={() => setEnabled(!enabled)}>
          {String(enabled)}
        </button>
      );
    }

    const { getByTestId } = render(
      <APIProvider client={currentClientMock as APIClient}>
        <ExperimentsProvider>
          <Toggle />
        </ExperimentsProvider>
      </APIProvider>
    );

    expect(getByTestId("toggle").textContent).toBe("true");

    // Toggling PTC off must rewrite the legacy key too: a downgraded renderer
    // treats it as an explicit override that wins over the mirrored backend
    // value, so a stale entry would resurrect the pre-merge posture.
    fireEvent.click(getByTestId("toggle"));
    await waitFor(() => {
      expect(getByTestId("toggle").textContent).toBe("false");
    });
    expect(globalThis.window.localStorage.getItem(getLegacyPtcExclusiveExperimentKey())).toBe(
      "false"
    );
    expect(
      globalThis.window.localStorage.getItem(
        getExperimentKey(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING)
      )
    ).toBe("false");
  });
});

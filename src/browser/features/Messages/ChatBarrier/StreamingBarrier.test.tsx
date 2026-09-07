import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

import type * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import type * as ModelsFromSettingsModule from "@/browser/hooks/useModelsFromSettings";
import type * as APIModule from "@/browser/contexts/API";
import { overlayWorkspaceStoreRaw } from "@/browser/stores/workspaceStoreTestOverlay";

interface MockWorkspaceState {
  canInterrupt: boolean;
  isCompacting: boolean;
  isStreamStarting: boolean;
  awaitingUserQuestion: boolean;
  currentModel: string | null;
  pendingStreamStartTime: number | null;
  pendingStreamModel: string | null;
  runtimeStatus: { phase: string; detail?: string } | null;
  activeBashMonitorCount: number;
}

function createWorkspaceState(overrides: Partial<MockWorkspaceState> = {}): MockWorkspaceState {
  const state: MockWorkspaceState = {
    canInterrupt: true,
    isCompacting: false,
    isStreamStarting: false,
    awaitingUserQuestion: false,
    currentModel: "openai:gpt-4o-mini",
    pendingStreamStartTime: null,
    pendingStreamModel: null,
    runtimeStatus: null,
    activeBashMonitorCount: 0,
    ...overrides,
  };

  if (overrides.isStreamStarting === undefined) {
    state.isStreamStarting = !state.canInterrupt && state.pendingStreamStartTime !== null;
  }

  return state;
}

interface MockStreamingStats {
  tokenCount: number;
  tps: number;
  charsPerSec: number;
}

const STATUS_DISPLAY_DELAY_MS = 1000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let currentWorkspaceState = createWorkspaceState();
let currentStreamingStats: MockStreamingStats | null = null;
let hasInterruptingStream = false;
const setInterrupting = mock((_workspaceId: string) => undefined);
const interruptStream = mock((_input: unknown) =>
  Promise.resolve({ success: true as const, data: undefined })
);
const setAutoRetryEnabled = mock((_input: unknown) =>
  Promise.resolve({
    success: true as const,
    data: { previousEnabled: true, enabled: true },
  })
);
const openSettings = mock((_section?: string) => undefined);

/* eslint-disable @typescript-eslint/no-require-imports */
const actualWorkspaceStore =
  require("@/browser/stores/WorkspaceStore?real=1") as typeof WorkspaceStoreModule;
/* eslint-enable @typescript-eslint/no-require-imports */

// Overlay (not replace) the raw store: bun evaluates every test file before running tests
// and static import bindings freeze at eval time, so this file-scope mock is what any
// later-evaluated file in the same bun process gets forever. A bare fake missing store
// methods breaks those files' cleanup and cascades.
void mock.module("@/browser/stores/WorkspaceStore", () => ({
  ...actualWorkspaceStore,
  useWorkspaceState: () => currentWorkspaceState,
  useWorkspaceAggregator: () => ({
    hasInterruptingStream: () => hasInterruptingStream,
  }),
  useWorkspaceStoreRaw: () =>
    overlayWorkspaceStoreRaw(actualWorkspaceStore.useWorkspaceStoreRaw(), {
      setInterrupting,
    }),
  useWorkspaceStreamingStats: () => currentStreamingStats,
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const actualAPI = require("@/browser/contexts/API?real=1") as typeof APIModule;
/* eslint-enable @typescript-eslint/no-require-imports */

// Spread the real module: replacing it outright deletes exports like APIContext that
// later-evaluated test files import statically, crashing them at load (module mocks are
// process-wide and bun evaluates every test file before running tests).
void mock.module("@/browser/contexts/API", () => ({
  ...actualAPI,
  useAPI: () => ({
    api: {
      workspace: {
        interruptStream,
        setAutoRetryEnabled,
      },
    },
    status: "connected" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

void mock.module("@/browser/contexts/SettingsContext", () => ({
  useSettings: () => ({
    isOpen: false,
    activeSection: "general",
    open: openSettings,
    close: () => undefined,
    setActiveSection: () => undefined,
    providersExpandedProvider: null,
    setProvidersExpandedProvider: () => undefined,
  }),
}));

// No usePersistedState module mock: in a fresh happy-dom localStorage the real
// readPersistedState/readPersistedString already return the defaults this suite relied on,
// and a partial module replacement here leaks process-wide (bun evaluates every test file
// before running tests), deleting exports that later-evaluated suites need (seen as
// GeneralSection/MemoryTab CI failures).

/* eslint-disable @typescript-eslint/no-require-imports */
const actualModelsFromSettings =
  require("@/browser/hooks/useModelsFromSettings?real=1") as typeof ModelsFromSettingsModule;
/* eslint-enable @typescript-eslint/no-require-imports */

// Spread the real module: this suite only pins getDefaultModel (its assertions expect
// "openai:gpt-4o-mini"); replacing the whole module would leak missing exports.
void mock.module("@/browser/hooks/useModelsFromSettings", () => ({
  ...actualModelsFromSettings,
  getDefaultModel: () => "openai:gpt-4o-mini",
}));

import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { StreamingBarrier } from "./StreamingBarrier";

describe("StreamingBarrier", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    currentWorkspaceState = createWorkspaceState();
    currentStreamingStats = null;
    hasInterruptingStream = false;
    setInterrupting.mockClear();
    interruptStream.mockClear();
    setAutoRetryEnabled.mockClear();
    openSettings.mockClear();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("clicking stop during normal streaming interrupts with default options", async () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: true,
      isCompacting: false,
      awaitingUserQuestion: false,
    });

    // First appearance is immediate — stop button available right away.
    const view = render(<StreamingBarrier workspaceId="ws-1" />);

    fireEvent.click(view.getByRole("button", { name: "Stop streaming" }));

    expect(setInterrupting).toHaveBeenCalledWith("ws-1");
    await waitFor(() =>
      expect(interruptStream).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        options: { disableAutoRetry: true, retireBashMonitorAttention: true },
      })
    );
    expect(setAutoRetryEnabled).not.toHaveBeenCalled();
  });

  test("clicking stop during stream-start interrupts without setting interrupting state", async () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: false,
      pendingStreamStartTime: Date.now(),
      pendingStreamModel: "openai:gpt-4o-mini",
    });

    const view = render(<StreamingBarrier workspaceId="ws-1" />);

    const stopButton = view.getByRole("button", { name: "Stop streaming" });
    expect(stopButton.textContent).toContain("Esc");
    expect(stopButton.getAttribute("title")).toBeNull();

    fireEvent.click(stopButton);

    expect(setInterrupting).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(interruptStream).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        options: { disableAutoRetry: true, retireBashMonitorAttention: true },
      })
    );
  });

  test("shows the barrier immediately on first appearance", () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: false,
      pendingStreamStartTime: null,
      pendingStreamModel: null,
    });

    const view = render(<StreamingBarrier workspaceId="ws-1" />);
    expect(view.queryByRole("button", { name: "Stop streaming" })).toBeNull();

    // Activate streaming phase — barrier appears immediately on first
    // appearance so the empty-transcript placeholder doesn't flash through.
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: false,
      pendingStreamStartTime: Date.now(),
      pendingStreamModel: "anthropic:claude-opus-4-6",
    });
    view.rerender(<StreamingBarrier workspaceId="ws-1" />);

    expect(view.getByRole("button", { name: "Stop streaming" })).toBeTruthy();
    expect(view.getByText("claude-opus-4-6 starting...")).toBeTruthy();
  });

  test("keeps the barrier mounted when startup detail is an empty string", () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: false,
      pendingStreamStartTime: Date.now(),
      pendingStreamModel: "anthropic:claude-opus-4-6",
      runtimeStatus: { phase: "starting", detail: "" },
    });

    const view = render(<StreamingBarrier workspaceId="ws-1" />);

    expect(view.getByRole("button", { name: "Stop streaming" })).toBeTruthy();
  });

  test("shows initial backend startup breadcrumb immediately", () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: false,
      pendingStreamStartTime: Date.now(),
      pendingStreamModel: "openai:gpt-4o-mini",
      runtimeStatus: { phase: "starting", detail: "Loading tools..." },
    });

    const view = render(<StreamingBarrier workspaceId="ws-1" />);

    // First appearance is immediate — text visible right away.
    expect(view.getByText("Loading tools...")).toBeTruthy();
  });

  test("debounces subsequent within-phase breadcrumb changes", async () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: false,
      pendingStreamStartTime: Date.now(),
      pendingStreamModel: "anthropic:claude-opus-4-6",
      runtimeStatus: { phase: "starting", detail: "Starting workspace..." },
    });

    const view = render(<StreamingBarrier workspaceId="ws-1" />);

    // First appearance shows immediately.
    expect(view.getByText("Starting workspace...")).toBeTruthy();

    // Rapid breadcrumb change — holds the first text until the timer fires.
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: false,
      pendingStreamStartTime: Date.now(),
      pendingStreamModel: "anthropic:claude-opus-4-6",
      runtimeStatus: { phase: "starting", detail: "Loading tools..." },
    });
    view.rerender(<StreamingBarrier workspaceId="ws-1" />);

    // Previous text is held; new text not promoted yet.
    expect(view.getByText("Starting workspace...")).toBeTruthy();
    expect(view.queryByText("Loading tools...")).toBeNull();

    // After the delay, the settled text replaces the first.
    await sleep(STATUS_DISPLAY_DELAY_MS + 50);
    expect(view.getByText("Loading tools...")).toBeTruthy();
    expect(view.queryByText("Starting workspace...")).toBeNull();
  });

  test("shows new label immediately on cross-phase transition", () => {
    // Start in "starting" phase — first appearance is immediate.
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: false,
      pendingStreamStartTime: Date.now(),
      pendingStreamModel: "anthropic:claude-opus-4-6",
      runtimeStatus: { phase: "starting", detail: "Loading tools..." },
    });

    const view = render(<StreamingBarrier workspaceId="ws-1" />);
    expect(view.getByText("Loading tools...")).toBeTruthy();

    // Transition to streaming — cross-phase, so immediate.
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: true,
      currentModel: "anthropic:claude-opus-4-6",
    });
    view.rerender(<StreamingBarrier workspaceId="ws-1" />);

    expect(view.getByText("claude-opus-4-6 streaming...")).toBeTruthy();
    expect(view.queryByText("Loading tools...")).toBeNull();
  });

  test("token/tps rerenders do not change displayed status text", () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: true,
      currentModel: "anthropic:claude-opus-4-6",
    });

    // First appearance is immediate.
    const view = render(<StreamingBarrier workspaceId="ws-1" />);
    expect(view.getByText("claude-opus-4-6 streaming...")).toBeTruthy();

    // Token count updates don't change statusText, so the displayed text stays.
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: true,
      currentModel: "anthropic:claude-opus-4-6",
    });
    currentStreamingStats = { tokenCount: 42, tps: 18, charsPerSec: 72 };
    view.rerender(<StreamingBarrier workspaceId="ws-1" />);

    expect(view.getByText("claude-opus-4-6 streaming...")).toBeTruthy();
  });

  test("shows vim interrupt shortcut when vim mode is enabled", () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: false,
      pendingStreamStartTime: Date.now(),
      pendingStreamModel: "openai:gpt-4o-mini",
    });

    const view = render(<StreamingBarrier workspaceId="ws-1" vimEnabled />);

    const stopButton = view.getByRole("button", { name: "Stop streaming" });
    const expectedVimShortcut = formatKeybind(KEYBINDS.INTERRUPT_STREAM_VIM).replace(
      "Escape",
      "Esc"
    );

    expect(stopButton.textContent).toContain(expectedVimShortcut);
    expect(stopButton.getAttribute("title")).toBeNull();
  });

  test("clicking stop during compaction uses onCancelCompaction when provided", () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: true,
      isCompacting: true,
    });

    const onCancelCompaction = mock(() => undefined);
    const view = render(
      <StreamingBarrier workspaceId="ws-1" onCancelCompaction={onCancelCompaction} />
    );

    fireEvent.click(view.getByRole("button", { name: "Stop streaming" }));

    // The compaction-cancel flow owns the retry opt-out along with its Stop.
    expect(onCancelCompaction).toHaveBeenCalledTimes(1);
    expect(setAutoRetryEnabled).not.toHaveBeenCalled();
    expect(setInterrupting).not.toHaveBeenCalled();
    expect(interruptStream).not.toHaveBeenCalled();
  });

  test("clicking stop during compaction falls back to abandonPartial interrupt", async () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: true,
      isCompacting: true,
    });

    const view = render(<StreamingBarrier workspaceId="ws-1" />);

    fireEvent.click(view.getByRole("button", { name: "Stop streaming" }));

    expect(setInterrupting).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(interruptStream).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        options: { abandonPartial: true, disableAutoRetry: true, retireBashMonitorAttention: true },
      })
    );
  });

  test("resets to new workspace text immediately on workspace switch", () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: true,
      currentModel: "anthropic:claude-opus-4-6",
    });

    const view = render(<StreamingBarrier workspaceId="ws-1" />);
    expect(view.getByText("claude-opus-4-6 streaming...")).toBeTruthy();

    // Switch workspace — immediately shows the new workspace's text.
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: true,
      currentModel: "openai:gpt-4o-mini",
    });
    view.rerender(<StreamingBarrier workspaceId="ws-2" />);

    // Old workspace text gone; new workspace text shown immediately.
    expect(view.queryByText("claude-opus-4-6 streaming...")).toBeNull();
    expect(view.getByText("gpt-4o-mini streaming...")).toBeTruthy();
  });

  test("awaiting-input phase keeps cancel hint non-interactive", () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: true,
      awaitingUserQuestion: true,
    });

    const view = render(<StreamingBarrier workspaceId="ws-1" />);

    expect(view.queryByRole("button", { name: "Stop streaming" })).toBeNull();
    expect(view.getByText("type a message to respond")).toBeTruthy();
  });

  test("idle workspace with an armed bash monitor shows the waiting state without a stop control", () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: false,
      activeBashMonitorCount: 1,
    });

    const view = render(<StreamingBarrier workspaceId="ws-1" />);

    // Shown immediately (not debounced) so the stream-end -> waiting handoff
    // doesn't flash an empty transcript tail.
    expect(view.getByText("Waiting on background bash monitor...")).toBeTruthy();
    // Nothing to interrupt — the hint is informational, not a cancel control.
    expect(view.queryByRole("button", { name: "Stop streaming" })).toBeNull();
    expect(view.getByText("agent wakes on matching output")).toBeTruthy();
    // Not streaming-bound: no reserved token-stats slot (frees narrow panes).
    expect(view.queryByTestId("streaming-barrier-stats")).toBeNull();
  });

  test("idle workspace without armed monitors renders nothing", () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: false,
      activeBashMonitorCount: 0,
    });

    const view = render(<StreamingBarrier workspaceId="ws-1" />);

    expect(view.container.textContent).toBe("");
  });

  test("active streaming takes precedence over an armed bash monitor", () => {
    currentWorkspaceState = createWorkspaceState({
      canInterrupt: true,
      activeBashMonitorCount: 2,
    });

    const view = render(<StreamingBarrier workspaceId="ws-1" />);

    expect(view.getByText("gpt-4o-mini streaming...")).toBeTruthy();
    expect(view.getByRole("button", { name: "Stop streaming" })).toBeTruthy();
  });
});

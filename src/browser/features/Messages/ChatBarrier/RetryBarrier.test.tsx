import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

import type * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import type * as APIModule from "@/browser/contexts/API";
import { overlayWorkspaceStoreRaw } from "@/browser/stores/workspaceStoreTestOverlay";

interface MockWorkspaceState {
  autoRetryStatus:
    | {
        type: "auto-retry-scheduled";
        attempt: number;
        delayMs: number;
        scheduledAt: number;
      }
    | {
        type: "auto-retry-starting";
        attempt: number;
      }
    | {
        type: "auto-retry-abandoned";
        reason: string;
      }
    | null;
  isStreamStarting: boolean;
  canInterrupt: boolean;
  messages: Array<Record<string, unknown>>;
}

function createWorkspaceState(overrides: Partial<MockWorkspaceState> = {}): MockWorkspaceState {
  return {
    autoRetryStatus: null,
    isStreamStarting: false,
    canInterrupt: false,
    messages: [
      {
        type: "stream-error",
        messageId: "assistant-1",
        error: "Runtime failed to start",
        errorType: "runtime_start_failed",
      },
    ],
    ...overrides,
  };
}

let currentWorkspaceState = createWorkspaceState();

type ResumeStreamResult =
  | { success: true; data: { started: boolean } }
  | {
      success: false;
      error: {
        type: "runtime_start_failed";
        message: string;
      };
    };

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

let resumeStreamResult: ResumeStreamResult = { success: true, data: { started: true } };
let previousAutoRetryEnabled = false;
const resumeStream = mock((_input: unknown) => Promise.resolve(resumeStreamResult));
const interruptStream = mock((_input: unknown) => Promise.resolve({ success: true as const }));
const setAutoRetryEnabled = mock((input: unknown) => {
  if (
    typeof input === "object" &&
    input !== null &&
    "enabled" in input &&
    (input as { enabled?: unknown }).enabled === false
  ) {
    previousAutoRetryEnabled = false;
  }

  return Promise.resolve({
    success: true as const,
    data: {
      previousEnabled: previousAutoRetryEnabled,
      enabled:
        typeof input === "object" && input !== null && "enabled" in input
          ? ((input as { enabled?: boolean }).enabled ?? true)
          : true,
    },
  });
});

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
        resumeStream,
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
  useWorkspaceStoreRaw: () =>
    overlayWorkspaceStoreRaw(actualWorkspaceStore.useWorkspaceStoreRaw(), {
      getWorkspaceState: (_workspaceId: string) => currentWorkspaceState,
    }),
}));

// No usePersistedState module mock: the real hook returns [false, setter] for the unset
// vim key in a fresh happy-dom localStorage (what the old fake hardcoded), and a partial
// module replacement here leaks process-wide (bun evaluates every test file before running
// tests), turning later-evaluated suites' persistence into no-ops (seen as GeneralSection
// CI failures).

import { RetryBarrier } from "./RetryBarrier";

describe("RetryBarrier", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    currentWorkspaceState = createWorkspaceState();
    resumeStreamResult = { success: true, data: { started: true } };
    previousAutoRetryEnabled = false;
    resumeStream.mockClear();
    interruptStream.mockClear();
    setAutoRetryEnabled.mockClear();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("uses delayed-start copy while the first response is still starting", () => {
    currentWorkspaceState = createWorkspaceState({
      isStreamStarting: true,
      messages: [
        {
          type: "user",
          id: "user-1",
          historyId: "user-1",
          content: "Hello",
          historySequence: 1,
        },
      ],
    });

    const view = render(<RetryBarrier workspaceId="ws-1" />);

    expect(view.getByText("Response startup is taking longer than expected")).toBeTruthy();
    expect(view.queryByText("Stream interrupted")).toBeNull();
  });

  test("shows error details when manual resume fails before stream events", async () => {
    resumeStreamResult = {
      success: false,
      error: {
        type: "runtime_start_failed",
        message: "Runtime failed to start",
      },
    };

    const view = render(<RetryBarrier workspaceId="ws-1" />);

    fireEvent.click(view.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(view.getByText("Retry failed:")).toBeTruthy();
    });
    expect(view.getByText(/Runtime failed to start/)).toBeTruthy();

    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(1, {
      workspaceId: "ws-1",
      enabled: true,
      persist: false,
    });
    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-1",
      enabled: false,
      persist: false,
    });
    expect(resumeStream).toHaveBeenCalledTimes(1);
  });

  test("restores disabled auto-retry preference after resumed stream reaches terminal state", async () => {
    previousAutoRetryEnabled = false;
    const resumeDeferred = createDeferred<ResumeStreamResult>();
    resumeStream.mockImplementationOnce((_input: unknown) => resumeDeferred.promise);

    const view = render(<RetryBarrier workspaceId="ws-1" />);

    fireEvent.click(view.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(setAutoRetryEnabled).toHaveBeenCalledTimes(1);
    });

    currentWorkspaceState = createWorkspaceState({
      autoRetryStatus: { type: "auto-retry-starting", attempt: 1 },
      isStreamStarting: true,
      canInterrupt: true,
    });
    view.rerender(<RetryBarrier workspaceId="ws-1" />);

    resumeDeferred.resolve({ success: true, data: { started: true } });
    await waitFor(() => {
      expect(resumeStream).toHaveBeenCalledTimes(1);
      expect(setAutoRetryEnabled.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    currentWorkspaceState = createWorkspaceState({
      autoRetryStatus: null,
      isStreamStarting: false,
      canInterrupt: false,
    });
    view.rerender(<RetryBarrier workspaceId="ws-1" />);

    await waitFor(() => {
      expect(setAutoRetryEnabled).toHaveBeenCalledTimes(2);
    });

    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(1, {
      workspaceId: "ws-1",
      enabled: true,
      persist: false,
    });
    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-1",
      enabled: false,
      persist: false,
    });
    expect(view.queryByText("Retry failed:")).toBeNull();
  });

  test("restores preference when terminal state arrives without in-flight snapshots", async () => {
    resumeStreamResult = { success: true, data: { started: true } };
    previousAutoRetryEnabled = false;

    const view = render(<RetryBarrier workspaceId="ws-1" />);

    fireEvent.click(view.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(resumeStream).toHaveBeenCalledTimes(1);
      expect(setAutoRetryEnabled.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    currentWorkspaceState = createWorkspaceState({
      autoRetryStatus: null,
      isStreamStarting: false,
      canInterrupt: false,
      messages: [
        {
          type: "stream-error",
          messageId: "assistant-1",
          error: "Runtime failed to start",
          errorType: "runtime_start_failed",
        },
        {
          type: "stream-error",
          messageId: "assistant-2",
          error: "Runtime failed to start",
          errorType: "runtime_start_failed",
        },
      ],
    });
    view.rerender(<RetryBarrier workspaceId="ws-1" />);

    await waitFor(() => {
      expect(setAutoRetryEnabled).toHaveBeenCalledTimes(2);
    });

    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(1, {
      workspaceId: "ws-1",
      enabled: true,
      persist: false,
    });
    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-1",
      enabled: false,
      persist: false,
    });
  });

  test("restores disabled auto-retry preference if barrier unmounts before terminal state", async () => {
    resumeStreamResult = { success: true, data: { started: true } };
    previousAutoRetryEnabled = false;

    const view = render(<RetryBarrier workspaceId="ws-1" />);

    fireEvent.click(view.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(resumeStream).toHaveBeenCalledTimes(1);
      expect(setAutoRetryEnabled.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    view.unmount();

    await waitFor(() => {
      expect(setAutoRetryEnabled).toHaveBeenCalledTimes(2);
    });

    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(1, {
      workspaceId: "ws-1",
      enabled: true,
      persist: false,
    });
    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-1",
      enabled: false,
      persist: false,
    });
  });

  test("rolls back temporary retry enable when resume reports not started", async () => {
    resumeStreamResult = { success: true, data: { started: false } };
    previousAutoRetryEnabled = false;

    const view = render(<RetryBarrier workspaceId="ws-1" />);

    fireEvent.click(view.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(setAutoRetryEnabled).toHaveBeenCalledTimes(2);
    });

    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(1, {
      workspaceId: "ws-1",
      enabled: true,
      persist: false,
    });
    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-1",
      enabled: false,
      persist: false,
    });
  });

  test("keeps auto-retry enabled when manual retry fails and preference was already on", async () => {
    previousAutoRetryEnabled = true;
    resumeStreamResult = {
      success: false,
      error: {
        type: "runtime_start_failed",
        message: "Runtime failed to start",
      },
    };

    const view = render(<RetryBarrier workspaceId="ws-1" />);

    fireEvent.click(view.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(view.getByText("Retry failed:")).toBeTruthy();
    });

    expect(setAutoRetryEnabled).toHaveBeenCalledTimes(1);
    expect(setAutoRetryEnabled).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      enabled: true,
      persist: false,
    });
    expect(resumeStream).toHaveBeenCalledTimes(1);
  });

  test("the Stop button issues Stop only after the retry opt-out has landed", async () => {
    currentWorkspaceState = createWorkspaceState({
      autoRetryStatus: {
        type: "auto-retry-scheduled",
        attempt: 1,
        delayMs: 5_000,
        scheduledAt: Date.now(),
      },
    });
    let settleOptOut!: () => void;
    setAutoRetryEnabled.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settleOptOut = () =>
            resolve({ success: true as const, data: { previousEnabled: true, enabled: false } });
        })
    );

    const view = render(<RetryBarrier workspaceId="ws-1" />);
    fireEvent.click(view.getByRole("button", { name: /^Stop/ }));
    await Promise.resolve();

    expect(setAutoRetryEnabled).toHaveBeenCalledTimes(1);
    expect(interruptStream).not.toHaveBeenCalled();

    settleOptOut();
    await waitFor(() => expect(interruptStream).toHaveBeenCalledTimes(1));
  });

  test("the Stop button issues the same attention-retiring Stop as its shortcut", async () => {
    currentWorkspaceState = createWorkspaceState({
      autoRetryStatus: {
        type: "auto-retry-scheduled",
        attempt: 1,
        delayMs: 5_000,
        scheduledAt: Date.now(),
      },
    });

    const view = render(<RetryBarrier workspaceId="ws-1" />);

    fireEvent.click(view.getByRole("button", { name: /^Stop/ }));

    expect(setAutoRetryEnabled).toHaveBeenCalledWith({ workspaceId: "ws-1", enabled: false });
    await waitFor(() => expect(interruptStream).toHaveBeenCalledTimes(1));
    expect(interruptStream).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      options: { retireBashMonitorAttention: true },
    });
  });
});

import type { ReactNode, RefObject } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalWindow } from "happy-dom";
import type { ChatInputAPI } from "@/browser/features/ChatInput";
import type * as APIModule from "@/browser/contexts/API";
import type { APIClient } from "@/browser/contexts/API";
import { requireTestModule, type RecursivePartial } from "@/browser/testUtils";
import type * as UseAIViewKeybindsModule from "./useAIViewKeybinds";

let currentClientMock: RecursivePartial<APIClient> = {};
let originalWindow: typeof globalThis.window;
let originalDocument: typeof globalThis.document;
let originalHTMLElement: unknown;
let APIProvider!: typeof APIModule.APIProvider;
let useAIViewKeybinds!: typeof UseAIViewKeybindsModule.useAIViewKeybinds;
let isolatedModulePaths: string[] = [];

const hooksDir = dirname(fileURLToPath(import.meta.url));
const contextsDir = join(hooksDir, "../contexts");

async function importIsolatedAIViewKeybindModules() {
  const suffix = randomUUID();
  const isolatedApiPath = join(contextsDir, `API.real.${suffix}.tsx`);
  const isolatedHookPath = join(hooksDir, `useAIViewKeybinds.real.${suffix}.ts`);

  await copyFile(join(contextsDir, "API.tsx"), isolatedApiPath);

  const hookSource = await readFile(join(hooksDir, "useAIViewKeybinds.ts"), "utf8");
  const isolatedHookSource = hookSource.replace(
    'from "@/browser/contexts/API";',
    `from "../contexts/API.real.${suffix}.tsx";`
  );

  if (isolatedHookSource === hookSource) {
    throw new Error("Failed to rewrite useAIViewKeybinds API import for the isolated test copy");
  }

  await writeFile(isolatedHookPath, isolatedHookSource);

  ({ APIProvider } = requireTestModule<{ APIProvider: typeof APIModule.APIProvider }>(
    isolatedApiPath
  ));
  ({ useAIViewKeybinds } = requireTestModule<{
    useAIViewKeybinds: typeof UseAIViewKeybindsModule.useAIViewKeybinds;
  }>(isolatedHookPath));

  return [isolatedApiPath, isolatedHookPath];
}

function renderUseAIViewKeybinds(props: Parameters<typeof useAIViewKeybinds>[0]) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <APIProvider client={currentClientMock as APIClient}>{children}</APIProvider>
  );

  return renderHook(() => useAIViewKeybinds(props), { wrapper });
}

describe("useAIViewKeybinds", () => {
  beforeEach(async () => {
    isolatedModulePaths = await importIsolatedAIViewKeybindModules();
    mock.restore();

    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalHTMLElement = (globalThis as unknown as { HTMLElement: unknown }).HTMLElement;

    const domWindow = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.window = domWindow;
    globalThis.document = domWindow.document;
    // happy-dom doesn't define HTMLElement on globalThis by default.
    // Our keybind helpers use `target instanceof HTMLElement`, so polyfill it for tests.
    (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = domWindow.HTMLElement;
  });

  afterEach(async () => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = originalHTMLElement;
    currentClientMock = {};

    for (const modulePath of isolatedModulePaths) {
      await rm(modulePath, { force: true });
    }
    isolatedModulePaths = [];
  });

  test("Escape interrupts an active stream in normal mode", async () => {
    const interruptStream = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    currentClientMock = {
      workspace: {
        interruptStream,
      },
    };

    const chatInputAPI: RefObject<ChatInputAPI | null> = { current: null };

    renderUseAIViewKeybinds({
      workspaceId: "ws",
      canInterrupt: true,
      showRetryBarrier: false,
      chatInputAPI,
      jumpToBottom: () => undefined,
      loadOlderHistory: null,
      handleOpenTerminal: () => undefined,
      handleOpenInEditor: () => undefined,
      aggregator: undefined,
      setEditingMessage: () => undefined,
      vimEnabled: false,
    });

    document.body.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      })
    );

    await waitFor(() => expect(interruptStream.mock.calls.length).toBe(1));
  });

  test("Escape does not interrupt when the event target is an <input>", () => {
    const interruptStream = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    currentClientMock = {
      workspace: {
        interruptStream,
      },
    };

    const chatInputAPI: RefObject<ChatInputAPI | null> = { current: null };

    renderUseAIViewKeybinds({
      workspaceId: "ws",
      canInterrupt: true,
      showRetryBarrier: false,
      chatInputAPI,
      jumpToBottom: () => undefined,
      loadOlderHistory: null,
      handleOpenTerminal: () => undefined,
      handleOpenInEditor: () => undefined,
      aggregator: undefined,
      setEditingMessage: () => undefined,
      vimEnabled: false,
    });

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    input.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      })
    );

    expect(interruptStream.mock.calls.length).toBe(0);
  });

  test("Escape interrupts when an editable element opts in", async () => {
    const interruptStream = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    currentClientMock = {
      workspace: {
        interruptStream,
      },
    };

    const chatInputAPI: RefObject<ChatInputAPI | null> = { current: null };

    renderUseAIViewKeybinds({
      workspaceId: "ws",
      canInterrupt: true,
      showRetryBarrier: false,
      chatInputAPI,
      jumpToBottom: () => undefined,
      loadOlderHistory: null,
      handleOpenTerminal: () => undefined,
      handleOpenInEditor: () => undefined,
      aggregator: undefined,
      setEditingMessage: () => undefined,
      vimEnabled: false,
    });

    const input = document.createElement("input");
    input.setAttribute("data-escape-interrupts-stream", "true");
    document.body.appendChild(input);
    input.focus();

    input.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      })
    );

    await waitFor(() => expect(interruptStream.mock.calls.length).toBe(1));
  });

  test("Ctrl+C interrupts in vim mode even when an <input> is focused", async () => {
    const interruptStream = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    currentClientMock = {
      workspace: {
        interruptStream,
      },
    };

    const chatInputAPI: RefObject<ChatInputAPI | null> = { current: null };

    renderUseAIViewKeybinds({
      workspaceId: "ws",
      canInterrupt: true,
      showRetryBarrier: false,
      chatInputAPI,
      jumpToBottom: () => undefined,
      loadOlderHistory: null,
      handleOpenTerminal: () => undefined,
      handleOpenInEditor: () => undefined,
      aggregator: undefined,
      setEditingMessage: () => undefined,
      vimEnabled: true,
    });

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    input.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "c",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
    );

    await waitFor(() => expect(interruptStream.mock.calls.length).toBe(1));
  });

  test("Escape on the retry barrier opts out of auto-retry inside the Stop itself", async () => {
    const interruptStream = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    const setAutoRetryEnabled = mock(() =>
      Promise.resolve({
        success: true as const,
        data: { previousEnabled: true, enabled: false },
      })
    );
    currentClientMock = {
      workspace: {
        interruptStream,
        setAutoRetryEnabled,
      },
    };

    const chatInputAPI: RefObject<ChatInputAPI | null> = { current: null };

    renderUseAIViewKeybinds({
      workspaceId: "ws",
      canInterrupt: false,
      showRetryBarrier: true,
      chatInputAPI,
      jumpToBottom: () => undefined,
      loadOlderHistory: null,
      handleOpenTerminal: () => undefined,
      handleOpenInEditor: () => undefined,
      aggregator: undefined,
      setEditingMessage: () => undefined,
      vimEnabled: false,
    });

    document.body.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      })
    );

    await waitFor(() => expect(interruptStream.mock.calls.length).toBe(1));
    expect(interruptStream).toHaveBeenCalledWith({
      workspaceId: "ws",
      options: { disableAutoRetry: true, retireBashMonitorAttention: true },
    });
    expect(setAutoRetryEnabled).not.toHaveBeenCalled();
  });

  test.each([
    ["data-browser-viewport", "c", true],
    ["data-desktop-viewport", "c", true],
    ["data-desktop-viewport", "Escape", false],
  ] as const)("%s keeps %s instead of interrupting the stream", (attribute, key, ctrlKey) => {
    const interruptStream = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    currentClientMock = {
      workspace: {
        interruptStream,
      },
    };

    const chatInputAPI: RefObject<ChatInputAPI | null> = { current: null };

    renderUseAIViewKeybinds({
      workspaceId: "ws",
      canInterrupt: true,
      showRetryBarrier: false,
      chatInputAPI,
      jumpToBottom: () => undefined,
      loadOlderHistory: null,
      handleOpenTerminal: () => undefined,
      handleOpenInEditor: () => undefined,
      aggregator: undefined,
      setEditingMessage: () => undefined,
      vimEnabled: ctrlKey,
    });

    const browserViewport = document.createElement("div");
    browserViewport.setAttribute(attribute, "true");
    const canvas = document.createElement("canvas");
    browserViewport.appendChild(canvas);
    document.body.appendChild(browserViewport);

    canvas.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key,
        ctrlKey,
        bubbles: true,
        cancelable: true,
      })
    );

    expect(interruptStream.mock.calls.length).toBe(0);
  });

  test("desktop canvas owns capture-phase resume, chat focus, editor, and terminal shortcuts", () => {
    const focus = mock(() => undefined);
    const resumeInterruptedStream = mock(() => undefined);
    const handleOpenInEditor = mock(() => undefined);
    const handleOpenTerminal = mock(() => undefined);
    const chatInputAPI: RefObject<ChatInputAPI | null> = {
      current: {
        focus,
        send: () => Promise.resolve(),
        restoreText: () => undefined,
        restoreDraft: () => undefined,
        appendText: () => undefined,
        prependText: () => undefined,
      },
    };
    renderUseAIViewKeybinds({
      workspaceId: "ws",
      canInterrupt: false,
      showRetryBarrier: false,
      chatInputAPI,
      jumpToBottom: () => undefined,
      loadOlderHistory: null,
      handleOpenTerminal,
      handleOpenInEditor,
      aggregator: undefined,
      setEditingMessage: () => undefined,
      vimEnabled: false,
      canResumeInterruptedStream: true,
      resumeInterruptedStream,
    });
    const viewport = document.createElement("div");
    viewport.setAttribute("data-desktop-viewport", "");
    const canvas = document.createElement("canvas");
    viewport.appendChild(canvas);
    document.body.appendChild(viewport);
    const shortcuts = [
      { key: "R", shiftKey: true },
      { key: "i", ctrlKey: true },
      { key: "E", ctrlKey: true, shiftKey: true },
      { key: "t", ctrlKey: true },
    ];
    for (const shortcut of shortcuts) {
      const event = new window.KeyboardEvent("keydown", {
        ...shortcut,
        bubbles: true,
        cancelable: true,
      });
      canvas.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    for (const action of [focus, resumeInterruptedStream, handleOpenInEditor, handleOpenTerminal]) {
      expect(action).not.toHaveBeenCalled();
    }

    // Outside the guest surface, those same keystrokes must retain their host behavior.
    for (const shortcut of shortcuts) {
      document.body.dispatchEvent(
        new window.KeyboardEvent("keydown", { ...shortcut, bubbles: true, cancelable: true })
      );
    }
    for (const action of [focus, resumeInterruptedStream, handleOpenInEditor, handleOpenTerminal]) {
      expect(action).toHaveBeenCalledTimes(1);
    }
  });

  test("Shift+H loads older history when callback is provided", () => {
    const loadOlderHistory = mock(() => undefined);
    const chatInputAPI: RefObject<ChatInputAPI | null> = { current: null };

    renderUseAIViewKeybinds({
      workspaceId: "ws",
      canInterrupt: false,
      showRetryBarrier: false,
      chatInputAPI,
      jumpToBottom: () => undefined,
      loadOlderHistory,
      handleOpenTerminal: () => undefined,
      handleOpenInEditor: () => undefined,
      aggregator: undefined,
      setEditingMessage: () => undefined,
      vimEnabled: false,
    });

    document.body.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "H",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      })
    );

    expect(loadOlderHistory.mock.calls.length).toBe(1);
  });

  test("Escape does not interrupt when immersive review captures Escape", () => {
    const interruptStream = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    currentClientMock = {
      workspace: {
        interruptStream,
      },
    };

    const chatInputAPI: RefObject<ChatInputAPI | null> = { current: null };

    renderUseAIViewKeybinds({
      workspaceId: "ws",
      canInterrupt: true,
      showRetryBarrier: false,
      chatInputAPI,
      jumpToBottom: () => undefined,
      loadOlderHistory: null,
      handleOpenTerminal: () => undefined,
      handleOpenInEditor: () => undefined,
      aggregator: undefined,
      setEditingMessage: () => undefined,
      vimEnabled: false,
    });

    const stopImmersiveEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    // Immersive review listens in capture phase so Escape never reaches bubble-phase
    // stream interrupt listeners.
    window.addEventListener("keydown", stopImmersiveEscape, { capture: true });

    document.body.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      })
    );

    window.removeEventListener("keydown", stopImmersiveEscape, { capture: true });

    expect(interruptStream.mock.calls.length).toBe(0);
  });

  test("Escape does not interrupt when a modal stops propagation (e.g., Settings)", () => {
    const interruptStream = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    currentClientMock = {
      workspace: {
        interruptStream,
      },
    };

    const chatInputAPI: RefObject<ChatInputAPI | null> = { current: null };

    renderUseAIViewKeybinds({
      workspaceId: "ws",
      canInterrupt: true,
      showRetryBarrier: false,
      chatInputAPI,
      jumpToBottom: () => undefined,
      loadOlderHistory: null,
      handleOpenTerminal: () => undefined,
      handleOpenInEditor: () => undefined,
      aggregator: undefined,
      setEditingMessage: () => undefined,
      vimEnabled: false,
    });

    const stopEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
      }
    };

    document.addEventListener("keydown", stopEscape, { capture: true });

    document.body.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      })
    );

    document.removeEventListener("keydown", stopEscape, { capture: true });

    expect(interruptStream.mock.calls.length).toBe(0);
  });

  test("Shift+R resumes when a resumable interrupted turn is shown", () => {
    const resumeInterruptedStream = mock(() => undefined);
    const chatInputAPI: RefObject<ChatInputAPI | null> = { current: null };

    renderUseAIViewKeybinds({
      workspaceId: "ws",
      canInterrupt: false,
      showRetryBarrier: false,
      chatInputAPI,
      jumpToBottom: () => undefined,
      loadOlderHistory: null,
      handleOpenTerminal: () => undefined,
      handleOpenInEditor: () => undefined,
      aggregator: undefined,
      setEditingMessage: () => undefined,
      vimEnabled: false,
      canResumeInterruptedStream: true,
      resumeInterruptedStream,
    });

    document.body.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "R",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      })
    );

    expect(resumeInterruptedStream.mock.calls.length).toBe(1);
  });

  test("Shift+R does nothing when no resumable turn is shown", () => {
    const resumeInterruptedStream = mock(() => undefined);
    const chatInputAPI: RefObject<ChatInputAPI | null> = { current: null };

    renderUseAIViewKeybinds({
      workspaceId: "ws",
      canInterrupt: false,
      showRetryBarrier: false,
      chatInputAPI,
      jumpToBottom: () => undefined,
      loadOlderHistory: null,
      handleOpenTerminal: () => undefined,
      handleOpenInEditor: () => undefined,
      aggregator: undefined,
      setEditingMessage: () => undefined,
      vimEnabled: false,
      canResumeInterruptedStream: false,
      resumeInterruptedStream,
    });

    document.body.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "R",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      })
    );

    expect(resumeInterruptedStream.mock.calls.length).toBe(0);
  });

  test("Shift+R does not resume while typing in an input (types normally)", () => {
    const resumeInterruptedStream = mock(() => undefined);
    const chatInputAPI: RefObject<ChatInputAPI | null> = { current: null };

    renderUseAIViewKeybinds({
      workspaceId: "ws",
      canInterrupt: false,
      showRetryBarrier: false,
      chatInputAPI,
      jumpToBottom: () => undefined,
      loadOlderHistory: null,
      handleOpenTerminal: () => undefined,
      handleOpenInEditor: () => undefined,
      aggregator: undefined,
      setEditingMessage: () => undefined,
      vimEnabled: false,
      canResumeInterruptedStream: true,
      resumeInterruptedStream,
    });

    // Composer/terminal are editable elements, so the transcript-scoped key must
    // type "R" instead of resuming.
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    input.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "R",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      })
    );

    expect(resumeInterruptedStream.mock.calls.length).toBe(0);
  });
});

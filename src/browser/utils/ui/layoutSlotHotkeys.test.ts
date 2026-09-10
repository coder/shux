import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";

import { handleLayoutSlotHotkeys } from "./layoutSlotHotkeys";
import type { LayoutPresetsConfig, LayoutPreset } from "@/common/types/uiLayouts";

function createEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return {
    key: "1",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    preventDefault: () => undefined,
    ...overrides,
  } as KeyboardEvent;
}

function createPreset(): LayoutPreset {
  return {
    id: "preset-1",
    name: "Slot 1",
    leftSidebarCollapsed: false,
    rightSidebar: {
      collapsed: false,
      width: { mode: "px", value: 400 },
      layout: {
        version: 1,
        nextId: 1,
        focusedTabsetId: "tabset-1",
        root: {
          type: "tabset",
          id: "tabset-1",
          tabs: ["costs"],
          activeTab: "costs",
        },
      },
    },
  };
}

function createLayoutPresetsWithSlot1(): LayoutPresetsConfig {
  return {
    version: 2,
    slots: [{ slot: 1, preset: createPreset() }],
  };
}

describe("handleLayoutSlotHotkeys", () => {
  beforeEach(() => {
    const happyWindow = new GlobalWindow();
    globalThis.window = happyWindow as unknown as Window & typeof globalThis;
    globalThis.document = happyWindow.document as unknown as Document;
    (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = happyWindow.HTMLElement;
  });

  afterEach(() => {
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
    (globalThis as unknown as { HTMLElement?: unknown }).HTMLElement = undefined;
  });

  test("handles slot hotkey even when focus is in a textarea", () => {
    const applySlotToWorkspace = mock((_workspaceId: string, _slot: number) => Promise.resolve());
    const preventDefault = mock(() => undefined);

    const textarea = document.createElement("textarea");

    const handled = handleLayoutSlotHotkeys(
      createEvent({ key: "1", ctrlKey: true, altKey: true, target: textarea, preventDefault }),
      {
        isCommandPaletteOpen: false,
        isSettingsOpen: false,
        selectedWorkspaceId: "ws",
        layoutPresets: createLayoutPresetsWithSlot1(),
        applySlotToWorkspace,
      }
    );

    expect(handled).toBe(true);
    expect(preventDefault.mock.calls.length).toBe(1);
    expect(applySlotToWorkspace.mock.calls).toEqual([["ws", 1]]);
  });

  test("does not handle slot hotkey when a terminal is focused", () => {
    const applySlotToWorkspace = mock((_workspaceId: string, _slot: number) => Promise.resolve());

    const terminalContainer = document.createElement("div");
    terminalContainer.setAttribute("data-terminal-container", "true");

    const textarea = document.createElement("textarea");
    terminalContainer.appendChild(textarea);

    const handled = handleLayoutSlotHotkeys(
      createEvent({ key: "1", ctrlKey: true, altKey: true, target: textarea }),
      {
        isCommandPaletteOpen: false,
        isSettingsOpen: false,
        selectedWorkspaceId: "ws",
        layoutPresets: createLayoutPresetsWithSlot1(),
        applySlotToWorkspace,
      }
    );

    expect(handled).toBe(false);
    expect(applySlotToWorkspace.mock.calls.length).toBe(0);
  });

  test.each(["data-browser-viewport", "data-desktop-viewport"])(
    "does not handle slot hotkey inside %s",
    (viewportAttribute) => {
      const applySlotToWorkspace = mock((_workspaceId: string, _slot: number) => Promise.resolve());

      const browserViewport = document.createElement("div");
      browserViewport.setAttribute(viewportAttribute, "true");

      const textarea = document.createElement("textarea");
      browserViewport.appendChild(textarea);

      const handled = handleLayoutSlotHotkeys(
        createEvent({ key: "1", ctrlKey: true, altKey: true, target: textarea }),
        {
          isCommandPaletteOpen: false,
          isSettingsOpen: false,
          selectedWorkspaceId: "ws",
          layoutPresets: createLayoutPresetsWithSlot1(),
          applySlotToWorkspace,
        }
      );

      expect(handled).toBe(false);
      expect(applySlotToWorkspace.mock.calls.length).toBe(0);
    }
  );

  test("does not handle slot hotkey when AltGr is active", () => {
    const applySlotToWorkspace = mock((_workspaceId: string, _slot: number) => Promise.resolve());

    const textarea = document.createElement("textarea");

    const handled = handleLayoutSlotHotkeys(
      createEvent({
        key: "1",
        ctrlKey: true,
        altKey: true,
        target: textarea,
        getModifierState: (key: string) => key === "AltGraph",
      }),
      {
        isCommandPaletteOpen: false,
        isSettingsOpen: false,
        selectedWorkspaceId: "ws",
        layoutPresets: createLayoutPresetsWithSlot1(),
        applySlotToWorkspace,
      }
    );

    expect(handled).toBe(false);
    expect(applySlotToWorkspace.mock.calls.length).toBe(0);
  });
});

import { describe, it, expect, test } from "bun:test";
import { isMac, matchesKeybind, isKeybindDeprecated, KEYBINDS } from "./keybinds";
import type { Keybind } from "@/common/types/keybind";

// Helper to create a minimal keyboard event
function createEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return {
    key: "a",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...overrides,
  } as KeyboardEvent;
}

describe("COPY_MARKDOWN keybind", () => {
  test("accepts M without modifiers and rejects modified keys", () => {
    expect(matchesKeybind(createEvent({ key: "m" }), KEYBINDS.COPY_MARKDOWN)).toBe(true);
    for (const modifier of ["shiftKey", "ctrlKey", "metaKey", "altKey"]) {
      expect(
        matchesKeybind(createEvent({ key: "M", [modifier]: true }), KEYBINDS.COPY_MARKDOWN)
      ).toBe(false);
    }
  });
});

describe("isMac", () => {
  it("falls back to navigator.platform when Electron API is missing", () => {
    const originalWindow = globalThis.window;
    const originalNavigator = globalThis.navigator;

    // Simulate browser mode on macOS (no Electron preload API)
    globalThis.window = {} as unknown as Window & typeof globalThis;
    globalThis.navigator = {
      platform: "MacIntel",
      userAgent: "Mozilla/5.0",
    } as unknown as Navigator;

    expect(isMac()).toBe(true);

    // Ctrl-style keybinds should match Cmd (Meta) on macOS
    const event = createEvent({ key: "P", metaKey: true, shiftKey: true });
    expect(matchesKeybind(event, KEYBINDS.OPEN_COMMAND_PALETTE)).toBe(true);

    globalThis.window = originalWindow;
    globalThis.navigator = originalNavigator;
  });
});

describe("CYCLE_MODEL keybind (Ctrl+/)", () => {
  it("matches Ctrl+/ on Linux/Windows", () => {
    // Mock non-Mac platform
    globalThis.window = { api: { platform: "linux" } } as unknown as Window & typeof globalThis;
    const event = createEvent({ key: "/", ctrlKey: true });
    expect(matchesKeybind(event, { key: "/", ctrl: true })).toBe(true);
  });

  it("matches Cmd+/ on macOS", () => {
    // Mock Mac platform
    globalThis.window = { api: { platform: "darwin" } } as unknown as Window & typeof globalThis;
    const event = createEvent({ key: "/", metaKey: true });
    expect(matchesKeybind(event, { key: "/", ctrl: true })).toBe(true);
  });

  it("matches Ctrl+/ on macOS (either behavior)", () => {
    // Mock Mac platform
    globalThis.window = { api: { platform: "darwin" } } as unknown as Window & typeof globalThis;
    const event = createEvent({ key: "/", ctrlKey: true });
    expect(matchesKeybind(event, { key: "/", ctrl: true })).toBe(true);
  });

  it("does not match just /", () => {
    const event = createEvent({ key: "/" });
    expect(matchesKeybind(event, { key: "/", ctrl: true })).toBe(false);
  });

  it("does not match Ctrl+? (shifted /)", () => {
    const event = createEvent({ key: "?", ctrlKey: true, shiftKey: true });
    expect(matchesKeybind(event, { key: "/", ctrl: true })).toBe(false);
  });
});

describe("CYCLE_AGENT keybind (Ctrl/Cmd+.)", () => {
  it("matches Cmd+. on macOS via the Period key code", () => {
    globalThis.window = { api: { platform: "darwin" } } as unknown as Window & typeof globalThis;
    const event = createEvent({ key: ".", code: "Period", metaKey: true });
    expect(matchesKeybind(event, KEYBINDS.CYCLE_AGENT)).toBe(true);
  });

  it("matches Cmd+Shift+Period on layouts where Period requires Shift", () => {
    globalThis.window = { api: { platform: "darwin" } } as unknown as Window & typeof globalThis;
    const event = createEvent({ key: ">", code: "Period", metaKey: true, shiftKey: true });
    expect(matchesKeybind(event, KEYBINDS.CYCLE_AGENT)).toBe(true);
  });
});

describe("thinking adjustment keybinds (Ctrl/Cmd+Shift+[ and ])", () => {
  it("INCREASE_THINKING matches Ctrl+Shift+] via the BracketRight code", () => {
    globalThis.window = { api: { platform: "linux" } } as unknown as Window & typeof globalThis;
    // Shift turns "]" into "}", so matching must key off event.code, not event.key.
    const event = createEvent({ key: "}", code: "BracketRight", ctrlKey: true, shiftKey: true });
    expect(matchesKeybind(event, KEYBINDS.INCREASE_THINKING)).toBe(true);
  });

  it("DECREASE_THINKING matches Cmd+Shift+[ via the BracketLeft code on macOS", () => {
    globalThis.window = { api: { platform: "darwin" } } as unknown as Window & typeof globalThis;
    const event = createEvent({ key: "{", code: "BracketLeft", metaKey: true, shiftKey: true });
    expect(matchesKeybind(event, KEYBINDS.DECREASE_THINKING)).toBe(true);
  });

  it("requires Shift (plain Ctrl+] does not increase)", () => {
    globalThis.window = { api: { platform: "linux" } } as unknown as Window & typeof globalThis;
    const event = createEvent({ key: "]", code: "BracketRight", ctrlKey: true });
    expect(matchesKeybind(event, KEYBINDS.INCREASE_THINKING)).toBe(false);
  });

  it("does not collide with NAVIGATE_BACK/FORWARD (which omit Shift)", () => {
    globalThis.window = { api: { platform: "linux" } } as unknown as Window & typeof globalThis;
    // Ctrl+[ (history back) must not trigger a thinking decrease...
    const back = createEvent({ key: "[", code: "BracketLeft", ctrlKey: true });
    expect(matchesKeybind(back, KEYBINDS.NAVIGATE_BACK)).toBe(true);
    expect(matchesKeybind(back, KEYBINDS.DECREASE_THINKING)).toBe(false);
    // ...and Ctrl+Shift+[ (thinking decrease) must not trigger history back.
    const decrease = createEvent({ key: "{", code: "BracketLeft", ctrlKey: true, shiftKey: true });
    expect(matchesKeybind(decrease, KEYBINDS.DECREASE_THINKING)).toBe(true);
    expect(matchesKeybind(decrease, KEYBINDS.NAVIGATE_BACK)).toBe(false);
  });
});

describe("isKeybindDeprecated", () => {
  it("flags the legacy TOGGLE_THINKING cycle but not the directional keybinds", () => {
    expect(isKeybindDeprecated(KEYBINDS.TOGGLE_THINKING)).toBe(true);
    expect(isKeybindDeprecated(KEYBINDS.INCREASE_THINKING)).toBe(false);
    expect(isKeybindDeprecated(KEYBINDS.DECREASE_THINKING)).toBe(false);
  });
});

test("removed auto agent toggle keybind", () => {
  const removedKey = ["TOGGLE", "AUTO", "AGENT"].join("_");
  expect(KEYBINDS).not.toHaveProperty(removedKey);
});

describe("SEND_MESSAGE_AFTER_TURN keybind (Ctrl/Cmd+Enter)", () => {
  it("matches Ctrl+Enter", () => {
    globalThis.window = { api: { platform: "linux" } } as unknown as Window & typeof globalThis;
    const event = createEvent({ key: "Enter", ctrlKey: true, metaKey: false });
    expect(matchesKeybind(event, KEYBINDS.SEND_MESSAGE_AFTER_TURN)).toBe(true);
  });

  it("matches Cmd+Enter on macOS", () => {
    globalThis.window = { api: { platform: "darwin" } } as unknown as Window & typeof globalThis;
    const event = createEvent({ key: "Enter", metaKey: true, ctrlKey: false });
    expect(matchesKeybind(event, KEYBINDS.SEND_MESSAGE_AFTER_TURN)).toBe(true);
  });

  it("does not match plain Enter", () => {
    globalThis.window = { api: { platform: "linux" } } as unknown as Window & typeof globalThis;
    const event = createEvent({ key: "Enter" });
    expect(matchesKeybind(event, KEYBINDS.SEND_MESSAGE_AFTER_TURN)).toBe(false);
  });

  it("SEND_MESSAGE does not match Ctrl+Enter", () => {
    globalThis.window = { api: { platform: "linux" } } as unknown as Window & typeof globalThis;
    const event = createEvent({ key: "Enter", ctrlKey: true });
    expect(matchesKeybind(event, KEYBINDS.SEND_MESSAGE)).toBe(false);
  });
});

describe("matchesKeybind", () => {
  describe("FOCUS_REVIEW_SEARCH_QUICK keybind (/)", () => {
    it("matches Shift+/ when event.key is /", () => {
      const event = createEvent({ key: "/", shiftKey: true });
      expect(matchesKeybind(event, KEYBINDS.FOCUS_REVIEW_SEARCH_QUICK)).toBe(true);
    });

    it("matches plain /", () => {
      const event = createEvent({ key: "/" });
      expect(matchesKeybind(event, KEYBINDS.FOCUS_REVIEW_SEARCH_QUICK)).toBe(true);
    });

    it("does not match Ctrl+/", () => {
      const event = createEvent({ key: "/", ctrlKey: true });
      expect(matchesKeybind(event, KEYBINDS.FOCUS_REVIEW_SEARCH_QUICK)).toBe(false);
    });

    it("does not match Cmd+/", () => {
      const event = createEvent({ key: "/", metaKey: true });
      expect(matchesKeybind(event, KEYBINDS.FOCUS_REVIEW_SEARCH_QUICK)).toBe(false);
    });
  });

  it("should return false when event.key is undefined", () => {
    // This can happen with dead keys, modifier-only events, etc.
    const event = createEvent({ key: undefined as unknown as string });
    const keybind: Keybind = { key: "a" };

    expect(matchesKeybind(event, keybind)).toBe(false);
  });

  it("should return false when event.key is empty string", () => {
    const event = createEvent({ key: "" });
    const keybind: Keybind = { key: "a" };

    expect(matchesKeybind(event, keybind)).toBe(false);
  });

  it("should match simple key press", () => {
    const event = createEvent({ key: "a" });
    const keybind: Keybind = { key: "a" };

    expect(matchesKeybind(event, keybind)).toBe(true);
  });

  it("should match case-insensitively", () => {
    const event = createEvent({ key: "A" });
    const keybind: Keybind = { key: "a" };

    expect(matchesKeybind(event, keybind)).toBe(true);
  });

  it("should not match different key", () => {
    const event = createEvent({ key: "b" });
    const keybind: Keybind = { key: "a" };

    expect(matchesKeybind(event, keybind)).toBe(false);
  });

  it("should match Ctrl+key combination", () => {
    const event = createEvent({ key: "n", ctrlKey: true });
    const keybind: Keybind = { key: "n", ctrl: true };

    expect(matchesKeybind(event, keybind)).toBe(true);
  });

  it("should not match when Ctrl is required but not pressed", () => {
    const event = createEvent({ key: "n", ctrlKey: false });
    const keybind: Keybind = { key: "n", ctrl: true };

    expect(matchesKeybind(event, keybind)).toBe(false);
  });

  it("should not match when Ctrl is pressed but not required", () => {
    const event = createEvent({ key: "n", ctrlKey: true });
    const keybind: Keybind = { key: "n" };

    expect(matchesKeybind(event, keybind)).toBe(false);
  });

  it("should match Shift+key combination", () => {
    const event = createEvent({ key: "G", shiftKey: true });
    const keybind: Keybind = { key: "G", shift: true };

    expect(matchesKeybind(event, keybind)).toBe(true);
  });

  it("should match Alt+key combination", () => {
    const event = createEvent({ key: "a", altKey: true });
    const keybind: Keybind = { key: "a", alt: true };

    expect(matchesKeybind(event, keybind)).toBe(true);
  });

  it("should match Ctrl/Cmd+Shift+P for OPEN_COMMAND_PALETTE", () => {
    const event = createEvent({ key: "P", ctrlKey: true, shiftKey: true });

    expect(matchesKeybind(event, KEYBINDS.OPEN_COMMAND_PALETTE)).toBe(true);
  });

  it("should match F4 for OPEN_COMMAND_PALETTE_ACTIONS", () => {
    const event = createEvent({ key: "F4" });

    expect(matchesKeybind(event, KEYBINDS.OPEN_COMMAND_PALETTE_ACTIONS)).toBe(true);
  });

  it("should match complex multi-modifier combination", () => {
    const event = createEvent({ key: "P", ctrlKey: true, shiftKey: true });
    const keybind: Keybind = { key: "P", ctrl: true, shift: true };

    expect(matchesKeybind(event, keybind)).toBe(true);
  });
});

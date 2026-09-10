/**
 * Vim Command Integration Tests
 *
 * These tests verify complete Vim command workflows, not isolated utility functions.
 * Each test simulates a sequence of key presses and verifies the final state.
 *
 * Test format:
 * - Initial state: text, cursor position, mode
 * - Execute: sequence of key presses (e.g., ["Escape", "d", "$"])
 * - Assert: final text, cursor position, mode, yank buffer
 *
 * This approach catches integration bugs that unit tests miss:
 * - Cursor positioning across mode transitions
 * - Operator-motion composition
 * - State management between key presses
 *
 * Keep in sync with:
 * - docs/config/vim-mode.mdx (user documentation)
 * - src/browser/components/VimTextArea.tsx (React component integration)
 * - src/browser/utils/vim.ts (core Vim logic)
 */

import { describe, expect, test } from "@jest/globals";
import * as vim from "./vim";

/**
 * Execute a sequence of Vim commands and return the final state.
 * Uses the real handleKeyPress() function from vim.ts for complete integration testing.
 */
function executeVimCommands(initial: vim.VimState, keys: string[]): vim.VimState {
  let state = { ...initial };

  const applyBrowserKey = (current: vim.VimState, key: string, ctrl: boolean): vim.VimState => {
    if (ctrl) return current;
    if (current.mode !== "insert") return current;

    const cursor = Math.max(0, Math.min(current.cursor, current.text.length));

    if (key === "Backspace") {
      if (cursor === 0) return current;
      return {
        ...current,
        text: current.text.slice(0, cursor - 1) + current.text.slice(cursor),
        cursor: cursor - 1,
      };
    }

    if (key === "Enter") {
      return {
        ...current,
        text: current.text.slice(0, cursor) + "\n" + current.text.slice(cursor),
        cursor: cursor + 1,
      };
    }

    // Most single-character keys insert themselves.
    if (key.length === 1) {
      return {
        ...current,
        text: current.text.slice(0, cursor) + key + current.text.slice(cursor),
        cursor: cursor + 1,
      };
    }

    return current;
  };

  for (const key of keys) {
    // Parse key string to extract modifiers
    const ctrl = key.startsWith("Ctrl-");
    const actualKey = ctrl ? key.slice(5) : key;

    const result = vim.handleKeyPress(state, actualKey, { ctrl });

    if (result.handled) {
      state = result.newState;
      continue;
    }

    // If not handled, simulate the browser behavior (e.g. typing in insert mode).
    state = applyBrowserKey(state, actualKey, ctrl);
  }

  return state;
}

describe("Vim Command Integration Tests", () => {
  const initialState: vim.VimState = {
    text: "",
    cursor: 0,
    mode: "insert",
    visualAnchor: null,
    yankBuffer: "",
    desiredColumn: null,
    lastFind: null,
    count: null,
    pending: null,
    undoStack: [],
    redoStack: [],
    insertStartSnapshot: null,
    lastEdit: null,
  };

  describe("Mode Transitions", () => {
    test("ESC enters normal mode from insert", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello", cursor: 5, mode: "insert" },
        ["Escape"]
      );
      expect(state.mode).toBe("normal");
      expect(state.cursor).toBe(4); // Clamps to last char
    });

    test("i enters insert mode at cursor", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello", cursor: 2, mode: "normal" },
        ["i"]
      );
      expect(state.mode).toBe("insert");
      expect(state.cursor).toBe(2);
    });

    test("a enters insert mode after cursor", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello", cursor: 2, mode: "normal" },
        ["a"]
      );
      expect(state.mode).toBe("insert");
      expect(state.cursor).toBe(3);
    });

    test("o opens line below", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello\nworld", cursor: 2, mode: "normal" },
        ["o"]
      );
      expect(state.mode).toBe("insert");
      expect(state.text).toBe("hello\n\nworld");
      expect(state.cursor).toBe(6);
    });
  });

  describe("Visual mode", () => {
    test("v enters visual mode and Escape exits to normal at selection start", () => {
      const afterV = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 0, mode: "normal" },
        ["v"]
      );

      expect(afterV.mode).toBe("visual");
      expect(afterV.visualAnchor).toBe(0);
      expect(afterV.cursor).toBe(0);

      const afterEsc = executeVimCommands(afterV, ["Escape"]);
      expect(afterEsc.mode).toBe("normal");
      expect(afterEsc.visualAnchor).toBeNull();
      expect(afterEsc.cursor).toBe(0);
    });

    test("motions extend the selection (v + w)", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 0, mode: "normal" },
        ["v", "w"]
      );

      expect(state.mode).toBe("visual");
      expect(state.visualAnchor).toBe(0);
      expect(state.cursor).toBe(6);

      expect(vim.getVisualRange(state)).toEqual({ start: 0, end: 7, kind: "char" });
    });

    test("visual operators act on the selection (d/c/y)", () => {
      const initial = { ...initialState, text: "hello world", cursor: 0, mode: "normal" as const };

      const deleted = executeVimCommands(initial, ["v", "w", "d"]);
      expect(deleted.mode).toBe("normal");
      expect(deleted.visualAnchor).toBeNull();
      expect(deleted.text).toBe("orld");
      expect(deleted.cursor).toBe(0);
      expect(deleted.yankBuffer).toBe("hello w");

      const changed = executeVimCommands(initial, ["v", "w", "c"]);
      expect(changed.mode).toBe("insert");
      expect(changed.visualAnchor).toBeNull();
      expect(changed.text).toBe("orld");
      expect(changed.cursor).toBe(0);
      expect(changed.yankBuffer).toBe("hello w");

      const yanked = executeVimCommands(initial, ["v", "w", "y"]);
      expect(yanked.mode).toBe("normal");
      expect(yanked.visualAnchor).toBeNull();
      expect(yanked.text).toBe("hello world");
      expect(yanked.cursor).toBe(0);
      expect(yanked.yankBuffer).toBe("hello w");
    });

    test("V enters visual line mode and d deletes whole lines", () => {
      const state = executeVimCommands(
        { ...initialState, text: "one\ntwo\nthree", cursor: 0, mode: "normal" },
        ["V", "j", "d"]
      );

      expect(state.mode).toBe("normal");
      expect(state.visualAnchor).toBeNull();
      expect(state.text).toBe("three");
      expect(state.cursor).toBe(0);
      expect(state.yankBuffer).toBe("one\ntwo\n");
    });

    test("V enters visual line mode and c changes whole lines", () => {
      const state = executeVimCommands(
        { ...initialState, text: "one\ntwo\nthree", cursor: 0, mode: "normal" },
        ["V", "j", "c"]
      );

      expect(state.mode).toBe("insert");
      expect(state.visualAnchor).toBeNull();
      expect(state.text).toBe("\nthree");
      expect(state.cursor).toBe(0);
      expect(state.yankBuffer).toBe("one\ntwo");
    });
  });

  describe("Navigation", () => {
    test("w moves to next word", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world foo", cursor: 0, mode: "normal" },
        ["w"]
      );
      expect(state.cursor).toBe(6);
    });

    test("b moves to previous word", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world foo", cursor: 12, mode: "normal" },
        ["b"]
      );
      expect(state.cursor).toBe(6);
    });

    test("$ moves to end of line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 0, mode: "normal" },
        ["$"]
      );
      expect(state.cursor).toBe(10); // On last char, not past it
    });

    test("0 moves to start of line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 10, mode: "normal" },
        ["0"]
      );
      expect(state.cursor).toBe(0);
    });

    test("w skips punctuation separators like hyphen", () => {
      const initial = {
        ...initialState,
        text: "asd-f asdf asdf",
        cursor: 0,
        mode: "normal" as const,
      };

      const afterFirstW = executeVimCommands(initial, ["w"]);
      expect(afterFirstW.cursor).toBe(4);

      const afterSecondW = executeVimCommands(afterFirstW, ["w"]);
      expect(afterSecondW.cursor).toBe(6);
    });

    test("e moves past punctuation to end of next word", () => {
      const state = executeVimCommands(
        {
          ...initialState,
          text: "asd-f asdf asdf",
          cursor: 3,
          mode: "normal",
        },
        ["e"]
      );

      expect(state.cursor).toBe(4);
    });
  });

  describe("Find/till (f/F/t/T)", () => {
    test("fx moves to next match on the line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "abcxdefx", cursor: 0, mode: "normal" },
        ["f", "x"]
      );
      expect(state.cursor).toBe(3);
      expect(state.lastFind).toEqual({ variant: "f", char: "x" });
    });

    test("tx moves to just before next match", () => {
      const state = executeVimCommands(
        { ...initialState, text: "abcxdefx", cursor: 0, mode: "normal" },
        ["t", "x"]
      );
      expect(state.cursor).toBe(2);
      expect(state.lastFind).toEqual({ variant: "t", char: "x" });
    });

    test("Tx moves to just after previous match", () => {
      const state = executeVimCommands(
        { ...initialState, text: "abcxdefx", cursor: 7, mode: "normal" },
        ["T", "x"]
      );
      expect(state.cursor).toBe(4);
      expect(state.lastFind).toEqual({ variant: "T", char: "x" });
    });

    test("F, finds punctuation backwards", () => {
      const state = executeVimCommands(
        { ...initialState, text: "a,b,c", cursor: 4, mode: "normal" },
        ["F", ","]
      );
      expect(state.cursor).toBe(3);
      expect(state.lastFind).toEqual({ variant: "F", char: "," });
    });

    test("3fx uses count to find the third match", () => {
      const state = executeVimCommands(
        { ...initialState, text: "axxx", cursor: 0, mode: "normal" },
        ["3", "f", "x"]
      );
      expect(state.cursor).toBe(3);
    });
  });

  describe("Find repeat (; and ,)", () => {
    test("; repeats last find in the same direction", () => {
      const state = executeVimCommands(
        { ...initialState, text: "axxx", cursor: 0, mode: "normal" },
        ["f", "x", ";"]
      );
      expect(state.cursor).toBe(2);
      expect(state.lastFind).toEqual({ variant: "f", char: "x" });
    });

    test(", repeats last find in the opposite direction", () => {
      const state = executeVimCommands(
        { ...initialState, text: "axxx", cursor: 0, mode: "normal" },
        ["f", "x", ";", ","]
      );
      expect(state.cursor).toBe(1);
      expect(state.lastFind).toEqual({ variant: "f", char: "x" });
    });
  });
  describe("Line Navigation (gg/G)", () => {
    const text = "aaa\nbbb\nccc\nddd\neee";

    test("gg goes to first line (preserves column)", () => {
      const state = executeVimCommands({ ...initialState, text, cursor: 14, mode: "normal" }, [
        "g",
        "g",
      ]);
      expect(state.cursor).toBe(2);
    });

    test("5gg goes to line 5 (preserves column)", () => {
      const state = executeVimCommands({ ...initialState, text, cursor: 1, mode: "normal" }, [
        "5",
        "g",
        "g",
      ]);
      expect(state.cursor).toBe(17);
    });

    test("G goes to last line", () => {
      const state = executeVimCommands({ ...initialState, text, cursor: 5, mode: "normal" }, ["G"]);
      expect(state.cursor).toBe(17);
    });

    test("3G goes to line 3", () => {
      const state = executeVimCommands({ ...initialState, text, cursor: 2, mode: "normal" }, [
        "3",
        "G",
      ]);
      expect(state.cursor).toBe(10);
    });
  });

  describe("Pending timeout", () => {
    test("stale g-prefix pending is cleared before handling next key", () => {
      const text = "aaa\nbbb";
      const state = executeVimCommands(
        {
          ...initialState,
          text,
          cursor: 5,
          mode: "normal",
          pending: { kind: "g", at: 0, count: 1 },
        },
        ["g"]
      );

      // If the old pending hadn't timed out, we'd treat this as `gg` and jump to the first line.
      expect(state.cursor).toBe(5);
      expect(state.pending?.kind).toBe("g");
    });

    test("stale operator pending is cleared before handling next key", () => {
      const state = executeVimCommands(
        {
          ...initialState,
          text: "hello world",
          cursor: 0,
          mode: "normal",
          pending: { kind: "op", op: "d", at: 0, count: 1, args: [] },
        },
        ["w"]
      );

      // If the old pending hadn't timed out, we'd treat this as `dw` and delete text.
      expect(state.text).toBe("hello world");
      expect(state.cursor).toBe(6);
      expect(state.pending).toBeNull();
    });

    test("stale find pending is cleared before handling next key", () => {
      const state = executeVimCommands(
        {
          ...initialState,
          text: "hello",
          cursor: 1,
          mode: "normal",
          pending: { kind: "find", variant: "f", at: 0, count: 1 },
        },
        ["x"]
      );

      // If the old pending hadn't timed out, we'd treat this as `fx` (find) and not delete.
      expect(state.text).toBe("hllo");
      expect(state.yankBuffer).toBe("e");
      expect(state.pending).toBeNull();
    });
  });
  describe("WORD Motions (W/B/E)", () => {
    test("W moves to next WORD (whitespace-separated)", () => {
      const state = executeVimCommands(
        { ...initialState, text: "asd-f asdf asdf", cursor: 0, mode: "normal" },
        ["W"]
      );

      expect(state.cursor).toBe(6);
    });

    test("B moves to previous WORD", () => {
      const state = executeVimCommands(
        { ...initialState, text: "asd-f asdf asdf", cursor: 11, mode: "normal" },
        ["B"]
      );

      expect(state.cursor).toBe(6);
    });

    test("E moves to end of current WORD", () => {
      const state = executeVimCommands(
        { ...initialState, text: "asd-f asdf asdf", cursor: 0, mode: "normal" },
        ["E"]
      );

      expect(state.cursor).toBe(4);
    });

    test("E at end of WORD moves to end of next WORD", () => {
      const state = executeVimCommands(
        { ...initialState, text: "asd-f asdf asdf", cursor: 4, mode: "normal" },
        ["E"]
      );

      expect(state.cursor).toBe(9);
    });
  });

  describe("Simple Edits", () => {
    test("x deletes character under cursor", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello", cursor: 1, mode: "normal" },
        ["x"]
      );
      expect(state.text).toBe("hllo");
      expect(state.cursor).toBe(1);
      expect(state.yankBuffer).toBe("e");
    });

    test("p pastes after cursor", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello", cursor: 2, mode: "normal", yankBuffer: "XX" },
        ["p"]
      );
      expect(state.text).toBe("helXXlo");
      expect(state.cursor).toBe(4);
    });

    test("P pastes before cursor", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello", cursor: 2, mode: "normal", yankBuffer: "XX" },
        ["P"]
      );
      expect(state.text).toBe("heXXllo");
      expect(state.cursor).toBe(2);
    });

    test("s substitutes character under cursor", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello", cursor: 1, mode: "normal" },
        ["s"]
      );
      expect(state.text).toBe("hllo");
      expect(state.cursor).toBe(1);
      expect(state.mode).toBe("insert");
      expect(state.yankBuffer).toBe("e");
    });

    test("s at end of text does nothing", () => {
      // Normal-mode cursor cannot be `cursor === text.length` for non-empty text.
      // Use an empty buffer to represent being at the end of the text.
      const state = executeVimCommands({ ...initialState, text: "", cursor: 0, mode: "normal" }, [
        "s",
      ]);
      expect(state.text).toBe("");
      expect(state.mode).toBe("normal");
    });

    test("~ toggles case of character under cursor", () => {
      const state = executeVimCommands(
        { ...initialState, text: "HeLLo", cursor: 0, mode: "normal" },
        ["~"]
      );
      expect(state.text).toBe("heLLo");
      expect(state.cursor).toBe(1);
    });

    test("~ toggles case and moves through word", () => {
      const state = executeVimCommands(
        { ...initialState, text: "HeLLo", cursor: 0, mode: "normal" },
        ["~", "~", "~"]
      );
      expect(state.text).toBe("hElLo");
      expect(state.cursor).toBe(3);
    });

    test("~ on non-letter does nothing but advances cursor", () => {
      const state = executeVimCommands(
        { ...initialState, text: "a 1 b", cursor: 1, mode: "normal" },
        ["~"]
      );
      expect(state.text).toBe("a 1 b");
      expect(state.cursor).toBe(2);
    });

    test("~ at end of text does not advance cursor", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello", cursor: 4, mode: "normal" },
        ["~"]
      );
      expect(state.text).toBe("hellO");
      expect(state.cursor).toBe(4);
    });
  });

  describe("Line Operations", () => {
    test("dd deletes line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello\nworld\nfoo", cursor: 8, mode: "normal" },
        ["d", "d"]
      );
      expect(state.text).toBe("hello\nfoo");
      expect(state.yankBuffer).toBe("world\n");
    });

    test("yy yanks line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello\nworld", cursor: 2, mode: "normal" },
        ["y", "y"]
      );
      expect(state.text).toBe("hello\nworld"); // Text unchanged
      expect(state.yankBuffer).toBe("hello\n");
    });

    test("cc changes line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello\nworld\nfoo", cursor: 8, mode: "normal" },
        ["c", "c"]
      );
      expect(state.text).toBe("hello\n\nfoo");
      expect(state.mode).toBe("insert");
      expect(state.yankBuffer).toBe("world");
    });
  });

  describe("Operator + Motion: Delete", () => {
    test("d$ deletes to end of line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 6, mode: "normal" },
        ["d", "$"]
      );
      expect(state.text).toBe("hello ");
      expect(state.cursor).toBe(5); // Normal mode clamps to last char
      expect(state.yankBuffer).toBe("world");
    });

    test("D deletes to end of line (shortcut)", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 6, mode: "normal" },
        ["D"]
      );
      expect(state.text).toBe("hello ");
      expect(state.cursor).toBe(5); // Normal mode clamps to last char
    });

    test("d0 deletes to beginning of line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 6, mode: "normal" },
        ["d", "0"]
      );
      expect(state.text).toBe("world");
      expect(state.yankBuffer).toBe("hello ");
    });

    test("dw deletes to next word", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world foo", cursor: 0, mode: "normal" },
        ["d", "w"]
      );
      expect(state.text).toBe("world foo");
      expect(state.yankBuffer).toBe("hello ");
    });

    test("dfx deletes through next matching character", () => {
      const state = executeVimCommands(
        { ...initialState, text: "abcxdef", cursor: 0, mode: "normal" },
        ["d", "f", "x"]
      );
      expect(state.text).toBe("def");
      expect(state.cursor).toBe(0);
      expect(state.yankBuffer).toBe("abcx");
      expect(state.lastFind).toEqual({ variant: "f", char: "x" });
    });

    test("dFx deletes backward through previous matching character (includes cursor)", () => {
      const state = executeVimCommands(
        { ...initialState, text: "abcxdef", cursor: 6, mode: "normal" },
        ["d", "F", "x"]
      );
      expect(state.text).toBe("abc");
      expect(state.cursor).toBe(2);
      expect(state.yankBuffer).toBe("xdef");
      expect(state.lastFind).toEqual({ variant: "F", char: "x" });
    });

    test("dTx deletes backward till after previous matching character (includes cursor)", () => {
      const state = executeVimCommands(
        { ...initialState, text: "abcxdef", cursor: 6, mode: "normal" },
        ["d", "T", "x"]
      );
      expect(state.text).toBe("abcx");
      expect(state.cursor).toBe(3);
      expect(state.yankBuffer).toBe("def");
      expect(state.lastFind).toEqual({ variant: "T", char: "x" });
    });

    test("dW deletes to next WORD (whitespace-separated)", () => {
      const state = executeVimCommands(
        { ...initialState, text: "foo-bar baz", cursor: 0, mode: "normal" },
        ["d", "W"]
      );
      expect(state.text).toBe("baz");
      expect(state.yankBuffer).toBe("foo-bar ");
    });
    test("db deletes to previous word", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world foo", cursor: 12, mode: "normal" },
        ["d", "b"]
      );
      expect(state.text).toBe("hello foo");
    });
  });

  describe("Operator + Motion: Change", () => {
    test("c$ changes to end of line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 6, mode: "normal" },
        ["c", "$"]
      );
      expect(state.text).toBe("hello ");
      expect(state.mode).toBe("insert");
      expect(state.cursor).toBe(6);
    });

    test("C changes to end of line (shortcut)", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 6, mode: "normal" },
        ["C"]
      );
      expect(state.text).toBe("hello ");
      expect(state.mode).toBe("insert");
    });

    test("c0 changes to beginning of line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 6, mode: "normal" },
        ["c", "0"]
      );
      expect(state.text).toBe("world");
      expect(state.mode).toBe("insert");
    });

    test("ctx changes until next matching character", () => {
      const state = executeVimCommands(
        { ...initialState, text: "abcxdef", cursor: 0, mode: "normal" },
        ["c", "t", "x"]
      );
      expect(state.text).toBe("xdef");
      expect(state.cursor).toBe(0);
      expect(state.mode).toBe("insert");
      expect(state.yankBuffer).toBe("abc");
      expect(state.lastFind).toEqual({ variant: "t", char: "x" });
    });

    test("cFx changes backward through previous matching character (includes cursor)", () => {
      const state = executeVimCommands(
        { ...initialState, text: "abcxdef", cursor: 6, mode: "normal" },
        ["c", "F", "x"]
      );
      expect(state.text).toBe("abc");
      expect(state.cursor).toBe(3);
      expect(state.mode).toBe("insert");
      expect(state.yankBuffer).toBe("xdef");
      expect(state.lastFind).toEqual({ variant: "F", char: "x" });
    });

    test("cTx changes backward till after previous matching character (includes cursor)", () => {
      const state = executeVimCommands(
        { ...initialState, text: "abcxdef", cursor: 6, mode: "normal" },
        ["c", "T", "x"]
      );
      expect(state.text).toBe("abcx");
      expect(state.cursor).toBe(4);
      expect(state.mode).toBe("insert");
      expect(state.yankBuffer).toBe("def");
      expect(state.lastFind).toEqual({ variant: "T", char: "x" });
    });

    test("cw changes to end of word (like ce)", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 0, mode: "normal" },
        ["c", "w"]
      );
      expect(state.text).toBe(" world");
      expect(state.mode).toBe("insert");
    });

    test("cw differs from dw (cw like ce)", () => {
      const dwState = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 0, mode: "normal" },
        ["d", "w"]
      );
      expect(dwState.text).toBe("world");

      const cwState = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 0, mode: "normal" },
        ["c", "w"]
      );
      expect(cwState.text).toBe(" world");
    });

    test("cW changes to end of WORD when on WORD char (like cE)", () => {
      const state = executeVimCommands(
        { ...initialState, text: "foo-bar baz", cursor: 0, mode: "normal" },
        ["c", "W"]
      );
      expect(state.text).toBe(" baz");
      expect(state.yankBuffer).toBe("foo-bar");
      expect(state.mode).toBe("insert");
    });

    test("cE changes to end of WORD", () => {
      const state = executeVimCommands(
        { ...initialState, text: "foo-bar baz", cursor: 0, mode: "normal" },
        ["c", "E"]
      );
      expect(state.text).toBe(" baz");
      expect(state.mode).toBe("insert");
    });
  });

  describe("Operator + Motion: Yank", () => {
    test("y$ yanks to end of line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 6, mode: "normal" },
        ["y", "$"]
      );
      expect(state.text).toBe("hello world"); // Text unchanged
      expect(state.yankBuffer).toBe("world");
      expect(state.mode).toBe("normal");
    });

    test("y0 yanks to beginning of line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 6, mode: "normal" },
        ["y", "0"]
      );
      expect(state.text).toBe("hello world");
      expect(state.yankBuffer).toBe("hello ");
    });

    test("yw yanks to next word", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 0, mode: "normal" },
        ["y", "w"]
      );
      expect(state.text).toBe("hello world");
      expect(state.yankBuffer).toBe("hello ");
    });
  });

  describe("Operator + Text Objects", () => {
    test("daw deletes a word including trailing whitespace", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world foo", cursor: 0, mode: "normal" },
        ["d", "a", "w"]
      );

      expect(state.text).toBe("world foo");
      expect(state.cursor).toBe(0);
      expect(state.mode).toBe("normal");
      expect(state.yankBuffer).toBe("hello ");
    });

    test("caw changes a word including trailing whitespace", () => {
      const state = executeVimCommands(
        { ...initialState, text: "one two three", cursor: 4, mode: "normal" },
        ["c", "a", "w"]
      );

      expect(state.text).toBe("one three");
      expect(state.cursor).toBe(4);
      expect(state.mode).toBe("insert");
      expect(state.yankBuffer).toBe("two ");
    });

    test('di" deletes inside quotes on the current line', () => {
      const text = 'const s = "hello world";';
      const cursor = text.indexOf("world");

      const state = executeVimCommands({ ...initialState, text, cursor, mode: "normal" }, [
        "d",
        "i",
        '"',
      ]);

      expect(state.text).toBe('const s = "";');
      expect(state.mode).toBe("normal");
      expect(state.yankBuffer).toBe("hello world");
    });

    test("ci( changes inside parentheses on the current line", () => {
      const text = "foo(bar) baz";
      const cursor = text.indexOf("bar") + 1; // inside the parens

      const state = executeVimCommands({ ...initialState, text, cursor, mode: "normal" }, [
        "c",
        "i",
        "(",
      ]);

      expect(state.text).toBe("foo() baz");
      expect(state.mode).toBe("insert");
      expect(state.cursor).toBe(4);
      expect(state.yankBuffer).toBe("bar");
    });

    test('di" is a no-op when no quotes are found on the line', () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 0, mode: "normal", yankBuffer: "prev" },
        ["d", "i", '"']
      );

      expect(state.text).toBe("hello world");
      expect(state.mode).toBe("normal");
      expect(state.yankBuffer).toBe("prev");
      expect(state.pending).toBeNull();
    });
  });
  describe("Complex Workflows", () => {
    test("ESC then d$ deletes from insert cursor to end", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 6, mode: "insert" },
        ["Escape", "d", "$"]
      );
      // In Vim, exiting insert mode moves the cursor left by 1.
      // Cursor at 6 in insert mode becomes 5 after ESC (on the space before "world").
      // d$ deletes from that space to the end of the line.
      expect(state.text).toBe("hello");
      expect(state.mode).toBe("normal");
    });

    test("navigate with w, then delete with dw", () => {
      const state = executeVimCommands(
        { ...initialState, text: "one two three", cursor: 0, mode: "normal" },
        ["w", "d", "w"]
      );
      expect(state.text).toBe("one three");
    });

    test("yank line, navigate, paste", () => {
      const state = executeVimCommands(
        { ...initialState, text: "first\nsecond\nthird", cursor: 0, mode: "normal" },
        ["y", "y", "j", "j", "p"]
      );
      expect(state.yankBuffer).toBe("first\n");
      // After yy: cursor at 0, yank "first\n"
      // After jj: cursor moves down 2 lines to "third" (at index 13, on 't')
      // After p: pastes "first\n" after cursor position (character-wise in test harness)
      // Note: Real Vim would do line-wise paste, but test harness does character-wise
      expect(state.text).toBe("first\nsecond\ntfirst\nhird");
    });

    test("delete word, move, paste", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world foo", cursor: 0, mode: "normal" },
        ["d", "w", "w", "p"]
      );
      expect(state.yankBuffer).toBe("hello ");
      // After dw: text = "world foo", cursor at 0, yank "hello "
      // After w: cursor moves to start of "foo" (index 6)
      // After p: paste "hello " after cursor
      expect(state.text).toBe("world fhello oo");
    });
  });

  describe("Edge Cases", () => {
    test("$ on empty line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello\n\nworld", cursor: 6, mode: "normal" },
        ["$"]
      );
      expect(state.cursor).toBe(6); // Empty line, stays at newline char
    });

    test("w at end of text", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello", cursor: 4, mode: "normal" },
        ["w"]
      );
      expect(state.cursor).toBe(4); // Clamps to last char
    });

    test("d$ at end of line deletes last char", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello", cursor: 4, mode: "normal" },
        ["d", "$"]
      );
      // Cursor at 4 (on 'o'), d$ deletes from 'o' to line end
      expect(state.text).toBe("hell");
    });

    test("x at end of text does nothing", () => {
      // Normal-mode cursor cannot be `cursor === text.length` for non-empty text.
      // Use an empty buffer to represent being at the end of the text.
      const state = executeVimCommands({ ...initialState, text: "", cursor: 0, mode: "normal" }, [
        "x",
      ]);
      expect(state.text).toBe("");
    });
  });

  describe("Reported Issues", () => {
    test("issue #1: ciw should delete inner word correctly", () => {
      // User reported: "ciw sometimes leaves a blank character highlighted"
      // Root cause: test harness was treating 'w' in 'ciw' as a motion, not text object
      // This caused 'ciw' to behave like 'cw' (change word forward)
      const state = executeVimCommands(
        { ...initialState, text: "hello world foo", cursor: 6, mode: "normal" },
        ["c", "i", "w"]
      );
      expect(state.text).toBe("hello  foo"); // Only "world" deleted, both spaces remain
      expect(state.mode).toBe("insert");
      expect(state.cursor).toBe(6); // Cursor at start of deleted word
    });

    test("issue #2: o on last line should insert line below", () => {
      // In Vim: o opens new line below current line, even on last line
      const state = executeVimCommands(
        { ...initialState, text: "first\nsecond\nthird", cursor: 15, mode: "normal" },
        ["o"]
      );
      expect(state.mode).toBe("insert");
      expect(state.text).toBe("first\nsecond\nthird\n"); // New line added
      expect(state.cursor).toBe(19); // Cursor on new line
    });
  });

  describe("e/E motion", () => {
    test("e moves to end of current word", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 1, mode: "normal" },
        ["e"]
      );
      expect(state.cursor).toBe(4);
    });

    test("de deletes to end of word", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 1, mode: "normal" },
        ["d", "e"]
      );
      expect(state.text).toBe("h world");
      expect(state.yankBuffer).toBe("ello");
    });

    test("ce changes to end of word", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 1, mode: "normal" },
        ["c", "e"]
      );
      expect(state.text).toBe("h world");
      expect(state.mode).toBe("insert");
    });

    test("e at end of word moves to end of next word", () => {
      // Bug: when cursor is at end of word, 'e' should move to end of next word
      const state = executeVimCommands(
        { ...initialState, text: "hello world foo", cursor: 4, mode: "normal" }, // cursor on 'o' (end of "hello")
        ["e"]
      );
      expect(state.cursor).toBe(10); // Should move to end of "world" (not stay at 4)
    });

    test("e at end of word with punctuation moves correctly", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello, world", cursor: 4, mode: "normal" }, // cursor on 'o' (end of "hello")
        ["e"]
      );
      expect(state.cursor).toBe(11); // Should move to end of "world"
    });
  });

  describe("Count Prefixes", () => {
    test("3w moves forward three words", () => {
      const state = executeVimCommands(
        { ...initialState, text: "one two three four", cursor: 0, mode: "normal" },
        ["3", "w"]
      );
      expect(state.cursor).toBe(14);
    });

    test("20l moves right 20 characters (0 appends to count)", () => {
      const state = executeVimCommands(
        { ...initialState, text: "abcdefghijklmnopqrstuvwxyz", cursor: 0, mode: "normal" },
        ["2", "0", "l"]
      );
      expect(state.cursor).toBe(20);
    });

    test("5x deletes five characters", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 0, mode: "normal" },
        ["5", "x"]
      );
      expect(state.text).toBe(" world");
      expect(state.cursor).toBe(0);
      expect(state.yankBuffer).toBe("hello");
    });

    test("2dd deletes two lines", () => {
      const state = executeVimCommands(
        { ...initialState, text: "one\ntwo\nthree\nfour", cursor: 0, mode: "normal" },
        ["2", "d", "d"]
      );
      expect(state.text).toBe("three\nfour");
      expect(state.cursor).toBe(0);
      expect(state.yankBuffer).toBe("one\ntwo\n");
    });

    test("2cc changes two lines into a single replacement line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "one\ntwo\nthree", cursor: 0, mode: "normal" },
        ["2", "c", "c"]
      );
      expect(state.text).toBe("\nthree");
      expect(state.cursor).toBe(0);
      expect(state.mode).toBe("insert");
      expect(state.yankBuffer).toBe("one\ntwo");
    });

    test("2c_ changes two lines into a single replacement line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "one\ntwo\nthree", cursor: 0, mode: "normal" },
        ["2", "c", "_"]
      );
      expect(state.text).toBe("\nthree");
      expect(state.cursor).toBe(0);
      expect(state.mode).toBe("insert");
      expect(state.yankBuffer).toBe("one\ntwo");
    });

    test("d3w deletes three words", () => {
      const state = executeVimCommands(
        { ...initialState, text: "one two three four", cursor: 0, mode: "normal" },
        ["d", "3", "w"]
      );
      expect(state.text).toBe("four");
      expect(state.cursor).toBe(0);
      expect(state.yankBuffer).toBe("one two three ");
    });
  });

  describe("Undo / Redo / Dot repeat", () => {
    test("u and Ctrl-r undo/redo normal-mode edits (x)", () => {
      const initial = { ...initialState, text: "abc", cursor: 1, mode: "normal" as const };

      const afterX = executeVimCommands(initial, ["x"]);
      expect(afterX.text).toBe("ac");

      const afterUndo = executeVimCommands(afterX, ["u"]);
      expect(afterUndo.text).toBe("abc");
      expect(afterUndo.cursor).toBe(1);

      const afterRedo = executeVimCommands(afterUndo, ["Ctrl-r"]);
      expect(afterRedo.text).toBe("ac");
      expect(afterRedo.cursor).toBe(1);
    });

    test("u and Ctrl-r undo/redo operator edits (dw)", () => {
      const initial = {
        ...initialState,
        text: "one two three",
        cursor: 0,
        mode: "normal" as const,
      };

      const afterDw = executeVimCommands(initial, ["d", "w"]);
      expect(afterDw.text).toBe("two three");

      const afterUndo = executeVimCommands(afterDw, ["u"]);
      expect(afterUndo.text).toBe("one two three");

      const afterRedo = executeVimCommands(afterUndo, ["Ctrl-r"]);
      expect(afterRedo.text).toBe("two three");
    });

    test("insert-mode typing is grouped into a single undo step", () => {
      const initial = { ...initialState, text: "hello", cursor: 0, mode: "normal" as const };

      const afterInsert = executeVimCommands(initial, ["i", "a", "b", "c", "Escape"]);
      expect(afterInsert.text).toBe("abchello");

      const afterUndo = executeVimCommands(afterInsert, ["u"]);
      expect(afterUndo.text).toBe("hello");
      expect(afterUndo.cursor).toBe(0);
    });

    test("dot repeats last operator edit (dw)", () => {
      const initial = {
        ...initialState,
        text: "one two three",
        cursor: 0,
        mode: "normal" as const,
      };

      const state = executeVimCommands(initial, ["d", "w", "."]);
      expect(state.text).toBe("three");
      expect(state.cursor).toBe(0);
    });

    test("dot repeats last single-key edit (x)", () => {
      const initial = { ...initialState, text: "abcd", cursor: 0, mode: "normal" as const };

      const state = executeVimCommands(initial, ["x", "."]);
      expect(state.text).toBe("cd");
      expect(state.cursor).toBe(0);
    });

    test("dot repeats last visual delete (v...d)", () => {
      const initial = { ...initialState, text: "abcdefghi", cursor: 0, mode: "normal" as const };

      const state = executeVimCommands(initial, ["v", "l", "l", "d", "."]);
      expect(state.text).toBe("ghi");
      expect(state.cursor).toBe(0);
      expect(state.yankBuffer).toBe("def");
    });

    test("dot repeats last visual-line delete (V...d)", () => {
      const initial = {
        ...initialState,
        text: "one\ntwo\nthree\nfour\nfive",
        cursor: 0,
        mode: "normal" as const,
      };

      const state = executeVimCommands(initial, ["V", "j", "d", "."]);
      expect(state.text).toBe("five");
      expect(state.cursor).toBe(0);
      expect(state.yankBuffer).toBe("three\nfour\n");
    });
  });

  describe("_ motion (first non-whitespace character)", () => {
    test("_ moves to first non-whitespace character", () => {
      const state = executeVimCommands(
        { ...initialState, text: "  hello world", cursor: 10, mode: "normal" },
        ["_"]
      );
      expect(state.cursor).toBe(2); // Should move to 'h' (first non-whitespace)
    });

    test("_ on line with no leading whitespace goes to position 0", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 6, mode: "normal" },
        ["_"]
      );
      expect(state.cursor).toBe(0); // Should move to start of line
    });

    test("_ with tabs and spaces", () => {
      const state = executeVimCommands(
        { ...initialState, text: "\t  hello", cursor: 5, mode: "normal" },
        ["_"]
      );
      expect(state.cursor).toBe(3); // Should move to 'h' after tab and spaces
    });

    test("d_ deletes entire line and newline (linewise motion)", () => {
      const state = executeVimCommands(
        { ...initialState, text: "  hello world\nnext", cursor: 10, mode: "normal" },
        ["d", "_"]
      );
      expect(state.text).toBe("next"); // Entire current line removed (including newline)
      expect(state.cursor).toBe(0);
    });

    test("c_ changes entire line like cc", () => {
      const state = executeVimCommands(
        { ...initialState, text: "  hello world\nnext", cursor: 5, mode: "normal" },
        ["c", "_"]
      );
      expect(state.text).toBe("\nnext"); // Line cleared and enters insert mode
      expect(state.mode).toBe("insert");
      expect(state.cursor).toBe(0);
    });

    test("y_ yanks entire line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "  hello world\nnext", cursor: 3, mode: "normal" },
        ["y", "_"]
      );
      expect(state.yankBuffer).toBe("  hello world\n");
      expect(state.text).toBe("  hello world\nnext");
    });
  });
});

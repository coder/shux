/**
 * Core Vim text manipulation utilities.
 * All functions are pure and accept text + cursor position, returning new state.
 *
 * Keep in sync with:
 * - docs/config/vim-mode.mdx (user documentation)
 * - src/browser/components/VimTextArea.tsx (React component integration)
 * - src/browser/utils/vim.test.ts (integration tests)
 */

import assert from "@/common/utils/assert";

export type VimMode = "insert" | "normal" | "visual" | "visualLine";

export interface VimRange {
  start: number;
  end: number;
  kind: "char" | "line";
}

export type FindVariant = "f" | "F" | "t" | "T";

export type VimTextObject =
  | "iw"
  | "aw"
  | 'i"'
  | 'a"'
  | "i'"
  | "a'"
  | "i("
  | "a("
  | "i["
  | "a["
  | "i{"
  | "a{";

export interface LastFind {
  variant: FindVariant;
  char: string;
}

export interface VimHistorySnapshot {
  text: string;
  cursor: number;
}

export type LastEdit =
  | { kind: "x"; count: number }
  | { kind: "~"; count: number }
  | {
      kind: "opMotion";
      op: "d" | "c";
      motion: "w" | "W" | "b" | "B" | "e" | "E" | "$" | "0" | "_" | "line";
      count: number;
    }
  | {
      kind: "opTextObject";
      op: "d" | "c";
      textObject: VimTextObject;
      count: number;
    }
  | {
      kind: "opVisual";
      op: "d" | "c";
      rangeKind: "char" | "line";
      count: number;
    }
  | { kind: "paste"; variant: "p" | "P"; count: number };

export type Pending =
  | {
      kind: "op";
      op: "d" | "y" | "c";
      at: number;
      count: number;
      args?: string[];
    }
  | {
      kind: "g";
      at: number;
      count: number;
    }
  | {
      kind: "find";
      variant: FindVariant;
      at: number;
      count: number;
      /**
       * If present, the find motion is being used as an operator motion (e.g. `dfx`).
       */
      op?: "d" | "y" | "c";
    };

export interface VimState {
  text: string;
  cursor: number;
  mode: VimMode;
  /**
   * Visual selection anchor (set when entering visual modes).
   *
   * Invariants:
   * - null in insert/normal
   * - non-null in visual/visualLine
   */
  visualAnchor: number | null;
  yankBuffer: string;
  desiredColumn: number | null;
  lastFind: LastFind | null;
  /**
   * Numeric count prefix being built (e.g. typing `2` then `0` then `w` -> count=20).
   *
   * Note: `0` is only treated as a count digit if a count is already in progress.
   */
  count: number | null;
  pending: Pending | null;

  /**
   * Engine-driven undo/redo stacks.
   *
   * Notes:
   * - Snapshots intentionally store ONLY text + cursor.
   * - Registers (yankBuffer) are not undone/redone.
   */
  undoStack: VimHistorySnapshot[];
  redoStack: VimHistorySnapshot[];

  /**
   * Snapshot captured when entering insert mode from a Vim command.
   * Used to group all insert-mode typing into a single undo step.
   */
  insertStartSnapshot: VimHistorySnapshot | null;

  /**
   * Last structural edit to repeat with `.`.
   * This does not attempt to replay arbitrary insert-mode typed text.
   */
  lastEdit: LastEdit | null;
}

export type VimAction = "escapeInNormalMode";

export type VimKeyResult =
  | { handled: false } // Browser should handle this key
  | { handled: true; newState: VimState; action?: VimAction }; // Vim handled it

export interface LinesInfo {
  lines: string[];
  starts: number[]; // start index of each line
}

const VIM_HISTORY_STACK_LIMIT = 100;

function assertHistorySnapshot(snapshot: VimHistorySnapshot, label: string): void {
  assert(typeof snapshot.text === "string", `${label}.text must be a string`);
  assert(Number.isFinite(snapshot.cursor), `${label}.cursor must be a finite number`);
  assert(Number.isInteger(snapshot.cursor), `${label}.cursor must be an integer`);
  assert(snapshot.cursor >= 0, `${label}.cursor must be >= 0`);

  const maxCursor = Math.max(0, snapshot.text.length - 1);
  assert(
    snapshot.cursor <= maxCursor,
    `${label}.cursor out of bounds. cursor=${snapshot.cursor} max=${maxCursor} text.length=${snapshot.text.length}`
  );
}

function assertVimState(state: VimState): void {
  assert(
    state.mode === "insert" ||
      state.mode === "normal" ||
      state.mode === "visual" ||
      state.mode === "visualLine",
    "Unexpected Vim mode"
  );
  assert(typeof state.text === "string", "Vim text must be a string");
  assert(typeof state.yankBuffer === "string", "Vim yankBuffer must be a string");

  assert(Number.isFinite(state.cursor), "Vim cursor must be a finite number");
  assert(Number.isInteger(state.cursor), "Vim cursor must be an integer");
  assert(state.cursor >= 0, "Vim cursor must be >= 0");

  const maxCursor =
    state.mode === "insert" ? state.text.length : Math.max(0, state.text.length - 1);
  assert(
    state.cursor <= maxCursor,
    `Vim cursor out of bounds for mode=${state.mode}. cursor=${state.cursor} max=${maxCursor} text.length=${state.text.length}`
  );

  const isVisualMode = state.mode === "visual" || state.mode === "visualLine";

  if (isVisualMode) {
    assert(state.visualAnchor != null, "Vim visualAnchor must be set in visual mode");
  } else {
    assert(state.visualAnchor == null, "Vim visualAnchor must be null outside visual mode");
  }

  if (state.visualAnchor != null) {
    assert(Number.isFinite(state.visualAnchor), "Vim visualAnchor must be a finite number");
    assert(Number.isInteger(state.visualAnchor), "Vim visualAnchor must be an integer");
    assert(state.visualAnchor >= 0, "Vim visualAnchor must be >= 0");
    assert(
      state.visualAnchor <= maxCursor,
      `Vim visualAnchor out of bounds for mode=${state.mode}. visualAnchor=${state.visualAnchor} max=${maxCursor} text.length=${state.text.length}`
    );
  }

  if (state.desiredColumn != null) {
    assert(Number.isFinite(state.desiredColumn), "Vim desiredColumn must be a finite number");
    assert(Number.isInteger(state.desiredColumn), "Vim desiredColumn must be an integer");
    assert(state.desiredColumn >= 0, "Vim desiredColumn must be >= 0");
  }

  if (state.lastFind != null) {
    assert(
      state.lastFind.variant === "f" ||
        state.lastFind.variant === "F" ||
        state.lastFind.variant === "t" ||
        state.lastFind.variant === "T",
      "Unexpected Vim lastFind variant"
    );
    assert(typeof state.lastFind.char === "string", "Vim lastFind.char must be a string");
    assert(state.lastFind.char.length === 1, "Vim lastFind.char must be a single character");
  }

  if (state.count != null) {
    assert(Number.isFinite(state.count), "Vim count must be a finite number");
    assert(Number.isInteger(state.count), "Vim count must be an integer");
    assert(state.count >= 1, "Vim count must be >= 1");
    assert(state.count <= 10000, "Vim count must be <= 10000");
  }
  if (state.pending) {
    const pending = state.pending;

    assert(
      pending.kind === "op" || pending.kind === "g" || pending.kind === "find",
      `Unexpected Vim pending kind: ${String((pending as { kind?: unknown }).kind)}`
    );

    assert(Number.isFinite(pending.at), "Vim pending.at must be a finite timestamp");

    assert(Number.isFinite(pending.count), "Vim pending.count must be a finite number");
    assert(Number.isInteger(pending.count), "Vim pending.count must be an integer");
    assert(pending.count >= 1, "Vim pending.count must be >= 1");
    assert(pending.count <= 10000, "Vim pending.count must be <= 10000");

    if (pending.kind === "op") {
      assert(
        pending.op === "d" || pending.op === "c" || pending.op === "y",
        "Unexpected Vim pending operator"
      );

      if (pending.args != null) {
        assert(Array.isArray(pending.args), "Vim pending.args must be an array");
        for (const arg of pending.args) {
          assert(typeof arg === "string", "Vim pending args must be strings");
        }
      }
    }

    if (pending.kind === "find") {
      assert(
        pending.variant === "f" ||
          pending.variant === "F" ||
          pending.variant === "t" ||
          pending.variant === "T",
        "Unexpected Vim pending find variant"
      );
      if (pending.op != null) {
        assert(
          pending.op === "d" || pending.op === "c" || pending.op === "y",
          "Unexpected Vim pending find operator"
        );
      }
    }
  }

  assert(Array.isArray(state.undoStack), "Vim undoStack must be an array");
  assert(Array.isArray(state.redoStack), "Vim redoStack must be an array");
  assert(
    state.undoStack.length <= VIM_HISTORY_STACK_LIMIT,
    `Vim undoStack too large: ${state.undoStack.length} > ${VIM_HISTORY_STACK_LIMIT}`
  );
  assert(
    state.redoStack.length <= VIM_HISTORY_STACK_LIMIT,
    `Vim redoStack too large: ${state.redoStack.length} > ${VIM_HISTORY_STACK_LIMIT}`
  );

  for (let i = 0; i < state.undoStack.length; i++) {
    assertHistorySnapshot(state.undoStack[i], `Vim undoStack[${i}]`);
  }
  for (let i = 0; i < state.redoStack.length; i++) {
    assertHistorySnapshot(state.redoStack[i], `Vim redoStack[${i}]`);
  }

  if (state.mode === "insert") {
    if (state.insertStartSnapshot != null) {
      assertHistorySnapshot(state.insertStartSnapshot, "Vim insertStartSnapshot");
    }
  } else {
    assert(
      state.insertStartSnapshot == null,
      "Vim insertStartSnapshot must be null outside insert mode"
    );
  }

  if (state.lastEdit != null) {
    const { lastEdit } = state;

    assert(typeof lastEdit.kind === "string", "Vim lastEdit.kind must be a string");

    const assertCount = (count: number) => {
      assert(Number.isFinite(count), "Vim lastEdit.count must be a finite number");
      assert(Number.isInteger(count), "Vim lastEdit.count must be an integer");
      assert(count >= 1, "Vim lastEdit.count must be >= 1");
      assert(count <= 10000, "Vim lastEdit.count must be <= 10000");
    };

    switch (lastEdit.kind) {
      case "x":
      case "~":
        assertCount(lastEdit.count);
        break;

      case "paste":
        assert(
          lastEdit.variant === "p" || lastEdit.variant === "P",
          "Unexpected Vim lastEdit paste variant"
        );
        assertCount(lastEdit.count);
        break;

      case "opMotion":
        assert(lastEdit.op === "d" || lastEdit.op === "c", "Unexpected Vim lastEdit operator");
        assert(
          lastEdit.motion === "w" ||
            lastEdit.motion === "W" ||
            lastEdit.motion === "b" ||
            lastEdit.motion === "B" ||
            lastEdit.motion === "e" ||
            lastEdit.motion === "E" ||
            lastEdit.motion === "$" ||
            lastEdit.motion === "0" ||
            lastEdit.motion === "_" ||
            lastEdit.motion === "line",
          "Unexpected Vim lastEdit motion"
        );
        assertCount(lastEdit.count);
        break;

      case "opTextObject":
        assert(lastEdit.op === "d" || lastEdit.op === "c", "Unexpected Vim lastEdit operator");
        assert(isVimTextObject(lastEdit.textObject), "Unexpected Vim lastEdit text object");
        assertCount(lastEdit.count);
        break;

      case "opVisual":
        assert(lastEdit.op === "d" || lastEdit.op === "c", "Unexpected Vim lastEdit operator");
        assert(
          lastEdit.rangeKind === "char" || lastEdit.rangeKind === "line",
          "Unexpected Vim lastEdit visual range kind"
        );
        assertCount(lastEdit.count);
        break;

      default:
        assert(
          false,
          `Unexpected Vim lastEdit kind: ${String((lastEdit as { kind?: unknown }).kind)}`
        );
    }
  }
}

/**
 * Parse text into lines and compute start indices.
 */
export function getLinesInfo(text: string): LinesInfo {
  const lines = text.split("\n");
  const starts: number[] = [];
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    starts.push(acc);
    acc += lines[i].length + (i < lines.length - 1 ? 1 : 0);
  }
  return { lines, starts };
}

/**
 * Convert index to (row, col) coordinates.
 */
export function getRowCol(text: string, idx: number): { row: number; col: number } {
  const { starts } = getLinesInfo(text);
  let row = 0;
  while (row + 1 < starts.length && starts[row + 1] <= idx) row++;
  const col = idx - starts[row];
  return { row, col };
}

/**
 * Convert (row, col) to index, clamping to valid range.
 */
export function indexAt(text: string, row: number, col: number): number {
  const { lines, starts } = getLinesInfo(text);
  row = Math.max(0, Math.min(row, lines.length - 1));
  col = Math.max(0, Math.min(col, lines[row].length));
  return starts[row] + col;
}

/**
 * Get line bounds (start, end) for the line containing cursor.
 */
export function getLineBounds(
  text: string,
  cursor: number
): { lineStart: number; lineEnd: number; row: number } {
  const { row } = getRowCol(text, cursor);
  const { lines, starts } = getLinesInfo(text);
  const lineStart = starts[row];
  const lineEnd = lineStart + lines[row].length;
  return { lineStart, lineEnd, row };
}

function clampSelectionIndex(text: string, idx: number): number {
  return Math.max(0, Math.min(idx, text.length));
}

function getCharwiseVisualRange(text: string, anchor: number, cursor: number): VimRange {
  // Visual charwise selection is inclusive on both ends, but the DOM range is [start, end).
  const startInclusive = Math.min(anchor, cursor);
  const endInclusive = Math.max(anchor, cursor);

  return {
    start: clampSelectionIndex(text, startInclusive),
    end: clampSelectionIndex(text, endInclusive + 1),
    kind: "char",
  };
}

function getLinewiseVisualRange(text: string, anchor: number, cursor: number): VimRange {
  const { row: anchorRow } = getRowCol(text, anchor);
  const { row: cursorRow } = getRowCol(text, cursor);

  const startRow = Math.min(anchorRow, cursorRow);
  const endRow = Math.max(anchorRow, cursorRow);

  const { lines, starts } = getLinesInfo(text);
  const start = starts[startRow];

  const endLineStart = starts[endRow];
  const endLineEnd = endLineStart + lines[endRow].length;
  const end = endRow < lines.length - 1 ? endLineEnd + 1 : endLineEnd;

  return {
    start: clampSelectionIndex(text, start),
    end: clampSelectionIndex(text, end),
    kind: "line",
  };
}

export function getVisualRange(
  state: Pick<VimState, "text" | "cursor" | "mode" | "visualAnchor">
): VimRange | null {
  if (state.mode !== "visual" && state.mode !== "visualLine") return null;
  if (state.visualAnchor == null) return null;

  return state.mode === "visual"
    ? getCharwiseVisualRange(state.text, state.visualAnchor, state.cursor)
    : getLinewiseVisualRange(state.text, state.visualAnchor, state.cursor);
}

/**
 * Move to first non-whitespace character on current line (like '_').
 */
export function moveToFirstNonWhitespace(text: string, cursor: number): number {
  const { lineStart, lineEnd } = getLineBounds(text, cursor);
  let i = lineStart;
  while (i < lineEnd && /\s/.test(text[i])) {
    i++;
  }
  // If entire line is whitespace, go to line start
  return i >= lineEnd ? lineStart : i;
}

type FindDirection = "forward" | "backward";

function isFindForward(variant: FindVariant): boolean {
  return variant === "f" || variant === "t";
}

function findCharIndexInLine(
  text: string,
  cursor: number,
  targetChar: string,
  direction: FindDirection,
  count: number
): number | null {
  assert(targetChar.length === 1, "Find target must be a single character");

  const safeCount = Math.max(1, Math.min(10000, count));
  const { lineStart, lineEnd } = getLineBounds(text, cursor);

  if (direction === "forward") {
    let searchFrom = cursor + 1;
    if (searchFrom >= lineEnd) return null;

    let match = -1;
    for (let i = 0; i < safeCount; i++) {
      match = text.indexOf(targetChar, searchFrom);
      if (match === -1 || match >= lineEnd) return null;
      searchFrom = match + 1;
    }
    return match;
  }

  let searchFrom = cursor - 1;
  if (searchFrom < lineStart) return null;

  let match = -1;
  for (let i = 0; i < safeCount; i++) {
    match = text.lastIndexOf(targetChar, searchFrom);
    if (match === -1 || match < lineStart) return null;
    searchFrom = match - 1;
  }
  return match;
}

function getFindMotionDestination(
  text: string,
  cursor: number,
  variant: FindVariant,
  targetChar: string,
  count: number
): number | null {
  const { lineStart, lineEnd } = getLineBounds(text, cursor);

  const direction: FindDirection = isFindForward(variant) ? "forward" : "backward";
  const match = findCharIndexInLine(text, cursor, targetChar, direction, count);
  if (match == null) return null;

  switch (variant) {
    case "f":
    case "F":
      return match;
    case "t":
      return Math.max(lineStart, match - 1);
    case "T":
      return Math.min(lineEnd, match + 1);
  }
}

/**
 * Move cursor vertically by delta lines, maintaining desiredColumn if provided.
 */
export function moveVertical(
  text: string,
  cursor: number,
  delta: number,
  desiredColumn: number | null
): { cursor: number; desiredColumn: number } {
  const { row, col } = getRowCol(text, cursor);
  const { lines } = getLinesInfo(text);
  const nextRow = Math.max(0, Math.min(lines.length - 1, row + delta));
  const goal = desiredColumn ?? col;
  const nextCol = Math.max(0, Math.min(goal, lines[nextRow].length));
  return {
    cursor: indexAt(text, nextRow, nextCol),
    desiredColumn: goal,
  };
}

/**
 * Move cursor to next word boundary (like 'w').
 * In normal mode, cursor should never go past the last character.
 */
export function moveWordForward(text: string, cursor: number): number {
  const n = text.length;
  if (n === 0) return 0;

  let i = Math.max(0, Math.min(cursor, n - 1));
  const isWord = (ch: string) => /[A-Za-z0-9_]/.test(ch);

  const advancePastWord = (idx: number): number => {
    let j = idx;
    while (j < n && isWord(text[j])) j++;
    return j;
  };

  const advanceToWord = (idx: number): number => {
    let j = idx;
    while (j < n && !isWord(text[j])) j++;
    return j;
  };

  if (isWord(text[i])) {
    i = advancePastWord(i);
  }

  i = advanceToWord(i);

  if (i >= n) {
    return Math.max(0, n - 1);
  }

  return i;
}

/**
 * Move cursor to next WORD boundary (like 'W').
 * WORD chars are anything that's not whitespace (Vim's "WORD" definition).
 *
 * In normal mode, cursor should never go past the last character.
 */
export function moveWORDForward(text: string, cursor: number): number {
  const n = text.length;
  if (n === 0) return 0;

  let i = Math.max(0, Math.min(cursor, n - 1));
  const isWORD = (ch: string) => !/\s/.test(ch);

  const advancePastWORD = (idx: number): number => {
    let j = idx;
    while (j < n && isWORD(text[j])) j++;
    return j;
  };

  const advanceToWORD = (idx: number): number => {
    let j = idx;
    while (j < n && !isWORD(text[j])) j++;
    return j;
  };

  if (isWORD(text[i])) {
    i = advancePastWORD(i);
  }

  i = advanceToWORD(i);

  if (i >= n) {
    return Math.max(0, n - 1);
  }

  return i;
}

/**
 * Move cursor to end of current/next word (like 'e').
 * If on a word character, goes to end of current word.
 * If already at end of word, goes to end of next word.
 * If on whitespace, goes to end of next word.
 */
export function moveWordEnd(text: string, cursor: number): number {
  const n = text.length;
  if (n === 0) return 0;
  if (cursor >= n - 1) return Math.max(0, n - 1);

  const clamp = Math.max(0, Math.min(cursor, n - 1));
  const isWord = (ch: string) => /[A-Za-z0-9_]/.test(ch);

  if (!isWord(text[clamp])) {
    let i = clamp;
    while (i < n && !isWord(text[i])) i++;
    if (i >= n) return Math.max(0, n - 1);
    while (i < n - 1 && isWord(text[i + 1])) i++;
    return i;
  }

  let endOfCurrent = clamp;
  while (endOfCurrent < n - 1 && isWord(text[endOfCurrent + 1])) endOfCurrent++;

  if (clamp < endOfCurrent) {
    return endOfCurrent;
  }

  let j = endOfCurrent + 1;
  while (j < n && !isWord(text[j])) j++;
  if (j >= n) return Math.max(0, n - 1);

  let endOfNext = j;
  while (endOfNext < n - 1 && isWord(text[endOfNext + 1])) endOfNext++;
  return endOfNext;
}

/**
 * Move cursor to end of current/next WORD (like 'E').
 * WORD chars are anything that's not whitespace (Vim's "WORD" definition).
 */
export function moveWORDEnd(text: string, cursor: number): number {
  const n = text.length;
  if (n === 0) return 0;
  if (cursor >= n - 1) return Math.max(0, n - 1);

  const clamp = Math.max(0, Math.min(cursor, n - 1));
  const isWORD = (ch: string) => !/\s/.test(ch);

  if (!isWORD(text[clamp])) {
    let i = clamp;
    while (i < n && !isWORD(text[i])) i++;
    if (i >= n) return Math.max(0, n - 1);
    while (i < n - 1 && isWORD(text[i + 1])) i++;
    return i;
  }

  let endOfCurrent = clamp;
  while (endOfCurrent < n - 1 && isWORD(text[endOfCurrent + 1])) endOfCurrent++;

  if (clamp < endOfCurrent) {
    return endOfCurrent;
  }

  let j = endOfCurrent + 1;
  while (j < n && !isWORD(text[j])) j++;
  if (j >= n) return Math.max(0, n - 1);

  let endOfNext = j;
  while (endOfNext < n - 1 && isWORD(text[endOfNext + 1])) endOfNext++;
  return endOfNext;
}

/**
 * Move cursor to previous word boundary (like 'b').
 * In normal mode, cursor should never go past the last character.
 */
export function moveWordBackward(text: string, cursor: number): number {
  let i = cursor - 1;
  while (i > 0 && /\s/.test(text[i])) i--;
  while (i > 0 && /[A-Za-z0-9_]/.test(text[i - 1])) i--;
  // Clamp to last character position in normal mode (never past the end)
  return Math.min(Math.max(0, i), Math.max(0, text.length - 1));
}

/**
 * Move cursor to previous WORD boundary (like 'B').
 * WORD chars are anything that's not whitespace (Vim's "WORD" definition).
 */
export function moveWORDBackward(text: string, cursor: number): number {
  let i = cursor - 1;
  while (i > 0 && /\s/.test(text[i])) i--;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  // Clamp to last character position in normal mode (never past the end)
  return Math.min(Math.max(0, i), Math.max(0, text.length - 1));
}

/**
 * Get word bounds at the given index.
 * If on whitespace, uses the next word to the right.
 */
export function wordBoundsAt(text: string, idx: number): { start: number; end: number } {
  const n = text.length;
  let i = Math.max(0, Math.min(n, idx));
  const isWord = (ch: string) => /[A-Za-z0-9_]/.test(ch);
  if (i >= n) i = n - 1;
  if (n === 0) return { start: 0, end: 0 };
  if (i < 0) i = 0;
  if (!isWord(text[i])) {
    let j = i;
    while (j < n && !isWord(text[j])) j++;
    if (j >= n) return { start: n, end: n };
    i = j;
  }
  let a = i;
  while (a > 0 && isWord(text[a - 1])) a--;
  let b = i + 1;
  while (b < n && isWord(text[b])) b++;
  return { start: a, end: b };
}

/**
 * Delete range [from, to) and optionally store in yankBuffer.
 */
export function deleteRange(
  text: string,
  from: number,
  to: number,
  yank: boolean,
  yankBuffer: string
): { text: string; cursor: number; yankBuffer: string } {
  const a = Math.max(0, Math.min(from, to));
  const b = Math.max(0, Math.max(from, to));
  const removed = text.slice(a, b);
  const newText = text.slice(0, a) + text.slice(b);
  return {
    text: newText,
    cursor: a,
    yankBuffer: yank ? removed : yankBuffer,
  };
}

/**
 * Delete the character under cursor (like 'x').
 */
export function deleteCharUnderCursor(
  text: string,
  cursor: number,
  yankBuffer: string
): { text: string; cursor: number; yankBuffer: string } {
  if (cursor >= text.length) return { text, cursor, yankBuffer };
  return deleteRange(text, cursor, cursor + 1, true, yankBuffer);
}

/**
 * Paste yankBuffer after cursor (like 'p').
 */
export function pasteAfter(
  text: string,
  cursor: number,
  yankBuffer: string
): { text: string; cursor: number } {
  if (!yankBuffer) return { text, cursor };
  const newText = text.slice(0, cursor) + yankBuffer + text.slice(cursor);
  return { text: newText, cursor: cursor + yankBuffer.length };
}

/**
 * Paste yankBuffer before cursor (like 'P').
 */
export function pasteBefore(
  text: string,
  cursor: number,
  yankBuffer: string
): { text: string; cursor: number } {
  if (!yankBuffer) return { text, cursor };
  const newText = text.slice(0, cursor) + yankBuffer + text.slice(cursor);
  return { text: newText, cursor };
}

/**
 * Compute cursor placement for insert mode entry (i/a/I/A/o/O).
 */
export function getInsertCursorPos(
  text: string,
  cursor: number,
  mode: "i" | "a" | "I" | "A" | "o" | "O"
): { cursor: number; text: string } {
  const { lineStart, lineEnd } = getLineBounds(text, cursor);
  switch (mode) {
    case "i":
      return { cursor, text };
    case "a":
      return { cursor: Math.min(cursor + 1, text.length), text };
    case "I":
      return { cursor: lineStart, text };
    case "A":
      return { cursor: lineEnd, text };
    case "o": {
      const newText = text.slice(0, lineEnd) + "\n" + text.slice(lineEnd);
      return { cursor: lineEnd + 1, text: newText };
    }
    case "O": {
      const newText = text.slice(0, lineStart) + "\n" + text.slice(lineStart);
      return { cursor: lineStart, text: newText };
    }
  }
}

/**
 * Apply a change operator (delete + enter insert).
 */
export function changeRange(
  text: string,
  from: number,
  to: number,
  _yankBuffer: string
): { text: string; cursor: number; yankBuffer: string } {
  return deleteRange(text, from, to, true, _yankBuffer);
}

/**
 * ============================================================================
 * CENTRAL STATE MACHINE
 * ============================================================================
 * All Vim key handling logic is centralized here for testability.
 * The component just calls handleKeyPress() and applies the result.
 */

interface KeyModifiers {
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
}

function makeHistorySnapshot(text: string, cursor: number): VimHistorySnapshot {
  return { text, cursor: clampCursorForMode(text, cursor, "normal") };
}

function pushHistoryStack(
  stack: VimHistorySnapshot[],
  snapshot: VimHistorySnapshot
): VimHistorySnapshot[] {
  const next = [...stack, snapshot];
  if (next.length <= VIM_HISTORY_STACK_LIMIT) return next;
  return next.slice(next.length - VIM_HISTORY_STACK_LIMIT);
}

function pushUndoSnapshot(state: VimState, snapshot: VimHistorySnapshot): VimState {
  return {
    ...state,
    undoStack: pushHistoryStack(state.undoStack, snapshot),
    redoStack: state.redoStack.length === 0 ? state.redoStack : [],
  };
}

function normalizeHistoryNavigationState(state: VimState): VimState {
  return {
    ...state,
    mode: "normal",
    cursor: clampCursorForMode(state.text, state.cursor, "normal"),
    visualAnchor: null,
    pending: null,
    desiredColumn: null,
    count: null,
    insertStartSnapshot: null,
  };
}

function applyUndo(state: VimState): VimState {
  if (state.undoStack.length === 0) {
    return normalizeHistoryNavigationState(state);
  }

  const snapshot = state.undoStack[state.undoStack.length - 1];
  const nextUndoStack = state.undoStack.slice(0, -1);

  const redoSnapshot = makeHistorySnapshot(state.text, state.cursor);
  const nextRedoStack = pushHistoryStack(state.redoStack, redoSnapshot);

  return normalizeHistoryNavigationState({
    ...state,
    text: snapshot.text,
    cursor: snapshot.cursor,
    undoStack: nextUndoStack,
    redoStack: nextRedoStack,
  });
}

function applyRedo(state: VimState): VimState {
  if (state.redoStack.length === 0) {
    return normalizeHistoryNavigationState(state);
  }

  const snapshot = state.redoStack[state.redoStack.length - 1];
  const nextRedoStack = state.redoStack.slice(0, -1);

  const undoSnapshot = makeHistorySnapshot(state.text, state.cursor);
  const nextUndoStack = pushHistoryStack(state.undoStack, undoSnapshot);

  return normalizeHistoryNavigationState({
    ...state,
    text: snapshot.text,
    cursor: snapshot.cursor,
    undoStack: nextUndoStack,
    redoStack: nextRedoStack,
  });
}

function applyLastEditOnce(state: VimState, lastEdit: LastEdit): VimState {
  switch (lastEdit.kind) {
    case "x":
    case "~":
    case "paste": {
      const res = tryHandleEdit(
        state,
        lastEdit.kind === "paste" ? lastEdit.variant : lastEdit.kind,
        lastEdit.count
      );
      if (!res) return state;
      assert(res.handled, "Expected lastEdit edit to be handled");
      return res.newState;
    }

    case "opMotion": {
      return applyOperatorMotion(state, lastEdit.op, lastEdit.motion, lastEdit.count);
    }

    case "opTextObject": {
      return applyOperatorTextObject(state, lastEdit.op, lastEdit.textObject, lastEdit.count);
    }

    case "opVisual": {
      const { text, cursor, yankBuffer } = state;
      const safeCount = Math.max(1, Math.min(10000, lastEdit.count));

      if (lastEdit.rangeKind === "char") {
        const to = Math.min(text.length, cursor + safeCount);

        if (lastEdit.op === "d") {
          const result = deleteRange(text, cursor, to, true, yankBuffer);
          return completeOperation(state, {
            text: result.text,
            cursor: result.cursor,
            yankBuffer: result.yankBuffer,
          });
        }

        const result = changeRange(text, cursor, to, yankBuffer);
        return completeOperation(state, {
          mode: "insert",
          text: result.text,
          cursor: result.cursor,
          yankBuffer: result.yankBuffer,
        });
      }

      const range = getLinewiseRange(text, cursor, safeCount);

      if (lastEdit.op === "d") {
        const result = deleteRange(text, range.from, range.to, true, yankBuffer);
        return completeOperation(state, {
          text: result.text,
          cursor: result.cursor,
          yankBuffer: result.yankBuffer,
        });
      }

      const removed = text.slice(range.from, range.to);
      const yankText = removed.endsWith("\n") ? removed.slice(0, -1) : removed;

      const replacement = range.to < text.length ? "\n" : "";
      const newText = text.slice(0, range.from) + replacement + text.slice(range.to);

      return completeOperation(state, {
        mode: "insert",
        text: newText,
        cursor: range.from,
        yankBuffer: yankText,
      });
    }

    default:
      assert(
        false,
        `Unexpected Vim lastEdit kind: ${String((lastEdit as { kind?: unknown }).kind)}`
      );
      return state;
  }
}

function applyDotRepeat(state: VimState, repeatCount: number): VimState {
  if (state.lastEdit == null) {
    return completeOperation(state, {});
  }

  const safeCount = Math.max(1, Math.min(10000, repeatCount));

  const lastEdit = state.lastEdit;
  let nextState = state;
  for (let i = 0; i < safeCount; i++) {
    nextState = applyLastEditOnce(nextState, lastEdit);
  }

  // Treat dot repeat as a single command; clear count/pending/desiredColumn.
  return completeOperation(nextState, {});
}

/**
 * Main entry point for handling key presses in Vim mode.
 * Returns null if browser should handle the key (e.g., typing in insert mode).
 * Returns new state if Vim handled the key.
 */
export function handleKeyPress(
  state: VimState,
  key: string,
  modifiers: KeyModifiers
): VimKeyResult {
  assertVimState(state);

  let result: VimKeyResult;
  switch (state.mode) {
    case "insert":
      result = handleInsertModeKey(state, key, modifiers);
      break;
    case "normal":
      result = handleNormalModeKey(state, key, modifiers);
      break;
    case "visual":
    case "visualLine":
      result = handleVisualModeKey(state, key, modifiers);
      break;
  }

  if (!result.handled) {
    return result;
  }

  let nextState = result.newState;

  // When entering insert mode from a Vim command, capture the pre-insert snapshot so
  // all subsequent insert-mode typing can be undone as a single step on Escape.
  if (state.mode !== "insert" && nextState.mode === "insert") {
    nextState = {
      ...nextState,
      insertStartSnapshot: makeHistorySnapshot(state.text, state.cursor),
    };
  }

  const isUndoKey = !modifiers.ctrl && !modifiers.meta && !modifiers.alt && key === "u";
  const isRedoKey = modifiers.ctrl && !modifiers.meta && !modifiers.alt && key === "r";

  const isHistoryNavigation = isUndoKey || isRedoKey;

  const didTextChange = nextState.text !== state.text;

  // For text-changing operations in normal/visual mode, push a pre-change snapshot.
  // (Insert-mode edits are grouped and committed on Escape in handleInsertModeKey.)
  if (
    didTextChange &&
    state.mode !== "insert" &&
    nextState.mode !== "insert" &&
    !isHistoryNavigation
  ) {
    nextState = pushUndoSnapshot(nextState, makeHistorySnapshot(state.text, state.cursor));
  }

  // Enforce the invariant: insertStartSnapshot is only used while in insert mode.
  if (nextState.mode !== "insert" && nextState.insertStartSnapshot != null) {
    nextState = { ...nextState, insertStartSnapshot: null };
  }

  const finalResult: VimKeyResult = { ...result, newState: nextState };
  assertVimState(nextState);
  return finalResult;
}

/**
 * Handle keys in insert mode.
 * Most keys return { handled: false } so browser can handle typing.
 */
function handleInsertModeKey(state: VimState, key: string, modifiers: KeyModifiers): VimKeyResult {
  // ESC or Ctrl-[ -> enter normal mode
  if (key === "Escape" || (key === "[" && modifiers.ctrl)) {
    const insertSnapshot = state.insertStartSnapshot;

    // In insert mode the DOM cursor is "between" characters. Normal mode is "on" a character.
    // Vim moves the cursor left when leaving insert mode.
    const normalCursor = clampCursorForMode(state.text, Math.max(0, state.cursor - 1), "normal");

    let nextState: VimState = {
      ...state,
      mode: "normal",
      visualAnchor: null,
      cursor: normalCursor,
      desiredColumn: null,
      pending: null,
      count: null,
      insertStartSnapshot: null,
    };

    // Insert-mode undo grouping:
    // When insert mode started from a Vim command, we commit a single undo snapshot on Escape.
    if (insertSnapshot != null && state.text !== insertSnapshot.text) {
      nextState = pushUndoSnapshot(nextState, insertSnapshot);
    }

    return { handled: true, newState: nextState };
  }

  // Let browser handle all other keys in insert mode
  return { handled: false };
}

/**
 * Handle keys in normal mode.
 */
function handleNormalModeKey(state: VimState, key: string, modifiers: KeyModifiers): VimKeyResult {
  const now = Date.now();
  let nextState = state;

  // Check for timeout on pending command sequences (800ms like Vim)
  if (nextState.pending && now - nextState.pending.at > 800) {
    nextState = { ...nextState, pending: null, count: null };
  }

  // Count parsing (like `2w`, `20l`).
  // - 1–9 starts a count.
  // - 0 only appends if a count is already in progress; otherwise it stays the `0` motion.
  if (
    nextState.pending?.kind !== "find" &&
    !modifiers.ctrl &&
    !modifiers.meta &&
    !modifiers.alt &&
    key.length === 1 &&
    /^[0-9]$/.test(key)
  ) {
    const digit = Number(key);
    if (digit !== 0 || nextState.count != null) {
      const prev = nextState.count ?? 0;
      const nextCount = Math.min(10000, prev * 10 + digit);
      return handleKey(nextState, { count: nextCount });
    }
  }

  // Enter visual modes.
  // Clear any pending operator/find/g state for predictability.
  if (!modifiers.ctrl && !modifiers.meta && !modifiers.alt && key === "v") {
    return handleKey(nextState, {
      mode: "visual",
      visualAnchor: nextState.cursor,
      pending: null,
      desiredColumn: null,
      count: null,
    });
  }
  if (!modifiers.ctrl && !modifiers.meta && !modifiers.alt && key === "V") {
    return handleKey(nextState, {
      mode: "visualLine",
      visualAnchor: nextState.cursor,
      pending: null,
      desiredColumn: null,
      count: null,
    });
  }

  // Handle pending command sequences (operators, multi-key prefixes, etc.)
  if (nextState.pending) {
    const result = handlePending(nextState, nextState.pending, key, modifiers, now);
    if (result) return result;
  }

  // Handle undo/redo
  if (!modifiers.ctrl && !modifiers.meta && !modifiers.alt && key === "u") {
    return { handled: true, newState: applyUndo(nextState) };
  }
  if (!modifiers.meta && !modifiers.alt && key === "r" && modifiers.ctrl) {
    return { handled: true, newState: applyRedo(nextState) };
  }

  // Dot repeat (repeat last structural edit)
  if (!modifiers.ctrl && !modifiers.meta && !modifiers.alt && key === ".") {
    const repeatCount = nextState.count ?? 1;
    return { handled: true, newState: applyDotRepeat(nextState, repeatCount) };
  }

  // Handle mode transitions (i/a/I/A/o/O)
  const insertResult = tryEnterInsertMode(nextState, key);
  if (insertResult) return insertResult;

  // Handle multi-key prefix commands (e.g. `g` prefix).
  const prefixResult = tryHandlePrefix(nextState, key, now);
  if (prefixResult) return prefixResult;

  const count = nextState.count ?? 1;

  const navResult = tryHandleNavigation(nextState, key, count);
  if (navResult) return navResult;

  // Handle edit commands
  const editResult = tryHandleEdit(nextState, key, count);
  if (editResult) return editResult;

  // Handle operators (d/c/y/D/C)
  const opResult = tryHandleOperator(nextState, key, now);
  if (opResult) return opResult;

  // Escape in normal mode:
  // - If we're mid-count, treat as cancel (like Vim) instead of propagating.
  // - Otherwise signal to the parent (e.g. cancel edit mode).
  if (key === "Escape" || (key === "[" && modifiers.ctrl)) {
    if (nextState.count != null) {
      return handleKey(nextState, { count: null });
    }
    return { handled: true, newState: { ...nextState, count: null }, action: "escapeInNormalMode" };
  }

  // Swallow all other single-character keys in normal mode (don't type letters)
  if (key.length === 1 && !modifiers.ctrl && !modifiers.meta && !modifiers.alt) {
    return { handled: true, newState: { ...nextState, count: null } };
  }

  // Unknown key - let browser handle
  return { handled: false };
}

/**
 * Handle keys in visual / visual line mode.
 */
function handleVisualModeKey(state: VimState, key: string, modifiers: KeyModifiers): VimKeyResult {
  const now = Date.now();
  let nextState = state;

  // Recover if visualAnchor is missing (should never happen, but avoids bricking key handling).
  if (nextState.visualAnchor == null) {
    return handleKey(nextState, {
      mode: "normal",
      visualAnchor: null,
      pending: null,
      desiredColumn: null,
      count: null,
    });
  }

  // Check for timeout on pending command sequences (800ms like Vim)
  if (nextState.pending && now - nextState.pending.at > 800) {
    nextState = { ...nextState, pending: null, count: null };
  }

  // Count parsing (like `2w`, `20l`).
  // - 1–9 starts a count.
  // - 0 only appends if a count is already in progress; otherwise it stays the `0` motion.
  if (
    nextState.pending?.kind !== "find" &&
    !modifiers.ctrl &&
    !modifiers.meta &&
    !modifiers.alt &&
    key.length === 1 &&
    /^[0-9]$/.test(key)
  ) {
    const digit = Number(key);
    if (digit !== 0 || nextState.count != null) {
      const prev = nextState.count ?? 0;
      const nextCount = Math.min(10000, prev * 10 + digit);
      return handleKey(nextState, { count: nextCount });
    }
  }

  // Handle pending command sequences (g prefix, find/till, etc.)
  if (nextState.pending) {
    // Visual mode operators operate immediately on the selection; a pending operator here is stale.
    if (nextState.pending.kind === "op") {
      nextState = { ...nextState, pending: null, count: null };
    } else {
      const result = handlePending(nextState, nextState.pending, key, modifiers, now);
      if (result) return result;
    }
  }

  // Exit visual mode.
  if (key === "Escape" || (key === "[" && modifiers.ctrl)) {
    return { handled: true, newState: exitVisualMode(nextState) };
  }

  // Toggle between visual/visualLine, or exit if pressed again.
  if (!modifiers.ctrl && !modifiers.meta && !modifiers.alt && key === "v") {
    if (nextState.mode === "visual") {
      return { handled: true, newState: exitVisualMode(nextState) };
    }
    return handleKey(nextState, {
      mode: "visual",
      pending: null,
      desiredColumn: null,
      count: null,
    });
  }
  if (!modifiers.ctrl && !modifiers.meta && !modifiers.alt && key === "V") {
    if (nextState.mode === "visualLine") {
      return { handled: true, newState: exitVisualMode(nextState) };
    }
    return handleKey(nextState, {
      mode: "visualLine",
      pending: null,
      desiredColumn: null,
      count: null,
    });
  }

  // Operators act on the current visual selection (count is ignored).
  if (
    !modifiers.ctrl &&
    !modifiers.meta &&
    !modifiers.alt &&
    (key === "d" || key === "c" || key === "y")
  ) {
    return { handled: true, newState: applyVisualOperator(nextState, key) };
  }

  // Handle undo/redo
  if (!modifiers.ctrl && !modifiers.meta && !modifiers.alt && key === "u") {
    return { handled: true, newState: applyUndo(nextState) };
  }
  if (!modifiers.meta && !modifiers.alt && key === "r" && modifiers.ctrl) {
    return { handled: true, newState: applyRedo(nextState) };
  }

  // Handle multi-key prefix commands (e.g. `g` prefix, find/till).
  const prefixResult = tryHandlePrefix(nextState, key, now);
  if (prefixResult) return prefixResult;

  const count = nextState.count ?? 1;

  // Motions extend the visual selection by moving the cursor.
  const navResult = tryHandleNavigation(nextState, key, count);
  if (navResult) return navResult;

  // Swallow all other single-character keys in visual mode (don't type letters)
  if (key.length === 1 && !modifiers.ctrl && !modifiers.meta && !modifiers.alt) {
    return { handled: true, newState: { ...nextState, count: null } };
  }

  // Unknown key - let browser handle (e.g. Ctrl-V paste)
  return { handled: false };
}
/**
 * Handle pending command sequences (operators, multi-key prefixes, etc.).
 */
function handlePending(
  state: VimState,
  pending: Pending,
  key: string,
  modifiers: KeyModifiers,
  now: number
): VimKeyResult | null {
  switch (pending.kind) {
    case "op":
      return handlePendingOperator(state, pending, key, modifiers, now);
    case "g":
      return handlePendingG(state, pending, key);
    case "find":
      return handlePendingFind(state, pending, key, modifiers);
    default:
      assert(false, `Unexpected Vim pending kind: ${String((pending as { kind?: unknown }).kind)}`);
      return null;
  }
}

/**
 * Handle pending operator + motion/text-object combinations.
 */
function handlePendingOperator(
  state: VimState,
  pending: Extract<Pending, { kind: "op" }>,
  key: string,
  _modifiers: KeyModifiers,
  now: number
): VimKeyResult | null {
  const args = pending.args ?? [];

  const motionCount = state.count ?? 1;
  const combinedCount = Math.min(10000, pending.count * motionCount);

  // Handle doubled operator (dd, yy, cc) -> line operation
  if (args.length === 0 && key === pending.op) {
    return {
      handled: true,
      newState: applyOperatorMotion(state, pending.op, "line", combinedCount),
    };
  }

  // Handle text objects (iw/aw + simple delimiter objects).
  if (args.length === 1 && args[0] === "i") {
    if (key === "w") {
      return {
        handled: true,
        newState: applyOperatorTextObject(state, pending.op, "iw", combinedCount),
      };
    }

    if (key === '"') {
      return {
        handled: true,
        newState: applyOperatorTextObject(state, pending.op, 'i"', combinedCount),
      };
    }

    if (key === "'") {
      return {
        handled: true,
        newState: applyOperatorTextObject(state, pending.op, "i'", combinedCount),
      };
    }

    if (key === "(") {
      return {
        handled: true,
        newState: applyOperatorTextObject(state, pending.op, "i(", combinedCount),
      };
    }

    if (key === "[") {
      return {
        handled: true,
        newState: applyOperatorTextObject(state, pending.op, "i[", combinedCount),
      };
    }

    if (key === "{") {
      return {
        handled: true,
        newState: applyOperatorTextObject(state, pending.op, "i{", combinedCount),
      };
    }
  }

  if (args.length === 1 && args[0] === "a") {
    if (key === "w") {
      return {
        handled: true,
        newState: applyOperatorTextObject(state, pending.op, "aw", combinedCount),
      };
    }

    if (key === '"') {
      return {
        handled: true,
        newState: applyOperatorTextObject(state, pending.op, 'a"', combinedCount),
      };
    }

    if (key === "'") {
      return {
        handled: true,
        newState: applyOperatorTextObject(state, pending.op, "a'", combinedCount),
      };
    }

    if (key === "(") {
      return {
        handled: true,
        newState: applyOperatorTextObject(state, pending.op, "a(", combinedCount),
      };
    }

    if (key === "[") {
      return {
        handled: true,
        newState: applyOperatorTextObject(state, pending.op, "a[", combinedCount),
      };
    }

    if (key === "{") {
      return {
        handled: true,
        newState: applyOperatorTextObject(state, pending.op, "a{", combinedCount),
      };
    }
  }

  // Handle motions when no text object is pending
  if (args.length === 0) {
    // Word motions
    if (key === "w") {
      // Vim special-case: `cw` behaves like `ce` when on a word char.
      const isWordChar =
        state.cursor < state.text.length && /[A-Za-z0-9_]/.test(state.text[state.cursor]);
      const motion: "w" | "e" = pending.op === "c" && isWordChar ? "e" : "w";
      return {
        handled: true,
        newState: applyOperatorMotion(state, pending.op, motion, combinedCount),
      };
    }
    if (key === "W") {
      // Vim special-case: `cW` behaves like `cE` when on a WORD char.
      const isWORDChar = state.cursor < state.text.length && !/\s/.test(state.text[state.cursor]);
      const motion: "W" | "E" = pending.op === "c" && isWORDChar ? "E" : "W";
      return {
        handled: true,
        newState: applyOperatorMotion(state, pending.op, motion, combinedCount),
      };
    }
    if (key === "b") {
      return {
        handled: true,
        newState: applyOperatorMotion(state, pending.op, "b", combinedCount),
      };
    }
    if (key === "B") {
      return {
        handled: true,
        newState: applyOperatorMotion(state, pending.op, "B", combinedCount),
      };
    }
    if (key === "e") {
      return {
        handled: true,
        newState: applyOperatorMotion(state, pending.op, "e", combinedCount),
      };
    }
    if (key === "E") {
      return {
        handled: true,
        newState: applyOperatorMotion(state, pending.op, "E", combinedCount),
      };
    }
    // Line motions
    if (key === "$" || key === "End") {
      return {
        handled: true,
        newState: applyOperatorMotion(state, pending.op, "$", combinedCount),
      };
    }
    if (key === "0" || key === "Home") {
      return {
        handled: true,
        newState: applyOperatorMotion(state, pending.op, "0", combinedCount),
      };
    }
    if (key === "_") {
      return {
        handled: true,
        newState: applyOperatorMotion(state, pending.op, "_", combinedCount),
      };
    }

    // Find/till motions (f/F/t/T)
    if (isFindVariant(key)) {
      return handleKey(state, {
        pending: {
          kind: "find",
          variant: key,
          at: now,
          count: combinedCount,
          op: pending.op,
        },
        count: null,
      });
    }
    // Text object prefix
    if (key === "i" || key === "a") {
      return handleKey(state, {
        pending: { kind: "op", op: pending.op, at: now, count: pending.count, args: [key] },
      });
    }
  }

  // Unknown motion - cancel pending operation
  return handleKey(state, { pending: null, count: null });
}

/**
 * Handle pending `g` prefix commands.
 */
function handlePendingG(
  state: VimState,
  pending: Extract<Pending, { kind: "g" }>,
  key: string
): VimKeyResult | null {
  // `gg`: go to line {count} (default 1).
  if (key === "g") {
    const text = state.text;
    const lineNumber = state.count ?? pending.count;

    const { row } = getRowCol(text, state.cursor);
    const { lines } = getLinesInfo(text);

    // Vim uses 1-indexed line numbers.
    const targetRow = Math.max(0, Math.min(lines.length - 1, lineNumber - 1));
    const delta = targetRow - row;

    const result = moveVertical(text, state.cursor, delta, state.desiredColumn);
    return handleCommand(state, {
      cursor: clampCursorForMode(text, result.cursor, "normal"),
      desiredColumn: result.desiredColumn,
      pending: null,
    });
  }

  // Unknown g-prefixed command - cancel.
  return handleKey(state, { pending: null, count: null });
}

function handlePendingFind(
  state: VimState,
  pending: Extract<Pending, { kind: "find" }>,
  key: string,
  modifiers: KeyModifiers
): VimKeyResult | null {
  // ESC / Ctrl-[ cancels pending find.
  if (key === "Escape" || (key === "[" && modifiers.ctrl)) {
    return handleKey(state, { pending: null, count: null });
  }

  // Capture the *literal* next key as the target char (including digits).
  if (modifiers.ctrl || modifiers.meta || modifiers.alt || key.length !== 1) {
    return handleKey(state, { pending: null, count: null });
  }

  const targetChar = key;
  const safeCount = Math.max(1, Math.min(10000, pending.count));

  const dest = getFindMotionDestination(
    state.text,
    state.cursor,
    pending.variant,
    targetChar,
    safeCount
  );

  // Not found - cancel the find/op.
  if (dest == null) {
    return handleCommand(state, { pending: null, desiredColumn: null });
  }

  const nextCursor = clampCursorForMode(state.text, dest, "normal");

  // Find motion as an operator range (dfx, ctx, etc.).
  if (pending.op != null) {
    return {
      handled: true,
      newState: applyOperatorFind(state, pending.op, nextCursor, pending.variant, targetChar),
    };
  }

  return handleCommand(state, {
    cursor: nextCursor,
    desiredColumn: null,
    pending: null,
    lastFind: { variant: pending.variant, char: targetChar },
  });
}

function clampCursorForMode(text: string, cursor: number, mode: VimMode): number {
  const maxCursor = mode === "insert" ? text.length : Math.max(0, text.length - 1);
  return Math.max(0, Math.min(cursor, maxCursor));
}

/**
 * Helper to complete an operation and clear pending state.
 */
function completeOperation(state: VimState, updates: Partial<VimState>): VimState {
  const nextText = updates.text ?? state.text;
  const nextMode = updates.mode ?? state.mode;
  const nextCursor = clampCursorForMode(nextText, updates.cursor ?? state.cursor, nextMode);

  return {
    ...state,
    ...updates,
    cursor: nextCursor,
    pending: null,
    desiredColumn: null,
    count: null,
  };
}

/**
 * Helper to create a handled key result with updated state.
 */
function handleKey(state: VimState, updates: Partial<VimState>): VimKeyResult {
  return {
    handled: true,
    newState: { ...state, ...updates },
  };
}

function handleCommand(state: VimState, updates: Partial<VimState>): VimKeyResult {
  return handleKey(state, { ...updates, count: null });
}

function exitVisualMode(state: VimState): VimState {
  const range = getVisualRange(state);
  assert(range != null, "Expected visual range when exiting visual mode");

  // When leaving visual mode we put the cursor at the selection start (like Vim).
  return completeOperation(state, {
    mode: "normal",
    cursor: range.start,
    visualAnchor: null,
  });
}

function applyVisualOperator(state: VimState, op: "d" | "c" | "y"): VimState {
  const range = getVisualRange(state);
  assert(range != null, "Expected visual range in visual mode");

  const { text, yankBuffer } = state;
  const removed = text.slice(range.start, range.end);

  // Record visual edits for dot repeat.
  let visualLastEdit: LastEdit | null = null;
  if (op === "d" || op === "c") {
    if (range.kind === "char") {
      const charCount = range.end - range.start;
      if (charCount > 0) {
        visualLastEdit = { kind: "opVisual", op, rangeKind: "char", count: charCount };
      }
    } else {
      assert(state.visualAnchor != null, "Expected visualAnchor in visual line mode");
      const { row: anchorRow } = getRowCol(text, state.visualAnchor);
      const { row: cursorRow } = getRowCol(text, state.cursor);
      const lineCount = Math.abs(cursorRow - anchorRow) + 1;
      visualLastEdit = { kind: "opVisual", op, rangeKind: "line", count: lineCount };
    }
  }

  switch (op) {
    case "d": {
      const result = deleteRange(text, range.start, range.end, true, yankBuffer);
      return completeOperation(state, {
        mode: "normal",
        text: result.text,
        cursor: result.cursor,
        yankBuffer: result.yankBuffer,
        visualAnchor: null,
        ...(visualLastEdit != null ? { lastEdit: visualLastEdit } : {}),
      });
    }

    case "c": {
      if (range.kind === "line") {
        const yankText = removed.endsWith("\n") ? removed.slice(0, -1) : removed;

        const replacement = range.end < text.length ? "\n" : "";
        const newText = text.slice(0, range.start) + replacement + text.slice(range.end);

        return completeOperation(state, {
          mode: "insert",
          text: newText,
          cursor: range.start,
          yankBuffer: yankText,
          visualAnchor: null,
          ...(visualLastEdit != null ? { lastEdit: visualLastEdit } : {}),
        });
      }

      const result = changeRange(text, range.start, range.end, yankBuffer);
      return completeOperation(state, {
        mode: "insert",
        text: result.text,
        cursor: result.cursor,
        yankBuffer: result.yankBuffer,
        visualAnchor: null,
        ...(visualLastEdit != null ? { lastEdit: visualLastEdit } : {}),
      });
    }

    case "y": {
      return completeOperation(state, {
        mode: "normal",
        cursor: range.start,
        yankBuffer: removed,
        visualAnchor: null,
      });
    }
  }
}

/**
 * Calculate the range (from, to) for a motion.
 * Returns null for "line" motion (requires special handling).
 */
function getMotionRange(
  text: string,
  cursor: number,
  motion: "w" | "W" | "b" | "B" | "e" | "E" | "$" | "0" | "_" | "line",
  count: number
): { from: number; to: number } | null {
  switch (motion) {
    case "w": {
      let to = cursor;
      for (let i = 0; i < count; i++) {
        to = moveWordForward(text, to);
      }
      return { from: cursor, to };
    }
    case "W": {
      let to = cursor;
      for (let i = 0; i < count; i++) {
        to = moveWORDForward(text, to);
      }
      return { from: cursor, to };
    }
    case "b": {
      let from = cursor;
      for (let i = 0; i < count; i++) {
        from = moveWordBackward(text, from);
      }
      return { from, to: cursor };
    }
    case "B": {
      let from = cursor;
      for (let i = 0; i < count; i++) {
        from = moveWORDBackward(text, from);
      }
      return { from, to: cursor };
    }
    case "e": {
      let end = cursor;
      for (let i = 0; i < count; i++) {
        end = moveWordEnd(text, end);
      }
      return { from: cursor, to: end + 1 };
    }
    case "E": {
      let end = cursor;
      for (let i = 0; i < count; i++) {
        end = moveWORDEnd(text, end);
      }
      return { from: cursor, to: end + 1 };
    }
    case "$": {
      const { row } = getRowCol(text, cursor);
      const { lines, starts } = getLinesInfo(text);
      const targetRow = Math.max(0, Math.min(lines.length - 1, row + count - 1));
      const lineStart = starts[targetRow];
      const lineEnd = lineStart + lines[targetRow].length;
      return { from: cursor, to: lineEnd };
    }
    case "0": {
      const { lineStart } = getLineBounds(text, cursor);
      return { from: lineStart, to: cursor };
    }
    case "_":
      // '_' is a linewise motion in Vim - operates on whole lines
      return null; // Use linewise handling like 'dd'
    case "line":
      return null; // Special case: handled separately
  }
}

function getLinewiseRange(
  text: string,
  cursor: number,
  count: number
): { from: number; to: number; row: number } {
  const { row } = getRowCol(text, cursor);
  const { lines, starts } = getLinesInfo(text);
  const targetRow = Math.max(0, Math.min(lines.length - 1, row + count - 1));
  const from = starts[row];
  let to = starts[targetRow] + lines[targetRow].length;
  if (targetRow < lines.length - 1) {
    to += 1; // include trailing newline
  }
  return { from, to, row };
}
/**
 * Apply operator + motion combination.
 */
function applyOperatorMotion(
  state: VimState,
  op: "d" | "c" | "y",
  motion: "w" | "W" | "b" | "B" | "e" | "E" | "$" | "0" | "_" | "line",
  count: number
): VimState {
  const { text, cursor, yankBuffer } = state;
  const safeCount = Math.max(1, Math.min(10000, count));

  // Line operations (dd, cc, yy, d_, c_, y_)
  if (motion === "line" || motion === "_") {
    const range = getLinewiseRange(text, cursor, safeCount);
    const removed = text.slice(range.from, range.to);

    if (op === "d") {
      const newText = text.slice(0, range.from) + text.slice(range.to);
      return completeOperation(state, {
        text: newText,
        cursor: range.from,
        yankBuffer: removed,
        lastEdit: { kind: "opMotion", op: "d", motion, count: safeCount },
      });
    }

    if (op === "c") {
      const yankText = removed.endsWith("\n") ? removed.slice(0, -1) : removed;

      // Like Vim, counted linewise changes collapse to a single replacement line.
      const replacement = range.to < text.length ? "\n" : "";
      const newText = text.slice(0, range.from) + replacement + text.slice(range.to);

      return completeOperation(state, {
        mode: "insert",
        text: newText,
        cursor: range.from,
        yankBuffer: yankText,
        lastEdit: { kind: "opMotion", op: "c", motion, count: safeCount },
      });
    }

    if (op === "y") {
      return completeOperation(state, {
        yankBuffer: removed,
      });
    }
  }

  // Calculate range for all other motions
  const range = getMotionRange(text, cursor, motion, safeCount);
  if (!range) return state; // Shouldn't happen, but type safety

  // Apply operator to range
  if (op === "d") {
    const result = deleteRange(text, range.from, range.to, true, yankBuffer);
    return completeOperation(state, {
      text: result.text,
      cursor: result.cursor,
      yankBuffer: result.yankBuffer,
      lastEdit: { kind: "opMotion", op: "d", motion, count: safeCount },
    });
  }

  if (op === "c") {
    const result = changeRange(text, range.from, range.to, yankBuffer);
    return completeOperation(state, {
      mode: "insert",
      text: result.text,
      cursor: result.cursor,
      yankBuffer: result.yankBuffer,
      lastEdit: { kind: "opMotion", op: "c", motion, count: safeCount },
    });
  }

  if (op === "y") {
    return completeOperation(state, {
      yankBuffer: text.slice(range.from, range.to),
    });
  }

  return state;
}

function applyOperatorFind(
  state: VimState,
  op: "d" | "c" | "y",
  dest: number,
  variant: FindVariant,
  targetChar: string
): VimState {
  const { text, cursor, yankBuffer } = state;

  assert(targetChar.length === 1, "Find target must be a single character");

  const lastFind: LastFind = { variant, char: targetChar };

  const range = isFindForward(variant)
    ? {
        from: cursor,
        to: Math.min(text.length, dest + 1),
      }
    : {
        from: dest,
        to: Math.min(text.length, cursor + 1),
      };

  if (isFindForward(variant)) {
    assert(dest >= cursor, "Expected forward find destination to be >= cursor");
  } else {
    assert(dest <= cursor, "Expected backward find destination to be <= cursor");
  }

  if (op === "d") {
    const result = deleteRange(text, range.from, range.to, true, yankBuffer);
    return completeOperation(state, {
      text: result.text,
      cursor: result.cursor,
      yankBuffer: result.yankBuffer,
      lastFind,
    });
  }

  if (op === "c") {
    const result = changeRange(text, range.from, range.to, yankBuffer);
    return completeOperation(state, {
      mode: "insert",
      text: result.text,
      cursor: result.cursor,
      yankBuffer: result.yankBuffer,
      lastFind,
    });
  }

  if (op === "y") {
    return completeOperation(state, {
      yankBuffer: text.slice(range.from, range.to),
      lastFind,
    });
  }

  return state;
}

type QuoteChar = '"' | "'";

type BracketOpenChar = "(" | "[" | "{";

type BracketCloseChar = ")" | "]" | "}";

interface LineLocalPair {
  open: number;
  close: number;
}

function isVimTextObject(textObj: unknown): textObj is VimTextObject {
  if (typeof textObj !== "string") return false;

  switch (textObj) {
    case "iw":
    case "aw":
    case 'i"':
    case 'a"':
    case "i'":
    case "a'":
    case "i(":
    case "a(":
    case "i[":
    case "a[":
    case "i{":
    case "a{":
      return true;
    default:
      return false;
  }
}

function getLineLocalInnerWordBoundsAt(
  text: string,
  idx: number
): { start: number; end: number } | null {
  const n = text.length;
  if (n === 0) return null;

  if (idx < 0) idx = 0;
  if (idx >= n) return null;

  const { lineStart, lineEnd } = getLineBounds(text, idx);
  const bounds = wordBoundsAt(text, idx);

  // Keep word objects line-local for predictability.
  if (bounds.start < lineStart || bounds.start >= lineEnd) return null;

  const end = Math.min(bounds.end, lineEnd);
  if (end <= bounds.start) return null;

  return { start: bounds.start, end };
}

function getLineLocalAWordBoundsAt(
  text: string,
  idx: number
): { start: number; end: number } | null {
  const inner = getLineLocalInnerWordBoundsAt(text, idx);
  if (!inner) return null;

  const { lineStart, lineEnd } = getLineBounds(text, inner.start);

  // Prefer trailing whitespace.
  let end = inner.end;
  while (end < lineEnd && /\s/.test(text[end])) end++;
  if (end > inner.end) {
    return { start: inner.start, end };
  }

  // Otherwise include leading whitespace.
  let start = inner.start;
  while (start > lineStart && /\s/.test(text[start - 1])) start--;
  return { start, end: inner.end };
}

function findQuotePairInLine(
  line: string,
  cursorCol: number,
  quoteChar: QuoteChar
): LineLocalPair | null {
  let open: number | null = null;
  let best: LineLocalPair | null = null;

  for (let i = 0; i < line.length; i++) {
    if (line[i] !== quoteChar) continue;

    if (open == null) {
      open = i;
      continue;
    }

    const close = i;
    if (open <= cursorCol && cursorCol <= close) {
      best = { open, close };
    }

    open = null;
  }

  return best;
}

function findBracketPairInLine(
  line: string,
  cursorCol: number,
  openChar: BracketOpenChar,
  closeChar: BracketCloseChar
): LineLocalPair | null {
  const stack: number[] = [];
  let best: LineLocalPair | null = null;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === openChar) {
      stack.push(i);
      continue;
    }

    if (ch === closeChar) {
      const open = stack.pop();
      if (open == null) continue;

      if (open <= cursorCol && cursorCol <= i) {
        if (best == null || open > best.open) {
          best = { open, close: i };
        }
      }
    }
  }

  return best;
}

function getLineLocalQuoteTextObjectRange(
  text: string,
  cursor: number,
  quoteChar: QuoteChar,
  includeDelimiters: boolean
): { start: number; end: number } | null {
  if (text.length === 0) return null;
  if (cursor < 0 || cursor >= text.length) return null;

  const { lineStart, lineEnd } = getLineBounds(text, cursor);
  const line = text.slice(lineStart, lineEnd);
  const cursorCol = Math.max(0, Math.min(cursor - lineStart, line.length));

  const pair = findQuotePairInLine(line, cursorCol, quoteChar);
  if (!pair) return null;

  const start = lineStart + (includeDelimiters ? pair.open : pair.open + 1);
  const end = lineStart + (includeDelimiters ? pair.close + 1 : pair.close);

  if (start < lineStart || start > lineEnd) return null;
  if (end < lineStart || end > lineEnd) return null;
  if (start > end) return null;

  return { start, end };
}

function getLineLocalBracketTextObjectRange(
  text: string,
  cursor: number,
  openChar: BracketOpenChar,
  closeChar: BracketCloseChar,
  includeDelimiters: boolean
): { start: number; end: number } | null {
  if (text.length === 0) return null;
  if (cursor < 0 || cursor >= text.length) return null;

  const { lineStart, lineEnd } = getLineBounds(text, cursor);
  const line = text.slice(lineStart, lineEnd);
  const cursorCol = Math.max(0, Math.min(cursor - lineStart, line.length));

  const pair = findBracketPairInLine(line, cursorCol, openChar, closeChar);
  if (!pair) return null;

  const start = lineStart + (includeDelimiters ? pair.open : pair.open + 1);
  const end = lineStart + (includeDelimiters ? pair.close + 1 : pair.close);

  if (start < lineStart || start > lineEnd) return null;
  if (end < lineStart || end > lineEnd) return null;
  if (start > end) return null;

  return { start, end };
}

function getTextObjectRange(
  text: string,
  cursor: number,
  textObj: VimTextObject,
  count: number
): { start: number; end: number } | null {
  switch (textObj) {
    case "iw": {
      const first = getLineLocalInnerWordBoundsAt(text, cursor);
      if (!first) return null;

      const start = first.start;
      let end = first.end;

      for (let i = 1; i < count; i++) {
        const next = getLineLocalInnerWordBoundsAt(text, end);
        if (!next) break;
        if (next.end <= end) break;
        end = next.end;
      }

      return { start, end };
    }

    case "aw": {
      const first = getLineLocalAWordBoundsAt(text, cursor);
      if (!first) return null;

      const start = first.start;
      let end = first.end;

      for (let i = 1; i < count; i++) {
        const next = getLineLocalAWordBoundsAt(text, end);
        if (!next) break;
        if (next.end <= end) break;
        end = next.end;
      }

      return { start, end };
    }

    case 'i"':
      return getLineLocalQuoteTextObjectRange(text, cursor, '"', false);
    case 'a"':
      return getLineLocalQuoteTextObjectRange(text, cursor, '"', true);

    case "i'":
      return getLineLocalQuoteTextObjectRange(text, cursor, "'", false);
    case "a'":
      return getLineLocalQuoteTextObjectRange(text, cursor, "'", true);

    case "i(":
      return getLineLocalBracketTextObjectRange(text, cursor, "(", ")", false);
    case "a(":
      return getLineLocalBracketTextObjectRange(text, cursor, "(", ")", true);

    case "i[":
      return getLineLocalBracketTextObjectRange(text, cursor, "[", "]", false);
    case "a[":
      return getLineLocalBracketTextObjectRange(text, cursor, "[", "]", true);

    case "i{":
      return getLineLocalBracketTextObjectRange(text, cursor, "{", "}", false);
    case "a{":
      return getLineLocalBracketTextObjectRange(text, cursor, "{", "}", true);
  }
}

/**
 * Apply operator + text object combination.
 */
function applyOperatorTextObject(
  state: VimState,
  op: "d" | "c" | "y",
  textObj: VimTextObject,
  count: number
): VimState {
  const { text, cursor, yankBuffer } = state;
  const safeCount = Math.max(1, Math.min(10000, count));

  const range = getTextObjectRange(text, cursor, textObj, safeCount);
  if (!range) {
    // No matching text object on this line -> no-op, but clear pending/count.
    return completeOperation(state, {});
  }

  const { start, end } = range;

  // Apply operator to range [start, end)
  if (op === "d") {
    const result = deleteRange(text, start, end, true, yankBuffer);
    return completeOperation(state, {
      text: result.text,
      cursor: result.cursor,
      yankBuffer: result.yankBuffer,
      lastEdit: { kind: "opTextObject", op: "d", textObject: textObj, count: safeCount },
    });
  }

  if (op === "c") {
    const result = changeRange(text, start, end, yankBuffer);
    return completeOperation(state, {
      mode: "insert",
      text: result.text,
      cursor: result.cursor,
      yankBuffer: result.yankBuffer,
      lastEdit: { kind: "opTextObject", op: "c", textObject: textObj, count: safeCount },
    });
  }

  if (op === "y") {
    return completeOperation(state, {
      yankBuffer: text.slice(start, end),
    });
  }

  return completeOperation(state, {});
}

function isFindVariant(key: string): key is FindVariant {
  return key === "f" || key === "F" || key === "t" || key === "T";
}

function invertFindVariant(variant: FindVariant): FindVariant {
  switch (variant) {
    case "f":
      return "F";
    case "F":
      return "f";
    case "t":
      return "T";
    case "T":
      return "t";
  }
}

type InsertKey = "i" | "a" | "I" | "A" | "o" | "O";

/**
 * Type guard to check if key is a valid insert mode key.
 */
function isInsertKey(key: string): key is InsertKey {
  return ["i", "a", "I", "A", "o", "O"].includes(key);
}

/**
 * Try to handle insert mode entry (i/a/I/A/o/O).
 */
function tryEnterInsertMode(state: VimState, key: string): VimKeyResult | null {
  if (!isInsertKey(key)) return null;

  const result = getInsertCursorPos(state.text, state.cursor, key);
  return handleCommand(state, {
    mode: "insert",
    text: result.text,
    cursor: result.cursor,
    desiredColumn: null,
    pending: null,
  });
}

/**
 * Try to handle multi-key prefix commands (e.g. `g` prefix).
 */
function tryHandlePrefix(state: VimState, key: string, now: number): VimKeyResult | null {
  // `g` introduces a multi-key sequence (e.g. `gg`).
  if (key === "g") {
    // Consume the current count into the pending state so it doesn't get cleared.
    const prefixCount = state.count ?? 1;
    return handleKey(state, {
      pending: { kind: "g", at: now, count: prefixCount },
      count: null,
    });
  }

  // `f`/`F`/`t`/`T` introduce a pending find/till sequence.
  if (isFindVariant(key)) {
    // Consume the current count into the pending state so it doesn't get cleared.
    const findCount = state.count ?? 1;
    return handleKey(state, {
      pending: { kind: "find", variant: key, at: now, count: findCount },
      count: null,
    });
  }
  return null;
}

/**
 * Try to handle navigation commands (h/j/k/l/w/b/0/$).
 */
function tryHandleNavigation(state: VimState, key: string, count: number): VimKeyResult | null {
  const { text, cursor, desiredColumn } = state;

  switch (key) {
    case "h":
      return handleCommand(state, {
        cursor: Math.max(0, cursor - count),
        desiredColumn: null,
      });

    case "l":
      return handleCommand(state, {
        cursor: Math.min(cursor + count, Math.max(0, text.length - 1)),
        desiredColumn: null,
      });

    case "j": {
      const result = moveVertical(text, cursor, count, desiredColumn);
      return handleCommand(state, { cursor: result.cursor, desiredColumn: result.desiredColumn });
    }

    case "k": {
      const result = moveVertical(text, cursor, -count, desiredColumn);
      return handleCommand(state, { cursor: result.cursor, desiredColumn: result.desiredColumn });
    }

    case "w": {
      let next = cursor;
      for (let i = 0; i < count; i++) {
        next = moveWordForward(text, next);
      }
      return handleCommand(state, { cursor: next, desiredColumn: null });
    }

    case "W": {
      let next = cursor;
      for (let i = 0; i < count; i++) {
        next = moveWORDForward(text, next);
      }
      return handleCommand(state, { cursor: next, desiredColumn: null });
    }

    case "b": {
      let next = cursor;
      for (let i = 0; i < count; i++) {
        next = moveWordBackward(text, next);
      }
      return handleCommand(state, { cursor: next, desiredColumn: null });
    }

    case "B": {
      let next = cursor;
      for (let i = 0; i < count; i++) {
        next = moveWORDBackward(text, next);
      }
      return handleCommand(state, { cursor: next, desiredColumn: null });
    }

    case "e": {
      let next = cursor;
      for (let i = 0; i < count; i++) {
        next = moveWordEnd(text, next);
      }
      return handleCommand(state, { cursor: next, desiredColumn: null });
    }

    case "E": {
      let next = cursor;
      for (let i = 0; i < count; i++) {
        next = moveWORDEnd(text, next);
      }
      return handleCommand(state, { cursor: next, desiredColumn: null });
    }

    case "0":
    case "Home": {
      const { lineStart } = getLineBounds(text, cursor);
      return handleCommand(state, { cursor: lineStart, desiredColumn: null });
    }

    case "_": {
      const { row } = getRowCol(text, cursor);
      const { lines, starts } = getLinesInfo(text);
      const targetRow = Math.max(0, Math.min(lines.length - 1, row + count - 1));
      const targetCursor = moveToFirstNonWhitespace(text, starts[targetRow]);
      return handleCommand(state, { cursor: targetCursor, desiredColumn: null });
    }

    case "$":
    case "End": {
      const { row } = getRowCol(text, cursor);
      const { lines, starts } = getLinesInfo(text);
      const targetRow = Math.max(0, Math.min(lines.length - 1, row + count - 1));
      const lineStart = starts[targetRow];
      const lineEnd = lineStart + lines[targetRow].length;
      // In normal mode, $ goes to last character, not after it
      // Special case: empty line stays at lineStart
      const newCursor = lineEnd > lineStart ? lineEnd - 1 : lineStart;
      return handleCommand(state, { cursor: newCursor, desiredColumn: null });
    }

    case "G": {
      const { row } = getRowCol(text, cursor);
      const { lines } = getLinesInfo(text);

      const targetRow =
        state.count == null ? lines.length - 1 : Math.max(0, Math.min(lines.length - 1, count - 1));

      const delta = targetRow - row;
      const result = moveVertical(text, cursor, delta, desiredColumn);
      return handleCommand(state, {
        cursor: clampCursorForMode(text, result.cursor, "normal"),
        desiredColumn: result.desiredColumn,
      });
    }

    case ";": {
      if (!state.lastFind) {
        return handleCommand(state, { desiredColumn: null });
      }

      const dest = getFindMotionDestination(
        text,
        cursor,
        state.lastFind.variant,
        state.lastFind.char,
        count
      );
      if (dest == null) {
        return handleCommand(state, { desiredColumn: null });
      }

      return handleCommand(state, {
        cursor: clampCursorForMode(text, dest, "normal"),
        desiredColumn: null,
      });
    }

    case ",": {
      if (!state.lastFind) {
        return handleCommand(state, { desiredColumn: null });
      }

      const variant = invertFindVariant(state.lastFind.variant);
      const dest = getFindMotionDestination(text, cursor, variant, state.lastFind.char, count);
      if (dest == null) {
        return handleCommand(state, { desiredColumn: null });
      }

      return handleCommand(state, {
        cursor: clampCursorForMode(text, dest, "normal"),
        desiredColumn: null,
      });
    }
  }

  return null;
}

/**
 * Try to handle edit commands (x/p/P).
 */
function tryHandleEdit(state: VimState, key: string, count: number): VimKeyResult | null {
  const { text, cursor, yankBuffer } = state;
  const safeCount = Math.max(1, Math.min(10000, count));

  switch (key) {
    case "x": {
      if (cursor >= text.length) return null;
      const to = Math.min(text.length, cursor + safeCount);
      const result = deleteRange(text, cursor, to, true, yankBuffer);
      const newCursor = clampCursorForMode(result.text, result.cursor, "normal");
      return handleCommand(state, {
        text: result.text,
        cursor: newCursor,
        yankBuffer: result.yankBuffer,
        desiredColumn: null,
        lastEdit: { kind: "x", count: safeCount },
      });
    }

    case "p": {
      // In normal mode, cursor is ON a character. Paste AFTER means after that character.
      const result = pasteAfter(text, cursor + 1, yankBuffer);
      return handleCommand(state, {
        text: result.text,
        cursor: result.cursor - 1, // Adjust back to normal mode positioning
        desiredColumn: null,
        lastEdit: { kind: "paste", variant: "p", count: 1 },
      });
    }

    case "P": {
      const result = pasteBefore(text, cursor, yankBuffer);
      return handleCommand(state, {
        text: result.text,
        cursor: result.cursor,
        desiredColumn: null,
        lastEdit: { kind: "paste", variant: "P", count: 1 },
      });
    }

    case "s": {
      if (cursor >= text.length) return null;
      const result = deleteCharUnderCursor(text, cursor, yankBuffer);
      return handleCommand(state, {
        text: result.text,
        cursor: result.cursor,
        yankBuffer: result.yankBuffer,
        mode: "insert",
        desiredColumn: null,
        pending: null,
      });
    }

    case "~": {
      if (cursor >= text.length) return null;

      let nextText = text;
      let nextCursor = cursor;

      for (let i = 0; i < safeCount; i++) {
        if (nextCursor >= nextText.length) break;

        const char = nextText[nextCursor];
        const toggled = char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase();
        nextText = nextText.slice(0, nextCursor) + toggled + nextText.slice(nextCursor + 1);

        if (nextCursor >= nextText.length - 1) break;
        nextCursor++;
      }

      return handleCommand(state, {
        text: nextText,
        cursor: nextCursor,
        desiredColumn: null,
        pending: null,
        lastEdit: { kind: "~", count: safeCount },
      });
    }
  }

  return null;
}

/**
 * Try to handle operator commands (d/c/y/D/C).
 */
function tryHandleOperator(state: VimState, key: string, now: number): VimKeyResult | null {
  const opCount = state.count ?? 1;

  switch (key) {
    case "d":
      return handleKey(state, {
        pending: { kind: "op", op: "d", at: now, count: opCount, args: [] },
        count: null,
      });

    case "c":
      return handleKey(state, {
        pending: { kind: "op", op: "c", at: now, count: opCount, args: [] },
        count: null,
      });

    case "y":
      return handleKey(state, {
        pending: { kind: "op", op: "y", at: now, count: opCount, args: [] },
        count: null,
      });

    case "D":
      return { handled: true, newState: applyOperatorMotion(state, "d", "$", opCount) };

    case "C":
      return { handled: true, newState: applyOperatorMotion(state, "c", "$", opCount) };
  }

  return null;
}

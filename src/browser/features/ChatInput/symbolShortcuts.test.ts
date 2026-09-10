import { describe, expect, test } from "bun:test";
import {
  convertSymbolCommandAtCursor,
  convertTerminatedSymbolCommand,
  findSymbolCommandAtCursor,
  getSymbolSuggestions,
} from "@/browser/features/ChatInput/symbolShortcuts";

const bs = String.fromCharCode(92);
const cmd = (name: string) => bs + name;
const tick = String.fromCharCode(96);
const displays = (partial: string) => getSymbolSuggestions(partial).map(({ display }) => display);
const fenced = `${tick.repeat(3)}\n${cmd("sum")}\n${tick.repeat(3)}`;

describe("symbol shortcuts", () => {
  test.each([
    ["partial command", cmd("al"), 3, { partial: "al", startIndex: 0, endIndex: 3 }],
    ["bare trigger", bs, 1, { partial: "", startIndex: 0, endIndex: 1 }],
    ["caret in a token", cmd("alpha"), 3, { partial: "alpha", startIndex: 0, endIndex: 6 }],
    ["no trigger", "alpha", 5, null],
    ["escaped trigger", bs + cmd("alpha"), 7, null],
    ["inline code", `${tick}${cmd("div")}${tick}`, 5, null],
    ["fenced code", fenced, fenced.indexOf("m") + 1, null],
    ["token outside code", cmd("div"), 4, { partial: "div", startIndex: 0, endIndex: 4 }],
  ])("finds %s", (_name, text, cursor, expected) => {
    expect(findSymbolCommandAtCursor(text, cursor)).toEqual(expected);
  });

  test("orders suggestions, defaults collisions, and keeps metadata valid", () => {
    expect(displays("a")).toEqual(["alpha", "ast", "approx", "angle"].map(cmd));
    for (const [partial, names] of [
      ["A", ["Alpha"]],
      ["in", ["in", "infty", "int"]],
      ["sub", ["subset", "subseteq"]],
      ["R", ["R", "Rho", "Rightarrow"]],
    ] as const)
      expect(displays(partial).sort()).toEqual(names.map(cmd).sort());
    for (const [partial, name, replacement] of [
      ["in", "in", "∈"],
      ["to", "to", "→"],
      ["subset", "subset", "⊂"],
      ["a", "alpha", "α"],
    ] as const)
      expect(getSymbolSuggestions(partial)[0]).toMatchObject({ display: cmd(name), replacement });
    const suggestions = getSymbolSuggestions("");
    expect(
      suggestions.every(
        ({ display, replacement, description }) =>
          display.startsWith(bs) && replacement === description
      )
    ).toBe(true);
    expect(new Set(displays("")).size).toBe(suggestions.length);
    expect(getSymbolSuggestions("zzz")).toEqual([]);
  });

  test.each([
    ["lowercase Greek", cmd("alpha"), 6, { text: "α", cursor: 1 }],
    ["uppercase Greek", cmd("Alpha"), 6, { text: "Α", cursor: 1 }],
    ["comparison", cmd("leq"), 4, { text: "≤", cursor: 1 }],
    ["multiplication", cmd("times"), 6, { text: "×", cursor: 1 }],
    ["set", cmd("subseteq"), 9, { text: "⊆", cursor: 1 }],
    ["logic", cmd("implies"), 8, { text: "⟹", cursor: 1 }],
    ["arrow", cmd("rightarrow"), 11, { text: "→", cursor: 1 }],
    ["currency", cmd("euro"), 5, { text: "€", cursor: 1 }],
    ["cryptocurrency", cmd("bitcoin"), 8, { text: "₿", cursor: 1 }],
    ["big operator", cmd("sum"), 4, { text: "∑", cursor: 1 }],
    ["surrounding text", `x ${cmd("geq")}`, 6, { text: "x ≥", cursor: 3 }],
    ["unambiguous prefix collision", cmd("int"), 4, { text: "∫", cursor: 1 }],
    ["unambiguous word", cmd("top"), 4, { text: "⊤", cursor: 1 }],
    ["ambiguous in", cmd("in"), 3, null],
    ["ambiguous to", cmd("to"), 3, null],
    ["ambiguous subset", cmd("subset"), 7, null],
    ["ambiguous R", cmd("R"), 2, null],
    ["partial name", cmd("alph"), 5, null],
    ["unknown name", cmd("alphax"), 7, null],
    ["mid-token caret", cmd("alpha"), 3, null],
    ["escaped command", bs + cmd("alpha"), 7, null],
  ])("converts at cursor: %s", (_name, input, cursor, expected) => {
    expect(convertSymbolCommandAtCursor(input, cursor)).toEqual(expected);
  });

  test.each([
    ["ambiguous name", cmd("in") + " ", 4, { text: "∈ ", cursor: 2 }],
    ["set name", cmd("subset") + ")", 8, { text: "⊂)", cursor: 2 }],
    ["single-letter set", cmd("R") + ")", 3, { text: "ℝ)", cursor: 2 }],
    ["pasted unambiguous run", cmd("alpha") + " ", 7, { text: "α ", cursor: 2 }],
    ["unterminated name", cmd("in"), 3, null],
    ["unknown name", cmd("nope") + " ", 6, null],
    ["escaped command", bs + cmd("in") + " ", 5, null],
  ])("converts terminated command: %s", (_name, input, cursor, expected) => {
    expect(convertTerminatedSymbolCommand(input, cursor)).toEqual(expected);
  });
});

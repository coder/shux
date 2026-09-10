import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { SlashSuggestion } from "@/browser/utils/slashCommands/types";
import { CommandSuggestions } from "./CommandSuggestions";

const makeSuggestion = (id: string): SlashSuggestion => ({
  id,
  display: id,
  description: `desc:${id}`,
  replacement: id,
});
const suggestions = ["a", "b", "c"].map(makeSuggestion);
const option = (getByText: (text: string) => HTMLElement, id: string) =>
  getByText(id).closest('[role="option"]')?.getAttribute("aria-selected");

describe("CommandSuggestions", () => {
  let originalScrollIntoView: ((...args: unknown[]) => unknown) | undefined;

  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    const prototype = globalThis.window.HTMLElement.prototype as unknown as {
      scrollIntoView?: (...args: unknown[]) => unknown;
    };
    originalScrollIntoView = prototype.scrollIntoView;
    prototype.scrollIntoView = () => undefined;
  });

  afterEach(() => {
    cleanup();
    const prototype = globalThis.window.HTMLElement.prototype as unknown as {
      scrollIntoView?: (...args: unknown[]) => unknown;
    };
    prototype.scrollIntoView = originalScrollIntoView;
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  it.each([
    {
      name: "preserves selection by id after reorder",
      downs: 1,
      before: "b",
      next: ["c", "a", "b"],
      after: "b",
    },
    {
      name: "clamps selection when the selected item disappears",
      downs: 2,
      before: "c",
      next: ["a", "b"],
      after: "b",
    },
  ])("$name", ({ downs, before, next, after }) => {
    function Harness() {
      const [items, setItems] = useState(suggestions);
      return (
        <div>
          <CommandSuggestions
            suggestions={items}
            onSelectSuggestion={() => undefined}
            onDismiss={() => undefined}
            isVisible
          />
          <button onClick={() => setItems(next.map(makeSuggestion))}>Update</button>
        </div>
      );
    }
    const { getByText } = render(<Harness />);
    for (let index = 0; index < downs; index++) fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(option(getByText, before)).toBe("true");
    fireEvent.click(getByText("Update"));
    expect(option(getByText, after)).toBe("true");
  });

  it.each([
    ["Enter", 1, "b"],
    ["Tab", 2, "c"],
  ] as const)("accepts the selected suggestion on %s", (key, downs, expected) => {
    const selectedIds: string[] = [];
    const { getByText } = render(
      <CommandSuggestions
        suggestions={suggestions}
        onSelectSuggestion={(suggestion) => {
          selectedIds.push(suggestion.id);
        }}
        onDismiss={() => undefined}
        isVisible
      />
    );
    for (let index = 0; index < downs; index++) fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(option(getByText, expected)).toBe("true");
    fireEvent.keyDown(document, { key });
    expect(selectedIds).toEqual([expected]);
  });

  it("does not accept Shift+Enter", () => {
    let selected: SlashSuggestion | null = null;
    render(
      <CommandSuggestions
        suggestions={suggestions}
        onSelectSuggestion={(suggestion) => {
          selected = suggestion;
        }}
        onDismiss={() => undefined}
        isVisible
      />
    );
    fireEvent.keyDown(document, { key: "Enter", shiftKey: true });
    expect(selected).toBeNull();
  });

  it("dismisses on Escape without propagation", () => {
    let dismissed = false;
    let propagated = false;
    const windowListener = () => {
      propagated = true;
    };
    window.addEventListener("keydown", windowListener);
    render(
      <CommandSuggestions
        suggestions={suggestions}
        onSelectSuggestion={() => undefined}
        onDismiss={() => {
          dismissed = true;
        }}
        isVisible
      />
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dismissed).toBe(true);
    expect(propagated).toBe(false);
    window.removeEventListener("keydown", windowListener);
  });
});

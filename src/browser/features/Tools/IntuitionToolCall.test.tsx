import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { installDom } from "../../../../tests/ui/dom";
import { IntuitionToolCall, toIntuitionView } from "./IntuitionToolCall";
import {
  EMPTY_INTUITION,
  INTUITION_CUE,
  RECOGNIZED_INTUITION,
  UNCERTAIN_INTUITION,
} from "./IntuitionToolCall.fixtures";

function card(result?: unknown, cue = INTUITION_CUE) {
  return (
    <TooltipProvider>
      <IntuitionToolCall args={{ cue }} result={result} status={result ? "completed" : "pending"} />
    </TooltipProvider>
  );
}

describe("IntuitionToolCall", () => {
  let restoreDom: () => void;
  beforeEach(() => {
    restoreDom = installDom();
  });
  afterEach(() => {
    cleanup();
    restoreDom();
  });

  test("switches from pending to recognized, uncertain, empty, limit and error without stale memories", () => {
    const view = render(card());
    const header = view.getByRole("button", { name: "Memory intuition details" });
    fireEvent.keyDown(header, { key: "Enter" });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(view.getByText("Waiting for result")).toBeTruthy();

    view.rerender(card({ type: "json", value: RECOGNIZED_INTUITION }));
    expect(view.queryByText("Waiting for result")).toBeNull();
    expect(view.getByText("recognized 2")).toBeTruthy();
    for (const memory of RECOGNIZED_INTUITION.memories) {
      expect(view.getByText(memory.path)).toBeTruthy();
      expect(view.getByText(memory.why)).toBeTruthy();
      expect(view.getByText(memory.excerpt, { normalizer: (text) => text })).toBeTruthy();
    }
    expect(view.getAllByText("93%")).toHaveLength(2);

    view.rerender(card(UNCERTAIN_INTUITION));
    expect(view.queryByText(RECOGNIZED_INTUITION.memories[0].path)).toBeNull();
    expect(view.getByText("uncertain · 1 lead")).toBeTruthy();
    expect(view.getAllByText("50%")).toHaveLength(2);
    expect(view.getByText(UNCERTAIN_INTUITION.candidates[0].description)).toBeTruthy();
    expect(view.getByText(UNCERTAIN_INTUITION.note)).toBeTruthy();

    view.rerender(card(EMPTY_INTUITION));
    expect(view.queryByText(UNCERTAIN_INTUITION.candidates[0].path)).toBeNull();
    expect(view.getByText("no matches")).toBeTruthy();
    expect(view.queryByText("Uncertain leads")).toBeNull();

    view.rerender(card({ kind: "limit_reached", message: "Try a direct memory read." }));
    expect(view.getByText("Try a direct memory read.")).toBeTruthy();
    expect(view.queryByText("no matches")).toBeNull();

    view.rerender(card({ kind: "error", isError: true, message: "Caller cancelled" }));
    expect(view.getByText("Caller cancelled")).toBeTruthy();
    expect(view.getByText("failed")).toBeTruthy();
    fireEvent.keyDown(header, { key: " " });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(view.queryByText("Caller cancelled")).toBeNull();
  });

  test("keeps untrusted cue, paths, explanations, excerpts and descriptions as plain text", () => {
    const attack = '<img src=x onerror="alert(1)">';
    const excerpt = `${attack}\n[click](javascript:alert(1)) **not bold**`;
    const result = {
      ...RECOGNIZED_INTUITION,
      memories: [{ path: attack, relevance: 0.9, why: attack, excerpt }],
      candidates: [{ path: attack, relevance: 0.5, description: attack }],
    };
    const view = render(card(result, attack));
    fireEvent.click(view.getByRole("button", { name: "Memory intuition details" }));
    expect(view.getAllByText(attack)).toHaveLength(5);
    const renderedExcerpt = view.getByText(excerpt, { normalizer: (text) => text });
    expect(renderedExcerpt.classList.contains("whitespace-pre-wrap")).toBe(true);
    expect(view.container.querySelector("img, a, strong, script")).toBeNull();
  });

  test("uses generic rendering for malformed results instead of fabricating a match", () => {
    for (const result of [
      "bad",
      { ...RECOGNIZED_INTUITION, memories: [] },
      {
        ...RECOGNIZED_INTUITION,
        memories: [{ path: "p", relevance: 2, why: {}, excerpt: "x" }],
      },
    ]) {
      expect(toIntuitionView(result)).toEqual({ kind: "invalid" });
    }
    expect(toIntuitionView(undefined)).toEqual({ kind: "pending" });
    expect(toIntuitionView({ success: false, error: "Aborted" })).toEqual({
      kind: "error",
      isError: true,
      message: "Aborted",
    });
    const view = render(card({ ...RECOGNIZED_INTUITION, memories: [] }));
    expect(view.queryByRole("button", { name: "Memory intuition details" })).toBeNull();
    expect(view.getByText("intuition")).toBeTruthy();
  });
});

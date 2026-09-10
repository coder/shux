import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { installDom } from "../../../../../tests/ui/dom";

import { WorkflowLongText } from "./WorkflowLongText";
import { WORKFLOW_TEXT_PREVIEW_CHAR_LIMIT } from "./workflowDisplay";

describe("WorkflowLongText", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("short text renders in full with no controls", () => {
    const { container, queryByRole } = render(
      <WorkflowLongText text="tiny prompt" title="Argument: prompt" />
    );
    expect(container.textContent).toContain("tiny prompt");
    expect(queryByRole("button")).toBeNull();
  });

  test("long text renders a bounded preview with Show more / Full view controls", () => {
    const text = `intro ${"x".repeat(5000)}`;
    const { container, getByLabelText } = render(
      <WorkflowLongText text={text} title="Argument: prompt" />
    );
    // Preview is cut at the char budget (plus ellipsis), not the whole value.
    expect(container.textContent).not.toContain(text);
    expect(container.textContent).toContain(`${text.slice(0, WORKFLOW_TEXT_PREVIEW_CHAR_LIMIT)}…`);
    expect(getByLabelText("Show more of Argument: prompt").textContent).toContain(
      "Show more (5.0k chars)"
    );
    expect(getByLabelText("Open Argument: prompt in full view")).toBeTruthy();
  });

  test("Show more expands inline and Show less collapses back", () => {
    const text = `intro ${"x".repeat(5000)}`;
    const { container, getByLabelText } = render(
      <WorkflowLongText text={text} title="Argument: prompt" />
    );
    fireEvent.click(getByLabelText("Show more of Argument: prompt"));
    expect(container.textContent).toContain(text);
    fireEvent.click(getByLabelText("Show less of Argument: prompt"));
    expect(container.textContent).not.toContain(text);
  });

  test("markdown mode renders the preview as plain text and the expansion as markdown", () => {
    const text = `## Findings\n\n${"finding ".repeat(200)}`;
    const { container, getByLabelText, queryByRole } = render(
      <WorkflowLongText markdown text={text} title="step — report" />
    );
    // Collapsed: raw markdown source preview; the markdown pipeline is not
    // mounted at all.
    expect(queryByRole("heading")).toBeNull();
    expect(container.querySelector(".markdown-content")).toBeNull();
    expect(container.textContent).toContain("## Findings");
    fireEvent.click(getByLabelText("Show more of step — report"));
    // Expanded: the plain-source preview is replaced by MarkdownRenderer.
    // Assert only the component-owned mode switch (renderer container mounted,
    // controls flipped) — anything about Streamdown's own output is unstable
    // across bun/happy-dom versions: parse flushing is async in some (1s+
    // waitFor timeouts) while others synchronously render the raw source first.
    expect(container.querySelector(".markdown-content")).not.toBeNull();
    expect(getByLabelText("Show less of step — report")).toBeTruthy();
  });
});

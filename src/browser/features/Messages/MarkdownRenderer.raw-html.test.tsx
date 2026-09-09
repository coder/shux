import "../../../../tests/ui/dom";

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { rawHtmlUsesOnlyAllowedTags } from "./MarkdownCore";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { getTranscriptContextMenuMarkdown } from "@/browser/utils/messages/transcriptContextMenu";

function renderMarkdown(content: string) {
  return render(<MarkdownRenderer content={content} preserveLineBreaks />);
}

describe("MarkdownRenderer raw HTML handling", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("renders unknown JSX-like tags as literal text", () => {
    const view = renderMarkdown(
      "@clerk/nextjs: You've passed multiple children components to <SignOutButton/>. You can only pass a single child component or text."
    );

    expect(view.container.textContent).toContain("<SignOutButton/>");
    expect(view.container.textContent).toContain("You can only pass a single child component");
    expect(view.container.querySelector("signoutbutton")).toBeNull();
  });

  function copyRenderedMarkdown(content: string) {
    const view = render(
      <div data-transcript-message>
        <div data-transcript-quote-root>
          <MarkdownRenderer content={content} />
        </div>
      </div>
    );
    const quoteRoot = view.container.querySelector<HTMLElement>("[data-transcript-quote-root]")!;
    const range = document.createRange();
    range.selectNodeContents(quoteRoot);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const copied = getTranscriptContextMenuMarkdown({
      transcriptRoot: view.container,
      target: quoteRoot,
      selection,
    });
    return { view, copied };
  }

  test("raw HTML cannot substitute hidden TeX for selected visible text", () => {
    const { view, copied } = copyRenderedMarkdown(
      '<span class="katex"><span>Visible</span><span style="display:none"><math><semantics><annotation encoding="application/x-tex">HIDDEN PAYLOAD</annotation></semantics></math></span></span>'
    );
    expect(view.container.querySelector(".katex")).toBeNull();
    expect(copied?.text).toBe("Visible");
    expect(copied?.html).not.toContain("HIDDEN PAYLOAD");
  });

  test("genuine rendered math still copies and renders as math", () => {
    const { view, copied } = copyRenderedMarkdown("$$x^2$$");
    expect(view.container.querySelector(".katex")).not.toBeNull();
    expect(copied?.text).toBe("$$x^2$$");
    const pasted = renderMarkdown(copied!.text);
    expect(
      pasted.container.querySelector('.katex annotation[encoding="application/x-tex"]')?.textContent
    ).toBe("x^2");
  });

  test("keeps supported collapsible HTML on the raw HTML path", () => {
    expect(rawHtmlUsesOnlyAllowedTags("<details><summary>More</summary>Hidden</details>")).toBe(
      true
    );
  });
});

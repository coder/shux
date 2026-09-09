import "../../../../tests/ui/dom";

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { rawHtmlUsesOnlyAllowedTags } from "./MarkdownCore";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { getTranscriptContextMenuMarkdown } from "@/browser/utils/messages/transcriptContextMenu";

function renderMarkdown(content: string) {
  return render(
    <ThemeProvider forcedTheme="dark">
      <MarkdownRenderer content={content} preserveLineBreaks />
    </ThemeProvider>
  );
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
    expect(view.container.querySelector("math, annotation")).toBeNull();
    expect(view.container.textContent).toContain("HIDDEN PAYLOAD");
    const pasted = renderMarkdown(copied!.text);
    expect(pasted.container.querySelector("math, annotation, .katex")).toBeNull();
    expect(pasted.container.textContent).toBe(view.container.textContent);
  });

  test("rendered Markdown emphasis survives copying", () => {
    const { copied } = copyRenderedMarkdown("**bold** and *italic*");
    expect(copied?.text).toBe("**bold** and _italic_");
    expect(copied?.html).toBe("<p><strong>bold</strong> and <em>italic</em></p>");
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

  test.each([
    'style="position:fixed;left:-10000px"',
    'style="clip-path:inset(100%);opacity:0"',
    'class="sr-only opacity-0"',
  ])("raw CSS cannot conceal copied text: %s", (attributes) => {
    const { view, copied } = copyRenderedMarkdown("<span " + attributes + ">Payload</span>");
    const span = view.container.querySelector("span")!;
    expect(span.getAttribute("style")).toBeNull();
    expect(span.className).toBe("");
    expect(copied?.text).toBe("Payload");
  });

  test("math inside an expanded disclosure survives copying and rendering", () => {
    const { view, copied } = copyRenderedMarkdown(
      "<details open>\n<summary>More</summary>\n\n$$x^2$$\n\n</details>"
    );
    expect(view.container.querySelector("details .katex")).not.toBeNull();
    expect(copied?.text).not.toContain("data-clipboard-math");
    const pasted = renderMarkdown(copied!.text);
    expect(
      pasted.container.querySelector('details .katex annotation[encoding="application/x-tex"]')
        ?.textContent
    ).toBe("x^2");
  });

  test("spanning tables retain rendered math after copying", () => {
    const { view, copied } = copyRenderedMarkdown(
      '<table><tr><td colspan="2">\n\n$$x^2$$\n\n</td></tr></table>'
    );
    expect(view.container.querySelector("td .katex")).not.toBeNull();
    const pasted = renderMarkdown(copied!.text);
    expect(pasted.container.querySelector("td")?.getAttribute("colspan")).toBe("2");
    expect(
      pasted.container.querySelector('td .katex annotation[encoding="application/x-tex"]')
        ?.textContent
    ).toBe("x^2");
    expect(copied!.text).not.toContain("data-clipboard-math");
  });

  test("GFM table alignment survives copying", () => {
    const { copied } = copyRenderedMarkdown(
      "| L | C | R |\n| :--- | :---: | ---: |\n| a | b | c |"
    );
    const pasted = renderMarkdown(copied!.text);
    expect(
      Array.from(
        pasted.container.querySelectorAll("th"),
        (cell) => cell.style.textAlign || cell.getAttribute("align")
      )
    ).toEqual(["left", "center", "right"]);
    expect(copied!.html).toContain('align="right"');
  });

  test("closed disclosures do not copy their hidden body", () => {
    const { copied } = copyRenderedMarkdown(
      "<details><summary>Visible</summary><p>HIDDEN</p></details>"
    );
    expect(copied?.text).toContain("Visible");
    expect(copied?.text).not.toContain("HIDDEN");
    expect(copied?.html).not.toContain("HIDDEN");
  });

  test("semantic task and code classes survive raw CSS removal", () => {
    const view = renderMarkdown("- [x] done\n\n```typescript\nconst x = 1;\n```");
    expect(view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(
      true
    );
    expect(
      view.container.querySelector(".code-block-container")?.getAttribute("data-code-language")
    ).toBe("typescript");
  });

  test("keeps supported collapsible HTML on the raw HTML path", () => {
    expect(rawHtmlUsesOnlyAllowedTags("<details><summary>More</summary>Hidden</details>")).toBe(
      true
    );
  });
});

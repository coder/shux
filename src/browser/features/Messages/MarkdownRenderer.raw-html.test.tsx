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
          <ThemeProvider forcedTheme="dark">
            <MarkdownRenderer content={content} />
          </ThemeProvider>
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

  test("definition lists retain nested Markdown, math, and code after copying", () => {
    const { copied } = copyRenderedMarkdown(
      "<dl><dt>Term</dt><dd>\n\n$$x^2$$ and **bold**\n\n<dl><dt>Nested</dt><dd>\n\n```ts\nconst x = 1;\n```\n\n</dd></dl>\n\n</dd></dl>"
    );
    const pasted = renderMarkdown(copied!.text);
    expect(pasted.container.querySelectorAll("dl")).toHaveLength(2);
    expect(pasted.container.querySelector("dt")?.textContent?.trim()).toBe("Term");
    expect(pasted.container.querySelector("dd .katex annotation")?.textContent).toBe("x^2");
    expect(pasted.container.querySelector('dd [data-streamdown="strong"]')?.textContent).toBe(
      "bold"
    );
    expect(pasted.container.querySelector("dd dd .code-line")?.textContent).toContain(
      "const x = 1;"
    );
  });

  test("footnotes retain forward links, repeated references, and backlinks in both formats", () => {
    const { copied } = copyRenderedMarkdown(
      "First[^note] and again[^note].\n\n[^note]: **Definition** with $$x^2$$."
    );
    const rich = document.createElement("div");
    rich.innerHTML = copied!.html;
    const pasted = renderMarkdown(copied!.text);
    for (const root of [rich, pasted.container]) {
      const references = root.querySelectorAll("sup a[href]");
      expect(references).toHaveLength(2);
      for (const reference of references) {
        const target = Array.from(root.querySelectorAll("[id]")).find(
          (element) => "#" + element.id === reference.getAttribute("href")
        );
        expect(target?.textContent).toContain("Definition");
        expect(
          Array.from(target!.querySelectorAll("a[href]")).some(
            (backlink) => backlink.getAttribute("href") === "#" + reference.id
          )
        ).toBe(true);
      }
    }
    expect(pasted.container.querySelector("li .katex annotation")?.textContent).toBe("x^2");
  });

  test("rendered Mermaid fences survive copying and parsing", () => {
    const chart = "graph TD\nA-->B";
    const { copied } = copyRenderedMarkdown("```mermaid\n" + chart + "\n```");
    const rich = document.createElement("div");
    rich.innerHTML = copied!.html;
    expect(rich.querySelector("pre code.language-mermaid")?.textContent?.trim()).toBe(chart);
    const pasted = renderMarkdown(copied!.text);
    expect(pasted.container.querySelector(".mermaid-container")).not.toBeNull();
    expect(pasted.container.querySelector(".code-block-container")).toBeNull();
  });

  test("forged Mermaid metadata cannot replace selected visible text", () => {
    const { copied } = copyRenderedMarkdown(
      '<div class="mermaid-container" data-mermaid-source="graph TD; hidden-->payload">Visible</div>'
    );
    const pasted = renderMarkdown(copied!.text);
    expect(pasted.container.textContent).toBe("Visible");
    expect(pasted.container.querySelector(".mermaid-container")).toBeNull();
  });

  test.each(["reference", "definition", "partial-definition"])(
    "partial footnote selection has no broken links: %s",
    (part) => {
      const { view } = copyRenderedMarkdown("Text[^note].\n\n[^note]: Definition content.");
      const quoteRoot = view.container.querySelector<HTMLElement>("[data-transcript-quote-root]")!;
      const reference = quoteRoot.querySelector("sup")!;
      const definition = quoteRoot.querySelector("li")!;
      const range = document.createRange();
      if (part === "reference") range.selectNodeContents(reference);
      else if (part === "definition") range.selectNodeContents(definition);
      else {
        range.setStartBefore(reference);
        range.setEnd(definition.querySelector("p")!.firstChild!, 10);
      }
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      const copied = getTranscriptContextMenuMarkdown({
        transcriptRoot: view.container,
        target: quoteRoot,
        selection,
      })!;
      const pasted = renderMarkdown(copied.text);
      const rich = document.createElement("div");
      rich.innerHTML = copied.html;
      for (const root of [pasted.container, rich]) {
        expect(root.querySelector('a[href^="#"]')).toBeNull();
        expect(root.textContent).not.toContain("blocked");
        expect(root.textContent).toContain(part === "definition" ? "Definition content." : "1");
      }
      if (part === "reference") expect(pasted.container.textContent).not.toContain("Definition");
      if (part === "partial-definition")
        expect(pasted.container.textContent).not.toContain("content.");
    }
  );

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

  test("safe raw blocks retain separate text boundaries when copied", () => {
    const { copied } = copyRenderedMarkdown(
      "<div>first</div><div>second</div><dl><dt>Term</dt><dd>Definition</dd></dl>"
    );
    const pasted = renderMarkdown(copied!.text);
    expect(copied!.html).toContain("</div><div>");
    expect(copied!.text).not.toContain("firstsecond");
    expect(pasted.container.textContent).toContain("first");
    expect(pasted.container.textContent).toContain("Definition");
  });

  test("row headers do not promote the first data row to a column header", () => {
    const { copied } = copyRenderedMarkdown(
      "<table><tr><th>One</th><td>A</td></tr><tr><th>Two</th><td>B</td></tr></table>"
    );
    const pasted = renderMarkdown(copied!.text);
    expect(pasted.container.querySelector("thead")?.textContent?.trim()).toBe("");
    expect(pasted.container.querySelector("tbody tr")?.textContent).toBe("OneA");
  });

  test("copying follows rendered numbering when unsupported reversed markup is stripped", () => {
    const { view, copied } = copyRenderedMarkdown(
      '<ol reversed start="5"><li>First</li><li>Second</li></ol>'
    );
    expect(view.container.querySelector("ol")?.hasAttribute("reversed")).toBe(false);
    const pasted = renderMarkdown(copied!.text);
    expect(pasted.container.querySelector("ol")?.start).toBe(5);
    expect(copied!.html).toContain('start="5"');
  });

  test("right-clicking a rendered math SVG keeps the selected formula copyable", () => {
    const { view } = copyRenderedMarkdown("$$\\sqrt{x}$$");
    const target = view.container.querySelector(".katex svg path")!;
    expect(target).not.toBeNull();
    const copied = getTranscriptContextMenuMarkdown({
      transcriptRoot: view.container,
      target,
      selection: window.getSelection(),
    });
    expect(copied?.text).toBe("$$\\sqrt{x}$$");
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

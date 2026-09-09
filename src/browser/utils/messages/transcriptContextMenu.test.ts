import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import MarkdownIt from "markdown-it";
import {
  formatTranscriptTextAsQuote,
  getTranscriptContextMenuLink,
  getTranscriptContextMenuMarkdown,
  getTranscriptContextMenuText,
} from "./transcriptContextMenu";

function createTranscriptRoot(markup: string): HTMLElement {
  const transcriptRoot = document.createElement("div");
  transcriptRoot.innerHTML = markup;
  document.body.appendChild(transcriptRoot);
  return transcriptRoot;
}

function createQuoteableTranscriptMessage(markup: string, rootAttributes = ""): string {
  return `<div data-transcript-message><div data-transcript-quote-root${rootAttributes}>${markup}</div></div>`;
}

function getFirstTextNode(element: Element | null): Text {
  const firstChild = element?.firstChild;
  if (firstChild?.nodeType !== 3) {
    throw new Error("Expected element to contain a text node");
  }

  return firstChild as Text;
}

describe("transcriptContextMenu", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  describe("selected Markdown", () => {
    function select(
      root: HTMLElement,
      start: string,
      end = start,
      startOffset = 0,
      endOffset?: number
    ) {
      const first = getFirstTextNode(root.querySelector(start));
      const last = getFirstTextNode(root.querySelector(end));
      const range = document.createRange();
      range.setStart(first, startOffset);
      range.setEnd(last, endOffset ?? last.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return { transcriptRoot: root, target: first.parentElement, selection };
    }

    test("preserves formatting around a partial text selection", () => {
      const root = createTranscriptRoot(
        createQuoteableTranscriptMessage(
          '<p>Before <strong id="part">Alpha beta gamma</strong> after</p>'
        )
      );
      const result = getTranscriptContextMenuMarkdown(select(root, "#part", "#part", 6, 10));
      expect(result).toEqual({ text: "**beta**", html: "<p><strong>beta</strong></p>" });
    });

    test("preserves links when the selection target is an anchor", () => {
      const root = createTranscriptRoot(
        createQuoteableTranscriptMessage(
          '<p><a id="part" href="https://example.com">Example</a></p>'
        )
      );
      const result = getTranscriptContextMenuMarkdown(select(root, "#part"));
      expect(result?.text).toBe("[Example](<https://example.com>)");
      expect(result?.html).toContain('href="https://example.com"');
    });

    test("preserves lists, emphasis, and paragraph boundaries", () => {
      const root = createTranscriptRoot(
        createQuoteableTranscriptMessage(
          '<p id="start">Introduction</p><ul><li><em>First</em></li><li id="end">Second</li></ul><p>Excluded</p>'
        )
      );
      const result = getTranscriptContextMenuMarkdown(select(root, "#start", "#end"));
      expect(result?.text).toBe("Introduction\n\n*   _First_\n*   Second");
      expect(result?.html).toBe(
        "<p>Introduction</p><ul><li><em>First</em></li><li>Second</li></ul>"
      );
    });

    test("preserves selected code whitespace without syntax-highlighting markup", () => {
      const root = createTranscriptRoot(
        createQuoteableTranscriptMessage(
          '<pre><code><span id="part" style="color:red">  const x = 1;\n  x++;</span></code></pre>'
        )
      );
      const result = getTranscriptContextMenuMarkdown(select(root, "#part"));
      expect(result?.text).toBe(["```", "  const x = 1;", "  x++;", "```"].join("\n"));
      expect(result?.html).toBe("<pre><code>  const x = 1;\n  x++;</code></pre>");
    });

    test("preserves partial highlighted code lines without line numbers or controls", () => {
      const root = createTranscriptRoot(
        createQuoteableTranscriptMessage(
          '<div class="code-block-wrapper"><div class="code-block-container"><div class="line-number">1</div><div class="code-line"><span id="first">before selected</span></div><div class="line-number">2</div><div class="code-line"><span id="last">  next after</span></div></div><button>Copy</button></div>'
        )
      );
      const result = getTranscriptContextMenuMarkdown(select(root, "#first", "#last", 7, 6));
      expect(result?.text).toBe(["```", "selected", "  next", "```"].join("\n"));
      expect(result?.html).toBe("<pre><code>selected\n  next</code></pre>");
    });

    test("preserves the starting number of a partial ordered list", () => {
      const root = createTranscriptRoot(
        createQuoteableTranscriptMessage(
          '<ol start="4"><li>Before</li><li id="part">Selected</li><li>After</li></ol>'
        )
      );
      const result = getTranscriptContextMenuMarkdown(select(root, "#part"));
      expect(result?.text).toBe("5.  Selected");
      expect(result?.html).toBe('<ol start="5"><li>Selected</li></ol>');
    });

    test("preserves table columns and escapes cell separators", () => {
      const root = createTranscriptRoot(
        createQuoteableTranscriptMessage(
          '<table><thead><tr><th id="first">Name</th><th>Value</th></tr></thead><tbody><tr><td>A|B</td><td id="last">Two</td></tr></tbody></table>'
        )
      );
      const result = getTranscriptContextMenuMarkdown(select(root, "#first", "#last"));
      expect(result?.text).toBe("| Name | Value |\n| --- | --- |\n| A\\|B | Two |");
      expect(result?.html).toContain("<table>");
    });

    test("keeps column positions when a table selection starts in the second column", () => {
      const root = createTranscriptRoot(
        createQuoteableTranscriptMessage(
          '<table><thead><tr><th>Excluded</th><th id="first">Value</th></tr></thead><tbody><tr><td>A</td><td id="last">Two</td></tr></tbody></table>'
        )
      );
      const result = getTranscriptContextMenuMarkdown(select(root, "#first", "#last"));
      expect(result?.text).toBe("|  | Value |\n| --- | --- |\n| A | Two |");
      expect(result?.html).toContain("<tr><th></th><th>Value</th></tr>");
      expect(result?.html).not.toContain("Excluded");
    });

    test.each([
      "src/main.ts",
      "../my file.ts",
      "docs/(file).ts",
      "docs/file>next.ts",
      "docs/%20exists.md",
      "#usage",
      "/docs",
      "https://example.com",
      "mailto:team@example.com",
    ])("preserves a safe link destination: %s", (href) => {
      const root = createTranscriptRoot(
        createQuoteableTranscriptMessage('<p><a id="part">Link</a></p>')
      );
      root.querySelector("a")!.setAttribute("href", href);
      const result = getTranscriptContextMenuMarkdown(select(root, "#part"));
      expect(result?.html).toContain('href="' + href + '"');
      const tokens = new MarkdownIt().parseInline(result?.text ?? "", {});
      const link = tokens[0].children?.find((token) => token.type === "link_open");
      expect(link?.attrGet("href")).toBe(href.replace(/[<>\s]/g, encodeURIComponent));
    });

    test.each([
      "javascript:alert(1)",
      "java\tscript:alert(1)",
      "data:text/html,bad",
      "vbscript:bad",
      "\\evil.example",
    ])("excludes an unsafe link destination: %s", (href) => {
      const root = createTranscriptRoot(
        createQuoteableTranscriptMessage('<p><a id="part">Link</a></p>')
      );
      root.querySelector("a")!.setAttribute("href", href);
      expect(getTranscriptContextMenuMarkdown(select(root, "#part"))?.html).toBe(
        "<p><a>Link</a></p>"
      );
    });

    test("preserves task state without copying interactive inputs", () => {
      const root = createTranscriptRoot(
        createQuoteableTranscriptMessage(
          '<p id="first">Tasks</p><ul><li><input type="checkbox" checked disabled> done</li><li><input type="checkbox" disabled> pending</li><li><input type="checkbox" checked> interactive</li></ul><p id="last">End</p>'
        )
      );
      const result = getTranscriptContextMenuMarkdown(select(root, "#first", "#last"));
      expect(result?.text).toContain("*   [x] done");
      expect(result?.text).toContain("*   [ ] pending");
      expect(result?.text).toContain("*   interactive");
      expect(result?.html).not.toContain("<input");
    });

    test.each([false, true])(
      "copies one TeX source for selected rendered math (display=%s)",
      (display) => {
        const math =
          '<span class="katex"><span class="katex-mathml"><math><semantics><mrow>x2</mrow><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span id="part">x2</span></span></span>';
        const root = createTranscriptRoot(
          createQuoteableTranscriptMessage(
            display ? '<span class="katex-display">' + math + "</span>" : math
          )
        );
        const result = getTranscriptContextMenuMarkdown(select(root, "#part"));
        expect(result?.text).toBe(display ? "$$\nx^2\n$$" : "$$x^2$$");
        expect(result?.html).not.toContain("x2");
        expect(result?.html).not.toContain("<math");
      }
    );

    test("retains sanitized disclosure structure", () => {
      const root = createTranscriptRoot(
        createQuoteableTranscriptMessage(
          '<details open ontoggle="alert(1)"><summary id="first">More</summary><p id="last">Selected</p><p>Excluded</p></details>'
        )
      );
      const result = getTranscriptContextMenuMarkdown(select(root, "#first", "#last"));
      expect(result?.text).toBe(
        '<details open=""><summary>More</summary><p>Selected</p></details>'
      );
      expect(result?.html).toBe(result?.text);
    });

    test("preserves the language of highlighted code", () => {
      const root = createTranscriptRoot(
        createQuoteableTranscriptMessage(
          '<div class="code-block-container" data-code-language="typescript"><div class="line-number">1</div><div class="code-line"><span id="part">const x = 1;</span></div></div>'
        )
      );
      const result = getTranscriptContextMenuMarkdown(select(root, "#part"));
      expect(result?.text).toBe(["```typescript", "const x = 1;", "```"].join("\n"));
      expect(result?.html).toBe('<pre><code class="language-typescript">const x = 1;</code></pre>');
    });

    test.each([true, false])(
      "retains task state when only item text is selected (checked=%s)",
      (checked) => {
        const root = createTranscriptRoot(
          createQuoteableTranscriptMessage(
            '<ul><li><input type="checkbox" disabled ' +
              (checked ? "checked" : "") +
              '><span id="part">done</span></li><li>Excluded</li></ul>'
          )
        );
        const result = getTranscriptContextMenuMarkdown(select(root, "#part"));
        expect(result?.text).toBe(checked ? "*   [x] done" : "*   [ ] done");
        expect(result?.html).not.toContain("Excluded");
      }
    );

    test("preserves subscript and superscript semantics", () => {
      const root = createTranscriptRoot(
        createQuoteableTranscriptMessage(
          '<p><span id="first">H</span><sub onclick="alert(1)">2</sub>O and x<sup id="last">2</sup></p>'
        )
      );
      const result = getTranscriptContextMenuMarkdown(select(root, "#first", "#last"));
      expect(result?.text).toBe("H<sub>2</sub>O and x<sup>2</sup>");
      expect(result?.html).toBe("<p>H<sub>2</sub>O and x<sup>2</sup></p>");
    });

    test.each([
      'class="sr-only"',
      'style="display:none"',
      'style="visibility:hidden"',
      'style="opacity:0"',
    ])("excludes visually hidden text: %s", (attributes) => {
      const root = createTranscriptRoot(
        createQuoteableTranscriptMessage(
          '<p><span id="first">Before </span><span ' +
            attributes +
            '>HIDDEN PAYLOAD</span><span id="last"> after</span></p>'
        )
      );
      const result = getTranscriptContextMenuMarkdown(select(root, "#first", "#last"));
      expect(result?.text).toBe("Before after");
      expect(result?.html).not.toContain("HIDDEN PAYLOAD");
    });

    test("removes unsafe URLs, attributes, and active content", () => {
      const root = createTranscriptRoot(
        createQuoteableTranscriptMessage(
          '<p><span id="start">&lt;script&gt;</span><a href="javascript:alert(1)" onclick="alert(1)">link</a><img src="https://example.com/tracker"><script>bad()</script><span id="end" style="color:red">end</span></p>'
        )
      );
      const result = getTranscriptContextMenuMarkdown(select(root, "#start", "#end"));
      expect(result?.html).toBe("<p>&lt;script&gt;<a>link</a>end</p>");
      expect(result?.text).not.toContain("bad()");
    });

    test("requires a selection and rejects cross-message selections and ignored controls", () => {
      const root = createTranscriptRoot(
        createQuoteableTranscriptMessage(
          '<p id="first">First</p><button data-transcript-ignore-context-menu>Copy</button><p id="last">Last</p>'
        ) + createQuoteableTranscriptMessage('<p id="other">Other</p>')
      );
      expect(
        getTranscriptContextMenuMarkdown({
          transcriptRoot: root,
          target: root.querySelector("#first"),
          selection: null,
        })
      ).toBeNull();
      expect(getTranscriptContextMenuMarkdown(select(root, "#first", "#other"))).toBeNull();
      expect(getTranscriptContextMenuMarkdown(select(root, "#first", "#last"))).toBeNull();
      const options = select(root, "#first");
      options.selection.collapseToStart();
      expect(getTranscriptContextMenuMarkdown(options)).toBeNull();
    });

    test("does not copy a selection from another message or outside the transcript", () => {
      const root = createTranscriptRoot(
        createQuoteableTranscriptMessage('<p id="first">First</p>') +
          createQuoteableTranscriptMessage('<p id="other">Other</p>')
      );
      const options = select(root, "#first");
      expect(
        getTranscriptContextMenuMarkdown({ ...options, target: root.querySelector("#other") })
      ).toBeNull();
      expect(getTranscriptContextMenuMarkdown({ ...options, target: document.body })).toBeNull();
    });
  });

  test("prefers selected transcript text over hovered text", () => {
    const transcriptRoot = createTranscriptRoot(
      createQuoteableTranscriptMessage(`<p id="message">Alpha beta gamma</p>`)
    );
    const paragraph = transcriptRoot.querySelector("#message");
    expect(paragraph).not.toBeNull();

    const textNode = getFirstTextNode(paragraph);

    const range = document.createRange();
    range.setStart(textNode, 6);
    range.setEnd(textNode, 10);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const result = getTranscriptContextMenuText({
      transcriptRoot,
      target: paragraph,
      selection,
    });

    expect(result).toBe("beta");
  });

  test("preserves leading and trailing whitespace in selected transcript text", () => {
    const transcriptRoot = createTranscriptRoot(
      createQuoteableTranscriptMessage(`<p id="message">  keep this whitespace  </p>`)
    );
    const paragraph = transcriptRoot.querySelector("#message");
    expect(paragraph).not.toBeNull();

    const textNode = getFirstTextNode(paragraph);
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, "  keep this whitespace  ".length);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const result = getTranscriptContextMenuText({
      transcriptRoot,
      target: paragraph,
      selection,
    });

    expect(result).toBe("  keep this whitespace  ");
  });

  test("returns null for interactive targets even when transcript selection exists", () => {
    const transcriptRoot = createTranscriptRoot(
      createQuoteableTranscriptMessage(
        `<p id="message">Alpha beta gamma</p><a id="message-link" href="https://example.com">Example</a>`
      )
    );
    const paragraph = transcriptRoot.querySelector("#message");
    const link = transcriptRoot.querySelector("#message-link");
    expect(paragraph).not.toBeNull();
    expect(link).not.toBeNull();

    const textNode = getFirstTextNode(paragraph);
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const result = getTranscriptContextMenuText({
      transcriptRoot,
      target: link,
      selection,
    });

    expect(result).toBeNull();
  });

  test("falls back to hovered transcript text when selection is outside transcript", () => {
    const transcriptRoot = createTranscriptRoot(
      createQuoteableTranscriptMessage(`<p id="message">Hovered transcript text</p>`)
    );
    const paragraph = transcriptRoot.querySelector("#message");
    expect(paragraph).not.toBeNull();

    const outsideParagraph = document.createElement("p");
    outsideParagraph.textContent = "Outside selection";
    document.body.appendChild(outsideParagraph);

    const outsideTextNode = getFirstTextNode(outsideParagraph);

    const range = document.createRange();
    range.setStart(outsideTextNode, 0);
    range.setEnd(outsideTextNode, "Outside".length);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const result = getTranscriptContextMenuText({
      transcriptRoot,
      target: paragraph,
      selection,
    });

    expect(result).toBe("Hovered transcript text");
  });

  test("falls back to hovered text when selection is inside transcript root but outside a quote root", () => {
    const transcriptRoot = createTranscriptRoot(
      `<div id="notice">System notice text</div>${createQuoteableTranscriptMessage(`<p id="message">Hovered transcript text</p>`)}`
    );
    const paragraph = transcriptRoot.querySelector("#message");
    const notice = transcriptRoot.querySelector("#notice");
    expect(paragraph).not.toBeNull();
    expect(notice).not.toBeNull();

    const noticeTextNode = getFirstTextNode(notice);

    const range = document.createRange();
    range.setStart(noticeTextNode, 0);
    range.setEnd(noticeTextNode, "System".length);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const result = getTranscriptContextMenuText({
      transcriptRoot,
      target: paragraph,
      selection,
    });

    expect(result).toBe("Hovered transcript text");
  });

  test("falls back to hovered text when selection spans multiple quote roots", () => {
    const transcriptRoot = createTranscriptRoot(
      `${createQuoteableTranscriptMessage(`<p id="message-a">First message</p>`)}<div id="notice">System notice text</div>${createQuoteableTranscriptMessage(`<p id="message-b">Second message</p>`)}`
    );
    const messageA = transcriptRoot.querySelector("#message-a");
    const messageB = transcriptRoot.querySelector("#message-b");
    expect(messageA).not.toBeNull();
    expect(messageB).not.toBeNull();

    const messageATextNode = getFirstTextNode(messageA);
    const messageBTextNode = getFirstTextNode(messageB);

    const range = document.createRange();
    range.setStart(messageATextNode, 0);
    range.setEnd(messageBTextNode, "Second".length);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const result = getTranscriptContextMenuText({
      transcriptRoot,
      target: messageB,
      selection,
    });

    expect(result).toBe("Second message");
  });

  test("falls back to hovered transcript text when selection crosses transcript boundary", () => {
    const transcriptRoot = createTranscriptRoot(
      createQuoteableTranscriptMessage(`<p id="message">Hovered transcript text</p>`)
    );
    const paragraph = transcriptRoot.querySelector("#message");
    expect(paragraph).not.toBeNull();

    const outsideParagraph = document.createElement("p");
    outsideParagraph.textContent = "Outside selection";
    document.body.appendChild(outsideParagraph);

    const outsideTextNode = getFirstTextNode(outsideParagraph);
    const insideTextNode = getFirstTextNode(paragraph);

    const range = document.createRange();
    range.setStart(outsideTextNode, 0);
    range.setEnd(insideTextNode, "Hovered".length);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const result = getTranscriptContextMenuText({
      transcriptRoot,
      target: paragraph,
      selection,
    });

    expect(result).toBe("Hovered transcript text");
  });

  test("returns null when target is outside a quoteable transcript message", () => {
    const transcriptRoot = createTranscriptRoot(`<p id="outside-message">No message wrapper</p>`);
    const target = transcriptRoot.querySelector("#outside-message");
    expect(target).not.toBeNull();

    const result = getTranscriptContextMenuText({
      transcriptRoot,
      target,
      selection: null,
    });

    expect(result).toBeNull();
  });

  test("returns null for interactive elements including links", () => {
    const transcriptRoot = createTranscriptRoot(
      createQuoteableTranscriptMessage(
        `<button id="action">Open menu</button><a id="message-link" href="https://example.com">Example</a>`
      )
    );
    const button = transcriptRoot.querySelector("#action");
    const link = transcriptRoot.querySelector("#message-link");
    expect(button).not.toBeNull();
    expect(link).not.toBeNull();

    const buttonResult = getTranscriptContextMenuText({
      transcriptRoot,
      target: button,
      selection: null,
    });
    const linkResult = getTranscriptContextMenuText({
      transcriptRoot,
      target: link,
      selection: null,
    });

    expect(buttonResult).toBeNull();
    expect(linkResult).toBeNull();
  });

  test("falls back to hovered element text for plain div/span transcript content", () => {
    const transcriptRoot = createTranscriptRoot(
      createQuoteableTranscriptMessage(`<div id="row"><span id="token">Command prefix</span></div>`)
    );
    const token = transcriptRoot.querySelector("#token");
    expect(token).not.toBeNull();

    const result = getTranscriptContextMenuText({
      transcriptRoot,
      target: token,
      selection: null,
    });

    expect(result).toBe("Command prefix");
  });

  test("uses explicit quote-block overrides for custom highlighted code blocks", () => {
    const transcriptRoot = createTranscriptRoot(
      createQuoteableTranscriptMessage(
        `<div class="code-block-wrapper" data-transcript-quote-text="echo hi\nls"><div class="code-line"><span id="token">echo</span> hi</div></div>`
      )
    );
    const token = transcriptRoot.querySelector("#token");
    expect(token).not.toBeNull();

    const result = getTranscriptContextMenuText({
      transcriptRoot,
      target: token,
      selection: null,
    });

    expect(result).toBe("echo hi\nls");
  });

  test("uses quote-root overrides for custom plan bodies without quote blocks", () => {
    const transcriptRoot = createTranscriptRoot(
      createQuoteableTranscriptMessage(
        `<div id="plan-body"><span id="plan-token">Phase</span> 1</div>`,
        ` data-transcript-quote-text="Entire plan text"`
      )
    );
    const token = transcriptRoot.querySelector("#plan-token");
    expect(token).not.toBeNull();

    const result = getTranscriptContextMenuText({
      transcriptRoot,
      target: token,
      selection: null,
    });

    expect(result).toBe("Entire plan text");
  });

  test("falls back to hovered text when selection crosses ignored transcript chrome", () => {
    const transcriptRoot = createTranscriptRoot(
      createQuoteableTranscriptMessage(
        `<div id="chrome" data-transcript-ignore-context-menu>Plan header</div><p id="body">Plan body</p>`,
        ` data-transcript-quote-text="Entire plan text"`
      )
    );
    const chrome = transcriptRoot.querySelector("#chrome");
    const body = transcriptRoot.querySelector("#body");
    expect(chrome).not.toBeNull();
    expect(body).not.toBeNull();

    const chromeTextNode = getFirstTextNode(chrome);
    const bodyTextNode = getFirstTextNode(body);
    const range = document.createRange();
    range.setStart(chromeTextNode, 0);
    range.setEnd(bodyTextNode, "Plan".length);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const result = getTranscriptContextMenuText({
      transcriptRoot,
      target: body,
      selection,
    });

    expect(result).toBe("Plan body");
  });

  test("returns null for transcript chrome that opts out of quote actions", () => {
    const transcriptRoot = createTranscriptRoot(
      createQuoteableTranscriptMessage(
        `<div id="chrome" data-transcript-ignore-context-menu>Plan header</div><p id="body">Plan body</p>`
      )
    );
    const chrome = transcriptRoot.querySelector("#chrome");
    expect(chrome).not.toBeNull();

    const result = getTranscriptContextMenuText({
      transcriptRoot,
      target: chrome,
      selection: null,
    });

    expect(result).toBeNull();
  });

  test("formats transcript text as markdown quote", () => {
    expect(formatTranscriptTextAsQuote("Line one\nLine two")).toBe("> Line one\n> Line two\n\n");
    expect(formatTranscriptTextAsQuote("  indented\nline")).toBe(">   indented\n> line\n\n");
    expect(formatTranscriptTextAsQuote("\n\n")).toBe("");
  });

  test("strips leading and trailing newlines from quote text", () => {
    expect(formatTranscriptTextAsQuote("\nLine one\nLine two\n")).toBe(
      "> Line one\n> Line two\n\n"
    );
    expect(formatTranscriptTextAsQuote("\n\nLeading\n\n")).toBe("> Leading\n\n");
    expect(formatTranscriptTextAsQuote("  indented\nline\n")).toBe(">   indented\n> line\n\n");
    expect(formatTranscriptTextAsQuote("\n  \n")).toBe("");
  });

  describe("getTranscriptContextMenuLink", () => {
    test("returns the href when target is an anchor inside the transcript", () => {
      const transcriptRoot = createTranscriptRoot(
        createQuoteableTranscriptMessage(
          `<a id="message-link" href="https://example.com/path?q=1#x">Example</a>`
        )
      );
      const link = transcriptRoot.querySelector("#message-link");
      expect(link).not.toBeNull();

      expect(getTranscriptContextMenuLink({ transcriptRoot, target: link })).toBe(
        "https://example.com/path?q=1#x"
      );
    });

    test("returns the href when target is a descendant text/element inside the anchor", () => {
      const transcriptRoot = createTranscriptRoot(
        createQuoteableTranscriptMessage(
          `<a id="message-link" href="https://example.com"><span id="link-label">Example</span></a>`
        )
      );
      const label = transcriptRoot.querySelector("#link-label");
      expect(label).not.toBeNull();

      const labelTextNode = getFirstTextNode(label);

      expect(getTranscriptContextMenuLink({ transcriptRoot, target: label })).toBe(
        "https://example.com"
      );
      expect(getTranscriptContextMenuLink({ transcriptRoot, target: labelTextNode })).toBe(
        "https://example.com"
      );
    });

    test("returns null when target is outside the transcript", () => {
      const transcriptRoot = createTranscriptRoot(
        createQuoteableTranscriptMessage(
          `<a id="message-link" href="https://example.com">Example</a>`
        )
      );

      const outsideLink = document.createElement("a");
      outsideLink.href = "https://outside.example.com";
      outsideLink.textContent = "Outside";
      document.body.appendChild(outsideLink);

      expect(getTranscriptContextMenuLink({ transcriptRoot, target: outsideLink })).toBeNull();
    });

    test("returns null when target is not an anchor", () => {
      const transcriptRoot = createTranscriptRoot(
        createQuoteableTranscriptMessage(`<p id="message">Plain text</p>`)
      );
      const paragraph = transcriptRoot.querySelector("#message");
      expect(paragraph).not.toBeNull();

      expect(getTranscriptContextMenuLink({ transcriptRoot, target: paragraph })).toBeNull();
    });

    test("returns null for anchors without an href attribute", () => {
      const transcriptRoot = createTranscriptRoot(
        createQuoteableTranscriptMessage(`<a id="anchor-no-href">No link</a>`)
      );
      const anchor = transcriptRoot.querySelector("#anchor-no-href");
      expect(anchor).not.toBeNull();

      expect(getTranscriptContextMenuLink({ transcriptRoot, target: anchor })).toBeNull();
    });

    test("returns null for anchors with blank href values", () => {
      const transcriptRoot = createTranscriptRoot(
        createQuoteableTranscriptMessage(`<a id="empty-href" href="   ">Blank</a>`)
      );
      const anchor = transcriptRoot.querySelector("#empty-href");
      expect(anchor).not.toBeNull();

      expect(getTranscriptContextMenuLink({ transcriptRoot, target: anchor })).toBeNull();
    });
  });
});

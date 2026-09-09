import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { StreamingContext } from "./StreamingContext";
import { Mermaid, sanitizeMermaidSvg } from "./Mermaid";
import { getTranscriptContextMenuMarkdown } from "@/browser/utils/messages/transcriptContextMenu";
import MarkdownIt from "markdown-it";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";

const DEFAULT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" /></svg>';

const mermaidInitialize = mock(() => undefined);
const mermaidParse = mock((_chart: string) => Promise.resolve());
const mermaidRender = mock((_id: string, _chart: string) => Promise.resolve({ svg: DEFAULT_SVG }));

void mock.module("mermaid", () => ({
  default: {
    initialize: mermaidInitialize,
    parse: (chart: string) => mermaidParse(chart),
    render: (id: string, chart: string) => mermaidRender(id, chart),
  },
}));

function renderMermaid(props: { chart?: string; isStreaming?: boolean } = {}) {
  return render(
    <StreamingContext.Provider value={{ isStreaming: props.isStreaming ?? false }}>
      <Mermaid chart={props.chart ?? "graph TD\nA-->B"} />
    </StreamingContext.Provider>
  );
}

describe("Mermaid layout stability", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalDOMParser: typeof globalThis.DOMParser;
  let originalHTMLElement: typeof globalThis.HTMLElement;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalDOMParser = globalThis.DOMParser;
    originalHTMLElement = globalThis.HTMLElement;

    const domWindow = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.window = domWindow;
    globalThis.document = domWindow.document;
    globalThis.DOMParser = domWindow.DOMParser;
    globalThis.HTMLElement = domWindow.HTMLElement;

    mermaidParse.mockImplementation(() => Promise.resolve());
    mermaidRender.mockImplementation(() => Promise.resolve({ svg: DEFAULT_SVG }));
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.DOMParser = originalDOMParser;
    globalThis.HTMLElement = originalHTMLElement;
    mermaidParse.mockClear();
    mermaidRender.mockClear();
  });

  test("copies a selected textless diagram and excludes diagram controls", async () => {
    const chart = "graph TD\nA-->B";
    const view = render(
      <div data-transcript-message>
        <div data-transcript-quote-root>
          <p>Before</p>
          <Mermaid chart={chart} />
          <p>After</p>
        </div>
      </div>
    );
    await waitFor(() =>
      expect(view.container.querySelector(".mermaid-container svg")).not.toBeNull()
    );
    const diagram = view.container.querySelector(".mermaid-container")!;
    const range = document.createRange();
    range.selectNodeContents(diagram);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString()).toBe("");
    const options = {
      transcriptRoot: view.container,
      selection,
      target: diagram.querySelector("rect"),
    };
    const copied = getTranscriptContextMenuMarkdown(options)!;
    const parsed = document.createElement("div");
    parsed.innerHTML = new MarkdownIt().render(copied.text);
    expect(parsed.querySelector("code.language-mermaid")?.textContent?.trim()).toBe(chart);
    expect(copied.html).not.toContain("svg");
    expect(
      getTranscriptContextMenuMarkdown({
        ...options,
        target: view.container.querySelector("button"),
      })
    ).toBeNull();

    const first = view.container.querySelector("p")!;
    range.setStart(first.firstChild!, 0);
    range.setEndBefore(diagram.parentElement!);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(getTranscriptContextMenuMarkdown({ ...options, target: first })?.text).toBe("Before");

    range.setEndAfter(diagram.parentElement!);
    selection.removeAllRanges();
    selection.addRange(range);
    const mixed = getTranscriptContextMenuMarkdown({ ...options, target: first })!;
    parsed.innerHTML = new MarkdownIt().render(mixed.text);
    expect(parsed.querySelector("p")?.textContent).toBe("Before");
    expect(parsed.querySelector("code.language-mermaid")?.textContent?.trim()).toBe(chart);
    expect(parsed.textContent).not.toContain("After");
  });

  test("copies the displayed chart during pending and invalid streaming updates", async () => {
    const first = "graph TD\nA-->B";
    const next = "graph TD\nB-->C";
    const renderContent = (chart: string) => (
      <ThemeProvider forcedTheme="dark">
        <StreamingContext.Provider value={{ isStreaming: true }}>
          <div data-transcript-message>
            <div data-transcript-quote-root>
              <MarkdownRenderer content={"```mermaid\n" + chart + "\n```"} />
            </div>
          </div>
        </StreamingContext.Provider>
      </ThemeProvider>
    );
    const view = render(renderContent(first));
    const copySource = () => {
      const diagram = view.container.querySelector(".mermaid-container")!;
      const range = document.createRange();
      range.selectNodeContents(diagram);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      const copied = getTranscriptContextMenuMarkdown({
        transcriptRoot: view.container,
        selection,
        target: diagram,
      })!;
      const parsed = document.createElement("div");
      parsed.innerHTML = new MarkdownIt().render(copied.text);
      return parsed.querySelector("code.language-mermaid")?.textContent?.trim();
    };
    await waitFor(() => expect(view.container.querySelector("svg")).not.toBeNull());
    expect(copySource()).toBe(first);
    const pending = Promise.withResolvers<void>();
    mermaidParse.mockImplementation(() => pending.promise);
    view.rerender(renderContent(next));
    expect(copySource()).toBe(first);
    await waitFor(() => expect(mermaidParse).toHaveBeenCalledWith(next + "\n"));
    expect(copySource()).toBe(first);
    await act(async () => {
      pending.reject(new Error("Incomplete diagram"));
      await pending.promise.catch(() => undefined);
    });
    expect(copySource()).toBe(first);

    mermaidParse.mockImplementation(() => Promise.resolve());
    const third = "graph TD\nC-->D";
    view.rerender(renderContent(third));
    await waitFor(() => expect(copySource()).toBe(third));
    const pasted = render(renderContent(copySource()!));
    await waitFor(() =>
      expect(pasted.container.querySelector(".mermaid-container svg")).not.toBeNull()
    );
  });

  test("guest Escape cannot close an expanded host diagram", async () => {
    const view = renderMermaid();
    fireEvent.click(await view.findByRole("button", { name: "⤢" }));
    const close = await view.findByRole("button", { name: "Close" });
    const viewport = document.createElement("div");
    viewport.setAttribute("data-desktop-viewport", "");
    const canvas = document.createElement("canvas");
    viewport.appendChild(canvas);
    view.container.appendChild(viewport);
    const event = new window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    fireEvent(canvas, event);
    expect(event.defaultPrevented).toBe(false);
    expect(view.getByRole("button", { name: "Close" })).toBe(close);

    fireEvent.keyDown(close, { key: "Escape" });
    expect(view.queryByRole("button", { name: "Close" })).toBeNull();
  });

  test("reserves diagram height while a streaming diagram is still rendering", () => {
    mermaidParse.mockImplementation(
      () =>
        new Promise<never>((resolve) => {
          void resolve;
        })
    );

    const view = renderMermaid({ isStreaming: true });

    const container = view.container.querySelector<HTMLElement>(".mermaid-container");
    expect(container).not.toBeNull();
    expect(container?.style.minHeight).toBe("300px");
    expect(container?.textContent).toBe("Rendering diagram...");
  });

  test("keeps the stable diagram frame for streaming parse errors", async () => {
    mermaidParse.mockImplementation(() => Promise.reject(new Error("diagram is incomplete")));

    const view = renderMermaid({ isStreaming: true });

    await waitFor(() => expect(mermaidParse).toHaveBeenCalled());
    const container = view.container.querySelector<HTMLElement>(".mermaid-container");
    expect(container).not.toBeNull();
    expect(container?.style.minHeight).toBe("300px");
    expect(view.container.textContent).toContain("Rendering diagram...");
    expect(view.container.textContent).not.toContain("Mermaid Error");
  });

  test("shows parse errors after streaming settles", async () => {
    mermaidParse.mockImplementation(() => Promise.reject(new Error("bad diagram")));

    const view = renderMermaid({ isStreaming: false });

    await waitFor(() => expect(view.container.textContent).toContain("Mermaid Error: bad diagram"));
    expect(view.container.querySelector(".mermaid-container")).toBeNull();
  });

  // Regression: Mermaid embeds HTML labels (with bare <br>, <hr>, etc.) inside
  // <foreignObject>. A strict image/svg+xml DOMParser rejects that markup and
  // we used to surface "Mermaid returned invalid SVG output" for any diagram
  // that wrapped a label. Sanitization must accept foreignObject HTML while
  // still stripping active content.
  describe("sanitizeMermaidSvg (foreignObject + void elements)", () => {
    const SVG_WITH_BR = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <foreignObject x="0" y="0" width="100" height="100">
        <div xmlns="http://www.w3.org/1999/xhtml"><span><p>first<br>second</p></span></div>
      </foreignObject>
    </svg>`;

    test("accepts SVG whose foreignObject HTML labels use bare <br>", () => {
      const out = sanitizeMermaidSvg(SVG_WITH_BR);
      expect(out).not.toBeNull();
      expect(out).toContain("<svg");
      expect(out).toContain("first");
      expect(out).toContain("second");
    });

    test("still strips <script> nested inside foreignObject", () => {
      const malicious = `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject>
        <div xmlns="http://www.w3.org/1999/xhtml">
          <p>hi<br>there</p>
          <script>alert(1)</script>
        </div>
      </foreignObject></svg>`;
      const out = sanitizeMermaidSvg(malicious);
      expect(out).not.toBeNull();
      expect(out).not.toContain("<script");
      expect(out).not.toContain("alert(1)");
    });

    test("still strips on* handlers and javascript: hrefs", () => {
      const malicious = `<svg xmlns="http://www.w3.org/2000/svg">
        <a href="javascript:alert(1)" onclick="alert(2)"><rect width="10" height="10"/></a>
      </svg>`;
      const out = sanitizeMermaidSvg(malicious);
      expect(out).not.toBeNull();
      expect(out).not.toContain("javascript:");
      expect(out).not.toContain("onclick");
    });

    test("rejects input that contains no <svg> root", () => {
      expect(sanitizeMermaidSvg("<div>not an svg</div>")).toBeNull();
      expect(sanitizeMermaidSvg("")).toBeNull();
    });

    test("still rejects malformed SVG that lacks foreignObject", () => {
      // Codex regression: HTML parsing is permissive enough to "repair" missing
      // close tags. We only relax to HTML parsing for the foreignObject case
      // (Mermaid's known idiom). Other malformed input must still fail closed
      // so callers see "invalid SVG output" instead of a silently-recovered
      // tree.
      expect(sanitizeMermaidSvg("<svg><g></svg>")).toBeNull();
      expect(sanitizeMermaidSvg("<svg><rect></svg>")).toBeNull();
    });

    test("rejects malformed SVG even when foreignObject is present and broken", () => {
      // A foreignObject opens the HTML-parser fallback, but the input still
      // has to contain a recognizable <svg> root. Garbage without one fails.
      expect(sanitizeMermaidSvg("<foreignObject><p>oops</p></foreignObject>")).toBeNull();
    });

    test("rejects malformed SVG that has foreignObject but breaks outside it", () => {
      // Codex regression #2: the presence of <foreignObject> alone must not
      // open the door to repairing structural errors elsewhere in the SVG.
      // After stripping the foreignObject subtree, the outer structure
      // (unbalanced <g>) is still malformed → must fail closed.
      const malformedOutside =
        '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><p>x<br></p></foreignObject><g></svg>';
      expect(sanitizeMermaidSvg(malformedOutside)).toBeNull();
    });

    test("accepts valid SVG whose only XML non-conformance is inside foreignObject", () => {
      // Positive complement of the above: when stripping <foreignObject>
      // produces well-formed XML, we relax to the HTML parser and keep the
      // embedded label intact.
      const wrappedLabel =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g><foreignObject x="0" y="0" width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"><p>a<br>b</p></div></foreignObject></g></svg>';
      const out = sanitizeMermaidSvg(wrappedLabel);
      expect(out).not.toBeNull();
      expect(out).toContain("<svg");
    });
  });

  test("zoom controls scale rendered diagrams", async () => {
    const view = renderMermaid();

    await waitFor(() => {
      expect(view.container.querySelector(".mermaid-container svg")).not.toBeNull();
    });

    const container = view.container.querySelector<HTMLElement>(".mermaid-container");
    expect(container).not.toBeNull();
    expect(container?.style.getPropertyValue("--diagram-zoom")).toBe("1");

    const buttons = Array.from(view.container.querySelectorAll("button"));
    const zoomOutButton = buttons.find((button) => button.textContent === "−");
    const zoomInButton = buttons.find((button) => button.textContent === "+");
    if (!zoomOutButton || !zoomInButton) {
      throw new Error("Expected Mermaid zoom controls to render");
    }

    fireEvent.click(zoomInButton);

    await waitFor(() => {
      expect(container?.style.getPropertyValue("--diagram-zoom")).toBe("1.1");
    });
    expect(window.localStorage.getItem("mermaid-diagram-zoom")).toBe("1.1");

    fireEvent.click(zoomOutButton);

    await waitFor(() => {
      expect(container?.style.getPropertyValue("--diagram-zoom")).toBe("1");
    });
  });

  test("renders sanitized SVG inside the stable container", async () => {
    mermaidRender.mockImplementation(() =>
      Promise.resolve({
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10" /></svg>',
      })
    );

    const view = renderMermaid();

    await waitFor(() => {
      const svg = view.container.querySelector(".mermaid-container svg");
      expect(svg).not.toBeNull();
    });
    const container = view.container.querySelector<HTMLElement>(".mermaid-container");
    expect(container?.style.minHeight).toBe("300px");
    expect(view.container.querySelector("script")).toBeNull();
  });
});

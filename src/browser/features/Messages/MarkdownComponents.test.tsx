import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { MessageListProvider } from "./MessageListContext";
import type { HighlightedCodeBlockLines } from "./MarkdownComponents";
import { resolveCodeBlockLines, markdownComponents } from "./MarkdownComponents";

// Mirrors the plain-line derivation in CodeBlock (drop the trailing empty line).
function toPlainLines(code: string): string[] {
  return code.split("\n").filter((line, idx, arr) => idx < arr.length - 1 || line !== "");
}

function renderCodeBlock(
  className: string,
  children: string,
  openTerminal = mock(() => undefined)
) {
  const view = render(
    <ThemeProvider forcedTheme="dark">
      <MessageListProvider value={{ workspaceId: "ws-1", latestMessageId: null, openTerminal }}>
        {markdownComponents.code({ inline: false, className, children })}
      </MessageListProvider>
    </ThemeProvider>
  );
  return { ...view, openTerminal };
}

function renderMarkdownLink(href: string | undefined, children: string) {
  return render(markdownComponents.a({ href, children }));
}

let cleanupDom: (() => void) | null = null;

beforeEach(() => {
  cleanupDom = installDom();
});

afterEach(() => {
  cleanup();
  cleanupDom?.();
  cleanupDom = null;
});

describe("MarkdownComponents command code blocks", () => {
  // prettier-ignore
  test.each([
    ["bash", "language-bash", "$ npm install\n", "npm install"],
    ["powershell", "language-powershell", "PS C:\\Users\\mike> npm install mux\n", "npm install mux"],
    ["cmd", "language-cmd", "C:\\Users\\mike> dir\n", "dir"],
    ["cmd-continuation", "language-cmd", "C:\\> echo foo ^\n>bar\n", "echo foo ^\nbar"],
    ["shell-continuation", "language-bash", "$ cat <<EOF\n> line 1\n> EOF\n", "cat <<EOF\nline 1\nEOF"],
  ])("runs %s command blocks", (_name, className, children, initialCommand) => {
    const { getByRole, openTerminal } = renderCodeBlock(className, children);

    fireEvent.click(getByRole("button", { name: "Run command" }));

    expect(openTerminal).toHaveBeenCalledWith({ initialCommand });
  });

  test.each([
    ["shell-session", "language-shell-session", "$ echo hello\nhello\n"],
    ["non-shell", "language-typescript", "console.log('hello')\n"],
  ])("hides Run for %s blocks", (_name, className, children) => {
    const { queryByRole } = renderCodeBlock(className, children);

    expect(queryByRole("button", { name: "Run command" })).toBeNull();
  });
});

describe("resolveCodeBlockLines streaming highlight", () => {
  const highlightedLine = (text: string) => `<span>${text}</span>`;

  test("renders plain text before any highlight is available", () => {
    const code = "const a = 1;\nconst b";
    expect(resolveCodeBlockLines(null, code, toPlainLines(code), "typescript", "dark")).toEqual([
      { content: "const a = 1;", highlighted: false },
      { content: "const b", highlighted: false },
    ]);
  });

  test("fully highlights when the highlight matches the current code", () => {
    const code = "const a = 1;";
    const highlighted: HighlightedCodeBlockLines = {
      code,
      shikiLanguage: "typescript",
      theme: "dark",
      lines: [highlightedLine("const a = 1;")],
    };
    expect(
      resolveCodeBlockLines(highlighted, code, toPlainLines(code), "typescript", "dark")
    ).toEqual([{ content: highlightedLine("const a = 1;"), highlighted: true }]);
  });

  test("keeps finalized prefix lines highlighted while the streaming tail stays plain", () => {
    // Previous highlight ended on a newline, so its line is complete and safe to reuse.
    const highlighted: HighlightedCodeBlockLines = {
      code: "const a = 1;\n",
      shikiLanguage: "typescript",
      theme: "dark",
      lines: [highlightedLine("const a = 1;")],
    };
    const code = "const a = 1;\nconst b = 2;";

    // The finalized first line stays colored (no flash back to plain); only the still-
    // growing last line renders as plain text until the next highlight lands.
    expect(
      resolveCodeBlockLines(highlighted, code, toPlainLines(code), "typescript", "dark")
    ).toEqual([
      { content: highlightedLine("const a = 1;"), highlighted: true },
      { content: "const b = 2;", highlighted: false },
    ]);
  });

  test("does not reuse the last highlighted line when it was still incomplete", () => {
    // No trailing newline => the last highlighted line ("const b = 2") was mid-stream and
    // must not be shown as stale text once more characters arrive.
    const highlighted: HighlightedCodeBlockLines = {
      code: "const a = 1;\nconst b = 2",
      shikiLanguage: "typescript",
      theme: "dark",
      lines: [highlightedLine("const a = 1;"), highlightedLine("const b = 2")],
    };
    const code = "const a = 1;\nconst b = 22;";

    expect(
      resolveCodeBlockLines(highlighted, code, toPlainLines(code), "typescript", "dark")
    ).toEqual([
      { content: highlightedLine("const a = 1;"), highlighted: true },
      { content: "const b = 22;", highlighted: false },
    ]);
  });

  test("falls back to plain text on theme change", () => {
    const code = "const a = 1;";
    const highlighted: HighlightedCodeBlockLines = {
      code,
      shikiLanguage: "typescript",
      theme: "dark",
      lines: [highlightedLine("const a = 1;")],
    };
    expect(
      resolveCodeBlockLines(highlighted, code, toPlainLines(code), "typescript", "light")
    ).toEqual([{ content: "const a = 1;", highlighted: false }]);
  });

  test("falls back to plain text when the highlight is not a prefix of the current code", () => {
    const highlighted: HighlightedCodeBlockLines = {
      code: "const oldValue = 1;\n",
      shikiLanguage: "typescript",
      theme: "dark",
      lines: [highlightedLine("const oldValue = 1;")],
    };
    const code = "const nextValue = 2;\nconsole.log(nextValue);";

    expect(
      resolveCodeBlockLines(highlighted, code, toPlainLines(code), "typescript", "dark")
    ).toEqual([
      { content: "const nextValue = 2;", highlighted: false },
      { content: "console.log(nextValue);", highlighted: false },
    ]);
  });
});

describe("MarkdownComponents anchors", () => {
  // prettier-ignore
  test.each([
    ["proxy-template", "https://coder.example.com/@u/ws/apps/mux/", "https://proxy-{{port}}.{{host}}", "http://127.0.0.1:5173/docs?x=1#details", "Open local docs", "https://proxy-5173.coder.example.com/docs?x=1#details", true],
    ["coder-template", "https://5173--dev--pog2--ethan--apps.sydney.fly.dev.coder.com/workspace/f5a5ed5f7e", undefined, "http://127.0.0.1:8080/api/health?x=1#ok", "Open forwarded health", "https://8080--dev--pog2--ethan--apps.sydney.fly.dev.coder.com/api/health?x=1#ok", false],
    ["external", "https://coder.example.com/@u/ws/apps/mux/", "https://proxy-{{port}}.{{host}}", "https://example.com/docs?x=1#details", "Open external docs", "https://example.com/docs?x=1#details", true],
  ])("handles %s links", (_name, locationHref, proxyTemplate, href, label, expectedHref, assertBlankAttrs) => {
    window.location.href = locationHref;
    (window as Window & { __MUX_PROXY_URI_TEMPLATE__?: string }).__MUX_PROXY_URI_TEMPLATE__ =
      proxyTemplate;

    const { getByRole } = renderMarkdownLink(href, label);
    const link = getByRole("link", { name: label });

    expect(link.getAttribute("href")).toBe(expectedHref);
    if (assertBlankAttrs) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });

  test("keeps undefined href behavior unchanged", () => {
    const { container } = renderMarkdownLink(undefined, "Missing href");
    const link = container.querySelector("a");

    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBeNull();
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });
});

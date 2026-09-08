import type { ReactNode } from "react";
import React, { useContext, useEffect, useState } from "react";
import { Play } from "lucide-react";
import { Mermaid } from "./Mermaid";
import { useOptionalMessageListContext } from "./MessageListContext";
import { highlightCode } from "@/browser/utils/highlighting/highlightWorkerClient";
import { extractShikiLines, isLightThemeMode } from "@/browser/utils/highlighting/shiki-shared";
import { useTheme } from "@/browser/contexts/ThemeContext";
import { CopyButton } from "@/browser/components/CopyButton/CopyButton";
import { resolveBrowserLocalhostProxyTemplate } from "@/browser/utils/browserLocalhostProxyTemplate";
import { normalizeLocalhostProxyUrl } from "@/common/utils/localhostProxyUrl";
import { InlineSkillPreviewContext } from "./InlineSkillPreviewContext";
import { INTERNAL_INLINE_SKILL_HREF_PREFIX } from "./inlineSkillMarkdown";

interface CodeProps {
  node?: unknown;
  inline?: boolean;
  className?: string;
  children?: ReactNode;
}

interface PreProps {
  children?: ReactNode;
}

interface DetailsProps {
  children?: ReactNode;
  open?: boolean;
}

interface SummaryProps {
  children?: ReactNode;
}

interface AnchorProps {
  href?: string;
  children?: ReactNode;
}

const RUNNABLE_SHELL_LANGUAGES = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "fish",
  "powershell",
  "pwsh",
  "cmd",
  "batch",
]);

function normalizeSuggestedShellCommand(code: string): string {
  const lines = code.split("\n");

  // Trim leading/trailing blank lines (but preserve blank lines in the middle).
  while (lines.length > 0 && lines[0].trim() === "") {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }

  let promptKind: "unix" | "powershell" | "cmd" | null = null;

  return lines
    .map((line, idx) => {
      // Remove leading prompt characters (copy/paste friendly).
      // Examples:
      //   $ npm install
      //   $ cat <<EOF
      //   > line 1
      //   > EOF
      //   PS C:\Users\mike> npm install
      //   C:\Users\mike> npm install

      // Common Unix shell prompt marker.
      if (/^\s*\$\s+/.test(line)) {
        promptKind = "unix";
        return line.replace(/^\s*\$\s+/, "");
      }

      // PowerShell prompt marker.
      if (/^\s*PS(?:\s+[^>]+)?>\s*/.test(line)) {
        promptKind = "powershell";
        return line.replace(/^\s*PS(?:\s+[^>]+)?>\s*/, "");
      }

      // cmd.exe prompt marker.
      if (/^\s*[A-Za-z]:\\[^>]*>\s*/.test(line)) {
        promptKind = "cmd";
        return line.replace(/^\s*[A-Za-z]:\\[^>]*>\s*/, "");
      }

      // Avoid stripping leading `>` on the *first* line since it can be a valid
      // redirection operator (e.g. `> output.txt` truncates/creates a file).
      //
      // But if the snippet starts with a `$ ` prompt marker, then `> ` on subsequent
      // lines is usually a continuation prompt (PS2) and should be stripped.
      if (promptKind === "unix" && idx > 0) {
        return line.replace(/^\s*>\s+/, "");
      }

      // cmd.exe continuation prompt is just `>` (space after is optional).
      if (promptKind === "cmd" && idx > 0) {
        return line.replace(/^\s*>\s*/, "");
      }

      // PowerShell uses `>>` for continuation lines.
      if (promptKind === "powershell" && idx > 0) {
        return line.replace(/^\s*>>\s+/, "");
      }

      return line;
    })
    .join("\n")
    .trim();
}

function isRunnableShellLanguage(language: string): boolean {
  return RUNNABLE_SHELL_LANGUAGES.has(language.toLowerCase());
}

interface CodeBlockProps {
  code: string;
  language: string;
  /**
   * Language id passed to Shiki. Allows us to keep a non-runnable “meta” language
   * (e.g. shell-session) while still getting reasonable highlighting.
   */
  highlightLanguage?: string;
}

export interface HighlightedCodeBlockLines {
  code: string;
  shikiLanguage: string;
  theme: "light" | "dark";
  lines: string[];
}

export interface ResolvedCodeBlockLine {
  /** Either Shiki HTML (when `highlighted`) or plain source text. */
  content: string;
  /** When true, `content` is trusted Shiki HTML; otherwise it is plain text. */
  highlighted: boolean;
}

/**
 * Resolve which lines to render while async Shiki output may lag behind the current code.
 *
 * Streaming code fences grow one chunk at a time, so the previous highlight is almost
 * always a prefix of the current code. Every line terminated by a newline in that prefix
 * is final (left-to-right tokenization means a completed line's colors never change based
 * on later lines), so we keep those lines highlighted and only fall back to plain text for
 * the still-growing tail. This shows correct partial highlighting instead of flashing the
 * whole block between plain and colored on every streamed chunk.
 */
export function resolveCodeBlockLines(
  highlighted: HighlightedCodeBlockLines | null,
  code: string,
  plainLines: string[],
  shikiLanguage: string,
  theme: "light" | "dark"
): ResolvedCodeBlockLine[] {
  const asPlain = (): ResolvedCodeBlockLine[] =>
    plainLines.map((content) => ({ content, highlighted: false }));

  // No highlight yet, or it targets a different language/theme: render plain.
  if (!highlighted) {
    return asPlain();
  }
  if (highlighted.shikiLanguage !== shikiLanguage || highlighted.theme !== theme) {
    return asPlain();
  }

  // Highlight matches the current code exactly: fully highlighted.
  if (highlighted.code === code) {
    return highlighted.lines.map((content) => ({ content, highlighted: true }));
  }

  // Streaming append: keep the finalized prefix highlighted, render the tail plain.
  if (code.startsWith(highlighted.code)) {
    // A trailing newline means every highlighted line is complete; otherwise the last
    // highlighted line is still growing and must not be reused (it would show stale text).
    const finalizedCount = highlighted.code.endsWith("\n")
      ? highlighted.lines.length
      : highlighted.lines.length - 1;
    const safeCount = Math.max(0, Math.min(finalizedCount, plainLines.length));
    return plainLines.map((content, idx) =>
      idx < safeCount
        ? { content: highlighted.lines[idx], highlighted: true }
        : { content, highlighted: false }
    );
  }

  // Highlight no longer corresponds to the current code (e.g. theme/code reset): render
  // plain until the async highlighter catches up.
  return asPlain();
}

/**
 * CodeBlock component with async Shiki highlighting
 * Displays code with line numbers in a CSS grid
 */
const CodeBlock: React.FC<CodeBlockProps> = ({ code, language, highlightLanguage }) => {
  const [highlighted, setHighlighted] = useState<HighlightedCodeBlockLines | null>(null);

  const shikiLanguage = highlightLanguage ?? language;
  const { theme: themeMode } = useTheme();
  const theme = isLightThemeMode(themeMode) ? "light" : "dark";

  // Split code into lines, removing trailing empty line
  const plainLines = code
    .split("\n")
    .filter((line, idx, arr) => idx < arr.length - 1 || line !== "");

  useEffect(() => {
    let cancelled = false;

    async function highlight() {
      try {
        const html = await highlightCode(code, shikiLanguage, theme);

        if (!cancelled) {
          const lines = extractShikiLines(html);
          // Remove trailing empty line if present
          const filteredLines = lines.filter(
            (line, idx, arr) => idx < arr.length - 1 || line.trim() !== ""
          );
          if (filteredLines.length > 0) {
            setHighlighted({ code, shikiLanguage, theme, lines: filteredLines });
          } else {
            setHighlighted(null);
          }
        }
      } catch (error) {
        console.warn(`Failed to highlight code block (${shikiLanguage}):`, error);
        if (!cancelled) setHighlighted(null);
      }
    }

    void highlight();
    return () => {
      cancelled = true;
    };
  }, [code, shikiLanguage, theme]);

  const messageListContext = useOptionalMessageListContext();
  const openTerminal = messageListContext?.openTerminal;
  const runnableCommand = isRunnableShellLanguage(language)
    ? normalizeSuggestedShellCommand(code)
    : "";
  const showRunButton = Boolean(openTerminal) && runnableCommand.length > 0;
  // Keep finalized lines highlighted while the async highlighter catches up to the
  // streaming tail, instead of flashing the whole block between plain and colored.
  const lines = resolveCodeBlockLines(highlighted, code, plainLines, shikiLanguage, theme);
  const isSingleLine = lines.length === 1;

  return (
    <div
      className={`code-block-wrapper${isSingleLine ? " code-block-single-line" : ""}${showRunButton ? " code-block-runnable" : ""}`}
    >
      <div className="code-block-container">
        {lines.map((line, idx) => (
          <React.Fragment key={idx}>
            <div className="line-number">{idx + 1}</div>
            {/* SECURITY AUDIT: dangerouslySetInnerHTML usage
             * Source: Shiki syntax highlighter (highlighter.codeToHtml)
             * Safety: Shiki escapes all user content before wrapping in <span> tokens
             * Data flow: User markdown → react-markdown → code prop → Shiki → extractShikiLines → here
             * Verification: Shiki's codeToHtml tokenizes and escapes HTML entities in code content
             * Risk: Low - Shiki is a trusted library that properly escapes user input
             * Alternative considered: Render Shiki's full <code> block, but per-line rendering
             *   required for line numbers in CSS grid layout
             */}
            <div
              className="code-line"
              {...(line.highlighted
                ? { dangerouslySetInnerHTML: { __html: line.content } }
                : { children: <code>{line.content}</code> })}
            />
          </React.Fragment>
        ))}
      </div>
      {showRunButton ? (
        <button
          type="button"
          className="copy-button code-run-button"
          aria-label="Run command"
          onClick={() => openTerminal?.({ initialCommand: runnableCommand })}
        >
          <Play className="copy-icon" />
        </button>
      ) : null}
      <CopyButton text={code} className="code-copy-button" />
    </div>
  );
};

function getTextFromReactNode(node: ReactNode): string {
  let text = "";

  React.Children.forEach(node, (child) => {
    if (typeof child === "string" || typeof child === "number") {
      text += String(child);
      return;
    }

    if (React.isValidElement<{ children?: ReactNode }>(child)) {
      text += getTextFromReactNode(child.props.children);
    }
  });

  return text;
}

function decodeInlineSkillHref(href: string): string | null {
  const encodedSkillName = href.slice(INTERNAL_INLINE_SKILL_HREF_PREFIX.length);
  if (encodedSkillName.length === 0) {
    return null;
  }

  try {
    return decodeURIComponent(encodedSkillName);
  } catch {
    return null;
  }
}

function InlineSkillAnchor(props: { href: string; children?: ReactNode }): ReactNode {
  const inlineSkillPreview = useContext(InlineSkillPreviewContext);
  const label = getTextFromReactNode(props.children);
  const skillName = decodeInlineSkillHref(props.href);
  if (!skillName) {
    return label;
  }

  return inlineSkillPreview.renderInlineSkillPreview(skillName, label);
}

function MarkdownAnchor(props: AnchorProps): ReactNode {
  if (typeof props.href === "string" && props.href.startsWith(INTERNAL_INLINE_SKILL_HREF_PREFIX)) {
    return <InlineSkillAnchor href={props.href}>{props.children}</InlineSkillAnchor>;
  }

  const normalizedHref =
    typeof props.href === "string" && typeof window !== "undefined"
      ? normalizeLocalhostProxyUrl({
          url: props.href,
          localhostProxyTemplate: resolveBrowserLocalhostProxyTemplate({
            injectedTemplate: window.__MUX_PROXY_URI_TEMPLATE__ ?? null,
            browserProtocol: window.location.protocol,
            browserHostname: window.location.hostname,
            browserPort: window.location.port,
          }),
          browserHost: window.location.host,
        })
      : props.href;

  return (
    <a href={normalizedHref} target="_blank" rel="noopener noreferrer">
      {props.children}
    </a>
  );
}

// Custom components for markdown rendering
export const markdownComponents = {
  // Pass through pre element - let code component handle the wrapping
  pre: ({ children }: PreProps) => <>{children}</>,

  // Custom anchor to open links externally
  a: MarkdownAnchor,

  // Custom details/summary for collapsible sections
  details: ({ children, open }: DetailsProps) => (
    <details
      open={open}
      className="bg-code-bg my-2 rounded border border-white/10 px-2 py-1 text-sm"
    >
      {children}
    </details>
  ),

  summary: ({ children }: SummaryProps) => (
    <summary className="cursor-pointer py-1 pl-1 font-semibold select-none">{children}</summary>
  ),

  // Custom code block renderer with async Shiki highlighting
  code: ({ inline, className, children, node, ...props }: CodeProps) => {
    const match = /language-([^\s]+)/.exec(className ?? "");
    const language = match ? match[1] : "";

    // Extract text content
    const childString =
      typeof children === "string" ? children : Array.isArray(children) ? children.join("") : "";
    const hasMultipleLines = childString.includes("\n");
    const isInline = inline ?? !hasMultipleLines;

    // Handle mermaid diagrams specially
    if (!isInline && language === "mermaid") {
      return <Mermaid chart={childString} />;
    }

    // Code blocks with language - use async Shiki highlighting
    if (!isInline && language) {
      const highlightLanguage = language === "shell-session" ? "shell" : language;
      return (
        <CodeBlock code={childString} language={language} highlightLanguage={highlightLanguage} />
      );
    }

    // Code blocks without language (global CSS provides styling)
    if (!isInline) {
      return (
        <pre>
          <code className={className} {...props}>
            {children}
          </code>
        </pre>
      );
    }

    // Inline code (filter out node prop to avoid [object Object])
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

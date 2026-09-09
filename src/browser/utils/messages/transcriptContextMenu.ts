import TurndownService from "turndown";
import type { FormattedClipboardContent } from "@/browser/utils/clipboard";
import {
  TRANSCRIPT_IGNORE_CONTEXT_MENU_SELECTOR,
  TRANSCRIPT_MESSAGE_SELECTOR,
  TRANSCRIPT_QUOTE_ROOT_SELECTOR,
  TRANSCRIPT_QUOTE_TEXT_ATTRIBUTE,
} from "./transcriptQuoteAttributes";

// Preserve native link context-menu actions (open/copy link, etc.) by treating
// anchors and explicitly opted-out transcript chrome as interactive targets.
const INTERACTIVE_SELECTOR = `button, [role='button'], input, textarea, select, a[href], ${TRANSCRIPT_IGNORE_CONTEXT_MENU_SELECTOR}`;
const QUOTEABLE_BLOCK_SELECTOR = [
  ".code-block-wrapper",
  ".mermaid-container",
  "p",
  "li",
  "blockquote",
  "pre",
  "code",
  "td",
  "th",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "summary",
].join(", ");

function normalizeTranscriptText(rawText: string): string {
  return rawText.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
}

function hasNonWhitespaceTranscriptText(text: string): boolean {
  return text.trim().length > 0;
}

function getEventTargetElement(target: EventTarget | null): Element | null {
  if (!target || typeof target !== "object") {
    return null;
  }

  const nodeTarget = target as { nodeType?: number; parentElement?: Element | null };
  if (nodeTarget.nodeType === 1) {
    return target as Element;
  }

  if (nodeTarget.nodeType === 3) {
    return nodeTarget.parentElement ?? null;
  }

  return null;
}

function getClosestTranscriptAncestor(
  transcriptRoot: HTMLElement,
  element: Element | null,
  selector: string
): Element | null {
  if (!element || !transcriptRoot.contains(element)) {
    return null;
  }

  const ancestor = element.closest(selector);
  return ancestor && transcriptRoot.contains(ancestor) ? ancestor : null;
}

function getTranscriptQuoteOverride(element: Element | null): string | null {
  if (!element) {
    return null;
  }

  const override = element.getAttribute(TRANSCRIPT_QUOTE_TEXT_ATTRIBUTE);
  if (override == null) {
    return null;
  }

  const normalizedOverride = normalizeTranscriptText(override);
  return hasNonWhitespaceTranscriptText(normalizedOverride) ? normalizedOverride : null;
}

function getTranscriptQuoteableText(element: Element | null): string | null {
  if (!element) {
    return null;
  }

  const override = getTranscriptQuoteOverride(element);
  if (override) {
    return override;
  }

  const normalizedText = normalizeTranscriptText(element.textContent ?? "");
  return hasNonWhitespaceTranscriptText(normalizedText) ? normalizedText : null;
}

function getClosestTranscriptQuoteBlock(
  quoteRoot: Element,
  targetElement: Element
): Element | null {
  const quoteBlock = targetElement.closest(QUOTEABLE_BLOCK_SELECTOR);
  return quoteBlock && quoteRoot.contains(quoteBlock) ? quoteBlock : null;
}

function selectionIntersectsIgnoredChrome(quoteRoot: Element, selectionRange: Range): boolean {
  for (const ignoredElement of quoteRoot.querySelectorAll(
    TRANSCRIPT_IGNORE_CONTEXT_MENU_SELECTOR
  )) {
    if (selectionRange.intersectsNode(ignoredElement)) {
      return true;
    }
  }

  return false;
}

function getSelectedTranscriptText(
  transcriptRoot: HTMLElement,
  selection: Selection | null,
  target: EventTarget | null
): string | null {
  if (!selection || selection.rangeCount === 0) {
    return null;
  }

  const selectedText = normalizeTranscriptText(selection.toString());
  if (!hasNonWhitespaceTranscriptText(selectedText)) {
    return null;
  }

  const selectedRange = selection.getRangeAt(0);
  const startElement = getEventTargetElement(selectedRange.startContainer);
  const endElement = getEventTargetElement(selectedRange.endContainer);
  const targetElement = getEventTargetElement(target);

  const startMessage = getClosestTranscriptAncestor(
    transcriptRoot,
    startElement,
    TRANSCRIPT_MESSAGE_SELECTOR
  );
  const endMessage = getClosestTranscriptAncestor(
    transcriptRoot,
    endElement,
    TRANSCRIPT_MESSAGE_SELECTOR
  );
  const startQuoteRoot = getClosestTranscriptAncestor(
    transcriptRoot,
    startElement,
    TRANSCRIPT_QUOTE_ROOT_SELECTOR
  );
  const endQuoteRoot = getClosestTranscriptAncestor(
    transcriptRoot,
    endElement,
    TRANSCRIPT_QUOTE_ROOT_SELECTOR
  );

  // Require the full selection range to stay within a single quoteable transcript body
  // so we do not accidentally quote text from non-message interstitial UI.
  if (
    startMessage === null ||
    endMessage === null ||
    startMessage !== endMessage ||
    startQuoteRoot === null ||
    endQuoteRoot === null ||
    startQuoteRoot !== endQuoteRoot
  ) {
    return null;
  }

  const targetMessage = getClosestTranscriptAncestor(
    transcriptRoot,
    targetElement,
    TRANSCRIPT_MESSAGE_SELECTOR
  );
  const targetQuoteRoot = getClosestTranscriptAncestor(
    transcriptRoot,
    targetElement,
    TRANSCRIPT_QUOTE_ROOT_SELECTOR
  );

  if (
    targetMessage !== null &&
    targetQuoteRoot !== null &&
    (targetMessage !== startMessage || targetQuoteRoot !== startQuoteRoot)
  ) {
    return null;
  }

  if (selectionIntersectsIgnoredChrome(startQuoteRoot, selectedRange)) {
    return null;
  }

  return selectedText;
}

function getHoveredTranscriptText(
  transcriptRoot: HTMLElement,
  target: EventTarget | null
): string | null {
  const targetElement = getEventTargetElement(target);
  if (!targetElement || !transcriptRoot.contains(targetElement)) {
    return null;
  }

  if (targetElement.closest(INTERACTIVE_SELECTOR)) {
    return null;
  }

  const quoteRoot = getClosestTranscriptAncestor(
    transcriptRoot,
    targetElement,
    TRANSCRIPT_QUOTE_ROOT_SELECTOR
  );
  if (!quoteRoot) {
    return null;
  }

  const quoteBlock = getClosestTranscriptQuoteBlock(quoteRoot, targetElement);
  if (quoteBlock) {
    return getTranscriptQuoteableText(quoteBlock);
  }

  // Quote roots act as selection boundaries. Fall back to an explicit root-level text override
  // for custom renderers whose DOM does not expose stable semantic blocks, but avoid quoting the
  // entire message when the user right-clicks the root container's empty padding.
  if (targetElement !== quoteRoot) {
    const quoteRootOverride = getTranscriptQuoteOverride(quoteRoot);
    if (quoteRootOverride) {
      return quoteRootOverride;
    }

    return getTranscriptQuoteableText(targetElement);
  }

  return null;
}

export interface TranscriptContextMenuTextOptions {
  transcriptRoot: HTMLElement;
  target: EventTarget | null;
  selection: Selection | null;
}

export interface TranscriptContextMenuLinkOptions {
  transcriptRoot: HTMLElement;
  target: EventTarget | null;
}

/**
 * Resolve an anchor href for right-click link actions (e.g. "Copy link").
 *
 * Returns the rendered href string when the right-click target is inside an
 * anchor within the transcript; otherwise null. This complements
 * `getTranscriptContextMenuText` so the transcript can offer link-specific
 * actions on anchors (which would otherwise bypass the text resolver).
 */
export function getTranscriptContextMenuLink(
  options: TranscriptContextMenuLinkOptions
): string | null {
  // Reuse the shared ancestor helper so the null/contains guards for the target
  // element and the resolved anchor stay in one place.
  const anchor = getClosestTranscriptAncestor(
    options.transcriptRoot,
    getEventTargetElement(options.target),
    "a[href]"
  );
  if (!anchor) {
    return null;
  }

  const href = anchor.getAttribute("href");
  if (href === null) {
    return null;
  }

  const trimmedHref = href.trim();
  return trimmedHref.length > 0 ? trimmedHref : null;
}

/**
 * Resolve transcript text for right-click actions.
 *
 * Priority:
 * 1) Current selection inside the same quoteable transcript body
 * 2) The nearest explicitly marked quote block under the cursor
 * 3) A root-level raw-text override for custom renderers whose DOM is not a faithful text source
 */
export function getTranscriptContextMenuText(
  options: TranscriptContextMenuTextOptions
): string | null {
  // Interactive transcript targets should keep native browser context-menu actions
  // (e.g. open/copy link) even when a transcript selection currently exists.
  const targetElement = getEventTargetElement(options.target);
  if (
    targetElement &&
    options.transcriptRoot.contains(targetElement) &&
    targetElement.closest(INTERACTIVE_SELECTOR)
  ) {
    return null;
  }

  const selectedText = getSelectedTranscriptText(
    options.transcriptRoot,
    options.selection,
    options.target
  );
  if (selectedText) {
    return selectedText;
  }

  return getHoveredTranscriptText(options.transcriptRoot, options.target);
}

// Copy only semantic formatting. Transcript content can contain untrusted repository text.
const CLIPBOARD_TAGS = new Set([
  "div",
  "dl",
  "dt",
  "dd",
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "s",
  "del",
  "blockquote",
  "pre",
  "code",
  "ul",
  "ol",
  "li",
  "a",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "details",
  "summary",
  "sub",
  "sup",
]);
const CLIPBOARD_EXCLUDED_SELECTOR = `script, style, annotation, svg, img, iframe, object, .line-number, .sr-only, button, input, textarea, select, [hidden], [aria-hidden="true"], ${TRANSCRIPT_IGNORE_CONTEXT_MENU_SELECTOR}`;

function isSafeClipboardHref(href: string): boolean {
  if (!href.trim() || href.includes("\\")) return false;
  try {
    // Resolve relative paths only for protocol validation. Keep the original destination when copying.
    const url = new URL(href, "https://clipboard.invalid/");
    return ["http:", "https:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function isClipboardElementHidden(element: Element): boolean {
  const style = element.ownerDocument.defaultView!.getComputedStyle(element);
  return (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.visibility === "collapse" ||
    style.opacity === "0"
  );
}

function hasSelectedOwnListText(item: Element, range: Range): boolean {
  for (const child of item.childNodes) {
    if (!range.intersectsNode(child)) continue;
    if (child.nodeType === 3) {
      const start = child === range.startContainer ? range.startOffset : 0;
      const end = child === range.endContainer ? range.endOffset : child.textContent?.length;
      if (child.textContent?.slice(start, end).trim()) return true;
    } else if (child.nodeType === 1) {
      const element = child as Element;
      if (!element.matches("ul, ol, input") && hasSelectedOwnListText(element, range)) return true;
    }
  }
  return false;
}

function appendClipboardNodes(
  source: Node,
  destination: Node,
  range: Range,
  preserveSpanningTable = false
): void {
  const document = destination.ownerDocument!;
  for (const child of source.childNodes) {
    const isTaskMarker =
      child.nodeType === 1 &&
      (child as Element).matches('li > input[type="checkbox"][disabled]:first-child') &&
      hasSelectedOwnListText(child.parentElement!, range);
    // Empty cells retain column positions and alignment without copying unselected text.
    const isTableStructure =
      child.nodeName === "TD" ||
      child.nodeName === "TH" ||
      (preserveSpanningTable && ["THEAD", "TBODY", "TFOOT", "TR"].includes(child.nodeName));
    if (
      source.nodeName === "DETAILS" &&
      !(source as Element).hasAttribute("open") &&
      child.nodeName !== "SUMMARY"
    )
      continue;
    if (!range.intersectsNode(child) && !isTaskMarker && !isTableStructure) {
      continue;
    }
    if (child.nodeType === 3) {
      const start = child === range.startContainer ? range.startOffset : 0;
      const end = child === range.endContainer ? range.endOffset : child.textContent?.length;
      destination.appendChild(document.createTextNode((child.textContent ?? "").slice(start, end)));
      continue;
    }
    if (child.nodeType !== 1) continue;
    const element = child as Element;
    if (isClipboardElementHidden(element)) continue;
    if (element.matches('input[type="checkbox"][disabled]')) {
      const marker = document.createElement("span");
      marker.setAttribute("data-clipboard-task", "true");
      marker.textContent = (element as HTMLInputElement).checked ? "[x] " : "[ ] ";
      destination.appendChild(marker);
      continue;
    }
    if (element.matches(CLIPBOARD_EXCLUDED_SELECTOR)) continue;
    if (element.matches(".katex")) {
      const tex = element.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
      if (tex != null) {
        // Rendered math has duplicate accessibility text. Treat each selected formula as one unit.
        const math = document.createElement("span");
        math.textContent = element.closest(".katex-display")
          ? "$$\n" + tex + "\n$$"
          : "$$" + tex + "$$";
        math.setAttribute("data-clipboard-math", math.textContent);
        destination.appendChild(math);
        continue;
      }
    }
    // Highlighted code uses a grid, not semantic pre/code elements. Exclude its line numbers.
    if (element.matches(".code-block-container")) {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      const language = element.getAttribute("data-code-language") ?? "";
      if (/^[\w.+#-]+$/.test(language)) code.className = `language-${language}`;
      const lines: string[] = [];
      for (const line of element.querySelectorAll(".code-line")) {
        if (!range.intersectsNode(line) || isClipboardElementHidden(line)) continue;
        const selectedLine = document.createElement("div");
        appendClipboardNodes(line, selectedLine, range);
        lines.push(selectedLine.textContent ?? "");
      }
      code.textContent = lines.join("\n");
      pre.appendChild(code);
      destination.appendChild(pre);
      continue;
    }
    // Streamdown renders Markdown bold as a styled span instead of a strong element.
    const tag =
      element.getAttribute("data-streamdown") === "strong"
        ? "strong"
        : element.tagName.toLowerCase();
    const summary = tag === "details" ? element.querySelector(":scope > summary") : null;
    // Body-only selections must not create a browser-generated disclosure label.
    if (
      !CLIPBOARD_TAGS.has(tag) ||
      (tag === "details" && (!summary || !range.intersectsNode(summary)))
    ) {
      appendClipboardNodes(element, destination, range, preserveSpanningTable);
      continue;
    }
    const copy = document.createElement(tag);
    if (tag === "a") {
      const href = element.getAttribute("href") ?? "";
      if (isSafeClipboardHref(href)) copy.setAttribute("href", href);
    }
    if (tag === "td" || tag === "th") {
      const cell = element as HTMLTableCellElement;
      const alignment = cell.getAttribute("align") ?? cell.style.textAlign;
      if (["left", "center", "right"].includes(alignment)) copy.setAttribute("align", alignment);
      if (/^\d+$/.test(element.getAttribute("colspan") ?? ""))
        copy.setAttribute("colspan", String(cell.colSpan));
      if (/^\d+$/.test(element.getAttribute("rowspan") ?? ""))
        copy.setAttribute("rowspan", String(cell.rowSpan));
    }
    if (tag === "details" && element.hasAttribute("open")) copy.setAttribute("open", "");
    if (tag === "code") {
      const languageClass = Array.from(element.classList).find((name) =>
        /^language-[\w.+#-]+$/.test(name)
      );
      if (languageClass) copy.className = languageClass;
    }
    if (tag === "ol") {
      const list = element as HTMLOListElement;
      const firstSelected = Array.from(list.children).findIndex((item) =>
        range.intersectsNode(item)
      );
      copy.setAttribute("start", String(list.start + Math.max(0, firstSelected)));
    }
    // Keep empty spanning-table structure so partial selections retain cell positions.
    const keepTableStructure =
      preserveSpanningTable ||
      (tag === "table" && element.querySelector("[rowspan], [colspan]") !== null);
    appendClipboardNodes(element, copy, range, keepTableStructure);
    destination.appendChild(copy);
  }
}

/** Return only the selected chat text, with Markdown and safe rich-text formatting. */
export function getTranscriptContextMenuMarkdown(
  options: TranscriptContextMenuTextOptions
): FormattedClipboardContent | null {
  const target = getEventTargetElement(options.target);
  const excludedTarget = target?.closest(CLIPBOARD_EXCLUDED_SELECTOR);
  if (
    !target ||
    !options.transcriptRoot.contains(target) ||
    (excludedTarget && !excludedTarget.closest(".katex"))
  ) {
    return null;
  }
  if (!getSelectedTranscriptText(options.transcriptRoot, options.selection, options.target)) {
    return null;
  }

  const range = options.selection!.getRangeAt(0);
  const quoteRoot = getEventTargetElement(range.startContainer)!.closest(
    TRANSCRIPT_QUOTE_ROOT_SELECTOR
  )!;
  const container = options.transcriptRoot.ownerDocument.createElement("div");
  // Walk the original range so partial selections retain their formatting and list positions.
  let selectedList = getEventTargetElement(range.startContainer)?.closest("ul, ol");
  while (selectedList && !selectedList.contains(range.endContainer)) {
    selectedList = selectedList.parentElement?.closest("ul, ol");
  }
  // A nested-item selection forms its own list, without empty unselected parent tasks.
  const copyRoot = selectedList?.parentElement?.matches("li")
    ? selectedList.parentElement
    : quoteRoot;
  appendClipboardNodes(copyRoot, container, range);
  // Drop redundant outer wrappers, but retain boundaries between adjacent raw HTML blocks.
  while (container.childNodes.length === 1 && container.firstElementChild?.tagName === "DIV") {
    container.replaceChildren(...container.firstElementChild.childNodes);
  }
  const markdown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  // Preserve literal HTML and entities as text when the copied Markdown is parsed again.
  markdown.escape = (text) =>
    TurndownService.prototype.escape(text).replace(/&/g, "&amp;").replace(/</g, "\\<");
  markdown.addRule("selectedMathAndTasks", {
    filter: (node) =>
      node.hasAttribute("data-clipboard-math") || node.hasAttribute("data-clipboard-task"),
    replacement: (_content, node) =>
      node.getAttribute("data-clipboard-math") ?? node.textContent?.trimEnd() ?? "",
  });
  markdown.addRule("disclosure", {
    filter: ["details", "summary"],
    replacement: (content, node) => {
      const tag = node.nodeName.toLowerCase();
      const open = tag === "details" && node.hasAttribute("open") ? " open" : "";
      return "\n\n<" + tag + open + ">\n\n" + content.trim() + "\n\n</" + tag + ">\n\n";
    },
  });
  markdown.addRule("scripts", {
    filter: ["sub", "sup"],
    // SECURITY AUDIT: This node contains only the sanitized clipboard elements and attributes.
    replacement: (_content, node) => node.outerHTML,
  });
  markdown.addRule("safeLink", {
    filter: (node) => node.nodeName === "A" && node.hasAttribute("href"),
    replacement: (content, node) => {
      const href = (node.getAttribute("href") ?? "").replace(/[<>\s]/g, encodeURIComponent);
      return "[" + content + "](<" + href + ">)";
    },
  });
  markdown.addRule("strikethrough", {
    filter: ["s", "del"],
    replacement: (content) => `~~${content}~~`,
  });
  markdown.addRule("table", {
    filter: "table",
    replacement: (_content, node) => {
      // GFM cannot represent spans. Keep sanitized HTML instead of inventing a different table layout.
      if (node.querySelector("[rowspan], [colspan]")) {
        // Blank lines let Markdown parse cell content inside the span-preserving HTML.
        const serialize = (element: Element): string => {
          const tag = element.tagName.toLowerCase();
          const attributes = Array.from(
            element.attributes,
            (attribute) => " " + attribute.name + '="' + attribute.value + '"'
          ).join("");
          const content = element.matches("td, th")
            ? markdown.turndown(element as HTMLElement)
            : Array.from(element.children, serialize).join("\n\n");
          return "<" + tag + attributes + ">\n\n" + content + "\n\n</" + tag + ">";
        };
        return "\n\n" + serialize(node) + "\n\n";
      }
      const rows = Array.from(node.querySelectorAll<HTMLTableRowElement>("tr"), (row) =>
        Array.from(row.cells, (cell) =>
          markdown.turndown(cell).replace(/\|/g, "\\|").replace(/\n/g, "<br>")
        )
      );
      const width = Math.max(0, ...rows.map((row) => row.length));
      if (!width) return "";
      const firstRow = node.querySelector("tr");
      // Row headers do not turn the first data record into a column header.
      if (!firstRow || !Array.from(firstRow.cells).every((cell) => cell.tagName === "TH")) {
        rows.unshift(Array<string>(width).fill(""));
      }
      rows.splice(
        1,
        0,
        Array.from({ length: width }, (_, index) => {
          const alignment = firstRow?.cells[index]?.getAttribute("align");
          return alignment === "left"
            ? ":---"
            : alignment === "right"
              ? "---:"
              : alignment === "center"
                ? ":---:"
                : "---";
        })
      );
      return (
        "\n\n" +
        rows
          .map(
            (row) =>
              "| " +
              Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ") +
              " |"
          )
          .join("\n") +
        "\n\n"
      );
    },
  });
  const text = markdown.turndown(container);
  if (!text.trim()) return null;
  // SECURITY AUDIT: Serialize only allowlisted elements and attributes, never the original selection HTML.
  return { text, html: container.innerHTML };
}

/**
 * Convert plain transcript text into Markdown blockquote syntax so pasted context
 * is visually separated from the user's next prompt.
 */
export function formatTranscriptTextAsQuote(text: string): string {
  const normalizedText = normalizeTranscriptText(text);
  if (!hasNonWhitespaceTranscriptText(normalizedText)) {
    return "";
  }

  // Strip leading/trailing newlines so the quote block doesn't start or end
  // with empty "> " lines (e.g. from DOM whitespace around block elements).
  const trimmedText = normalizedText.replace(/^\n+|\n+$/g, "");
  if (!hasNonWhitespaceTranscriptText(trimmedText)) {
    return "";
  }

  const quotedLines = trimmedText.split("\n").map((line) => (line.length > 0 ? `> ${line}` : ">"));

  return `${quotedLines.join("\n")}\n\n`;
}

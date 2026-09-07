/**
 * Search term highlighting for diff content
 * Post-processes Shiki-highlighted HTML to add search match highlights
 */

import { LRUCache } from "lru-cache";
import CRC32 from "crc-32";

export interface SearchHighlightConfig {
  searchTerm: string;
  useRegex: boolean;
  matchCase: boolean;
}

// Module-level caches for performance
// Lazy-loaded to avoid DOMParser instantiation in non-browser environments (e.g., tests)
let parserInstance: DOMParser | null = null;
const getParser = (): DOMParser => {
  parserInstance ??= new DOMParser();
  return parserInstance;
};

// LRU cache for compiled regex patterns
// Key: search config string, Value: compiled RegExp
const regexCache = new LRUCache<string, RegExp>({
  max: 100, // Max 100 unique search patterns (plenty for typical usage)
});

// LRU cache for parsed DOM documents
// Key: CRC32 checksum of html, Value: parsed Document
// Caching the parsed DOM is more efficient than caching the final highlighted HTML
// because the parsing step is identical regardless of search config
const domCache = new LRUCache<number, Document>({
  max: 2000, // Max number of cached parsed documents
  maxSize: 8 * 1024 * 1024, // 8MB total cache size (DOM objects are larger than strings)
  sizeCalculation: () => 4096, // Rough estimate: ~4KB per parsed document
});

/**
 * Escape special regex characters for literal string matching
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Walk all text nodes in a DOM tree and apply a callback
 */
function walkTextNodes(node: Node, callback: (textNode: Text) => void): void {
  if (node.nodeType === Node.TEXT_NODE) {
    callback(node as Text);
  } else {
    const children = Array.from(node.childNodes);
    for (const child of children) {
      walkTextNodes(child, callback);
    }
  }
}

/**
 * Wrap search matches in HTML with <mark> tags
 * Preserves existing HTML structure (e.g., Shiki syntax highlighting)
 *
 * @param html - HTML content to process (e.g., from Shiki)
 * @param config - Search configuration
 * @returns HTML with search matches wrapped in <mark class="search-highlight">
 */
export function highlightSearchMatches(html: string, config: SearchHighlightConfig): string {
  const { searchTerm, useRegex, matchCase } = config;

  // No highlighting if search term is empty
  if (!searchTerm.trim()) {
    return html;
  }

  try {
    // Check cache for parsed DOM (keyed only by html, not search config)
    const htmlChecksum = CRC32.str(html);
    let doc = domCache.get(htmlChecksum);

    if (!doc) {
      // Parse HTML into DOM for safe manipulation
      doc = getParser().parseFromString(html, "text/html");
      domCache.set(htmlChecksum, doc);
    }

    // Clone the cached DOM so we don't mutate the cached version
    // This is cheaper than re-parsing and allows cache reuse across different searches
    const workingDoc = doc.cloneNode(true) as Document;

    // Build regex pattern (with caching)
    const regexCacheKey = `${searchTerm}:${useRegex}:${matchCase}`;
    let pattern = regexCache.get(regexCacheKey);

    if (!pattern) {
      try {
        pattern = useRegex
          ? new RegExp(searchTerm, matchCase ? "g" : "gi")
          : new RegExp(escapeRegex(searchTerm), matchCase ? "g" : "gi");
        regexCache.set(regexCacheKey, pattern);
      } catch {
        // Invalid regex pattern - return original HTML
        return html;
      }
    }

    // Walk all text nodes and wrap matches in the working copy
    walkTextNodes(workingDoc.body, (textNode) => {
      const text = textNode.textContent || "";

      // Quick check: does this text node contain any matches?
      pattern.lastIndex = 0; // Reset regex state
      if (!pattern.test(text)) {
        return;
      }

      // Build replacement fragment with wrapped matches
      const fragment = workingDoc.createDocumentFragment();
      let lastIndex = 0;
      pattern.lastIndex = 0; // Reset again for actual iteration

      let match;
      while ((match = pattern.exec(text)) !== null) {
        // Add text before match
        if (match.index > lastIndex) {
          fragment.appendChild(workingDoc.createTextNode(text.slice(lastIndex, match.index)));
        }

        // Add highlighted match
        const mark = workingDoc.createElement("mark");
        mark.className = "search-highlight";
        mark.textContent = match[0];
        fragment.appendChild(mark);

        lastIndex = match.index + match[0].length;

        // Prevent infinite loop on zero-length matches
        if (match[0].length === 0) {
          pattern.lastIndex++;
        }
      }

      // Add remaining text after last match
      if (lastIndex < text.length) {
        fragment.appendChild(workingDoc.createTextNode(text.slice(lastIndex)));
      }

      textNode.parentNode?.replaceChild(fragment, textNode);
    });

    return workingDoc.body.innerHTML;
  } catch (error) {
    // Failed to parse/process - return original HTML
    console.warn("Failed to highlight search matches:", error);
    return html;
  }
}

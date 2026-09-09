// Only renderer refs register chart sources. Raw HTML cannot forge this metadata.
export const transcriptMermaidSources = new WeakMap<Element, string>();

export const TRANSCRIPT_MESSAGE_SELECTOR = "[data-transcript-message]";
export const TRANSCRIPT_QUOTE_ROOT_SELECTOR = "[data-transcript-quote-root]";
export const TRANSCRIPT_IGNORE_CONTEXT_MENU_SELECTOR = "[data-transcript-ignore-context-menu]";
export const TRANSCRIPT_QUOTE_TEXT_ATTRIBUTE = "data-transcript-quote-text";

export const transcriptMessageProps = {
  "data-transcript-message": "",
} as const;

export const transcriptQuoteRootProps = {
  "data-transcript-quote-root": "",
} as const;

export const transcriptIgnoreContextMenuProps = {
  "data-transcript-ignore-context-menu": "",
} as const;

export function getTranscriptQuoteRootProps(quoteText?: string | null) {
  return quoteText == null
    ? transcriptQuoteRootProps
    : {
        ...transcriptQuoteRootProps,
        [TRANSCRIPT_QUOTE_TEXT_ATTRIBUTE]: quoteText,
      };
}

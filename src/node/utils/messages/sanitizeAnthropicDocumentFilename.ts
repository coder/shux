import type { MuxMessage } from "@/common/types/message";

const PDF_MEDIA_TYPE = "application/pdf";

/**
 * Sanitize a document filename to comply with Anthropic's validation rules.
 *
 * Anthropic enforces strict character set validation on document block metadata:
 * - Allowed: alphanumeric, whitespace, hyphen (-), parentheses, square brackets
 * - Disallowed: periods (.), underscores (_), slashes, etc.
 * - No consecutive whitespace allowed
 *
 * @param filename - Original filename (e.g., "D19910350Lj.pdf")
 * @param fallback - Fallback if result would be empty (default: "Document")
 * @returns Sanitized filename (e.g., "D19910350Lj [pdf]")
 */
export function sanitizeAnthropicDocumentFilename(
  filename: string | undefined,
  fallback = "Document"
): string {
  if (!filename) {
    return fallback;
  }

  // Replace disallowed characters with space
  // Allowed: alphanumeric, whitespace, hyphen, parentheses (), square brackets []
  const sanitized = filename.replace(/[^a-zA-Z0-9\s\-()[\]]/g, " ");

  // Collapse consecutive whitespace to single space and trim
  const collapsed = sanitized.replace(/\s+/g, " ").trim();

  // Return fallback if empty after sanitization
  return collapsed || fallback;
}

/**
 * Sanitize PDF document filenames in user messages for Anthropic API requests.
 *
 * This is a request-only transformation - the original filenames are preserved in
 * persisted history and the UI. Only the outgoing API request gets sanitized names.
 *
 * Why: Anthropic validates document "file name/title" with a strict character set that
 * rejects common filename characters like periods (.). This causes uploads to fail with:
 * "The document file name can only contain alphanumeric characters, whitespace characters,
 * hyphens, parentheses, and square brackets."
 *
 * @param messages - XumMessage array to process
 * @returns New array with sanitized PDF filenames (does not mutate input)
 */
export function sanitizeAnthropicPdfFilenames(messages: MuxMessage[]): MuxMessage[] {
  let didChange = false;

  const result = messages.map((msg) => {
    if (msg.role !== "user") {
      return msg;
    }

    // Check if any part needs sanitization
    const hasPdfWithFilename = msg.parts.some(
      (part) =>
        part.type === "file" &&
        part.mediaType.toLowerCase() === PDF_MEDIA_TYPE &&
        part.filename !== undefined
    );

    if (!hasPdfWithFilename) {
      return msg;
    }

    didChange = true;

    const newParts = msg.parts.map((part) => {
      if (
        part.type === "file" &&
        part.mediaType.toLowerCase() === PDF_MEDIA_TYPE &&
        part.filename !== undefined
      ) {
        return {
          ...part,
          filename: sanitizeAnthropicDocumentFilename(part.filename),
        };
      }
      return part;
    });

    return {
      ...msg,
      parts: newParts,
    };
  });

  // Return original array if nothing changed (optimization)
  return didChange ? result : messages;
}

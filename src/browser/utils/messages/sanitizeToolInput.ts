import type { MuxMessage, MuxToolPart } from "@/common/types/message";

/**
 * Sanitizes tool inputs in messages to ensure they are valid objects.
 *
 * The Anthropic API (and other LLM APIs) require tool inputs to be objects/dictionaries.
 * However, if the model generates malformed JSON or if we have corrupted data in history,
 * the input field might be a string instead of an object.
 *
 * This causes API errors like: "Input should be a valid dictionary"
 *
 * This function ensures all tool inputs are objects by converting non-object inputs
 * to empty objects. This allows the conversation to continue even with corrupted history.
 *
 * @param messages - Messages to sanitize
 * @returns New array with sanitized messages (original messages are not modified)
 */
export function sanitizeToolInputs(messages: MuxMessage[]): MuxMessage[] {
  return messages.map((msg) => {
    // Only process assistant messages with tool parts
    if (msg.role !== "assistant") {
      return msg;
    }

    const needsSanitization = msg.parts.some(
      (part) =>
        part.type === "dynamic-tool" &&
        (typeof part.input !== "object" || part.input === null || Array.isArray(part.input))
    );

    if (!needsSanitization) {
      return msg;
    }

    // Create new message with sanitized parts
    return {
      ...msg,
      parts: msg.parts.map((part): typeof part => {
        if (part.type !== "dynamic-tool") {
          return part;
        }

        // Sanitize the input if it's not a valid object
        if (typeof part.input !== "object" || part.input === null || Array.isArray(part.input)) {
          const sanitized: MuxToolPart = {
            ...part,
            input: {}, // Replace with empty object
          };
          return sanitized;
        }

        return part;
      }),
    };
  });
}

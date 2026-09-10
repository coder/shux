import type { MuxMessage } from "@/common/types/message";

/**
 * Merge adjacent text/reasoning parts using array accumulation + join().
 * Avoids O(n²) string allocations from repeated concatenation.
 * Tool parts are preserved as-is between merged text/reasoning runs.
 */
export function mergeAdjacentParts(parts: MuxMessage["parts"]): MuxMessage["parts"] {
  if (parts.length <= 1) return parts;

  const merged: MuxMessage["parts"] = [];
  let pendingTexts: string[] = [];
  let pendingTextTimestamp: number | undefined;
  let pendingReasonings: string[] = [];
  let pendingReasoningTimestamp: number | undefined;

  const flushText = () => {
    if (pendingTexts.length > 0) {
      merged.push({
        type: "text",
        text: pendingTexts.join(""),
        timestamp: pendingTextTimestamp,
      });
      pendingTexts = [];
      pendingTextTimestamp = undefined;
    }
  };

  const flushReasoning = () => {
    if (pendingReasonings.length > 0) {
      merged.push({
        type: "reasoning",
        text: pendingReasonings.join(""),
        timestamp: pendingReasoningTimestamp,
      });
      pendingReasonings = [];
      pendingReasoningTimestamp = undefined;
    }
  };

  for (const part of parts) {
    if (part.type === "text") {
      flushReasoning();
      pendingTexts.push(part.text);
      pendingTextTimestamp ??= part.timestamp;
    } else if (part.type === "reasoning") {
      flushText();
      pendingReasonings.push(part.text);
      pendingReasoningTimestamp ??= part.timestamp;
    } else {
      // Tool part - flush and keep as-is
      flushText();
      flushReasoning();
      merged.push(part);
    }
  }
  flushText();
  flushReasoning();

  return merged;
}

import type { FilePart, ImagePart, ModelMessage, TextPart, ToolResultPart } from "ai";
import { MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST } from "@/common/constants/imageAttachments";
import { sanitizeAnthropicDocumentFilename } from "@/node/utils/messages/sanitizeAnthropicDocumentFilename";
import {
  coalesceAttachmentPlaceholders,
  createOmittedToolAttachmentText,
  createToolAttachmentSummaryText,
  extractAttachmentsFromToolOutput,
  isSyntheticToolMediaPart,
  prepareExtractedToolAttachmentForProvider,
  SYNTHETIC_TOOL_MEDIA_PART_METADATA,
  type ExtractedToolAttachment,
} from "@/node/utils/messages/toolResultAttachments";

// Extract the output type from ToolResultPart to ensure type compatibility with ai@6
type ToolResultOutput = ToolResultPart["output"];

/**
 * Request-only rewrite for *internal* streamText steps.
 *
 * streamText() can make multiple LLM calls (steps) when tools are enabled.
 * Tool results produced during the stream are included in subsequent step prompts.
 *
 * Some tools return attachments as base64 inside tool results (output.type === "content" with
 * media parts, or output.type === "json" containing a nested "content" container).
 * Providers can treat that as plain text/JSON and blow up context.
 *
 * This helper rewrites tool-result outputs to replace supported attachment payloads with small
 * text placeholders, and inserts a synthetic user message containing the extracted attachments.
 */
export async function extractToolMediaAsUserMessagesFromModelMessages(
  messages: ModelMessage[]
): Promise<ModelMessage[]> {
  // Pass 1 — extract once per tool-result part. The request-wide media cap
  // needs the TOTAL before any emission so the NEWEST attachments survive,
  // and the extraction walk must not run twice per part (see the MuxMessage
  // variant in extractToolMediaAsUserMessages.ts).
  const extractionsByPart = new Map<
    object,
    NonNullable<ReturnType<typeof extractAttachmentsFromToolOutput>>
  >();
  let totalAttachments = 0;
  // Existing media parts share the same per-request provider limits as new
  // extractions (r31), but they split into two pools:
  // - reserved: genuine user uploads (unmarked) — consume the allowance and
  //   are never evicted.
  // - synthetic tool media (marker from a prior history-level extraction) —
  //   evictable oldest-first so a fresh screenshot from the current tool call
  //   still reaches the model at saturation (r34).
  let reservedMediaParts = 0;
  const syntheticMediaParts: unknown[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const partType = (part as { type?: unknown }).type;
      if (partType === "image" || partType === "file") {
        if (isSyntheticToolMediaPart(part)) {
          syntheticMediaParts.push(part);
        } else {
          reservedMediaParts++;
        }
      }
    }
    if (message.role !== "assistant" && message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      const extracted = extractAttachmentsFromToolOutput(part.output as unknown);
      if (extracted == null) continue;
      extractionsByPart.set(part, extracted);
      totalAttachments += extracted.attachments.length;
    }
  }
  if (extractionsByPart.size === 0) return messages;

  // Request-wide cap (r28 security): capture bounds bytes and per-container
  // parts, not distinct records, so a looped bridged media tool could
  // otherwise fan out tens of thousands of synthetic provider parts.
  // Chronologically OLDEST tool media is dropped first: prior synthetic parts
  // (all older — they were extracted from earlier turns' tool results) are
  // evicted before new extractions are omitted behind bounded placeholders.
  const budget = Math.max(0, MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST - reservedMediaParts);
  const overBudget = Math.max(0, syntheticMediaParts.length + totalAttachments - budget);
  // syntheticMediaParts is collected in message order, so a prefix slice is
  // the chronologically oldest set.
  const evictedSyntheticParts = new Set(
    syntheticMediaParts.slice(0, Math.min(overBudget, syntheticMediaParts.length))
  );
  const capState = {
    omitRemaining: overBudget - evictedSyntheticParts.size,
  };

  const result: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role === "user" && Array.isArray(message.content)) {
      result.push(evictSyntheticMediaParts(message, evictedSyntheticParts));
      continue;
    }
    if (message.role !== "assistant" && message.role !== "tool") {
      result.push(message);
      continue;
    }
    if (!Array.isArray(message.content)) {
      result.push(message);
      continue;
    }

    let keptAttachments: ExtractedToolAttachment[] = [];
    let totalExtracted = 0;
    let omittedForMessage = 0;
    let changedMessage = false;

    const newContent = message.content.map((part) => {
      if (part.type !== "tool-result") {
        return part;
      }
      const extracted = extractionsByPart.get(part);
      if (extracted === undefined) {
        return part;
      }

      changedMessage = true;
      totalExtracted += extracted.attachments.length;
      // Over the request-wide cap: chronologically OLDEST attachments are
      // omitted, and their per-item output placeholders are coalesced so a
      // flooded transcript cannot keep megabytes of placeholder JSON in
      // every request (r29 security).
      const omittedHere = Math.min(capState.omitRemaining, extracted.attachments.length);
      capState.omitRemaining -= omittedHere;
      omittedForMessage += omittedHere;
      keptAttachments = [...keptAttachments, ...extracted.attachments.slice(omittedHere)];

      return {
        ...part,
        // Excess per-item placeholders (cap omission OR same-payload dedup —
        // r31) are coalesced; unchanged when placeholders match emitted
        // attachments 1:1.
        output: coalesceAttachmentPlaceholders(
          extracted.newOutput,
          extracted.attachments.length - omittedHere
        ) as ToolResultOutput,
      };
    });

    // The content arrays are structurally identical for both roles, but the
    // union needs the role-specific rebuild.
    result.push(
      changedMessage
        ? message.role === "tool"
          ? {
              ...message,
              content: newContent as Extract<ModelMessage, { role: "tool" }>["content"],
            }
          : {
              ...message,
              content: newContent as Extract<ModelMessage, { role: "assistant" }>["content"],
            }
        : message
    );
    if (totalExtracted > 0) {
      result.push(
        await createSyntheticUserMessage(keptAttachments, omittedForMessage, totalExtracted)
      );
    }
  }

  return result;
}

/**
 * Replaces evicted synthetic tool-media parts in a user message with one
 * bounded omission note (r34). Only parts identified by the pass-1 scan are
 * touched; genuine user uploads never enter the evicted set.
 */
function evictSyntheticMediaParts(
  message: Extract<ModelMessage, { role: "user" }>,
  evictedSyntheticParts: ReadonlySet<unknown>
): ModelMessage {
  if (evictedSyntheticParts.size === 0 || !Array.isArray(message.content)) return message;
  let evictedHere = 0;
  for (const part of message.content) {
    if (evictedSyntheticParts.has(part)) evictedHere++;
  }
  if (evictedHere === 0) return message;

  const newContent: Array<TextPart | ImagePart | FilePart> = [];
  let noteInserted = false;
  for (const part of message.content) {
    if (!evictedSyntheticParts.has(part)) {
      newContent.push(part);
      continue;
    }
    if (!noteInserted) {
      noteInserted = true;
      newContent.push({
        type: "text",
        text: createOmittedToolAttachmentText(evictedHere),
      });
    }
  }
  return { ...message, content: newContent };
}

async function createSyntheticUserMessage(
  keptAttachments: ExtractedToolAttachment[],
  omittedCount: number,
  totalExtracted: number
): Promise<ModelMessage> {
  const content: Array<TextPart | ImagePart | FilePart> = [
    {
      type: "text",
      text: createToolAttachmentSummaryText(totalExtracted),
    },
  ];

  for (const attachment of keptAttachments) {
    const providerReadyAttachment = await prepareExtractedToolAttachmentForProvider(attachment);
    if (providerReadyAttachment.type === "text") {
      content.push({
        type: "text",
        text: providerReadyAttachment.text,
      });
      continue;
    }

    const preparedAttachment = providerReadyAttachment.attachment;
    if (preparedAttachment.mediaType.startsWith("image/")) {
      content.push({
        type: "image",
        image: preparedAttachment.data,
        mediaType: preparedAttachment.mediaType,
        // Marks the part evictable under the request-wide media cap (r34) —
        // matters when these messages re-enter the transform (replay).
        providerOptions: SYNTHETIC_TOOL_MEDIA_PART_METADATA,
      });
      continue;
    }

    content.push({
      type: "file",
      data: preparedAttachment.data,
      mediaType: preparedAttachment.mediaType,
      providerOptions: SYNTHETIC_TOOL_MEDIA_PART_METADATA,
      ...(preparedAttachment.filename
        ? {
            filename: sanitizeAnthropicDocumentFilename(preparedAttachment.filename),
          }
        : {}),
    });
  }
  if (omittedCount > 0) {
    content.splice(1, 0, {
      type: "text",
      text: createOmittedToolAttachmentText(omittedCount),
    });
  }

  return {
    role: "user",
    content,
  };
}

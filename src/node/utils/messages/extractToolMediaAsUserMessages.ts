import type { MuxMessage } from "@/common/types/message";
import { MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST } from "@/common/constants/imageAttachments";
import { sanitizeAnthropicDocumentFilename } from "@/node/utils/messages/sanitizeAnthropicDocumentFilename";
import {
  coalesceAttachmentPlaceholders,
  createDataUrlForExtractedAttachment,
  createOmittedToolAttachmentText,
  createToolAttachmentSummaryText,
  extractAttachmentsFromToolOutput,
  prepareExtractedToolAttachmentForProvider,
  SYNTHETIC_TOOL_MEDIA_PART_METADATA,
} from "@/node/utils/messages/toolResultAttachments";

/**
 * Provider-request-only rewrite to avoid sending huge attachment payloads inside tool-result JSON.
 *
 * Some tools return attachments as base64 in the tool output.
 * If that payload is sent as tool-result JSON, providers can treat it as text, quickly
 * exceeding context limits.
 *
 * This helper:
 * - detects tool outputs shaped like { type: "content", value: [{ type: "media", data, mediaType }, ...] }
 * - replaces supported media items in the tool output with small text placeholders
 * - emits a synthetic *user* message immediately after the assistant message, attaching the files
 *   as proper multimodal file parts (XumFilePart)
 *
 * NOTE: This is request-only: it should be applied to the in-memory message list right before
 * convertToModelMessages(...). Persisted history and UI still keep the original tool output.
 */
export async function extractToolMediaAsUserMessages(
  messages: MuxMessage[]
): Promise<MuxMessage[]> {
  // Pass 1 — extract once per tool part. The request-wide media cap needs the
  // TOTAL before any emission so the NEWEST attachments survive (the model
  // usually needs its latest screenshot, not its oldest), and the extraction
  // walk must not run twice per part.
  const extractionsByPart = new Map<
    MuxMessage["parts"][number],
    NonNullable<ReturnType<typeof extractAttachmentsFromToolOutput>>
  >();
  let totalAttachments = 0;
  // Media parts already bound for the provider (user-attached images/PDFs and
  // prior synthetic file parts) share the same per-request provider limits,
  // so they consume the extraction allowance too (r31): 50 existing images
  // plus a full 64-part extraction allowance would exceed a ~100-image
  // provider cap the constant is sized to stay below.
  let existingMediaParts = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "file") existingMediaParts++;
    }
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "dynamic-tool" || part.state !== "output-available") continue;
      const extracted = extractAttachmentsFromToolOutput(part.output);
      if (extracted == null) continue;
      extractionsByPart.set(part, extracted);
      totalAttachments += extracted.attachments.length;
    }
  }
  if (extractionsByPart.size === 0) return messages;

  // Capture-time bounding caps bytes and per-container parts, not distinct
  // records across a transcript: a looped bridged media tool could otherwise
  // fan out tens of thousands of synthetic provider parts that every later
  // request re-processes (r28 security). Chronologically OLDEST overflow is
  // omitted (replaced with one bounded placeholder per synthetic message).
  const allowance = Math.max(0, MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST - existingMediaParts);
  let omitRemaining = Math.max(0, totalAttachments - allowance);

  const result: MuxMessage[] = [];

  for (const message of messages) {
    if (message.role !== "assistant") {
      result.push(message);
      continue;
    }

    let extractedUserParts: MuxMessage["parts"] = [];
    let extractedAttachmentCount = 0;
    let changedMessage = false;

    const newParts: MuxMessage["parts"] = [];
    for (const part of message.parts) {
      if (part.type !== "dynamic-tool" || part.state !== "output-available") {
        newParts.push(part);
        continue;
      }
      const extracted = extractionsByPart.get(part);
      if (extracted === undefined) {
        newParts.push(part);
        continue;
      }

      changedMessage = true;
      extractedAttachmentCount += extracted.attachments.length;

      // Over the request-wide cap: chronologically OLDEST attachments are
      // omitted. Skipping BEFORE provider preparation avoids the
      // resize/data-url work for payloads the request will never carry.
      const omittedHere = Math.min(omitRemaining, extracted.attachments.length);
      omitRemaining -= omittedHere;

      const nextExtractedUserParts: MuxMessage["parts"] = [];
      for (const attachment of extracted.attachments.slice(omittedHere)) {
        const providerReadyAttachment = await prepareExtractedToolAttachmentForProvider(attachment);
        if (providerReadyAttachment.type === "text") {
          nextExtractedUserParts.push({
            type: "text",
            text: providerReadyAttachment.text,
          });
          continue;
        }

        const preparedAttachment = providerReadyAttachment.attachment;
        nextExtractedUserParts.push({
          type: "file",
          mediaType: preparedAttachment.mediaType,
          url: createDataUrlForExtractedAttachment(preparedAttachment),
          // Marks the part evictable under the request-wide media cap so a
          // later step's fresh screenshot can displace it — genuine user
          // uploads carry no marker and are never evicted (r34).
          providerMetadata: SYNTHETIC_TOOL_MEDIA_PART_METADATA,
          ...(preparedAttachment.filename
            ? {
                filename:
                  preparedAttachment.mediaType === "application/pdf"
                    ? sanitizeAnthropicDocumentFilename(preparedAttachment.filename)
                    : preparedAttachment.filename,
              }
            : {}),
        });
      }

      if (omittedHere > 0) {
        nextExtractedUserParts.push({
          type: "text",
          text: createOmittedToolAttachmentText(omittedHere),
        });
      }
      extractedUserParts = [...extractedUserParts, ...nextExtractedUserParts];
      newParts.push({
        ...part,
        // Excess per-item placeholders (cap omission OR same-payload dedup —
        // r31) are coalesced so a flooded transcript cannot keep megabytes of
        // placeholder JSON in every request (r29 security). The helper
        // returns the output unchanged when placeholders match the emitted
        // attachments 1:1.
        output: coalesceAttachmentPlaceholders(
          extracted.newOutput,
          extracted.attachments.length - omittedHere
        ),
      });
    }

    const rewrittenMessage = changedMessage
      ? ({ ...message, parts: newParts } satisfies MuxMessage)
      : message;
    result.push(rewrittenMessage);

    if (extractedUserParts.length > 0) {
      const timestamp = message.metadata?.timestamp ?? Date.now();
      result.push({
        id: `tool-media-${message.id}`,
        role: "user",
        parts: [
          {
            type: "text",
            text: createToolAttachmentSummaryText(extractedAttachmentCount),
          },
          ...extractedUserParts,
        ],
        metadata: {
          timestamp,
          synthetic: true,
        },
      });
    }
  }

  // extractionsByPart is non-empty here, so at least one message changed.
  return result;
}

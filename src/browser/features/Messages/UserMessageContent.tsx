import React from "react";
import { FileText } from "lucide-react";
import type { InlineSkillSnapshotMap, ReviewNoteDataForDisplay } from "@/common/types/message";
import type { FilePart } from "@/common/orpc/schemas";
import {
  parseStagedAttachmentNotice,
  type DisplayStagedAttachment,
} from "@/browser/features/ChatInput/stagedAttachments";
import { ReviewBlockFromData } from "../Shared/ReviewBlock";
import {
  HoverCard,
  HoverCardContent,
  HoverCardPortal,
  HoverCardTrigger,
} from "@/browser/components/HoverCard/HoverCard";
import { isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";
import { downloadBlob } from "@/browser/utils/downloadFile";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { AgentSkillBadge } from "./AgentSkillBadge";
import { buildAgentSkillSnapshotMarkdown } from "./agentSkillSnapshotMarkdown";

interface UserMessageContentProps {
  content: string;
  commandPrefix?: string;
  /**
   * Optional agent-skill snapshot content for /{skillName} invocations.
   * When present, the command prefix badge shows a hover preview.
   */
  agentSkillSnapshot?: { frontmatterYaml?: string; body?: string };
  inlineSkillSnapshots?: InlineSkillSnapshotMap;
  reviews?: ReviewNoteDataForDisplay[];
  fileParts?: FilePart[];
  onDownloadStagedAttachment?: (attachment: DisplayStagedAttachment) => void;
  /** Controls styling: "sent" for full styling, "queued" for muted preview */
  variant: "sent" | "queued";
}

const markdownStyles: Record<UserMessageContentProps["variant"], React.CSSProperties> = {
  sent: {
    color: "var(--color-user-text)",
    overflowWrap: "break-word",
    wordBreak: "break-word",
  },
  queued: {
    // Queued follow-ups are still user-authored prose, so keep them readable instead of
    // styling the preview like subdued terminal output.
    color: "var(--color-text-light)",
    fontFamily: "inherit",
    fontSize: "13px",
    lineHeight: "18px",
    overflowWrap: "break-word",
    wordBreak: "break-word",
  },
};

const imageContainerStyles = {
  sent: "mt-3 flex flex-wrap gap-3",
  queued: "mt-2 flex flex-wrap gap-2",
} as const;

const markdownClassName = "user-message-markdown";

function dataUrlToBlob(dataUrl: string): Blob | null {
  if (!dataUrl.startsWith("data:")) return null;

  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) return null;

  const header = dataUrl.slice("data:".length, commaIndex);
  if (!header.includes(";base64")) return null;

  const mimeType = header.split(";")[0] ?? "application/octet-stream";

  try {
    const base64 = dataUrl.slice(commaIndex + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType });
  } catch {
    return null;
  }
}

function getBaseMediaType(mediaType: string): string {
  return mediaType.toLowerCase().trim().split(";")[0];
}

const fileAttachmentStyles = {
  sent: "flex max-w-80 items-center gap-2 rounded-xl border border-[var(--color-attachment-border)] px-3 py-2 text-sm text-[var(--color-subtle)]",
  queued:
    "border-border-light flex max-w-80 items-center gap-2 rounded border px-2 py-1 text-xs text-[var(--color-subtle)]",
} as const;
const imageStyles = {
  sent: "max-h-[300px] max-w-72 rounded-xl border border-[var(--color-attachment-border)] object-cover",
  queued: "border-border-light max-h-[300px] max-w-80 rounded border",
} as const;

/**
 * Shared content renderer for user messages (sent and queued).
 * Handles reviews, text content, and attachments.
 */
export const UserMessageContent: React.FC<UserMessageContentProps> = (props) => {
  const reviews = props.reviews ?? [];
  const fileParts = props.fileParts ?? [];
  const parsedStagedNotice = parseStagedAttachmentNotice(props.content);
  const stagedAttachments = parsedStagedNotice.attachments;

  const hasReviews = reviews.length > 0;

  // Strip model-only attachment/review tags from text when displaying alongside rich UI blocks.
  const textContent = hasReviews
    ? parsedStagedNotice.text.replace(/<review>[\s\S]*?<\/review>\s*/g, "").trim()
    : parsedStagedNotice.text;

  // Check if content starts with the command prefix
  const shouldHighlightPrefix =
    props.commandPrefix && textContent.startsWith(props.commandPrefix)
      ? props.commandPrefix
      : undefined;

  // Content after the prefix (if highlighting)
  const remainingContent = shouldHighlightPrefix
    ? textContent.slice(shouldHighlightPrefix.length)
    : textContent;

  // Render text content with optional command prefix badge
  const renderTextContent = () => {
    if (!remainingContent && !shouldHighlightPrefix) return null;

    // No prefix highlighting - render markdown directly without wrapper
    if (!shouldHighlightPrefix) {
      return (
        <MarkdownRenderer
          content={textContent}
          className={markdownClassName}
          style={markdownStyles[props.variant]}
          inlineSkillSnapshots={props.inlineSkillSnapshots}
          preserveLineBreaks
        />
      );
    }

    // Check what whitespace follows the prefix to preserve visual layout
    const charAfterPrefix = textContent.charAt(shouldHighlightPrefix.length);
    const hasSpaceAfterPrefix = charAfterPrefix === " ";
    const hasNewlineAfterPrefix = charAfterPrefix === "\n";

    const snapshotMarkdown = buildAgentSkillSnapshotMarkdown(props.agentSkillSnapshot);

    const badge = snapshotMarkdown ? (
      <HoverCard openDelay={150}>
        <HoverCardTrigger asChild>
          <AgentSkillBadge
            as="button"
            aria-label={`Show skill preview for ${shouldHighlightPrefix}`}
            className="cursor-help"
          >
            {shouldHighlightPrefix}
          </AgentSkillBadge>
        </HoverCardTrigger>
        {/* Keep skill preview above chat chrome and fully opaque while hovering. */}
        <HoverCardPortal>
          <HoverCardContent
            align="start"
            side="top"
            className="border-border-medium bg-modal-bg z-[1600] max-h-[360px] w-[520px] max-w-[80vw] overflow-auto border-2 p-3"
          >
            <MarkdownRenderer content={snapshotMarkdown} preserveLineBreaks />
          </HoverCardContent>
        </HoverCardPortal>
      </HoverCard>
    ) : (
      <AgentSkillBadge>{shouldHighlightPrefix}</AgentSkillBadge>
    );

    // Newline after prefix: block layout (badge on own line)
    // Space after prefix: inline layout (badge + content on same line)
    return (
      <div className={hasNewlineAfterPrefix ? "" : "flex flex-wrap items-baseline"}>
        {badge}
        {hasSpaceAfterPrefix && <span>&nbsp;</span>}
        {remainingContent.trim() && (
          <MarkdownRenderer
            content={remainingContent.trim()}
            className={markdownClassName}
            style={markdownStyles[props.variant]}
            inlineSkillSnapshots={props.inlineSkillSnapshots}
            preserveLineBreaks
          />
        )}
      </div>
    );
  };

  return (
    <>
      {hasReviews ? (
        <div className="space-y-2">
          {reviews.map((review, idx) => (
            <ReviewBlockFromData key={idx} data={review} />
          ))}
          {renderTextContent()}
        </div>
      ) : (
        renderTextContent()
      )}
      {fileParts.length > 0 && (
        <div className={imageContainerStyles[props.variant]}>
          {fileParts.map((part, idx) => {
            const baseMediaType = getBaseMediaType(part.mediaType);
            if (baseMediaType.startsWith("image/")) {
              return (
                <img
                  key={idx}
                  src={part.url}
                  alt={`Attachment ${idx + 1}`}
                  className={imageStyles[props.variant]}
                />
              );
            }

            const label =
              part.filename ??
              (baseMediaType === "application/pdf"
                ? "PDF attachment"
                : `Attachment (${baseMediaType})`);

            return (
              <a
                key={idx}
                href={part.url}
                target="_blank"
                rel="noreferrer"
                className={fileAttachmentStyles[props.variant]}
                onClick={(event) => {
                  const blob = dataUrlToBlob(part.url);
                  if (!blob) {
                    return;
                  }

                  event.preventDefault();

                  if (isDesktopMode()) {
                    // In desktop mode, new windows are routed via shell.openExternal.
                    // blob: URLs are tied to this renderer and won't resolve externally,
                    // so download the file in-app instead.
                    void downloadBlob(
                      blob,
                      part.filename ??
                        (baseMediaType === "application/pdf" ? "attachment.pdf" : "attachment")
                    );
                    return;
                  }

                  const blobUrl = URL.createObjectURL(blob);
                  window.open(blobUrl, "_blank", "noopener,noreferrer");

                  // Keep the blob URL alive long enough for the new tab to load.
                  setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
                }}
              >
                <FileText className="h-4 w-4 shrink-0" />
                <span className="truncate">{label}</span>
              </a>
            );
          })}
        </div>
      )}
      {stagedAttachments.length > 0 && (
        <div className={imageContainerStyles[props.variant]}>
          {stagedAttachments.map((attachment) => (
            <button
              key={attachment.stagedPath}
              type="button"
              aria-label={`Download ${attachment.filename}`}
              disabled={!props.onDownloadStagedAttachment}
              className={`${fileAttachmentStyles[props.variant]} ${
                props.onDownloadStagedAttachment
                  ? "cursor-pointer hover:bg-[var(--color-hover)]"
                  : "cursor-default opacity-70"
              }`}
              onClick={() => props.onDownloadStagedAttachment?.(attachment)}
            >
              <FileText className="h-4 w-4 shrink-0" />
              <span className="truncate">{attachment.filename}</span>
              <span className="text-[var(--color-text-muted)]">{attachment.sizeLabel}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
};

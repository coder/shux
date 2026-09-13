import React from "react";
import { FileText, X } from "lucide-react";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";

import { formatBytes } from "./stagedAttachments";

export interface ProviderChatAttachment {
  kind: "provider";
  id: string;
  url: string;
  mediaType: string;
  filename?: string;
  /** Present when the image was auto-resized on attach to fit provider limits. */
  resizeInfo?: {
    originalWidth: number;
    originalHeight: number;
    newWidth: number;
    newHeight: number;
  };
}

export interface StagedChatAttachment {
  kind: "staged";
  id: string;
  mediaType: string;
  filename: string;
  sizeBytes: number;
  stagedPath: string;
}

/**
 * Non-provider file held in memory (bytes included) by a creation composer
 * until a workspace exists to stage it into.
 */
export interface PendingFileChatAttachment {
  kind: "pending-file";
  id: string;
  mediaType: string;
  filename: string;
  sizeBytes: number;
  dataBase64: string;
}

export type ChatAttachment =
  | ProviderChatAttachment
  | StagedChatAttachment
  | PendingFileChatAttachment;

interface ChatAttachmentsProps {
  attachments: ChatAttachment[];
  /** If omitted, attachments are displayed read-only (no remove button). */
  onRemove?: (id: string) => void;
}

function getBaseMediaType(mediaType: string): string {
  return mediaType.toLowerCase().trim().split(";")[0];
}

export const ChatAttachments: React.FC<ChatAttachmentsProps> = (props) => {
  if (props.attachments.length === 0) return null;

  const handleRemove = props.onRemove;

  return (
    <div className="flex flex-wrap gap-2 py-2">
      {props.attachments.map((attachment) => {
        const baseMediaType = getBaseMediaType(attachment.mediaType);
        const isImage = attachment.kind === "provider" && baseMediaType.startsWith("image/");

        if (isImage) {
          const resizeTooltip = attachment.resizeInfo
            ? `Resized from ${attachment.resizeInfo.originalWidth}×${attachment.resizeInfo.originalHeight} to ${attachment.resizeInfo.newWidth}×${attachment.resizeInfo.newHeight}`
            : undefined;

          return (
            <div
              key={attachment.id}
              className="border-border-light bg-dark group grid h-20 w-20 overflow-hidden rounded border"
            >
              <TooltipIfPresent tooltip={resizeTooltip}>
                <img
                  src={attachment.url}
                  alt="Attached image"
                  className="col-start-1 row-start-1 h-full w-full object-cover"
                />
              </TooltipIfPresent>
              {handleRemove && (
                <TooltipIfPresent tooltip="Remove attachment">
                  <button
                    onClick={() => handleRemove(attachment.id)}
                    className="col-start-1 row-start-1 m-0.5 flex h-5 w-5 cursor-pointer items-center justify-center self-start justify-self-end rounded-full border-0 bg-black/70 p-0 text-sm leading-none text-white hover:bg-black/90"
                    aria-label="Remove attachment"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </TooltipIfPresent>
              )}
            </div>
          );
        }

        const label =
          attachment.filename ?? (baseMediaType === "application/pdf" ? "PDF" : baseMediaType);
        const detail =
          attachment.kind === "staged" || attachment.kind === "pending-file"
            ? `workspace file • ${formatBytes(attachment.sizeBytes)}`
            : null;

        return (
          <div
            key={attachment.id}
            className="border-border-light bg-dark flex max-w-[260px] items-center gap-2 rounded border px-2 py-1"
          >
            <FileText className="h-4 w-4 shrink-0 text-[var(--color-subtle)]" />
            <span className="min-w-0 truncate text-xs text-[var(--color-subtle)]">
              {label}
              {detail ? (
                <span className="ml-1 text-[var(--color-text-muted)]">{detail}</span>
              ) : null}
            </span>
            {handleRemove && (
              <TooltipIfPresent tooltip="Remove attachment">
                <button
                  onClick={() => handleRemove(attachment.id)}
                  className="ml-auto flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-[var(--color-subtle)] hover:bg-black/40"
                  aria-label="Remove attachment"
                >
                  <X className="h-3 w-3" />
                </button>
              </TooltipIfPresent>
            )}
          </div>
        );
      })}
    </div>
  );
};

import { useState } from "react";
import type React from "react";
import { useAPI } from "@/browser/contexts/API";
import {
  extractAttachmentsFromClipboard,
  extractAttachmentsFromDrop,
  processAttachmentFiles,
} from "@/browser/utils/attachmentsHandling";
import type { ChatAttachment } from "./ChatAttachments";
import type { Toast } from "./ChatInputToast";

const PDF_MEDIA_TYPE = "application/pdf";
const EDIT_MODE_ATTACHMENT_ERROR_MESSAGE = "Attachments cannot be added while editing a message.";

type PushToast = (toast: Omit<Toast, "id" | "type"> & { type: Toast["type"] | "info" }) => void;

interface UseComposerAttachmentsOptions {
  variant: "creation" | "workspace";
  workspaceId: string | null;
  setAttachments: (
    value: ChatAttachment[] | ((previous: ChatAttachment[]) => ChatAttachment[])
  ) => void;
  editingMessage: boolean;
  pushToast: PushToast;
}
function getBaseMediaType(mediaType: string): string {
  return mediaType.toLowerCase().trim().split(";")[0];
}
export function isPdfAttachment(
  attachment: ChatAttachment
): attachment is Extract<ChatAttachment, { kind: "provider" }> {
  return (
    attachment.kind === "provider" && getBaseMediaType(attachment.mediaType) === PDF_MEDIA_TYPE
  );
}
export function estimateBase64DataUrlBytes(dataUrl: string): number | null {
  if (!dataUrl.startsWith("data:")) return null;
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) return null;
  const header = dataUrl.slice("data:".length, commaIndex);
  if (!header.includes(";base64")) return null;
  const base64 = dataUrl.slice(commaIndex + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}
export function useComposerAttachments(options: UseComposerAttachmentsOptions) {
  const { api } = useAPI();
  const { setAttachments, editingMessage, pushToast, variant, workspaceId } = options;
  const [processingAttachmentCount, setProcessingAttachmentCount] = useState(0);

  const showResizeToast = (next: ChatAttachment[]) => {
    const resized = next.filter(
      (attachment): attachment is Extract<ChatAttachment, { kind: "provider" }> =>
        attachment.kind === "provider" && attachment.resizeInfo != null
    );
    const resizeInfo = resized[0]?.resizeInfo;
    if (!resizeInfo) return;
    pushToast({
      type: "info",
      message:
        resized.length === 1
          ? `Image resized from ${resizeInfo.originalWidth}×${resizeInfo.originalHeight} to ${resizeInfo.newWidth}×${resizeInfo.newHeight}`
          : `${resized.length} images resized to fit provider limits`,
    });
  };

  const processFiles = (files: File[]) => {
    setProcessingAttachmentCount((count) => count + 1);
    return processAttachmentFiles(files, {
      stageAttachment:
        variant === "workspace"
          ? async (file, dataBase64) => {
              if (!api) throw new Error("Not connected to server");
              if (workspaceId == null)
                throw new Error("Files can be staged after opening a workspace.");
              const result = await api.workspace.stageAttachment({
                workspaceId,
                filename: file.name,
                mediaType: file.type || null,
                sizeBytes: file.size,
                dataBase64,
              });
              if (!result.success) throw new Error(result.error);
              return result.data;
            }
          : undefined,
      holdNonProviderFiles: variant === "creation",
    }).finally(() => setProcessingAttachmentCount((count) => Math.max(0, count - 1)));
  };

  const attachFiles = (files: File[]) => {
    void Promise.all(
      files.map((file) =>
        processFiles([file]).then(
          (processed) => ({ ok: true as const, attachments: processed }),
          (error: unknown) => ({ ok: false as const, error })
        )
      )
    ).then((outcomes) => {
      const successes = outcomes.flatMap((outcome) => (outcome.ok ? outcome.attachments : []));
      if (successes.length > 0) {
        setAttachments((previous) => [...previous, ...successes]);
        showResizeToast(successes);
      }
      for (const outcome of outcomes) {
        if (outcome.ok) continue;
        console.error("Failed to process attached file:", outcome.error);
        pushToast({
          type: "error",
          message:
            outcome.error instanceof Error ? outcome.error.message : "Failed to process attachment",
        });
      }
    });
  };

  const rejectEditAttachment = () => {
    pushToast({ type: "error", message: EDIT_MODE_ATTACHMENT_ERROR_MESSAGE });
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = event.clipboardData?.items
      ? extractAttachmentsFromClipboard(event.clipboardData.items)
      : [];
    if (files.length === 0) return;
    if (editingMessage) {
      rejectEditAttachment();
      return;
    }
    event.preventDefault();
    attachFiles(files);
  };

  const handleAttachFiles = (files: File[]) => {
    if (editingMessage) rejectEditAttachment();
    else attachFiles(files);
  };

  const handleDragOver = (event: React.DragEvent<HTMLTextAreaElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = editingMessage ? "none" : "copy";
  };

  const handleDrop = (event: React.DragEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    const files = extractAttachmentsFromDrop(event.dataTransfer);
    if (files.length === 0) return;
    if (editingMessage) rejectEditAttachment();
    else attachFiles(files);
  };

  const handleRemoveAttachment = (id: string) => {
    setAttachments((previous) => previous.filter((item) => item.id !== id));
  };

  return {
    processingAttachmentCount,
    handlePaste,
    handleAttachFiles,
    handleDragOver,
    handleDrop,
    handleRemoveAttachment,
  };
}

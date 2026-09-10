/**
 * Shared cards for attachment-carrying tool results. Used by the attach_file
 * tool card and by code_execution's attachment carrier (nested attach_file
 * bytes ride the carrier, so the outer card owns their previews/downloads).
 */
import type React from "react";
import { Download, FileText } from "lucide-react";
import { isValidBase64AttachmentData } from "@/common/utils/attachments/base64";
import {
  MARKDOWN_MEDIA_TYPE,
  normalizeAttachmentMediaType,
} from "@/common/utils/attachments/supportedAttachmentMediaTypes";
import { formatBytes } from "@/common/utils/formatBytes";
import { downloadDataUrl } from "@/browser/utils/imageActions";
import {
  getDisplayOnlyFileMetadata,
  type DisplayOnlyFilePart,
} from "@/common/utils/attachments/displayOnlyFileParts";
import { MarkdownRenderer } from "../../Messages/MarkdownRenderer";
import type { MediaContent } from "./ToolResultImages";

const MARKDOWN_PREVIEW_CHAR_LIMIT = 50_000;
const MARKDOWN_PREVIEW_MEDIA_TYPES = new Set([MARKDOWN_MEDIA_TYPE, "text/x-markdown"]);

function createSafeDataUrl(file: DisplayOnlyFilePart): string | null {
  if (!isValidBase64AttachmentData(file.data)) {
    return null;
  }

  return `data:${normalizeAttachmentMediaType(file.mediaType)};base64,${file.data}`;
}

function isMarkdownPreviewMediaType(mediaType: string): boolean {
  return MARKDOWN_PREVIEW_MEDIA_TYPES.has(normalizeAttachmentMediaType(mediaType));
}

function decodeBase64Utf8(data: string): string | null {
  if (!isValidBase64AttachmentData(data)) {
    return null;
  }

  try {
    const binary = globalThis.atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Button, not <a download>: iOS home-screen web apps silently drop anchor
 * downloads; downloadDataUrl routes them to the native share sheet instead.
 */
const AttachmentDownloadButton: React.FC<{ dataUrl: string; filename?: string }> = (props) => (
  <button
    type="button"
    onClick={() => downloadDataUrl(props.dataUrl, props.filename ?? "attachment")}
    className="border-border-light hover:bg-surface flex items-center gap-1 rounded border px-2 py-1 text-[var(--color-text)]"
  >
    <Download className="h-3 w-3" />
    Download
  </button>
);

function createMarkdownPreview(markdown: string): { content: string; truncated: boolean } {
  if (markdown.length <= MARKDOWN_PREVIEW_CHAR_LIMIT) {
    return { content: markdown, truncated: false };
  }

  return {
    content: markdown.slice(0, MARKDOWN_PREVIEW_CHAR_LIMIT),
    truncated: true,
  };
}

export const DisplayOnlyFile: React.FC<{ file: DisplayOnlyFilePart }> = (props) => {
  const dataUrl = createSafeDataUrl(props.file);
  const baseMediaType = normalizeAttachmentMediaType(props.file.mediaType);
  const label = props.file.filename ?? `Attachment (${baseMediaType})`;
  const metadata = getDisplayOnlyFileMetadata(props.file.providerOptions);
  const formattedSize = metadata?.size != null ? formatBytes(metadata.size) : null;
  const markdownText = isMarkdownPreviewMediaType(baseMediaType)
    ? decodeBase64Utf8(props.file.data)
    : null;
  const markdownPreview = markdownText != null ? createMarkdownPreview(markdownText) : null;

  return (
    <div className="border-border-light bg-dark mt-2 max-w-xl rounded border p-3">
      <div className="mb-2 flex min-w-0 items-center gap-2 text-sm text-[var(--color-subtle)]">
        <FileText className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium text-[var(--color-text)]">
          {label}
        </span>
        <span className="counter-nums max-w-[40%] min-w-0 truncate text-xs">{baseMediaType}</span>
        {formattedSize != null && (
          <span className="counter-nums shrink-0 text-xs">{formattedSize}</span>
        )}
      </div>

      {dataUrl != null && baseMediaType.startsWith("video/") && (
        <video controls src={dataUrl} className="max-h-80 max-w-full rounded" />
      )}
      {dataUrl != null && baseMediaType.startsWith("audio/") && (
        <audio controls src={dataUrl} className="w-full" />
      )}

      {markdownPreview != null && (
        <div className="border-border-light bg-background max-h-80 overflow-auto rounded border p-3 text-[11px]">
          <MarkdownRenderer content={markdownPreview.content} />
          {markdownPreview.truncated && (
            <div className="text-muted mt-3 border-t border-white/10 pt-2 text-xs">
              Preview truncated. Download the file to view the full markdown.
            </div>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center gap-2 text-xs text-[var(--color-subtle)]">
        <span>Shown to the user only; not sent to the model as a file attachment.</span>
        {dataUrl == null && <span>File data is unavailable for preview or download.</span>}
        {dataUrl != null && (
          <AttachmentDownloadButton dataUrl={dataUrl} filename={props.file.filename} />
        )}
      </div>
    </div>
  );
};

/**
 * Card for media attachments that were sent to the model but cannot be
 * previewed inline (PDF, SVG). SVG is intentionally never rendered in the
 * renderer because it can contain scripts (see sanitizeImageData); both
 * formats are offered as downloads instead so the attachment isn't invisible.
 */
export const MediaAttachmentDownloadCard: React.FC<{ media: MediaContent }> = (props) => {
  const baseMediaType = normalizeAttachmentMediaType(props.media.mediaType);
  const dataUrl = isValidBase64AttachmentData(props.media.data)
    ? `data:${baseMediaType};base64,${props.media.data}`
    : null;
  const label = props.media.filename ?? `Attachment (${baseMediaType})`;

  return (
    <div className="border-border-light bg-dark mt-2 max-w-xl rounded border p-3">
      <div className="mb-2 flex min-w-0 items-center gap-2 text-sm text-[var(--color-subtle)]">
        <FileText className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium text-[var(--color-text)]">
          {label}
        </span>
        <span className="counter-nums max-w-[40%] min-w-0 truncate text-xs">{baseMediaType}</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-[var(--color-subtle)]">
        <span>Attached for the model; inline preview is not available for this file type.</span>
        {dataUrl == null && <span>File data is unavailable for download.</span>}
        {dataUrl != null && (
          <AttachmentDownloadButton dataUrl={dataUrl} filename={props.media.filename} />
        )}
      </div>
    </div>
  );
};

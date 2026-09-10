import React, { useState } from "react";
import { Maximize2 } from "lucide-react";
import { isValidBase64AttachmentData } from "@/common/utils/attachments/base64";
import { isToolContentResult } from "@/common/utils/tools/toolContentResult";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { ImageLightbox } from "@/browser/components/ImageLightbox";
import { useContextMenuPosition } from "@/browser/hooks/useContextMenuPosition";
import { PositionedMenuItem } from "@/browser/components/PositionedMenu/PositionedMenu";
import { ImageActionsMenu } from "@/browser/components/ImageActionsMenu";
import { getImageDownloadFilename } from "@/browser/utils/imageActions";

/**
 * Image content from tool results (attach_file, desktop screenshots, MCP tools).
 * MCP's image type is transformed to the AI SDK's media type upstream.
 */
export interface MediaContent {
  type: "media";
  data: string; // base64
  mediaType: string;
  /** Original filename when known (e.g. attach_file results) */
  filename?: string;
}

function isMediaContent(value: unknown): value is MediaContent {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    record.type === "media" &&
    typeof record.data === "string" &&
    typeof record.mediaType === "string"
  );
}

/**
 * Allowed image MIME types for display.
 * Excludes SVG (can contain scripts) and other potentially dangerous formats.
 */
const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
]);

/**
 * Sanitize and validate image data from MCP tool results.
 * Returns a safe data URL or null if validation fails.
 */
export function sanitizeImageData(mediaType: string, data: string): string | null {
  // Normalize and validate media type
  const normalizedType = mediaType.toLowerCase().trim();
  if (!ALLOWED_IMAGE_TYPES.has(normalizedType)) {
    return null;
  }

  if (!isValidBase64AttachmentData(data)) {
    return null;
  }

  return `data:${normalizedType};base64,${data}`;
}

/**
 * Extract images from a tool result.
 * Handles the transformed MCP result format: { type: "content", value: [...] }
 */
export function extractImagesFromToolResult(result: unknown): MediaContent[] {
  if (!isToolContentResult(result)) return [];

  return result.value.filter(isMediaContent).map((media) => {
    // Normalize to a known shape: media parts may carry extra fields, and
    // filename may be absent or malformed (e.g. from arbitrary MCP servers).
    const filename = (media as { filename?: unknown }).filename;
    return {
      type: "media" as const,
      data: media.data,
      mediaType: media.mediaType,
      filename: typeof filename === "string" && filename.length > 0 ? filename : undefined,
    };
  });
}

interface SafeToolResultImage {
  dataUrl: string;
  mediaType: string;
  filename?: string;
}

interface ToolResultImagesProps {
  result: unknown;
}

/**
 * Display images extracted from tool results (attach_file, desktop screenshots,
 * MCP tools). Click opens a lightbox; right-click (or long-press on touch)
 * opens a menu with copy/download actions.
 */
export const ToolResultImages: React.FC<ToolResultImagesProps> = ({ result }) => {
  const images = extractImagesFromToolResult(result);
  const [selectedImage, setSelectedImage] = useState<SafeToolResultImage | null>(null);
  // The image the context menu currently targets (set on right-click/long-press).
  const [menuImage, setMenuImage] = useState<SafeToolResultImage | null>(null);
  const contextMenu = useContextMenuPosition({ longPress: true });

  // Sanitize all images upfront, filtering out any that fail validation
  const safeImages = images
    .map((image): SafeToolResultImage | null => {
      const dataUrl = sanitizeImageData(image.mediaType, image.data);
      if (dataUrl === null) {
        return null;
      }
      return { dataUrl, mediaType: image.mediaType, filename: image.filename };
    })
    .filter((image): image is SafeToolResultImage => image !== null);

  if (safeImages.length === 0) return null;

  return (
    <>
      <div className="mt-2 flex flex-wrap gap-2">
        {safeImages.map((image, index) => (
          <TooltipIfPresent
            key={index}
            tooltip="Click to view full size. Right-click for actions."
            side="top"
          >
            <button
              onClick={() => {
                // A long-press already opened the context menu; don't also open the lightbox.
                if (contextMenu.suppressClickIfLongPress()) return;
                setSelectedImage(image);
              }}
              onContextMenu={(e) => {
                setMenuImage(image);
                contextMenu.onContextMenu(e);
              }}
              onTouchStart={(e) => {
                setMenuImage(image);
                contextMenu.touchHandlers.onTouchStart(e);
              }}
              onTouchEnd={contextMenu.touchHandlers.onTouchEnd}
              onTouchMove={contextMenu.touchHandlers.onTouchMove}
              className="border-border-light bg-dark flex max-w-full cursor-pointer flex-col overflow-hidden rounded border p-0 transition-opacity hover:opacity-80"
            >
              <img
                src={image.dataUrl}
                alt={image.filename ?? `Tool result image ${index + 1}`}
                className="max-h-48 max-w-full object-contain"
              />
              {image.filename && (
                // w-0 min-w-full keeps the caption from widening the thumbnail
                // beyond the image while still truncating long filenames.
                <span className="text-muted border-border-light w-0 min-w-full truncate border-t px-1.5 py-0.5 text-left text-[10px]">
                  {image.filename}
                </span>
              )}
            </button>
          </TooltipIfPresent>
        ))}
      </div>

      <ImageActionsMenu
        contextMenu={contextMenu}
        image={
          menuImage
            ? {
                dataUrl: menuImage.dataUrl,
                downloadFilename: getImageDownloadFilename(menuImage.filename, menuImage.mediaType),
              }
            : null
        }
      >
        {/* No shortcut hint: Enter/Space on the focused thumbnail button
            already opens the lightbox (native button activation). */}
        {menuImage && (
          <PositionedMenuItem
            icon={<Maximize2 />}
            label="View full size"
            onClick={() => {
              setSelectedImage(menuImage);
              contextMenu.close();
            }}
          />
        )}
      </ImageActionsMenu>

      <ImageLightbox
        src={selectedImage?.dataUrl ?? null}
        title="Image Preview"
        alt={selectedImage?.filename ?? "Full size preview"}
        filename={selectedImage?.filename}
        downloadFilename={
          selectedImage
            ? getImageDownloadFilename(selectedImage.filename, selectedImage.mediaType)
            : undefined
        }
        onClose={() => setSelectedImage(null)}
      />
    </>
  );
};

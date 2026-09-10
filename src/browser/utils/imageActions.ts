import type React from "react";
import { normalizeAttachmentMediaType } from "@/common/utils/attachments/supportedAttachmentMediaTypes";
import { KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";
import { downloadBlob, downloadViaAnchor } from "@/browser/utils/downloadFile";
import { isIosStandaloneWebApp } from "@/browser/utils/env";
import { stopKeyboardPropagation } from "@/browser/utils/events";

/**
 * Actions for images rendered from base64 data URLs (tool result images,
 * attach_file previews): copy to the system clipboard and download.
 */

// Subtypes whose conventional file extension differs from the MIME subtype.
const IMAGE_EXTENSION_BY_SUBTYPE = new Map<string, string>([
  ["jpeg", "jpg"],
  ["svg+xml", "svg"],
]);

/**
 * Decode a base64 data URL into a Blob. Returns null when the input is not a
 * well-formed base64 data URL.
 */
export function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) {
    return null;
  }

  const [, mediaType, base64Data] = match;
  try {
    const binary = globalThis.atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: normalizeAttachmentMediaType(mediaType) });
  } catch {
    return null;
  }
}

/**
 * Resolve the filename used when downloading an image attachment: prefer the
 * attachment's own filename, otherwise derive an extension from its media type.
 */
export function getImageDownloadFilename(filename: string | undefined, mediaType: string): string {
  if (filename) {
    return filename;
  }

  const subtype = normalizeAttachmentMediaType(mediaType).split("/")[1] ?? "";
  const extension = IMAGE_EXTENSION_BY_SUBTYPE.get(subtype) ?? subtype;
  return extension.length > 0 ? `image.${extension}` : "image";
}

/** Re-encode an arbitrary raster image blob to PNG through an offscreen canvas. */
async function reencodeImageBlobToPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Failed to acquire 2d canvas context for image re-encode");
    }
    context.drawImage(bitmap, 0, 0);

    const pngBlob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });
    if (!pngBlob) {
      throw new Error("Failed to encode image as PNG");
    }
    return pngBlob;
  } finally {
    bitmap.close();
  }
}

/**
 * Copy an image (given as a base64 data URL) to the system clipboard.
 *
 * Chromium's async Clipboard API only accepts "image/png" image payloads, so
 * non-PNG sources are re-encoded through a canvas first. Animated formats
 * (GIF) copy their first frame, matching native browser behavior.
 */
export async function copyImageDataUrlToClipboard(dataUrl: string): Promise<void> {
  const blob = dataUrlToBlob(dataUrl);
  if (!blob) {
    throw new Error("Invalid image data URL");
  }

  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    throw new Error("Clipboard image writes are not supported in this environment");
  }

  const pngBlob = blob.type === "image/png" ? blob : await reencodeImageBlobToPng(blob);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
}

/**
 * Shared keyboard handler for image surfaces (lightbox, image context menu):
 * mod+C copies the image, mod+S downloads it. Returns true when the event was
 * consumed. When text is selected, mod+C is left to the native copy behavior.
 */
export function handleImageActionKeyDown(
  e: React.KeyboardEvent,
  actions: { copy: () => void; download: () => void }
): boolean {
  if (matchesKeybind(e, KEYBINDS.IMAGE_COPY)) {
    if (window.getSelection()?.toString()) {
      return false;
    }
    e.preventDefault();
    // Block global handlers (e.g. Ctrl+C stream interrupt in vim mode).
    stopKeyboardPropagation(e);
    actions.copy();
    return true;
  }

  if (matchesKeybind(e, KEYBINDS.IMAGE_DOWNLOAD)) {
    // preventDefault suppresses the browser's save-page dialog.
    e.preventDefault();
    stopKeyboardPropagation(e);
    actions.download();
    return true;
  }

  return false;
}

/**
 * Trigger a download of a data URL. iOS home-screen web apps drop anchor
 * downloads, so only there the payload is decoded into a Blob for the share
 * sheet; everywhere else the anchor uses the data URL directly, avoiding a
 * synchronous base64 decode of potentially multi-MB attachments.
 */
export function downloadDataUrl(dataUrl: string, filename: string): void {
  if (isIosStandaloneWebApp()) {
    const blob = dataUrlToBlob(dataUrl);
    if (blob) {
      // downloadBlob alerts the user on failure itself, so fire-and-forget
      // cannot silently drop the download.
      void downloadBlob(blob, filename);
      return;
    }
  }

  downloadViaAnchor(dataUrl, filename);
}

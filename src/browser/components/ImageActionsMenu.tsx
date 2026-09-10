import type React from "react";
import { Copy, Download } from "lucide-react";
import type { UseContextMenuPositionReturn } from "@/browser/hooks/useContextMenuPosition";
import {
  PositionedMenu,
  PositionedMenuItem,
} from "@/browser/components/PositionedMenu/PositionedMenu";
import {
  copyImageDataUrlToClipboard,
  downloadDataUrl,
  handleImageActionKeyDown,
} from "@/browser/utils/imageActions";
import { KEYBINDS, formatKeybind } from "@/browser/utils/ui/keybinds";

export interface ImageActionsMenuImage {
  dataUrl: string;
  downloadFilename: string;
}

/** Copy an image data URL, logging (not throwing) on failure. */
export function copyImageWithErrorLogging(dataUrl: string): void {
  copyImageDataUrlToClipboard(dataUrl).catch((err: unknown) => {
    console.error("Failed to copy image:", err);
  });
}

interface ImageActionsMenuProps {
  contextMenu: UseContextMenuPositionReturn;
  /** The image the menu targets; null renders an empty (closed) menu */
  image: ImageActionsMenuImage | null;
  /** Extra leading menu items (e.g. "View full size" on thumbnails) */
  children?: React.ReactNode;
  /** Override the copy action (e.g. to surface copied-feedback in the lightbox) */
  onCopy?: (dataUrl: string) => void;
}

/**
 * Shared right-click menu for image surfaces (tool result thumbnails and the
 * expanded lightbox) so both offer the same Copy/Download actions and
 * keyboard shortcuts.
 */
export function ImageActionsMenu(props: ImageActionsMenuProps) {
  const image = props.image;
  const copy = props.onCopy ?? copyImageWithErrorLogging;

  return (
    <PositionedMenu
      open={props.contextMenu.isOpen}
      onOpenChange={props.contextMenu.onOpenChange}
      position={props.contextMenu.position}
      onKeyDown={(e) => {
        if (!image) return;
        const consumed = handleImageActionKeyDown(e, {
          copy: () => copy(image.dataUrl),
          download: () => downloadDataUrl(image.dataUrl, image.downloadFilename),
        });
        if (consumed) {
          props.contextMenu.close();
        }
      }}
    >
      {image && (
        <>
          {props.children}
          <PositionedMenuItem
            icon={<Copy />}
            label="Copy image"
            shortcut={formatKeybind(KEYBINDS.IMAGE_COPY)}
            onClick={() => {
              copy(image.dataUrl);
              props.contextMenu.close();
            }}
          />
          <PositionedMenuItem
            icon={<Download />}
            label="Download image"
            shortcut={formatKeybind(KEYBINDS.IMAGE_DOWNLOAD)}
            onClick={() => {
              downloadDataUrl(image.dataUrl, image.downloadFilename);
              props.contextMenu.close();
            }}
          />
        </>
      )}
    </PositionedMenu>
  );
}

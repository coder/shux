import { Check, Copy, Download } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  VisuallyHidden,
} from "@/browser/components/Dialog/Dialog";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { useContextMenuPosition } from "@/browser/hooks/useContextMenuPosition";
import { ImageActionsMenu } from "@/browser/components/ImageActionsMenu";
import {
  copyImageDataUrlToClipboard,
  downloadDataUrl,
  handleImageActionKeyDown,
} from "@/browser/utils/imageActions";
import { KEYBINDS, formatKeybind } from "@/browser/utils/ui/keybinds";

interface ImageLightboxProps {
  src: string | null;
  title: string;
  alt: string;
  /** Optional filename shown in the action bar */
  filename?: string;
  /** Filename used by the Download action (defaults to filename, then "image") */
  downloadFilename?: string;
  onClose: () => void;
}

const ACTION_BUTTON_CLASS =
  "border-border-light hover:bg-hover flex items-center gap-1 rounded border px-2 py-1 text-xs text-[var(--color-text)]";

/** Keybind hint rendered inside an action button; hidden on mobile views. */
function ShortcutHint(props: { keybind: (typeof KEYBINDS)[keyof typeof KEYBINDS] }) {
  return (
    <span className="text-muted hidden text-[10px] sm:inline">
      ({formatKeybind(props.keybind)})
    </span>
  );
}

export function ImageLightbox(props: ImageLightboxProps) {
  const src = props.src;
  // Reuse the shared copied-feedback hook with an image write function.
  const { copied, copyToClipboard } = useCopyToClipboard(copyImageDataUrlToClipboard);
  // Same right-click/long-press menu as the thumbnails so the expanded view
  // stays consistent with the tool card experience.
  const contextMenu = useContextMenuPosition({ longPress: true });
  const downloadFilename = props.downloadFilename ?? props.filename ?? "image";

  return (
    <Dialog open={src !== null} onOpenChange={props.onClose}>
      <DialogContent
        maxWidth="90vw"
        maxHeight="90vh"
        className="flex w-auto flex-col items-center justify-center gap-2 bg-black/90 p-2"
        onKeyDown={(e) => {
          if (src === null) return;
          handleImageActionKeyDown(e, {
            copy: () => void copyToClipboard(src),
            download: () => downloadDataUrl(src, downloadFilename),
          });
        }}
      >
        <VisuallyHidden>
          <DialogTitle>{props.title}</DialogTitle>
        </VisuallyHidden>
        {src !== null && (
          <>
            <img
              src={src}
              alt={props.alt}
              className="max-h-[80vh] max-w-full object-contain"
              onContextMenu={contextMenu.onContextMenu}
              onTouchStart={contextMenu.touchHandlers.onTouchStart}
              onTouchEnd={contextMenu.touchHandlers.onTouchEnd}
              onTouchMove={contextMenu.touchHandlers.onTouchMove}
            />
            {/* Route menu copies through the feedback hook so the Copy button
                flashes "Copied" regardless of how the copy was triggered. */}
            <ImageActionsMenu
              contextMenu={contextMenu}
              image={{ dataUrl: src, downloadFilename }}
              onCopy={(dataUrl) => void copyToClipboard(dataUrl)}
            />
            <div className="flex w-full min-w-0 items-center gap-2 px-1">
              {props.filename && (
                <span className="text-muted min-w-0 flex-1 truncate text-xs">{props.filename}</span>
              )}
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => void copyToClipboard(src)}
                  className={ACTION_BUTTON_CLASS}
                >
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {copied ? "Copied" : "Copy"}
                  <ShortcutHint keybind={KEYBINDS.IMAGE_COPY} />
                </button>
                {/* Button, not <a download>: iOS home-screen web apps silently
                    drop anchor downloads; downloadDataUrl routes them to the
                    native share sheet instead. */}
                <button
                  type="button"
                  onClick={() => downloadDataUrl(src, downloadFilename)}
                  className={ACTION_BUTTON_CLASS}
                >
                  <Download className="h-3 w-3" />
                  Download
                  <ShortcutHint keybind={KEYBINDS.IMAGE_DOWNLOAD} />
                </button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

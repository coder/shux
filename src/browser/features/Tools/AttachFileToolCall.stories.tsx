import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fireEvent, waitFor, within } from "@storybook/test";
import { createDisplayOnlyFilePart } from "@/common/utils/attachments/displayOnlyFileParts";
import { AttachFileToolCall } from "@/browser/features/Tools/AttachFileToolCall";
import { lightweightMeta } from "@/browser/stories/meta.js";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/AttachFile",
  component: AttachFileToolCall,
} satisfies Meta<typeof AttachFileToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

const samplePng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const sampleBytes = "ZGlzcGxheS1vbmx5IGZpbGU=";
const longDisplayMediaType = `application/${"x".repeat(160)}`;
const longDownloadMediaType = `image/${"y".repeat(80)}`;

function createAttachFileResult(file: ReturnType<typeof createDisplayOnlyFilePart>) {
  return {
    type: "content",
    value: [
      {
        type: "text",
        text: `[File shown to user: ${file.filename ?? file.mediaType}]`,
      },
      file,
    ],
  };
}

function ToolStoryShell(props: { children: ReactNode }) {
  return (
    <div className="bg-background p-6">
      <div className="w-full max-w-2xl">{props.children}</div>
    </div>
  );
}

function GallerySection(props: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {props.label}
      </div>
      {props.children}
    </section>
  );
}

// Gallery composite: folds the non-interactive "completed" attachment variants
// (image, video, audio, markdown, generic file) into a single snapshot to keep
// the snapshot budget low while preserving every distinct visual state.
export const Gallery: Story = {
  parameters: {
    pixel: {
      // Chromium's native media controls contain an internal loading spinner whose frame is not
      // controlled by page CSS. Mask only those controls; the surrounding attachment UI remains
      // under visual regression coverage.
      mask: [{ selector: "video, audio" }],
    },
  },
  render: () => (
    <ToolStoryShell>
      <div className="flex flex-col gap-6">
        <GallerySection label="Image attachment">
          <AttachFileToolCall
            toolName="attach_file"
            args={{ path: "screenshot.png" }}
            result={{
              type: "content",
              value: [
                { type: "text", text: "[Attachment prepared: screenshot.png]" },
                {
                  type: "media",
                  data: samplePng,
                  mediaType: "image/png",
                  filename: "screenshot.png",
                },
              ],
            }}
            status="completed"
          />
        </GallerySection>
        <GallerySection label="Display-only video">
          <AttachFileToolCall
            toolName="attach_file"
            args={{ path: "recording.webm" }}
            result={createAttachFileResult(
              createDisplayOnlyFilePart({
                data: sampleBytes,
                mediaType: "video/webm",
                filename: "recording.webm",
                size: 17_408,
              })
            )}
            status="completed"
          />
        </GallerySection>
        <GallerySection label="Display-only audio">
          <AttachFileToolCall
            toolName="attach_file"
            args={{ path: "voice-note.mp3" }}
            result={createAttachFileResult(
              createDisplayOnlyFilePart({
                data: sampleBytes,
                mediaType: "audio/mpeg",
                filename: "voice-note.mp3",
                size: 8_192,
              })
            )}
            status="completed"
          />
        </GallerySection>
        <GallerySection label="Display-only markdown">
          <AttachFileToolCall
            toolName="attach_file"
            args={{ path: "release-notes.md" }}
            result={createAttachFileResult(
              createDisplayOnlyFilePart({
                data: "IyBSZWxlYXNlIE5vdGVzCgotIEFkZGVkICoqbWFya2Rvd24qKiBwcmV2aWV3Lgo=",
                mediaType: "text/markdown",
                filename: "release-notes.md",
                size: 47,
              })
            )}
            status="completed"
          />
        </GallerySection>
        <GallerySection label="PDF attachment (download card)">
          <AttachFileToolCall
            toolName="attach_file"
            args={{ path: "quarterly-report.pdf" }}
            result={{
              type: "content",
              value: [
                { type: "text", text: "[Attachment prepared: quarterly-report.pdf]" },
                {
                  type: "media",
                  data: sampleBytes,
                  mediaType: "application/pdf",
                  filename: "quarterly-report.pdf",
                },
              ],
            }}
            status="completed"
          />
        </GallerySection>
        <GallerySection label="Display-only generic file">
          <AttachFileToolCall
            toolName="attach_file"
            args={{ path: "archive.zip", filename: "support-bundle.zip" }}
            result={createAttachFileResult(
              createDisplayOnlyFilePart({
                data: sampleBytes,
                mediaType: "application/octet-stream",
                filename: "support-bundle.zip",
                size: 524_288,
              })
            )}
            status="completed"
          />
        </GallerySection>
      </div>
    </ToolStoryShell>
  ),
};

export const LongMetadataPhone: Story = {
  tags: ["attachment-responsive"],
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: {
    pixel: {
      matrix: { themes: ["dark", "light"], viewports: ["phone"] },
    },
  },
  render: () => (
    <ToolStoryShell>
      <div className="w-[320px] max-w-full">
        <AttachFileToolCall
          toolName="attach_file"
          args={{ path: "notes.bin" }}
          result={{
            type: "content",
            value: [
              { type: "text", text: "[Attachment prepared: narrow metadata]" },
              createDisplayOnlyFilePart({
                data: sampleBytes,
                mediaType: longDisplayMediaType,
                filename: "notes.bin",
                size: 17,
              }),
              {
                type: "media",
                data: sampleBytes,
                mediaType: longDownloadMediaType,
                filename: "diagram.bin",
              },
            ],
          }}
          status="completed"
        />
      </div>
    </ToolStoryShell>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);
    const mediaTypes = await Promise.all([
      canvas.findByText(longDisplayMediaType),
      canvas.findByText(longDownloadMediaType),
    ]);

    await waitFor(() => {
      for (const mediaType of mediaTypes) {
        const card = mediaType.parentElement?.parentElement;
        if (card == null) throw new Error("Attachment card was not rendered");
        if (mediaType.getBoundingClientRect().right > card.getBoundingClientRect().right + 1) {
          throw new Error("Media type overflows the attachment card");
        }
      }
    });
  },
};

// Shared render for the interactive image-menu stories below.
function renderImageAttachment() {
  return (
    <ToolStoryShell>
      <AttachFileToolCall
        toolName="attach_file"
        args={{ path: "screenshot.png" }}
        result={{
          type: "content",
          value: [
            { type: "text", text: "[Attachment prepared: screenshot.png]" },
            {
              type: "media",
              data: samplePng,
              mediaType: "image/png",
              filename: "screenshot.png",
            },
          ],
        }}
        status="completed"
      />
    </ToolStoryShell>
  );
}

// Right-click on an image thumbnail opens a context menu with view/copy/download
// actions. The play function opens the menu so the Pixel snapshot captures it.
export const ImageContextMenu: Story = {
  render: renderImageAttachment,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);
    const image = await canvas.findByRole("img", { name: "screenshot.png" });

    // Fixed coordinates keep the menu position deterministic for snapshots.
    await fireEvent.contextMenu(image, { clientX: 120, clientY: 160 });

    // The menu renders in a portal attached to document.body.
    const body = within(document.body);
    await waitFor(() => body.getByText("Copy image"));
    await waitFor(() => body.getByText("Download image"));
    await waitFor(() => body.getByText("View full size"));
  },
};

// Touch-only contract: a 500ms long-press on the thumbnail opens the same
// context menu. Pixel does not emulate touch (pointer: coarse never matches),
// so this play function exercises the touch path directly per the Storybook
// responsive/Pixel validation rule.
export const ImageLongPressMenu: Story = {
  render: renderImageAttachment,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);
    const image = await canvas.findByRole("img", { name: "screenshot.png" });

    // Start a touch and hold: the long-press timer opens the menu after 500ms.
    // Chromium's TouchEvent constructor requires real Touch instances (plain
    // objects throw). Fixed coordinates keep the menu position deterministic.
    const touch = new Touch({ identifier: 1, target: image, clientX: 120, clientY: 160 });
    await fireEvent.touchStart(image, { touches: [touch], changedTouches: [touch] });

    // The menu renders in a portal attached to document.body. waitFor polls
    // past the 500ms long-press threshold.
    const body = within(document.body);
    await waitFor(() => body.getByText("Copy image"), { timeout: 3000 });

    await fireEvent.touchEnd(image, { changedTouches: [touch] });

    // The click that follows a long-press must be suppressed: the lightbox
    // must not open on top of the context menu. The Radix popover menu itself
    // has role="dialog", so detect the lightbox by its (visually hidden) title.
    await fireEvent.click(image);
    await waitFor(() => {
      if (body.queryByText("Image Preview")) {
        throw new Error("Lightbox should not open after a long-press");
      }
    });
  },
};

// The expanded lightbox offers the same context menu as the thumbnails, on
// both input paths. The play function asserts:
// 1. right-click opens the menu at the cursor (regression contract: the
//    dialog's centering transform used to offset the fixed-position anchor),
// 2. Escape closes only the menu (topmost Radix layer) while the lightbox
//    dialog stays open,
// 3. the touch-only 500ms long-press path opens the menu too (Pixel does not
//    emulate touch, so this must be a play contract).
export const LightboxContextMenu: Story = {
  render: renderImageAttachment,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);
    const thumbnail = await canvas.findByRole("img", { name: "screenshot.png" });
    await fireEvent.click(thumbnail);

    // The lightbox renders in a portal; locate the full-size image inside it
    // via the dialog's (visually hidden) title.
    const body = within(document.body);
    await waitFor(() => body.getByText("Image Preview"));
    const dialog = document.body.querySelector("[role='dialog']");
    if (!(dialog instanceof HTMLElement)) {
      throw new Error("Lightbox dialog not found");
    }
    const fullSizeImage = within(dialog).getByRole("img");

    // Fixed coordinates keep the menu position deterministic for snapshots.
    await fireEvent.contextMenu(fullSizeImage, { clientX: 240, clientY: 200 });
    const menuItem = await waitFor(() => body.getByText("Copy image"));
    await waitFor(() => body.getByText("Download image"));

    // The menu must open at the cursor. Before the virtual-anchor fix, the
    // dialog's translate(-50%,-50%) made the fixed-position anchor resolve
    // against the dialog box, offsetting the menu by hundreds of pixels.
    // 100px tolerance allows for collision flipping while still catching that.
    // Retry inside waitFor: Floating UI positions the content a frame after it
    // mounts (PositionedMenu keeps it hidden until placement settles).
    const menuContent = menuItem.closest("[role='dialog']");
    if (!menuContent) {
      throw new Error("Menu popover content not found");
    }
    await waitFor(() => {
      const menuRect = menuContent.getBoundingClientRect();
      if (Math.abs(menuRect.left - 240) > 100 || Math.abs(menuRect.top - 200) > 100) {
        throw new Error(
          `Context menu misaligned with cursor (240,200): got (${menuRect.left},${menuRect.top})`
        );
      }
    });

    // Escape must close only the menu; the lightbox stays open underneath.
    // Radix attaches its escape listener asynchronously after the menu
    // contents render, so dispatch inside the retry loop — guarded so we never
    // send Escape once the menu is gone (a stray extra Escape would close the
    // lightbox and break the layering assertion below).
    await waitFor(async () => {
      if (body.queryByText("Copy image")) {
        await fireEvent.keyDown(document, { key: "Escape" });
        throw new Error("Context menu should close on Escape");
      }
    });
    await waitFor(() => body.getByText("Image Preview"));

    // Reopen via the touch long-press path (lightbox-specific contract; the
    // thumbnail long-press story never exercises the lightbox wiring) and
    // leave open so the Pixel snapshot captures lightbox + menu.
    // changedTouches must be populated: the Radix dialog mounts
    // react-remove-scroll, whose document-level touch listeners read
    // event.changedTouches[0] and crash on events that omit it.
    const touch = new Touch({ identifier: 1, target: fullSizeImage, clientX: 240, clientY: 200 });
    await fireEvent.touchStart(fullSizeImage, { touches: [touch], changedTouches: [touch] });
    await waitFor(() => body.getByText("Copy image"), { timeout: 3000 });
    await fireEvent.touchEnd(fullSizeImage, { changedTouches: [touch] });
  },
};

export const FailedAttachment: Story = {
  render: () => (
    <ToolStoryShell>
      <AttachFileToolCall
        toolName="attach_file"
        args={{ path: "missing.webm" }}
        result={{ success: false, error: "File not found: /workspace/missing.webm" }}
        status="failed"
      />
    </ToolStoryShell>
  ),
};

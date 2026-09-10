import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { createDisplayOnlyFilePart } from "@/common/utils/attachments/displayOnlyFileParts";
import { DISPLAY_DATA_STUB, MEDIA_DATA_STUB } from "@/common/utils/attachments/toolAttachmentParts";
import { AttachFileToolCall } from "./AttachFileToolCall";

describe("AttachFileToolCall", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalCreateObjectURL: typeof URL.createObjectURL;
  let originalRevokeObjectURL: typeof URL.revokeObjectURL;
  let downloadedBlobs: Blob[];
  let clickedAnchors: HTMLAnchorElement[];

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalCreateObjectURL = URL.createObjectURL.bind(URL);
    originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    // Capture blob downloads (object URL + anchor click) without navigating.
    downloadedBlobs = [];
    clickedAnchors = [];
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      downloadedBlobs.push(blob as Blob);
      return "blob:mock";
    };
    URL.revokeObjectURL = () => undefined;
    const anchorPrototype = (
      globalThis.window as unknown as { HTMLAnchorElement: { prototype: HTMLAnchorElement } }
    ).HTMLAnchorElement.prototype;
    anchorPrototype.click = function (this: HTMLAnchorElement) {
      clickedAnchors.push(this);
    };
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  test("renders display-only markdown files with preview and download", () => {
    const markdown = "# Release Notes\n\n- Added **markdown** preview.\n";
    const data = Buffer.from(markdown).toString("base64");

    const view = render(
      <TooltipProvider>
        <AttachFileToolCall
          toolName="attach_file"
          args={{ path: "release-notes.md" }}
          result={{
            type: "content",
            value: [
              { type: "text", text: "[File shown to user: release-notes.md]" },
              createDisplayOnlyFilePart({
                data,
                mediaType: "text/markdown",
                filename: "release-notes.md",
                size: Buffer.byteLength(markdown),
              }),
            ],
          }}
          status="completed"
        />
      </TooltipProvider>
    );

    expect(view.getByText(/Release Notes/)).toBeTruthy();
    expect(view.getByText(/Added/)).toBeTruthy();
    expect(view.getByText(/Shown to the user only/)).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: /Download/ }));
    expect(clickedAnchors).toHaveLength(1);
    expect(clickedAnchors[0].getAttribute("download")).toBe("release-notes.md");
    // Outside iOS standalone mode the anchor uses the data URL directly, so
    // no Blob/object URL is created.
    expect(downloadedBlobs).toHaveLength(0);
    expect(clickedAnchors[0].getAttribute("href")).toBe(`data:text/markdown;base64,${data}`);
  });

  test("renders audio and video previews without native tooltips", () => {
    const data = Buffer.from("preview-bytes").toString("base64");
    const view = render(
      <TooltipProvider>
        <AttachFileToolCall
          toolName="attach_file"
          args={{ path: "preview.mp4" }}
          result={{
            type: "content",
            value: [
              createDisplayOnlyFilePart({
                data,
                mediaType: "audio/mpeg",
                filename: "sample.mp3",
                size: 13,
              }),
              createDisplayOnlyFilePart({
                data,
                mediaType: "video/mp4",
                filename: "sample.mp4",
                size: 13,
              }),
            ],
          }}
          status="completed"
        />
      </TooltipProvider>
    );

    expect(view.getByText("sample.mp3")).toBeTruthy();
    expect(view.getByText("sample.mp4")).toBeTruthy();
    expect(view.container.querySelector("audio")?.hasAttribute("title")).toBe(false);
    expect(view.container.querySelector("video")?.hasAttribute("title")).toBe(false);
  });

  test("suppresses carried stub attachments (bytes render on the parent carrier card)", () => {
    const view = render(
      <TooltipProvider>
        <AttachFileToolCall
          toolName="attach_file"
          args={{ path: "board.png" }}
          result={{
            type: "content",
            value: [
              { type: "text", text: "[Attachment prepared: board.png]" },
              {
                type: "media",
                data: MEDIA_DATA_STUB,
                mediaType: "image/png",
                filename: "board.png",
              },
              {
                type: "media",
                data: MEDIA_DATA_STUB,
                mediaType: "application/pdf",
                filename: "report.pdf",
              },
              {
                type: "display_file",
                data: DISPLAY_DATA_STUB,
                mediaType: "text/markdown",
                filename: "notes.md",
                providerOptions: { mux: { displayOnly: true, size: 38 } },
              },
            ],
          }}
          status="completed"
        />
      </TooltipProvider>
    );

    // Stubbed parts are duplicates of the parent code_execution carrier
    // render: no image gallery, no broken download card, no preview card.
    expect(view.queryByRole("img")).toBeNull();
    expect(view.queryByRole("button", { name: /Download/ })).toBeNull();
    expect(view.queryByText(/Shown to the user only/)).toBeNull();
  });

  test("renders image attachments with a filename caption", () => {
    const data = Buffer.from("fake-png-bytes").toString("base64");

    const view = render(
      <TooltipProvider>
        <AttachFileToolCall
          toolName="attach_file"
          args={{ path: "screenshot.png" }}
          result={{
            type: "content",
            value: [
              { type: "text", text: "[Attachment prepared: screenshot.png]" },
              { type: "media", data, mediaType: "image/png", filename: "screenshot.png" },
            ],
          }}
          status="completed"
        />
      </TooltipProvider>
    );

    const image = view.getByRole("img", { name: "screenshot.png" });
    expect(image.getAttribute("src")).toBe(`data:image/png;base64,${data}`);
    // Caption is rendered alongside the thumbnail so users can identify the file.
    expect(view.getByText("screenshot.png")).toBeTruthy();
  });

  test("renders a download card for media attachments without an inline preview (PDF)", () => {
    const data = Buffer.from("fake-pdf-bytes").toString("base64");

    const view = render(
      <TooltipProvider>
        <AttachFileToolCall
          toolName="attach_file"
          args={{ path: "report.pdf" }}
          result={{
            type: "content",
            value: [
              { type: "text", text: "[Attachment prepared: report.pdf]" },
              { type: "media", data, mediaType: "application/pdf", filename: "report.pdf" },
            ],
          }}
          status="completed"
        />
      </TooltipProvider>
    );

    // No inline preview for PDFs (not in the raster allowlist)...
    expect(view.queryByRole("img")).toBeNull();
    // ...but the attachment is surfaced as a download card instead of being invisible.
    expect(view.getByText("report.pdf")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: /Download/ }));
    expect(clickedAnchors).toHaveLength(1);
    expect(clickedAnchors[0].getAttribute("download")).toBe("report.pdf");
    expect(downloadedBlobs).toHaveLength(0);
    expect(clickedAnchors[0].getAttribute("href")).toBe(`data:application/pdf;base64,${data}`);
  });
});

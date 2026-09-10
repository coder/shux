import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type React from "react";
import { GlobalWindow } from "happy-dom";
import { dataUrlToBlob, getImageDownloadFilename, handleImageActionKeyDown } from "./imageActions";

describe("dataUrlToBlob", () => {
  it("decodes a valid base64 data URL into a typed blob", async () => {
    const blob = dataUrlToBlob("data:image/png;base64,SGVsbG8=");

    expect(blob).not.toBeNull();
    expect(blob?.type).toBe("image/png");
    expect(await blob?.text()).toBe("Hello");
  });

  it("strips media type parameters", () => {
    const blob = dataUrlToBlob("data:IMAGE/PNG;base64,SGVsbG8=");
    expect(blob?.type).toBe("image/png");
  });

  it("returns null for non-data URLs and non-base64 payloads", () => {
    expect(dataUrlToBlob("https://example.com/image.png")).toBeNull();
    expect(dataUrlToBlob("data:image/png,rawpayload")).toBeNull();
    expect(dataUrlToBlob("data:image/png;base64,not valid base64!!")).toBeNull();
  });
});

describe("getImageDownloadFilename", () => {
  it("prefers the attachment's own filename", () => {
    expect(getImageDownloadFilename("screenshot.png", "image/png")).toBe("screenshot.png");
  });

  it("derives an extension from the media type when no filename exists", () => {
    expect(getImageDownloadFilename(undefined, "image/png")).toBe("image.png");
    expect(getImageDownloadFilename(undefined, "image/webp")).toBe("image.webp");
  });

  it("maps subtypes whose extension differs from the MIME subtype", () => {
    expect(getImageDownloadFilename(undefined, "image/jpeg")).toBe("image.jpg");
    expect(getImageDownloadFilename(undefined, "image/svg+xml")).toBe("image.svg");
  });

  it("normalizes media type casing and parameters", () => {
    expect(getImageDownloadFilename(undefined, "IMAGE/PNG; charset=binary")).toBe("image.png");
  });

  it("falls back to a bare name when no extension can be derived", () => {
    expect(getImageDownloadFilename(undefined, "image")).toBe("image");
    expect(getImageDownloadFilename("", "image/png")).toBe("image.png");
  });
});

describe("handleImageActionKeyDown", () => {
  let originalWindow: typeof globalThis.window;

  beforeEach(() => {
    originalWindow = globalThis.window;
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
  });

  afterEach(() => {
    globalThis.window = originalWindow;
  });

  function createKeyEvent(init: { key: string; ctrlKey?: boolean; metaKey?: boolean }) {
    const preventDefault = mock(() => undefined);
    const event = {
      key: init.key,
      code: undefined,
      ctrlKey: init.ctrlKey ?? false,
      metaKey: init.metaKey ?? false,
      shiftKey: false,
      altKey: false,
      preventDefault,
      stopPropagation: mock(() => undefined),
    } as unknown as React.KeyboardEvent;
    return { event, preventDefault };
  }

  it("consumes mod+C as copy and prevents default", () => {
    const copy = mock(() => undefined);
    const download = mock(() => undefined);
    const { event, preventDefault } = createKeyEvent({ key: "c", ctrlKey: true });

    expect(handleImageActionKeyDown(event, { copy, download })).toBe(true);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(download).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalled();
  });

  it("consumes mod+S as download and prevents the browser save dialog", () => {
    const copy = mock(() => undefined);
    const download = mock(() => undefined);
    const { event, preventDefault } = createKeyEvent({ key: "s", ctrlKey: true });

    expect(handleImageActionKeyDown(event, { copy, download })).toBe(true);
    expect(download).toHaveBeenCalledTimes(1);
    expect(copy).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalled();
  });

  it("ignores unrelated keys and unmodified letters", () => {
    const copy = mock(() => undefined);
    const download = mock(() => undefined);

    expect(handleImageActionKeyDown(createKeyEvent({ key: "c" }).event, { copy, download })).toBe(
      false
    );
    expect(
      handleImageActionKeyDown(createKeyEvent({ key: "x", ctrlKey: true }).event, {
        copy,
        download,
      })
    ).toBe(false);
    expect(copy).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it("defers mod+C to native copy when text is selected", () => {
    // Simulate an active text selection in the document.
    const doc = globalThis.window.document;
    doc.body.textContent = "selectable text";
    const range = doc.createRange();
    range.selectNodeContents(doc.body);
    const selection = globalThis.window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const copy = mock(() => undefined);
    const download = mock(() => undefined);
    const { event, preventDefault } = createKeyEvent({ key: "c", ctrlKey: true });

    expect(handleImageActionKeyDown(event, { copy, download })).toBe(false);
    expect(copy).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

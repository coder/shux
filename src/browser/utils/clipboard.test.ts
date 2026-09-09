import { afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { copyFormattedToClipboard } from "./clipboard";

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalClipboardItem = Object.getOwnPropertyDescriptor(globalThis, "ClipboardItem");

afterEach(() => {
  for (const [key, descriptor] of [
    ["navigator", originalNavigator],
    ["ClipboardItem", originalClipboardItem],
    ["document", originalDocument],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe("copyFormattedToClipboard", () => {
  function setup() {
    const write = mock(() => Promise.resolve());
    const writeText = mock(() => Promise.resolve());
    const payloads: Array<Record<string, Blob>> = [];
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { write, writeText } },
    });
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: class {
        constructor(data: Record<string, Blob>) {
          payloads.push(data);
        }
      },
    });
    return { write, writeText, payloads };
  }

  test("writes Markdown and HTML in the same clipboard item", async () => {
    const { write, writeText, payloads } = setup();
    await copyFormattedToClipboard({ text: "**selected**", html: "<strong>selected</strong>" });
    expect(write).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();
    expect(payloads).toHaveLength(1);
    expect(await payloads[0]["text/plain"].text()).toBe("**selected**");
    expect(await payloads[0]["text/html"].text()).toBe("<strong>selected</strong>");
  });

  test("copies Markdown when rich clipboard support is unavailable", async () => {
    const { write, writeText } = setup();
    Reflect.deleteProperty(globalThis, "ClipboardItem");
    await copyFormattedToClipboard({ text: "**selected**", html: "<strong>selected</strong>" });
    expect(write).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith("**selected**");
  });

  test.each(["constructor", "write"])(
    "falls back after a rich clipboard %s rejection",
    async (stage) => {
      const { write, writeText } = setup();
      if (stage === "write") write.mockRejectedValueOnce(new Error("Permission denied"));
      else
        Object.defineProperty(globalThis, "ClipboardItem", {
          configurable: true,
          value: class {
            constructor() {
              throw new Error("Unsupported MIME type");
            }
          },
        });
      await copyFormattedToClipboard({ text: "**selected**", html: "<strong>selected</strong>" });
      expect(writeText).toHaveBeenCalledWith("**selected**");
    }
  );

  test("propagates a terminal plain-text rejection", async () => {
    const { write, writeText } = setup();
    write.mockRejectedValueOnce(new Error("Rich write failed"));
    writeText.mockRejectedValueOnce(new Error("Plain write failed"));
    const error = await copyFormattedToClipboard({
      text: "selected",
      html: "<p>selected</p>",
    }).catch((error: unknown) => error);
    expect(error).toEqual(new Error("Plain write failed"));
    expect(writeText).toHaveBeenCalledWith("selected");
  });

  test("uses writeText when write is unavailable", async () => {
    const { writeText } = setup();
    Reflect.deleteProperty(navigator.clipboard, "write");
    await copyFormattedToClipboard({ text: "selected", html: "<p>selected</p>" });
    expect(writeText).toHaveBeenCalledWith("selected");
  });

  test.each(["success", "false", "throw"])(
    "legacy fallback reports %s and removes its textarea",
    async (result) => {
      setup();
      Reflect.deleteProperty(navigator, "clipboard");
      const document = new GlobalWindow().document;
      Object.defineProperty(globalThis, "document", { configurable: true, value: document });
      const copy = mock(() => {
        expect(document.querySelector("textarea")?.value).toBe("**selected**");
        if (result === "throw") throw new Error("Legacy copy failed");
        return result === "success";
      });
      Object.defineProperty(document, "execCommand", { configurable: true, value: copy });
      const copying = copyFormattedToClipboard({
        text: "**selected**",
        html: "<strong>selected</strong>",
      });
      if (result === "success") await copying;
      else {
        const error = await copying.catch((error: unknown) => error);
        expect(error).toEqual(
          new Error(result === "throw" ? "Legacy copy failed" : "Clipboard copy failed")
        );
      }
      expect(copy).toHaveBeenCalledWith("copy");
      expect(document.querySelector("textarea")).toBeNull();
    }
  );
});

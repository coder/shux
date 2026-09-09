import { afterEach, describe, expect, mock, test } from "bun:test";
import { copyFormattedToClipboard } from "./clipboard";

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalClipboardItem = Object.getOwnPropertyDescriptor(globalThis, "ClipboardItem");

afterEach(() => {
  for (const [key, descriptor] of [
    ["navigator", originalNavigator],
    ["ClipboardItem", originalClipboardItem],
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

  test("reports a clipboard rejection instead of silently losing formatting", async () => {
    const { write, writeText } = setup();
    write.mockRejectedValueOnce(new Error("Permission denied"));
    const error = await copyFormattedToClipboard({
      text: "selected",
      html: "<p>selected</p>",
    }).catch((error: unknown) => error);
    expect(error).toEqual(new Error("Permission denied"));
    expect(writeText).not.toHaveBeenCalled();
  });
});

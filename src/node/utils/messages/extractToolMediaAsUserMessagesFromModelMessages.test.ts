import { describe, expect, it } from "@jest/globals";
import type { ModelMessage, ToolResultPart } from "ai";
import { convertToModelMessages } from "ai";
import sharp from "sharp";
import type { MuxMessage } from "@/common/types/message";
import {
  MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST,
  MAX_IMAGE_DIMENSION,
} from "@/common/constants/imageAttachments";
import { expectContentOutputValue } from "./testToolOutputHelpers";
import { extractToolMediaAsUserMessages } from "./extractToolMediaAsUserMessages";
import { extractToolMediaAsUserMessagesFromModelMessages } from "./extractToolMediaAsUserMessagesFromModelMessages";

describe("extractToolMediaAsUserMessagesFromModelMessages", () => {
  it("rewrites attach_file image output for prepareStep messages", async () => {
    const base64 = (
      await sharp({
        create: {
          width: 10,
          height: 10,
          channels: 3,
          background: { r: 255, g: 0, b: 0 },
        },
      })
        .png()
        .toBuffer()
    ).toString("base64");
    const attachFileOutput = {
      type: "content",
      value: [
        { type: "text", text: "[Attachment prepared: screenshot.png]" },
        {
          type: "media",
          mediaType: "image/png",
          data: base64,
          filename: "screenshot.png",
        },
      ],
    } as const satisfies { type: "content"; value: unknown[] };

    const input: ModelMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call1",
            toolName: "attach_file",
            output: attachFileOutput as unknown as ToolResultPart["output"],
          },
        ],
      },
    ];

    const rewritten = await extractToolMediaAsUserMessagesFromModelMessages(input);
    expect(rewritten).toHaveLength(3);

    const rewrittenTool = rewritten[1];
    expect(rewrittenTool.role).toBe("tool");

    const toolResultPart = (rewrittenTool as Extract<ModelMessage, { role: "tool" }>).content[0];
    if (toolResultPart.type !== "tool-result") throw new Error("Expected tool-result part");
    const outputText = JSON.stringify(toolResultPart.output);
    expect(outputText).toContain("[Attachment attached:");
    expect(outputText).not.toMatch(/[A]{1000,}/);

    const syntheticUser = rewritten[2];
    expect(syntheticUser.role).toBe("user");
    expect(Array.isArray(syntheticUser.content)).toBe(true);

    const imagePart = Array.isArray(syntheticUser.content)
      ? syntheticUser.content.find((part) => part.type === "image")
      : undefined;

    expect(imagePart).toBeDefined();
    if (imagePart?.type === "image") {
      expect(imagePart.mediaType).toBe("image/png");
      expect(imagePart.image).toBe(base64);
    }
  });

  it("self-heals oversized raster tool attachments for prepareStep messages", async () => {
    const oversizedPng = await sharp({
      create: {
        width: 9001,
        height: 10,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();
    const base64 = oversizedPng.toString("base64");
    const attachFileOutput = {
      type: "content",
      value: [
        { type: "text", text: "[Attachment prepared: oversized.png]" },
        {
          type: "media",
          mediaType: "image/png",
          data: base64,
          filename: "oversized.png",
        },
      ],
    } as const satisfies { type: "content"; value: unknown[] };

    const input: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-resize",
            toolName: "attach_file",
            output: attachFileOutput as unknown as ToolResultPart["output"],
          },
        ],
      },
    ];

    const rewritten = await extractToolMediaAsUserMessagesFromModelMessages(input);
    const syntheticUser = rewritten[1];
    expect(syntheticUser.role).toBe("user");
    const imagePart = Array.isArray(syntheticUser.content)
      ? syntheticUser.content.find((part) => part.type === "image")
      : undefined;

    expect(imagePart).toBeDefined();
    if (imagePart?.type !== "image") {
      throw new Error("Expected a synthetic image part for resized tool attachment");
    }

    expect(imagePart.mediaType).toBe("image/png");
    if (typeof imagePart.image !== "string") {
      throw new Error("Expected a base64 image payload for resized tool attachment");
    }

    const metadata = await sharp(Buffer.from(imagePart.image, "base64")).metadata();
    expect(metadata.width).toBe(MAX_IMAGE_DIMENSION);
    expect(metadata.height).toBe(2);
    expect(imagePart.image).not.toBe(base64);
  });

  it("rewrites attach_file PDF output for prepareStep messages", async () => {
    const base64 = Buffer.from("%PDF-1.7").toString("base64");
    const attachFileOutput = {
      type: "content",
      value: [
        { type: "text", text: "[Attachment prepared: report.pdf]" },
        {
          type: "media",
          mediaType: "application/pdf",
          data: base64,
          filename: "report.pdf",
        },
      ],
    } as const satisfies { type: "content"; value: unknown[] };

    const input: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call2",
            toolName: "attach_file",
            output: attachFileOutput as unknown as ToolResultPart["output"],
          },
        ],
      },
    ];

    const rewritten = await extractToolMediaAsUserMessagesFromModelMessages(input);
    expect(rewritten).toHaveLength(2);

    const syntheticUser = rewritten[1];
    expect(syntheticUser.role).toBe("user");
    const filePart = Array.isArray(syntheticUser.content)
      ? syntheticUser.content.find((part) => part.type === "file")
      : undefined;

    expect(filePart).toBeDefined();
    if (filePart?.type === "file") {
      expect(filePart.mediaType).toBe("application/pdf");
      expect(filePart.filename).toBe("report pdf");
      expect(filePart.data).toBe(base64);
    }
  });

  it("self-heals oversized SVG tool attachments instead of throwing", async () => {
    const oversizedSvg = `<svg>${"a".repeat(50_001)}</svg>`;
    const base64 = Buffer.from(oversizedSvg, "utf8").toString("base64");
    const attachFileOutput = {
      type: "content",
      value: [
        { type: "text", text: "[Attachment prepared: diagram.svg]" },
        {
          type: "media",
          mediaType: "image/svg+xml",
          data: base64,
          filename: "diagram.svg",
        },
      ],
    } as const satisfies { type: "content"; value: unknown[] };

    const input: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call3",
            toolName: "attach_file",
            output: attachFileOutput as unknown as ToolResultPart["output"],
          },
        ],
      },
    ];

    const rewritten = await extractToolMediaAsUserMessagesFromModelMessages(input);
    expect(rewritten).toHaveLength(2);
    const syntheticUser = rewritten[1];
    expect(syntheticUser.role).toBe("user");
    expect(Array.isArray(syntheticUser.content)).toBe(true);
    const svgTextPart = Array.isArray(syntheticUser.content)
      ? syntheticUser.content.find(
          (part) =>
            part.type === "text" &&
            part.text.includes("[SVG attachment omitted from provider request:")
        )
      : undefined;
    expect(svgTextPart).toBeDefined();
  });

  it("strips display-only file bytes without adding a synthetic user message", async () => {
    const base64 = Buffer.from("webm bytes").toString("base64");
    const attachFileOutput = {
      type: "content",
      value: [
        { type: "text", text: "[File shown to user: clip.webm]" },
        {
          type: "display_file",
          mediaType: "video/webm",
          data: base64,
          filename: "clip.webm",
          providerOptions: { mux: { displayOnly: true, size: 10 } },
        },
      ],
    } as const satisfies { type: "content"; value: unknown[] };

    const input: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-display",
            toolName: "attach_file",
            output: attachFileOutput as unknown as ToolResultPart["output"],
          },
        ],
      },
    ];

    const rewritten = await extractToolMediaAsUserMessagesFromModelMessages(input);
    expect(rewritten).toHaveLength(1);

    const rewrittenTool = rewritten[0];
    expect(rewrittenTool.role).toBe("tool");
    const toolResultPart = (rewrittenTool as Extract<ModelMessage, { role: "tool" }>).content[0];
    if (toolResultPart.type !== "tool-result") throw new Error("Expected tool-result part");
    const outputText = JSON.stringify(toolResultPart.output);
    expect(outputText).not.toContain(base64);
    const rewrittenValue = expectContentOutputValue(toolResultPart.output);
    const textParts = rewrittenValue.filter((part) => (part as { type?: unknown }).type === "text");
    expect(textParts).toHaveLength(2);
    expect(JSON.stringify(textParts)).toContain("clip.webm");
    expect(
      rewrittenValue.some((part) => (part as { type?: unknown }).type === "display_file")
    ).toBe(false);
  });

  it("scrubs display-only bytes from code_execution carrier values", async () => {
    const payload = Buffer.from("display-only secret bytes").toString("base64");
    const displayPart = {
      type: "display_file" as const,
      mediaType: "text/markdown",
      data: payload,
      filename: "notes.md",
      providerOptions: { mux: { displayOnly: true as const, size: 25 } },
    };
    const carrierOutput = {
      success: true,
      result: { copied: displayPart },
      toolCalls: [],
      consoleOutput: [],
      duration_ms: 2,
      attachments: [displayPart],
    };
    const input: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-display-carrier",
            toolName: "code_execution",
            output: carrierOutput as unknown as ToolResultPart["output"],
          },
        ],
      },
    ];

    const rewritten = await extractToolMediaAsUserMessagesFromModelMessages(input);
    expect(rewritten).toHaveLength(1);
    expect(JSON.stringify(rewritten)).not.toContain(payload);
    expect(JSON.stringify(rewritten)).toContain("File shown to user only");
    expect(JSON.stringify(input)).toContain(payload);
  });

  it("evicts oldest synthetic tool media instead of omitting a fresh extraction", async () => {
    // r34: history-level extraction can saturate the request-wide cap with
    // synthetic tool media. Those parts must be evictable (oldest-first) so a
    // screenshot produced by the CURRENT tool call still reaches the next
    // step — end-to-end through convertToModelMessages so the marker contract
    // (providerMetadata -> providerOptions) is what's actually validated.
    // PDFs pass through provider preparation unchanged (no raster decode),
    // giving distinct real file parts after conversion.
    const oldPayload = (i: number) =>
      Buffer.from(`old-${String(i).padStart(2, "0")}`).toString("base64");
    const historyInput: MuxMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call-history",
            toolName: "mcp__shots__take",
            input: {},
            state: "output-available",
            output: {
              type: "content",
              value: Array.from({ length: MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST }, (_, i) => ({
                type: "media",
                mediaType: "application/pdf",
                data: oldPayload(i),
              })),
            },
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];
    const historyMessages = await convertToModelMessages(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      (await extractToolMediaAsUserMessages(historyInput)) as any
    );
    const syntheticHistoryMedia = historyMessages
      .flatMap((message): unknown[] => (Array.isArray(message.content) ? message.content : []))
      .filter(
        (part) =>
          (part as { type?: unknown }).type === "file" ||
          (part as { type?: unknown }).type === "image"
      );
    expect(syntheticHistoryMedia).toHaveLength(MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST);

    const stepMessages: ModelMessage[] = [
      ...historyMessages,
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-current",
            toolName: "attach_file",
            output: {
              type: "content",
              value: [
                {
                  type: "media",
                  mediaType: "application/pdf",
                  data: Buffer.from("fresh-shot").toString("base64"),
                },
              ],
            } as unknown as ToolResultPart["output"],
          },
        ],
      },
    ];

    const rewritten = await extractToolMediaAsUserMessagesFromModelMessages(stepMessages);
    const rewrittenJson = JSON.stringify(rewritten);
    // The fresh attachment survives; the OLDEST synthetic part is evicted
    // behind a bounded note, keeping total media at the cap.
    expect(rewrittenJson).toContain(Buffer.from("fresh-shot").toString("base64"));
    expect(rewrittenJson).not.toContain(oldPayload(0));
    expect(rewrittenJson).toContain(oldPayload(1));
    expect(rewrittenJson).toContain("1 extracted media attachment(s) omitted");
    const mediaParts = rewritten
      .flatMap((message): unknown[] => (Array.isArray(message.content) ? message.content : []))
      .filter(
        (part) =>
          (part as { type?: unknown }).type === "file" ||
          (part as { type?: unknown }).type === "image"
      );
    expect(mediaParts).toHaveLength(MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST);
  });

  it("never evicts genuine user uploads at saturation", async () => {
    // Unmarked media (actual user attachments) reserves the allowance: with
    // the cap fully consumed by user uploads, the new extraction is omitted
    // and every upload is preserved untouched (r31 + r34).
    const userUploads = Array.from(
      { length: MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST },
      (_, i) =>
        ({
          type: "file",
          mediaType: "image/png",
          data: `QUJD${i}`,
        }) as const
    );
    const input: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "uploads" }, ...userUploads] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call1",
            toolName: "attach_file",
            output: {
              type: "content",
              value: [
                {
                  type: "media",
                  mediaType: "image/svg+xml",
                  data: Buffer.from(
                    `<svg xmlns="http://www.w3.org/2000/svg"><title>fresh-shot</title></svg>`
                  ).toString("base64"),
                },
              ],
            } as unknown as ToolResultPart["output"],
          },
        ],
      },
    ];

    const rewritten = await extractToolMediaAsUserMessagesFromModelMessages(input);
    // All user uploads intact (same parts, same message).
    const userMessage = rewritten[0];
    expect(Array.isArray(userMessage.content) ? userMessage.content : []).toHaveLength(
      1 + MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST
    );
    const rewrittenJson = JSON.stringify(rewritten);
    expect(rewrittenJson).toContain("1 extracted media attachment(s) omitted");
    expect(rewrittenJson).not.toContain("fresh-shot");
  });

  it("is a no-op when there is no media", async () => {
    const input: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call1",
            toolName: "bash",
            output: { type: "json", value: { stdout: "/tmp" } },
          },
        ],
      },
    ];

    const rewritten = await extractToolMediaAsUserMessagesFromModelMessages(input);
    expect(rewritten).toBe(input);
  });
});

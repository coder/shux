import { describe, expect, it } from "@jest/globals";
import sharp from "sharp";
import {
  MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST,
  MAX_IMAGE_DIMENSION,
} from "@/common/constants/imageAttachments";
import type { MuxMessage } from "@/common/types/message";
import { expectContentOutputValue } from "./testToolOutputHelpers";
import { extractToolMediaAsUserMessages } from "./extractToolMediaAsUserMessages";

describe("extractToolMediaAsUserMessages", () => {
  it("rewrites attach_file image output into a synthetic user file part", async () => {
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

    const input: MuxMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "attach_file",
            input: { path: "fixtures/screenshot.png" },
            state: "output-available",
            output: {
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
            },
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(2);

    const rewrittenAssistant = rewritten[0];
    expect(rewrittenAssistant.role).toBe("assistant");

    const toolPart = rewrittenAssistant.parts[0];
    expect(toolPart.type).toBe("dynamic-tool");
    if (toolPart.type === "dynamic-tool" && toolPart.state === "output-available") {
      const outputText = JSON.stringify(toolPart.output);
      expect(outputText).toContain("[Attachment attached:");
      expect(outputText).not.toMatch(/[A]{1000,}/);
    }

    const syntheticUser = rewritten[1];
    expect(syntheticUser.role).toBe("user");
    expect(syntheticUser.metadata?.synthetic).toBe(true);
    expect(syntheticUser.parts[0]).toEqual({
      type: "text",
      text: "[Attached 1 attachment(s) from tool output]",
    });

    const filePart = syntheticUser.parts.find((part) => part.type === "file");
    expect(filePart).toBeDefined();
    if (filePart?.type === "file") {
      expect(filePart.mediaType).toBe("image/png");
      expect(filePart.filename).toBe("screenshot.png");
      expect(filePart.url.startsWith("data:image/png;base64,")).toBe(true);
      expect(filePart.url).toContain(base64.slice(0, 100));
    }
  });

  it("extracts media from nested bridged tool records inside code_execution output", async () => {
    // Exclusive PTC: bridged MCP tools run nested inside code_execution and
    // their full results land in the classic record's toolCalls. Media there
    // must become a model-visible attachment (with a placeholder in the
    // record) instead of riding as raw base64 JSON text.
    const base64 = (
      await sharp({
        create: {
          width: 10,
          height: 10,
          channels: 3,
          background: { r: 0, g: 0, b: 255 },
        },
      })
        .png()
        .toBuffer()
    ).toString("base64");

    const input: MuxMessage[] = [
      {
        id: "ce1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "code_execution",
            input: { code: "return xum.mcp__shots__take({});" },
            state: "output-available",
            output: {
              success: true,
              toolCalls: [
                {
                  toolName: "mcp__shots__take",
                  args: {},
                  result: {
                    type: "content",
                    value: [
                      { type: "text", text: "took a screenshot" },
                      { type: "media", mediaType: "image/png", data: base64 },
                    ],
                  },
                },
                // Kernel-compacted / error records carry no extractable result.
                { toolName: "bash", args: { script: "true" }, ok: true, bytes: 4 },
              ],
            },
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(2);

    const toolPart = rewritten[0].parts[0];
    if (toolPart.type !== "dynamic-tool" || toolPart.state !== "output-available") {
      throw new Error("Expected an output-available dynamic-tool part");
    }
    const outputText = JSON.stringify(toolPart.output);
    expect(outputText).toContain("[Attachment attached:");
    expect(outputText).not.toContain(base64);
    // Untouched sibling records survive the rewrite.
    expect(outputText).toContain('"bytes":4');

    const syntheticUser = rewritten[1];
    expect(syntheticUser.role).toBe("user");
    const filePart = syntheticUser.parts.find((part) => part.type === "file");
    if (filePart?.type !== "file") {
      throw new Error("Expected a synthetic file part for nested tool media");
    }
    expect(filePart.mediaType).toBe("image/png");
    expect(filePart.url).toContain(base64.slice(0, 100));
  });

  it("dedupes media returned from code_execution (record + outer result carry the same payload)", async () => {
    // `return xum.<mediaTool>(...)` duplicates the media container in the
    // nested record AND the outer result; both copies must be replaced, and
    // the model should receive a single attachment.
    const base64 = (
      await sharp({
        create: {
          width: 10,
          height: 10,
          channels: 3,
          background: { r: 0, g: 255, b: 0 },
        },
      })
        .png()
        .toBuffer()
    ).toString("base64");

    const mediaContainer = {
      type: "content",
      value: [{ type: "media", mediaType: "image/png", data: base64 }],
    };
    const input: MuxMessage[] = [
      {
        id: "ce2",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "code_execution",
            input: { code: "return xum.mcp__shots__take({});" },
            state: "output-available",
            output: {
              success: true,
              result: mediaContainer,
              toolCalls: [{ toolName: "mcp__shots__take", args: {}, result: mediaContainer }],
            },
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(2);

    const toolPart = rewritten[0].parts[0];
    if (toolPart.type !== "dynamic-tool" || toolPart.state !== "output-available") {
      throw new Error("Expected an output-available dynamic-tool part");
    }
    // Both copies replaced — no base64 rides as JSON text anywhere.
    expect(JSON.stringify(toolPart.output)).not.toContain(base64);

    const syntheticUser = rewritten[1];
    const fileParts = syntheticUser.parts.filter((part) => part.type === "file");
    expect(fileParts).toHaveLength(1);
    expect(syntheticUser.parts[0]).toEqual({
      type: "text",
      text: "[Attached 1 attachment(s) from tool output]",
    });
  });

  it("rewrites media containers wrapped inside outer results and console args", async () => {
    // `return { image: xum.mcp(...) }` wraps the container in a plain object:
    // capture-time sanitization intentionally retains supported containers
    // under its budget, so the provider copy must deep-walk arbitrary
    // wrappers — a root-only outer check would ship the screenshot as BOTH an
    // attachment (from the nested record) and raw JSON on every later
    // request (round 15).
    const base64 = (
      await sharp({
        create: {
          width: 10,
          height: 10,
          channels: 3,
          background: { r: 0, g: 0, b: 255 },
        },
      })
        .png()
        .toBuffer()
    ).toString("base64");

    const mediaContainer = {
      type: "content",
      value: [{ type: "media", mediaType: "image/png", data: base64 }],
    };
    const input: MuxMessage[] = [
      {
        id: "ce-wrapped",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "code_execution",
            input: { code: "const r = xum.mcp__shots__take({}); return { image: r };" },
            state: "output-available",
            output: {
              success: true,
              result: { image: mediaContainer, note: "kept" },
              toolCalls: [{ toolName: "mcp__shots__take", args: {}, result: mediaContainer }],
              consoleOutput: [{ level: "log", args: [{ wrapped: mediaContainer }], timestamp: 1 }],
              // Sibling field beside the toolCalls-shaped structure: the
              // nested rewrite must walk it too, not return early (round 16
              // security straggler).
              sibling: { stashed: mediaContainer },
            },
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(2);

    const toolPart = rewritten[0].parts[0];
    if (toolPart.type !== "dynamic-tool" || toolPart.state !== "output-available") {
      throw new Error("Expected an output-available dynamic-tool part");
    }
    const outputText = JSON.stringify(toolPart.output);
    // All four copies (record, wrapped outer result, wrapped console arg,
    // sibling field) are replaced; non-media wrapper fields survive.
    expect(outputText).not.toContain(base64);
    expect(outputText).toContain('"note":"kept"');
    expect(outputText).toContain('"stashed"');

    // Identical media across all copies dedupes into ONE attachment.
    const syntheticUser = rewritten[1];
    const fileParts = syntheticUser.parts.filter((part) => part.type === "file");
    expect(fileParts).toHaveLength(1);
  });

  it("redacts media containers copied into code_execution console output", async () => {
    // `const image = xum.<mediaTool>(...); console.log(image)` copies the
    // container into consoleOutput args (classic console budget ~1MiB);
    // request-time extraction must rewrite that copy too and dedupe it
    // against the record's attachment.
    const base64 = (
      await sharp({
        create: { width: 10, height: 10, channels: 3, background: { r: 1, g: 2, b: 3 } },
      })
        .png()
        .toBuffer()
    ).toString("base64");
    const mediaContainer = {
      type: "content",
      value: [{ type: "media", mediaType: "image/png", data: base64 }],
    };

    const input: MuxMessage[] = [
      {
        id: "ce-console",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "code_execution",
            input: { code: "const image = xum.mcp__shots__take({}); console.log(image);" },
            state: "output-available",
            output: {
              success: true,
              toolCalls: [{ toolName: "mcp__shots__take", args: {}, result: mediaContainer }],
              consoleOutput: [{ level: "log", args: [mediaContainer], timestamp: 1 }],
            },
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(2);

    const toolPart = rewritten[0].parts[0];
    if (toolPart.type !== "dynamic-tool" || toolPart.state !== "output-available") {
      throw new Error("Expected an output-available dynamic-tool part");
    }
    expect(JSON.stringify(toolPart.output)).not.toContain(base64);

    // Record copy + console copy dedupe into a single attachment.
    const syntheticUser = rewritten[1];
    const fileParts = syntheticUser.parts.filter((part) => part.type === "file");
    expect(fileParts).toHaveLength(1);
  });

  it("replaces unsupported media (audio/blobs) with bounded placeholders", async () => {
    // Unsupported media can be MiBs of base64 the model can never consume as
    // an attachment; it must never ride into the provider request as JSON
    // text (top-level here; nested records share the same helper).
    const imageBase64 = (
      await sharp({
        create: { width: 10, height: 10, channels: 3, background: { r: 9, g: 9, b: 9 } },
      })
        .png()
        .toBuffer()
    ).toString("base64");
    const audioBase64 = Buffer.from("wav bytes".repeat(100)).toString("base64");

    const input: MuxMessage[] = [
      {
        id: "a-audio",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "mcp__rec__capture",
            input: {},
            state: "output-available",
            output: {
              type: "content",
              value: [
                { type: "media", mediaType: "image/png", data: imageBase64 },
                { type: "media", mediaType: "audio/wav", data: audioBase64 },
              ],
            },
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    const toolPart = rewritten[0].parts[0];
    if (toolPart.type !== "dynamic-tool" || toolPart.state !== "output-available") {
      throw new Error("Expected an output-available dynamic-tool part");
    }
    const outputText = JSON.stringify(toolPart.output);
    expect(outputText).not.toContain(audioBase64);
    expect(outputText).toContain("[Media omitted from provider request: audio/wav");

    // The supported image still becomes the single synthetic attachment.
    const syntheticUser = rewritten[1];
    const fileParts = syntheticUser.parts.filter((part) => part.type === "file");
    expect(fileParts).toHaveLength(1);
  });

  it("bounds junk media-type and filename metadata in provider-visible placeholders", async () => {
    // MCP servers copy MIME/filename metadata verbatim; a persisted part
    // carrying megabytes there must not be re-interpolated into placeholder
    // text on every later request (round 11). The junk type also fails
    // isSupportedAttachmentMediaType (well-formed + length validation), so it
    // can never become a supported attachment either.
    const junkType = `image/${"m".repeat(500_000)}`;
    const junkName = `${"n".repeat(500_000)}.png`;

    const input: MuxMessage[] = [
      {
        id: "a-junk-meta",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "mcp__shots__take",
            input: {},
            state: "output-available",
            output: {
              type: "content",
              value: [
                { type: "media", mediaType: junkType, data: "aGVsbG8=" },
                { type: "media", mediaType: "audio/wav", data: "d2F2", filename: junkName },
                {
                  type: "display_file",
                  mediaType: junkType,
                  data: "dGV4dA==",
                  filename: "notes.md",
                },
              ],
            },
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    const toolPart = rewritten[0].parts[0];
    if (toolPart.type !== "dynamic-tool" || toolPart.state !== "output-available") {
      throw new Error("Expected an output-available dynamic-tool part");
    }
    const outputText = JSON.stringify(toolPart.output);
    // Both parts degrade to placeholders with BOUNDED labels: the junk
    // metadata strings must not survive into the provider copy.
    expect(outputText.length).toBeLessThan(2_000);
    expect(outputText).toContain("[Media omitted from provider request:");
    // No synthetic attachment is created from the junk-typed part.
    expect(rewritten).toHaveLength(1);
  });

  it("replaces corrupt deeply-nested tool records with a bounded placeholder instead of overflowing the stack", async () => {
    // History rows are untrusted persisted JSON (self-healing rule): a
    // syntactically valid row nesting {toolCalls:[{result: …}]} deep enough
    // would otherwise stack-overflow while preparing provider messages — and
    // extraction runs on EVERY request, so one corrupt row would brick the
    // workspace. The over-deep subtree must also be REPLACED, not retained:
    // a payload hiding at the leaf would otherwise keep shipping as raw JSON
    // on every later request (round 13).
    const leafPayload = "aGlkZGVu".repeat(100);
    let deep: Record<string, unknown> = {
      toolCalls: [],
      result: {
        type: "content",
        value: [{ type: "media", mediaType: "image/png", data: leafPayload }],
      },
    };
    for (let i = 0; i < 50_000; i++) {
      deep = { toolCalls: [{ toolName: "bash", result: deep }] };
    }

    const input: MuxMessage[] = [
      {
        id: "a-deep",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "code_execution",
            input: { code: "..." },
            state: "output-available",
            output: deep,
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    // No throw and no synthetic attachment from the buried payload.
    expect(rewritten).toHaveLength(1);
    const toolPart = rewritten[0].parts[0];
    if (toolPart.type !== "dynamic-tool" || toolPart.state !== "output-available") {
      throw new Error("Expected an output-available dynamic-tool part");
    }
    const outputText = JSON.stringify(toolPart.output);
    expect(outputText).toContain("nested tool-record depth limit exceeded");
    expect(outputText).not.toContain(leafPayload);
  });

  it("leaves media-free deep JSON outputs untouched", async () => {
    // The wrapper walk visits arbitrary objects; legitimate deep JSON with no
    // media or tool-record shapes must pass through unchanged — only
    // tool-output-shaped chains earn the over-depth placeholder (round 16).
    let deep: Record<string, unknown> = { leaf: "value" };
    for (let i = 0; i < 200; i++) {
      deep = { next: deep };
    }

    const input: MuxMessage[] = [
      {
        id: "a-deep-json",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "mcp__api__query",
            input: {},
            state: "output-available",
            output: deep,
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(1);
    const toolPart = rewritten[0].parts[0];
    if (toolPart.type !== "dynamic-tool" || toolPart.state !== "output-available") {
      throw new Error("Expected an output-available dynamic-tool part");
    }
    expect(toolPart.output).toBe(deep);
  });

  it("redacts media containers passed as nested tool-call args", async () => {
    // Sandbox code can pass a bridged media result into another tool
    // ({payload: image}); classic capture retains the args copy under the
    // shared budget, so request-time extraction must rewrite it like result
    // media (r22).
    const base64 = (
      await sharp({
        create: { width: 10, height: 10, channels: 3, background: { r: 3, g: 1, b: 4 } },
      })
        .png()
        .toBuffer()
    ).toString("base64");
    const mediaContainer = {
      type: "content",
      value: [{ type: "media", mediaType: "image/png", data: base64 }],
    };

    const input: MuxMessage[] = [
      {
        id: "ce-args",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "code_execution",
            input: { code: "mux.mcp__sink__send({payload: img});" },
            state: "output-available",
            output: {
              success: true,
              result: null,
              toolCalls: [
                {
                  toolName: "mcp__sink__send",
                  args: { payload: mediaContainer, note: "kept" },
                  result: { ok: true },
                },
              ],
            },
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(2);
    const toolPart = rewritten[0].parts[0];
    if (toolPart.type !== "dynamic-tool" || toolPart.state !== "output-available") {
      throw new Error("Expected an output-available dynamic-tool part");
    }
    const outputText = JSON.stringify(toolPart.output);
    expect(outputText).not.toContain(base64);
    expect(outputText).toContain('"note":"kept"');
    const fileParts = rewritten[1].parts.filter((part) => part.type === "file");
    expect(fileParts).toHaveLength(1);
  });

  it("drops non-string filename metadata instead of throwing during extraction", async () => {
    // filename: 123 passes leaf recognition (optional metadata is ignored),
    // and .trim() on it would throw while preparing EVERY later provider
    // request — one malformed persisted row must not brick the workspace
    // (r25, self-healing rule).
    const base64 = (
      await sharp({
        create: { width: 10, height: 10, channels: 3, background: { r: 8, g: 8, b: 8 } },
      })
        .png()
        .toBuffer()
    ).toString("base64");

    const input: MuxMessage[] = [
      {
        id: "ce-numname",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "mcp__shots__take",
            input: {},
            state: "output-available",
            output: {
              type: "content",
              value: [{ type: "media", mediaType: "image/png", data: base64, filename: 123 }],
            },
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(2);
    const outputText = JSON.stringify((rewritten[0].parts[0] as { output?: unknown }).output);
    expect(outputText).not.toContain(base64);
    const fileParts = rewritten[1].parts.filter((part) => part.type === "file");
    expect(fileParts).toHaveLength(1);
    // The malformed filename is dropped, not sent.
    expect(fileParts[0]).not.toHaveProperty("filename", 123);
  });

  it("extracts media leaves whose optional metadata is malformed", async () => {
    // Capture recognition ignores optional metadata (asMediaPart), so a
    // retained leaf with filename:null must not be rejected by a stricter
    // request-time predicate — that would leave the retained base64 in
    // provider JSON (r24). The malformed filename is dropped, not sent.
    const base64 = (
      await sharp({
        create: { width: 10, height: 10, channels: 3, background: { r: 5, g: 5, b: 5 } },
      })
        .png()
        .toBuffer()
    ).toString("base64");

    const input: MuxMessage[] = [
      {
        id: "ce-nullname",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "code_execution",
            input: { code: "..." },
            state: "output-available",
            output: {
              success: true,
              result: {
                wrapped: { type: "media", mediaType: "image/png", data: base64, filename: null },
              },
              toolCalls: [],
            },
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(2);
    const outputText = JSON.stringify(
      (rewritten[0].parts[0] as { output?: unknown }).output ?? rewritten[0].parts[0]
    );
    expect(outputText).not.toContain(base64);
    const fileParts = rewritten[1].parts.filter((part) => part.type === "file");
    expect(fileParts).toHaveLength(1);
  });

  it("redacts standalone media leaves plucked out of containers", async () => {
    // `const part = image.value[0]; mux.sink({payload: part})` copies a BARE
    // media part (no surrounding container) into args; capture retains it
    // under the shared budget, so extraction must rewrite the leaf too (r23).
    const base64 = (
      await sharp({
        create: { width: 10, height: 10, channels: 3, background: { r: 9, g: 9, b: 9 } },
      })
        .png()
        .toBuffer()
    ).toString("base64");

    const input: MuxMessage[] = [
      {
        id: "ce-leaf",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "code_execution",
            input: { code: "mux.mcp__sink__send({payload: img.value[0]});" },
            state: "output-available",
            output: {
              success: true,
              // Bare leaf in the outer result too.
              result: { type: "media", mediaType: "image/png", data: base64 },
              toolCalls: [
                {
                  toolName: "mcp__sink__send",
                  args: { payload: { type: "media", mediaType: "image/png", data: base64 } },
                  result: { ok: true },
                },
              ],
            },
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(2);
    const toolPart = rewritten[0].parts[0];
    if (toolPart.type !== "dynamic-tool" || toolPart.state !== "output-available") {
      throw new Error("Expected an output-available dynamic-tool part");
    }
    const outputText = JSON.stringify(toolPart.output);
    expect(outputText).not.toContain(base64);
    // The dedup leaves 2 placeholders for 1 emitted attachment, so the
    // excess coalesces into one bounded summary (r31).
    expect(outputText).toContain("2 attachments attached from tool output");
    // Identical leaf in args and outer result dedupes into ONE attachment.
    const fileParts = rewritten[1].parts.filter((part) => part.type === "file");
    expect(fileParts).toHaveLength(1);
  });

  it("extracts media containers nested inside non-media content parts", async () => {
    // A content container can hold a custom non-media part that itself wraps
    // another media container. Capture retains such parts whole while within
    // the aggregate budget, so request-time extraction must traverse them —
    // otherwise the nested base64 rides as raw JSON in every later provider
    // request (r18 retry).
    const makeBase64 = async (r: number) =>
      (
        await sharp({
          create: { width: 10, height: 10, channels: 3, background: { r, g: 0, b: 0 } },
        })
          .png()
          .toBuffer()
      ).toString("base64");
    const directBase64 = await makeBase64(10);
    const nestedBase64 = await makeBase64(200);

    const input: MuxMessage[] = [
      {
        id: "a-nested-part",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "mcp__shots__take",
            input: {},
            state: "output-available",
            output: {
              type: "content",
              value: [
                { type: "media", mediaType: "image/png", data: directBase64 },
                {
                  type: "custom",
                  payload: {
                    inner: {
                      type: "content",
                      value: [{ type: "media", mediaType: "image/png", data: nestedBase64 }],
                    },
                    note: "kept",
                  },
                },
              ],
            },
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(2);
    const toolPart = rewritten[0].parts[0];
    if (toolPart.type !== "dynamic-tool" || toolPart.state !== "output-available") {
      throw new Error("Expected an output-available dynamic-tool part");
    }
    const outputText = JSON.stringify(toolPart.output);
    // Both the immediate media part AND the container nested inside the
    // custom part are rewritten; non-media custom fields survive.
    expect(outputText).not.toContain(directBase64);
    expect(outputText).not.toContain(nestedBase64);
    expect(outputText).toContain('"note":"kept"');

    const syntheticUser = rewritten[1];
    const fileParts = syntheticUser.parts.filter((part) => part.type === "file");
    expect(fileParts).toHaveLength(2);
  });

  it("extracts media buried under deep generic wrapper chains", async () => {
    // Capture-time sanitization retains supported containers under its budget
    // regardless of wrapper depth, so the request-time scan must not abandon
    // deep generic spans: a container hidden below more plain wrappers than a
    // recursive depth budget allows would otherwise ship raw base64 in every
    // provider request (round 17).
    const base64 = (
      await sharp({
        create: { width: 10, height: 10, channels: 3, background: { r: 7, g: 8, b: 9 } },
      })
        .png()
        .toBuffer()
    ).toString("base64");

    let deep: Record<string, unknown> = {
      image: {
        type: "content",
        value: [{ type: "media", mediaType: "image/png", data: base64 }],
      },
      leaf: "kept",
    };
    for (let i = 0; i < 200; i++) {
      deep = { next: deep };
    }

    const input: MuxMessage[] = [
      {
        id: "a-deep-media",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "code_execution",
            input: { code: "..." },
            state: "output-available",
            output: deep,
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(2);
    const toolPart = rewritten[0].parts[0];
    if (toolPart.type !== "dynamic-tool" || toolPart.state !== "output-available") {
      throw new Error("Expected an output-available dynamic-tool part");
    }
    const outputText = JSON.stringify(toolPart.output);
    // The buried container is rewritten to a placeholder while the media-free
    // wrapper structure survives untouched.
    expect(outputText).not.toContain(base64);
    expect(outputText).toContain("[Attachment attached:");
    expect(outputText).toContain('"leaf":"kept"');

    const syntheticUser = rewritten[1];
    const fileParts = syntheticUser.parts.filter((part) => part.type === "file");
    expect(fileParts).toHaveLength(1);
  });

  it("self-heals oversized raster tool attachments by downscaling them for provider requests", async () => {
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

    const input: MuxMessage[] = [
      {
        id: "a1-resize",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "attach_file",
            input: { path: "fixtures/oversized.png" },
            state: "output-available",
            output: {
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
            },
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    const syntheticUser = rewritten[1];
    const filePart = syntheticUser.parts.find((part) => part.type === "file");
    expect(filePart).toBeDefined();
    if (filePart?.type !== "file") {
      throw new Error("Expected a synthetic file part for resized tool attachment");
    }

    expect(filePart.mediaType).toBe("image/png");
    const resizedBase64 = filePart.url.replace(/^data:image\/png;base64,/, "");
    const metadata = await sharp(Buffer.from(resizedBase64, "base64")).metadata();
    expect(metadata.width).toBe(MAX_IMAGE_DIMENSION);
    expect(metadata.height).toBe(2);
    expect(resizedBase64).not.toBe(base64);
  });

  it("caps extracted media parts per request and keeps the newest attachments", async () => {
    // Capture bounds bytes and per-container parts, not distinct records: a
    // looped media tool could otherwise fan out tens of thousands of
    // synthetic provider parts re-processed by every request (r28 security).
    // Overflow is omitted OLDEST-first so the model keeps its latest
    // screenshots, replaced by one bounded placeholder.
    const svg = (marker: string) =>
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg"><title>${marker}</title></svg>`
      ).toString("base64");
    const total = MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST + 2;
    const value = Array.from({ length: total }, (_, i) => ({
      type: "media",
      mediaType: "image/svg+xml",
      data: svg(`marker-${String(i).padStart(2, "0")}`),
    }));
    const input: MuxMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "mcp__shots__take",
            input: {},
            state: "output-available",
            output: { type: "content", value },
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(2);
    const synthetic = rewritten[1];
    expect(synthetic.role).toBe("user");
    // 1 summary + capped inlined attachments + 1 omission placeholder.
    expect(synthetic.parts).toHaveLength(2 + MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST);
    const text = JSON.stringify(synthetic.parts);
    expect(text).toContain(`[Attached ${total} attachment(s) from tool output]`);
    expect(text).toContain("2 extracted media attachment(s) omitted");
    expect(text).not.toContain("marker-00");
    expect(text).not.toContain("marker-01");
    expect(text).toContain("marker-02");
    expect(text).toContain(`marker-${total - 1}`);

    // The rewritten TOOL OUTPUT coalesces the per-item placeholders too (r29
    // security): a flooded transcript would otherwise keep tens of thousands
    // of `[Attachment attached…]` parts — megabytes of provider JSON — even
    // after the attachment cap.
    const toolPart = rewritten[0].parts[0];
    expect(toolPart.type).toBe("dynamic-tool");
    if (toolPart.type === "dynamic-tool" && toolPart.state === "output-available") {
      const outputValue = (toolPart.output as { value?: unknown[] }).value;
      expect(outputValue).toHaveLength(1);
      const coalesced = outputValue?.[0] as { type?: string; text?: string };
      expect(coalesced.type).toBe("text");
      expect(coalesced.text).toContain(`${total} attachments attached from tool output`);
    }
  });

  it("coalesces omitted placeholders across separate nested records", async () => {
    // One small image per bridged call leaves a SINGLETON placeholder in each
    // record's value array — run-based coalescing would keep every one, so
    // thousands of looped records would still carry megabytes of placeholder
    // JSON after the attachment cap (r30). Coalescing is global across the
    // whole tool output.
    const svg = (i: number) =>
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg"><title>rec-${String(i).padStart(2, "0")}</title></svg>`
      ).toString("base64");
    const total = MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST + 2;
    const toolCalls = Array.from({ length: total }, (_, i) => ({
      toolName: "mcp__shots__take",
      args: {},
      result: {
        type: "content",
        value: [{ type: "media", mediaType: "image/svg+xml", data: svg(i) }],
      },
    }));
    const input: MuxMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "code_execution",
            input: { code: "..." },
            state: "output-available",
            output: { success: true, toolCalls },
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(2);
    const toolPart = rewritten[0].parts[0];
    expect(toolPart.type).toBe("dynamic-tool");
    if (toolPart.type === "dynamic-tool" && toolPart.state === "output-available") {
      const outputJson = JSON.stringify(toolPart.output);
      // No per-record singleton placeholders survive; one bounded summary does.
      expect(outputJson).not.toContain("[Attachment attached");
      expect(outputJson.split("placeholders coalesced").length - 1).toBe(1);
      expect(outputJson).toContain(`${total} attachments attached from tool output`);
    }
    // Newest attachments still ride in the synthetic message; the two oldest
    // were omitted by the request-wide cap.
    const syntheticJson = JSON.stringify(rewritten[1].parts);
    expect(syntheticJson).toContain("rec-02");
    expect(syntheticJson).toContain(`rec-${total - 1}`);
    expect(syntheticJson).not.toContain("rec-00");
    expect(syntheticJson).not.toContain("rec-01");
  });

  it("coalesces placeholders when dedup leaves excess without any cap omission", async () => {
    // pushUnique collapses repeated payloads into ONE attachment while every
    // occurrence still leaves a placeholder: with omission at zero, the
    // omitted-count trigger alone would keep every per-item placeholder in
    // provider JSON (r31). Coalescing keys off placeholder count vs emitted
    // attachments instead.
    const svgData = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><title>dedup-marker</title></svg>'
    ).toString("base64");
    const toolCalls = Array.from({ length: 5 }, () => ({
      toolName: "mcp__shots__take",
      args: {},
      result: {
        type: "content",
        value: [{ type: "media", mediaType: "image/svg+xml", data: svgData }],
      },
    }));
    const input: MuxMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "code_execution",
            input: { code: "..." },
            state: "output-available",
            output: { success: true, toolCalls },
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    const toolPart = rewritten[0].parts[0];
    expect(toolPart.type).toBe("dynamic-tool");
    if (toolPart.type === "dynamic-tool" && toolPart.state === "output-available") {
      const outputJson = JSON.stringify(toolPart.output);
      expect(outputJson).not.toContain("[Attachment attached");
      expect(outputJson).toContain("5 attachments attached from tool output");
    }
    // Dedup emitted exactly one attachment.
    const syntheticJson = JSON.stringify(rewritten[1].parts);
    expect(syntheticJson).toContain("[Attached 1 attachment(s) from tool output]");
    expect(syntheticJson.split("dedup-marker").length - 1).toBe(1);
  });

  it("coalesces placeholder floods below deep generic wrappers", async () => {
    // Extraction rewrites media at ANY wrapper depth (its wrapper walk is
    // iterative), so the coalescer must be unbounded too (r32 security): a
    // depth-capped counter saw no placeholders below 64 generic wrappers and
    // left a multi-hundred-KB placeholder flood intact in provider JSON.
    const svg = (i: number) =>
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg"><title>deep-${String(i).padStart(2, "0")}</title></svg>`
      ).toString("base64");
    const total = MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST + 2;
    const leaves = Array.from({ length: total }, (_, i) => ({
      type: "media",
      mediaType: "image/svg+xml",
      data: svg(i),
    }));
    let deep: unknown = { leaves };
    for (let i = 0; i < 70; i++) deep = { wrap: deep };
    const input: MuxMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "mcp__shots__take",
            input: {},
            state: "output-available",
            output: deep,
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(2);
    const toolPart = rewritten[0].parts[0];
    expect(toolPart.type).toBe("dynamic-tool");
    if (toolPart.type === "dynamic-tool" && toolPart.state === "output-available") {
      const outputJson = JSON.stringify(toolPart.output);
      expect(outputJson).not.toContain("[Attachment attached");
      expect(outputJson).toContain(`${total} attachments attached from tool output`);
    }
    // The newest attachments survive the cap; the two oldest were omitted.
    const syntheticJson = JSON.stringify(rewritten[1].parts);
    expect(syntheticJson).toContain("2 extracted media attachment(s) omitted");
    expect(syntheticJson).not.toContain("deep-00");
    expect(syntheticJson).toContain(`deep-${total - 1}`);
  });

  it("counts existing conversation media parts against the extraction allowance", async () => {
    // messagePipeline runs this transform after ordinary attachments are
    // already in the request, and providers cap TOTAL media parts: existing
    // images must consume the extraction allowance or 50 user images plus a
    // full 64-part extraction would exceed a ~100-image provider limit (r31).
    const svg = (i: number) =>
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg"><title>marker-${String(i).padStart(2, "0")}</title></svg>`
      ).toString("base64");
    const existingFileParts = Array.from(
      { length: MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST - 1 },
      (_, i) =>
        ({
          type: "file",
          mediaType: "image/png",
          url: `data:image/png;base64,QUJD${i}`,
        }) as const
    );
    const input: MuxMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "attached images" }, ...existingFileParts],
        metadata: { timestamp: 1 },
      },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "mcp__shots__take",
            input: {},
            state: "output-available",
            output: {
              type: "content",
              value: [0, 1, 2].map((i) => ({
                type: "media",
                mediaType: "image/svg+xml",
                data: svg(i),
              })),
            },
          },
        ],
        metadata: { timestamp: 2 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(3);
    const syntheticJson = JSON.stringify(rewritten[2].parts);
    // Allowance is 1 (cap minus existing parts): the two oldest extracted
    // attachments are omitted, the newest survives.
    expect(syntheticJson).toContain("2 extracted media attachment(s) omitted");
    expect(syntheticJson).not.toContain("marker-00");
    expect(syntheticJson).not.toContain("marker-01");
    expect(syntheticJson).toContain("marker-02");
  });

  it("keeps over-depth replacements schema-valid inside content containers", async () => {
    // The over-depth replacement is a bare string; inserted raw into a
    // content container's value array it would make the container malformed
    // (AI SDK content entries must be typed parts) and fail model-message
    // conversion on every later request (r29).
    let deepItem: unknown = { note: "leaf" };
    for (let i = 0; i < 70; i++) deepItem = { type: "json", value: deepItem };
    let output: unknown = {
      type: "content",
      value: [
        deepItem,
        { type: "media", mediaType: "image/png", data: "aGVsbG8=", filename: "shot.png" },
      ],
    };
    for (let i = 0; i < 64; i++) output = { type: "json", value: output };

    const input: MuxMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "mcp__shots__take",
            input: {},
            state: "output-available",
            output,
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(2);
    const toolPart = rewritten[0].parts[0];
    expect(toolPart.type).toBe("dynamic-tool");
    if (toolPart.type === "dynamic-tool" && toolPart.state === "output-available") {
      // Unwrap the 64 json layers back to the content container.
      let current: unknown = toolPart.output;
      for (let i = 0; i < 64; i++) {
        current = (current as { value: unknown }).value;
      }
      const container = current as { type?: string; value?: unknown[] };
      expect(container.type).toBe("content");
      for (const entry of container.value ?? []) {
        expect(typeof entry).toBe("object");
        expect(typeof (entry as { type?: unknown }).type).toBe("string");
      }
      const overDepth = (container.value ?? []).find(
        (entry) =>
          typeof (entry as { text?: unknown }).text === "string" &&
          (entry as { text: string }).text.includes("depth limit exceeded")
      ) as { type?: string } | undefined;
      expect(overDepth?.type).toBe("text");
    }
    // The media item beside the over-depth entry still extracted (the fake
    // PNG bytes then fail provider preparation, which is fine — extraction
    // reached it).
    const synthetic = rewritten[1];
    expect(JSON.stringify(synthetic.parts)).toContain(
      "[Attached 1 attachment(s) from tool output]"
    );
  });

  it("rewrites attach_file PDF output into a synthetic user file part", async () => {
    const base64 = Buffer.from("%PDF-1.7").toString("base64");

    const input: MuxMessage[] = [
      {
        id: "a2",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call2",
            toolName: "attach_file",
            input: { path: "/tmp/report.pdf" },
            state: "output-available",
            output: {
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
            },
          },
        ],
        metadata: { timestamp: 2 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(2);

    const syntheticUser = rewritten[1];
    const filePart = syntheticUser.parts.find((part) => part.type === "file");
    expect(filePart).toBeDefined();
    if (filePart?.type === "file") {
      expect(filePart.mediaType).toBe("application/pdf");
      expect(filePart.filename).toBe("report pdf");
      expect(filePart.url).toBe(`data:application/pdf;base64,${base64}`);
    }
  });

  it("sanitizes extracted PDF filenames in synthetic user file parts", async () => {
    const base64 = Buffer.from("%PDF-1.7").toString("base64");

    const input: MuxMessage[] = [
      {
        id: "a3",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call3",
            toolName: "attach_file",
            input: { path: "/tmp/report.pdf" },
            state: "output-available",
            output: {
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
            },
          },
        ],
        metadata: { timestamp: 3 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    const syntheticUser = rewritten[1];
    const filePart = syntheticUser.parts.find((part) => part.type === "file");
    expect(filePart).toBeDefined();
    if (filePart?.type === "file") {
      expect(filePart.filename).toBe("report pdf");
    }
  });

  it("inlines extracted SVG attachments as text instead of synthetic file parts", async () => {
    const base64 = Buffer.from('<svg><rect width="10" height="10"/></svg>', "utf8").toString(
      "base64"
    );

    const input: MuxMessage[] = [
      {
        id: "a4",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call4",
            toolName: "attach_file",
            input: { path: "/tmp/diagram.svg" },
            state: "output-available",
            output: {
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
            },
          },
        ],
        metadata: { timestamp: 4 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    const syntheticUser = rewritten[1];
    expect(syntheticUser.parts.some((part) => part.type === "file")).toBe(false);
    const svgTextPart = syntheticUser.parts.find(
      (part) => part.type === "text" && part.text.includes("[SVG attachment converted to text")
    );
    expect(svgTextPart).toBeDefined();
  });

  it("strips display-only file bytes without creating a model attachment", async () => {
    const base64 = Buffer.from("webm bytes").toString("base64");
    const input: MuxMessage[] = [
      {
        id: "a5",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call5",
            toolName: "attach_file",
            input: { path: "/tmp/clip.webm" },
            state: "output-available",
            output: {
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
            },
          },
        ],
        metadata: { timestamp: 5 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(1);

    const toolPart = rewritten[0].parts[0];
    if (toolPart.type !== "dynamic-tool" || toolPart.state !== "output-available") {
      throw new Error("Expected rewritten output-available tool part");
    }

    const outputText = JSON.stringify(toolPart.output);
    expect(outputText).not.toContain(base64);
    const rewrittenValue = expectContentOutputValue(toolPart.output);
    const textParts = rewrittenValue.filter((part) => (part as { type?: unknown }).type === "text");
    expect(textParts).toHaveLength(2);
    expect(JSON.stringify(textParts)).toContain("clip.webm");
    expect(
      rewrittenValue.some((part) => (part as { type?: unknown }).type === "display_file")
    ).toBe(false);
  });

  it("strips display-only file bytes even when metadata is missing", async () => {
    const base64 = Buffer.from("webm bytes").toString("base64");
    const input: MuxMessage[] = [
      {
        id: "a6",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call6",
            toolName: "attach_file",
            input: { path: "/tmp/corrupt.webm" },
            state: "output-available",
            output: {
              type: "content",
              value: [
                { type: "text", text: "[File shown to user: corrupt.webm]" },
                {
                  type: "display_file",
                  mediaType: "video/webm",
                  data: base64,
                  filename: "corrupt.webm",
                },
              ],
            },
          },
        ],
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(1);

    const toolPart = rewritten[0].parts[0];
    if (toolPart.type !== "dynamic-tool" || toolPart.state !== "output-available") {
      throw new Error("Expected rewritten output-available tool part");
    }

    const rewrittenValue = expectContentOutputValue(toolPart.output);
    const textParts = rewrittenValue.filter((part) => (part as { type?: unknown }).type === "text");
    expect(textParts).toHaveLength(2);
    expect(JSON.stringify(textParts)).toContain("corrupt.webm");
    expect(
      rewrittenValue.some((part) => (part as { type?: unknown }).type === "display_file")
    ).toBe(false);

    const outputText = JSON.stringify(toolPart.output);
    expect(outputText).not.toContain(base64);
  });

  it("does not rewrite unrelated tool outputs", async () => {
    const input: MuxMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call1",
            toolName: "bash",
            input: { script: "pwd" },
            state: "output-available",
            output: { type: "json", value: { stdout: "/tmp" } },
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toBe(input);
  });

  it("lifts media from tool outputs carrying a top-level attachments array", async () => {
    const base64 = (
      await sharp({
        create: {
          width: 8,
          height: 8,
          channels: 3,
          background: { r: 0, g: 128, b: 255 },
        },
      })
        .png()
        .toBuffer()
    ).toString("base64");

    const input: MuxMessage[] = [
      {
        id: "a-ce",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call-ce",
            toolName: "code_execution",
            input: { code: 'return xum.attach_file({ path: "/board.png" });' },
            state: "output-available",
            output: {
              success: true,
              result: {
                type: "content",
                value: [{ type: "text", text: "[Attachment prepared: board.png]" }],
              },
              toolCalls: [],
              consoleOutput: [],
              duration_ms: 5,
              attachments: [
                { type: "media", mediaType: "image/png", data: base64, filename: "board.png" },
              ],
            },
          },
        ],
        metadata: { timestamp: 1 },
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(2);

    const toolPart = rewritten[0].parts[0];
    expect(toolPart.type).toBe("dynamic-tool");
    if (toolPart.type === "dynamic-tool" && toolPart.state === "output-available") {
      const output = toolPart.output as { success: boolean; attachments: unknown[] };
      // Non-attachment fields survive the rewrite; media becomes a placeholder
      expect(output.success).toBe(true);
      expect(output.attachments).toHaveLength(1);
      const outputText = JSON.stringify(output);
      expect(outputText).toContain("[Attachment attached:");
      expect(outputText).not.toContain(base64.slice(0, 100));
    }

    const syntheticUser = rewritten[1];
    expect(syntheticUser.role).toBe("user");
    expect(syntheticUser.metadata?.synthetic).toBe(true);
    const filePart = syntheticUser.parts.find((part) => part.type === "file");
    expect(filePart).toBeDefined();
    if (filePart?.type === "file") {
      expect(filePart.mediaType).toBe("image/png");
      expect(filePart.filename).toBe("board.png");
      expect(filePart.url.startsWith("data:image/png;base64,")).toBe(true);
    }
  });

  it("scrubs display-only bytes copied through code_execution carrier values", async () => {
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
    const input: MuxMessage[] = [
      {
        id: "a-display-carrier",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call-display-carrier",
            toolName: "code_execution",
            input: { code: "return xum.attach_file({ path: '/notes.md' })" },
            state: "output-available",
            output: carrierOutput,
          },
        ],
      },
    ];

    const rewritten = await extractToolMediaAsUserMessages(input);
    expect(rewritten).toHaveLength(1);
    expect(JSON.stringify(rewritten)).not.toContain(payload);
    expect(JSON.stringify(rewritten)).toContain("File shown to user only");
    expect(JSON.stringify(input)).toContain(payload);
    expect(input[0].parts[0]).toMatchObject({ output: carrierOutput });
  });

  it("delivers carrier media to the provider identically to native attach_file media", async () => {
    const base64 = (
      await sharp({
        create: {
          width: 8,
          height: 8,
          channels: 3,
          background: { r: 200, g: 10, b: 10 },
        },
      })
        .png()
        .toBuffer()
    ).toString("base64");

    const mediaPart = {
      type: "media",
      mediaType: "image/png",
      data: base64,
      filename: "board.png",
    };
    const makeAssistant = (toolName: string, output: unknown): MuxMessage => ({
      id: `a-${toolName}`,
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: `call-${toolName}`,
          toolName,
          input: {},
          state: "output-available",
          output,
        },
      ],
      metadata: { timestamp: 1 },
    });

    // Native attach_file shape (proven end-to-end against providers) vs the
    // code_execution carrier shape introduced for PTC/RLM media delivery.
    const nativeMessages = await extractToolMediaAsUserMessages([
      makeAssistant("attach_file", {
        type: "content",
        value: [{ type: "text", text: "[Attachment prepared: board.png]" }, mediaPart],
      }),
    ]);
    const carrierMessages = await extractToolMediaAsUserMessages([
      makeAssistant("code_execution", {
        success: true,
        result: "ok",
        toolCalls: [],
        consoleOutput: [],
        duration_ms: 3,
        attachments: [mediaPart],
      }),
    ]);

    const syntheticOf = (messages: MuxMessage[]) => {
      const synthetic = messages.find((m) => m.role === "user" && m.metadata?.synthetic);
      expect(synthetic).toBeDefined();
      return synthetic!.parts;
    };

    // The synthetic user message must be part-for-part identical: whatever the
    // provider pipeline does for native attach_file media, it now does for
    // media that traveled through the code_execution sandbox.
    expect(syntheticOf(carrierMessages)).toEqual(syntheticOf(nativeMessages));
  });
});

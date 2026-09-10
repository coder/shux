import { describe, it, expect } from "bun:test";
import {
  MCP_TOOL_RESULT_MAX_TEXT_BYTES,
  MCP_TOOL_RESULT_MAX_TOTAL_BYTES,
} from "@/common/constants/toolLimits";
import {
  describeMCPErrorResult,
  transformMCPResult,
  MAX_IMAGE_DATA_BYTES,
} from "./mcpResultTransform";

describe("describeMCPErrorResult", () => {
  it("omits binary payloads from tool error messages", () => {
    const description = describeMCPErrorResult({
      isError: true,
      content: [
        {
          type: "image",
          data: "x".repeat(MAX_IMAGE_DATA_BYTES + 1),
          mimeType: "image/png",
        },
      ],
    });

    expect(description).toContain("Image omitted");
    expect(description).toContain("per-image guard");
    expect(description.length).toBeLessThan(200);
  });

  it("caps oversized error text with the same byte budget as successful results", () => {
    const description = describeMCPErrorResult({
      isError: true,
      content: [{ type: "text", text: "e".repeat(MCP_TOOL_RESULT_MAX_TEXT_BYTES * 2) }],
    });

    expect(Buffer.byteLength(description, "utf8")).toBeLessThanOrEqual(
      MCP_TOOL_RESULT_MAX_TEXT_BYTES + "\n[MCP error details truncated]".length
    );
    expect(description).toEndWith("[MCP error details truncated]");
  });

  it("surfaces structured-only error details instead of an empty content array", () => {
    const structured = describeMCPErrorResult({
      isError: true,
      content: [],
      structuredContent: { code: "NOT_FOUND", message: "Issue CODAGT-1 does not exist" },
    });
    expect(structured).toBe(
      JSON.stringify({ code: "NOT_FOUND", message: "Issue CODAGT-1 does not exist" })
    );

    // Non-blank readable content parts still win over structured details; blank
    // ones do not shadow them.
    expect(
      describeMCPErrorResult({
        isError: true,
        content: [
          { type: "text", text: "" },
          { type: "text", text: "plain failure" },
        ],
        structuredContent: { code: "IGNORED" },
      })
    ).toBe("plain failure");
    expect(
      describeMCPErrorResult({
        isError: true,
        content: [
          { type: "text", text: "   " },
          { type: "resource", resource: { uri: "linear://issue/1", text: "" } },
        ],
        structuredContent: { code: "NOT_FOUND" },
      })
    ).toBe(JSON.stringify({ code: "NOT_FOUND" }));

    // With nothing else to show, the whole result beats a bare "[]".
    expect(describeMCPErrorResult({ isError: true, content: [] })).toBe(
      JSON.stringify({ isError: true, content: [] })
    );
  });
});

describe("transformMCPResult", () => {
  describe("image data overflow handling", () => {
    it("should pass through small images unchanged", () => {
      const smallImageData = "a".repeat(1000); // 1KB of base64 data
      const result = transformMCPResult({
        content: [
          { type: "text", text: "Screenshot taken" },
          { type: "image", data: smallImageData, mimeType: "image/png" },
        ],
      });

      expect(result).toEqual({
        type: "content",
        value: [
          { type: "text", text: "Screenshot taken" },
          { type: "media", data: smallImageData, mediaType: "image/png" },
        ],
      });
    });

    it("should omit large image data to prevent context overflow", () => {
      // Create a large base64 string that simulates a screenshot
      // Even 50KB of base64 would be ~12,500 tokens when treated as text
      const largeImageData = "x".repeat(MAX_IMAGE_DATA_BYTES + 10_000);
      const result = transformMCPResult({
        content: [
          { type: "text", text: "Screenshot taken" },
          { type: "image", data: largeImageData, mimeType: "image/png" },
        ],
      });

      const transformed = result as {
        type: "content";
        value: Array<{ type: string; text?: string; data?: string; mediaType?: string }>;
      };

      expect(transformed.type).toBe("content");
      expect(transformed.value).toHaveLength(2);
      expect(transformed.value[0]).toEqual({ type: "text", text: "Screenshot taken" });

      // The image should be replaced with a text message explaining why it was omitted
      const imageResult = transformed.value[1];
      expect(imageResult.type).toBe("text");
      expect(imageResult.text).toContain("Image omitted");
      expect(imageResult.text).toContain("per-image guard");
    });

    it("should handle multiple images, omitting only the oversized ones", () => {
      const smallImageData = "small".repeat(100);
      const largeImageData = "x".repeat(MAX_IMAGE_DATA_BYTES + 5_000);

      const result = transformMCPResult({
        content: [
          { type: "image", data: smallImageData, mimeType: "image/png" },
          { type: "image", data: largeImageData, mimeType: "image/jpeg" },
        ],
      });

      const transformed = result as {
        type: "content";
        value: Array<{ type: string; text?: string; data?: string; mediaType?: string }>;
      };

      expect(transformed.value).toHaveLength(2);
      // Small image passes through
      expect(transformed.value[0]).toEqual({
        type: "media",
        data: smallImageData,
        mediaType: "image/png",
      });
      // Large image gets omitted with explanation
      expect(transformed.value[1].type).toBe("text");
      expect(transformed.value[1].text).toContain("Image omitted");
    });

    it("should mention size and guard limit in omission message", () => {
      // 100KB of base64 data should trigger the guard if limit is smaller, but we keep it big here
      const largeImageData = "y".repeat(MAX_IMAGE_DATA_BYTES + 1_000);
      const result = transformMCPResult({
        content: [{ type: "image", data: largeImageData, mimeType: "image/png" }],
      });

      const transformed = result as {
        type: "content";
        value: Array<{ type: string; text?: string }>;
      };

      expect(transformed.value[0].type).toBe("text");
      // Should mention size and guard
      expect(transformed.value[0].text).toMatch(/Image omitted/);
      expect(transformed.value[0].text).toMatch(/per-image guard/i);
      expect(transformed.value[0].text).toMatch(/MB|KB/);
    });
  });

  describe("text output cap", () => {
    interface TextContentResult {
      content: Array<{ type: string; text?: string; resource?: { uri: string; text?: string } }>;
      isError?: boolean;
      structuredContent?: unknown;
    }

    it("truncates an oversized text-only result with a notice, preserving MCP shape", () => {
      const bigText = "x".repeat(MCP_TOOL_RESULT_MAX_TEXT_BYTES + 10_000);
      const original = {
        isError: true,
        content: [{ type: "text" as const, text: bigText }],
      };

      const result = transformMCPResult(original) as TextContentResult;

      // MCP wire shape (and the isError flag) must survive so toModelOutput
      // still surfaces errors to the model.
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      const text = result.content[0].text!;
      expect(Buffer.byteLength(text, "utf8")).toBeLessThan(MCP_TOOL_RESULT_MAX_TEXT_BYTES + 300);
      expect(text.startsWith("xxx")).toBe(true);
      expect(text).toContain("[MCP tool result text truncated:");
      // Original object must not be mutated.
      expect(original.content[0].text).toHaveLength(bigText.length);
    });

    it("returns text-only results under the cap unchanged (same reference)", () => {
      // 100 bytes of headroom covers the serialized part-wrapper overhead.
      const underCap = {
        content: [
          { type: "text" as const, text: "a".repeat(MCP_TOOL_RESULT_MAX_TEXT_BYTES - 100) },
        ],
      };
      expect(transformMCPResult(underCap)).toBe(underCap);
    });

    it("shares one budget across parts and appends an omission notice", () => {
      const nearCapText = "b".repeat(MCP_TOOL_RESULT_MAX_TEXT_BYTES - 40);
      const result = transformMCPResult({
        content: [
          { type: "text" as const, text: nearCapText },
          { type: "text" as const, text: "dropped entirely" },
          { type: "text" as const, text: "also dropped" },
        ],
      }) as TextContentResult;

      expect(result.content).toHaveLength(2);
      expect(result.content[0].text).toBe(nearCapText);
      expect(result.content[1].text).toContain("[2 content part(s) omitted:");
    });

    it("bounds serialized size when a result carries very many tiny parts", () => {
      // Per Codex review: budgeting only raw text bytes lets 40k one-byte
      // parts serialize to >1MB of JSON wrapper overhead.
      const result = transformMCPResult({
        content: Array.from({ length: 40_000 }, () => ({ type: "text" as const, text: "x" })),
      }) as TextContentResult;

      expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(
        MCP_TOOL_RESULT_MAX_TOTAL_BYTES
      );
      expect(result.content.at(-1)!.text).toContain("content part(s) omitted:");
    });

    it("bounds serialized size of escape-heavy text (JSON escapes expand 6x)", () => {
      // Raw-byte budgeting lets 64KB of control characters serialize to ~384KB.
      const result = transformMCPResult({
        content: [{ type: "text" as const, text: "\u0001".repeat(MCP_TOOL_RESULT_MAX_TEXT_BYTES) }],
      }) as TextContentResult;

      expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(
        MCP_TOOL_RESULT_MAX_TOTAL_BYTES
      );
      expect(result.content[0].text).toContain("[MCP tool result text truncated:");
    });

    it("caps oversized text resources in text-only results", () => {
      const result = transformMCPResult({
        content: [
          {
            type: "resource" as const,
            resource: {
              uri: "file:///big.json",
              text: "r".repeat(MCP_TOOL_RESULT_MAX_TEXT_BYTES + 5_000),
            },
          },
        ],
      }) as TextContentResult;

      const text = result.content[0].resource!.text!;
      expect(Buffer.byteLength(text, "utf8")).toBeLessThan(MCP_TOOL_RESULT_MAX_TEXT_BYTES + 300);
      expect(text).toContain("[MCP tool result text truncated:");
      expect(result.content[0].resource!.uri).toBe("file:///big.json");
    });

    it("caps text parts in results that also carry binary content", () => {
      const smallImageData = "img".repeat(100);
      const result = transformMCPResult({
        content: [
          { type: "text" as const, text: "t".repeat(MCP_TOOL_RESULT_MAX_TEXT_BYTES + 5_000) },
          { type: "image" as const, data: smallImageData, mimeType: "image/png" },
        ],
      }) as {
        type: string;
        value: Array<{ type: string; text?: string; data?: string; mediaType?: string }>;
      };

      expect(result.type).toBe("content");
      expect(result.value[0].type).toBe("text");
      expect(result.value[0].text).toContain("[MCP tool result text truncated:");
      // Media parts are exempt from the text budget (guarded separately).
      expect(result.value[1]).toEqual({
        type: "media",
        data: smallImageData,
        mediaType: "image/png",
      });
    });

    it("does not cut truncated text mid-way through a multi-byte character", () => {
      const result = transformMCPResult({
        content: [{ type: "text" as const, text: "€".repeat(MCP_TOOL_RESULT_MAX_TEXT_BYTES) }],
      }) as TextContentResult;

      const text = result.content[0].text!;
      expect(text).toContain("[MCP tool result text truncated:");
      expect(text).not.toContain("\uFFFD");
    });

    it("passes small structuredContent through unchanged", () => {
      const withStructured = {
        content: [{ type: "text" as const, text: "ok" }],
        structuredContent: { rows: [1, 2, 3] },
      };
      expect(transformMCPResult(withStructured)).toBe(withStructured);
    });

    it("drops oversized structuredContent with a notice", () => {
      const result = transformMCPResult({
        content: [{ type: "text" as const, text: "summary" }],
        structuredContent: { blob: "s".repeat(MCP_TOOL_RESULT_MAX_TEXT_BYTES + 5_000) },
      }) as TextContentResult;

      expect(result.structuredContent).toBeUndefined();
      expect("structuredContent" in result).toBe(false);
      expect(result.content[0].text).toBe("summary");
      expect(result.content[1].text).toContain("[MCP structuredContent omitted:");
    });

    it("replaces an oversized toolResult with a bounded notice", () => {
      const result = transformMCPResult({
        toolResult: { data: "t".repeat(MCP_TOOL_RESULT_MAX_TEXT_BYTES + 5_000) },
      }) as { toolResult: string };

      expect(result.toolResult).toContain("[MCP toolResult omitted:");
      expect(result.toolResult.length).toBeLessThan(300);
    });

    it("replaces an oversized result without a content array with a bounded notice", () => {
      const result = transformMCPResult({
        something: "e".repeat(MCP_TOOL_RESULT_MAX_TEXT_BYTES + 5_000),
      }) as TextContentResult;

      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("[MCP tool result omitted:");
    });

    it("passes small results with modest metadata through unchanged", () => {
      const withMeta = {
        content: [{ type: "text" as const, text: "ok" }],
        _meta: { traceId: "abc123" },
      };
      expect(transformMCPResult(withMeta)).toBe(withMeta);
    });

    it("flattens results whose result-level metadata exceeds the total serialized cap", () => {
      const result = transformMCPResult({
        content: [{ type: "text" as const, text: "small useful text" }],
        _meta: { blob: "m".repeat(MCP_TOOL_RESULT_MAX_TOTAL_BYTES + 10_000) },
      }) as TextContentResult & { _meta?: unknown };

      expect(result._meta).toBeUndefined();
      expect(result.content[0].text).toBe("small useful text");
      expect(result.content.at(-1)!.text).toContain("[MCP result metadata omitted:");
      expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(
        MCP_TOOL_RESULT_MAX_TOTAL_BYTES
      );
    });

    it("bounds oversized metadata riding on individual content parts", () => {
      const result = transformMCPResult({
        isError: true,
        content: [
          {
            type: "text" as const,
            text: "hello",
            _meta: { blob: "m".repeat(MCP_TOOL_RESULT_MAX_TOTAL_BYTES + 10_000) },
          },
        ],
      }) as TextContentResult;

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("hello");
      expect(result.content.at(-1)!.text).toContain("[MCP result metadata omitted:");
      expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(
        MCP_TOOL_RESULT_MAX_TOTAL_BYTES
      );
    });

    it("bounds resource parts with oversized URIs and no text", () => {
      const result = transformMCPResult({
        content: [
          {
            type: "resource" as const,
            resource: { uri: "data:x," + "u".repeat(MCP_TOOL_RESULT_MAX_TOTAL_BYTES + 10_000) },
          },
        ],
      }) as TextContentResult;

      // Flattened to a truncated stringified text part plus the metadata notice.
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("[MCP tool result text truncated:");
      expect(result.content.at(-1)!.text).toContain("[MCP result metadata omitted:");
      expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(
        MCP_TOOL_RESULT_MAX_TOTAL_BYTES
      );
    });

    it("truncates oversized primitive string results", () => {
      const result = transformMCPResult(
        "p".repeat(MCP_TOOL_RESULT_MAX_TEXT_BYTES + 5_000)
      ) as string;

      expect(Buffer.byteLength(result, "utf8")).toBeLessThan(MCP_TOOL_RESULT_MAX_TEXT_BYTES + 300);
      expect(result).toContain("[MCP tool result text truncated:");
    });
  });

  describe("existing functionality", () => {
    it("should return null for null input", () => {
      expect(transformMCPResult(null)).toBeNull();
    });

    it("should return undefined for undefined input", () => {
      expect(transformMCPResult(undefined)).toBeUndefined();
    });

    it("should return primitive string input unchanged", () => {
      expect(transformMCPResult("serena")).toBe("serena");
    });

    it("should pass through toolResult unchanged", () => {
      const toolResult = { toolResult: { foo: "bar" } };
      expect(transformMCPResult(toolResult)).toBe(toolResult);
    });

    it("should pass through results without content array", () => {
      const noContent = { something: "else" };
      expect(transformMCPResult(noContent as never)).toBe(noContent);
    });

    it("should pass through text-only content without transformation wrapper", () => {
      const textOnly = {
        content: [
          { type: "text" as const, text: "Hello" },
          { type: "text" as const, text: "World" },
        ],
      };
      // No images = no transformation needed
      expect(transformMCPResult(textOnly)).toBe(textOnly);
    });

    it("should convert resource content to text", () => {
      const result = transformMCPResult({
        content: [
          { type: "image", data: "abc", mimeType: "image/png" },
          { type: "resource", resource: { uri: "file:///test.txt", text: "File content" } },
        ],
      });

      const transformed = result as {
        type: "content";
        value: Array<{ type: string; text?: string; data?: string }>;
      };

      expect(transformed.value[1]).toEqual({ type: "text", text: "File content" });
    });

    it("should default to image/png when mimeType is missing", () => {
      const result = transformMCPResult({
        content: [{ type: "image", data: "abc", mimeType: "" }],
      });

      const transformed = result as {
        type: "content";
        value: Array<{ type: string; mediaType?: string }>;
      };

      expect(transformed.value[0].mediaType).toBe("image/png");
    });
  });
});

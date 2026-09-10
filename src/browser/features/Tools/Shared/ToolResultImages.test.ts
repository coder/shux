import { describe, it, expect } from "bun:test";
import { extractImagesFromToolResult, sanitizeImageData } from "./ToolResultImages";

describe("extractImagesFromToolResult", () => {
  it("should extract images from MCP content result format", () => {
    const result = {
      type: "content",
      value: [
        { type: "text", text: "Screenshot taken" },
        { type: "media", data: "base64imagedata", mediaType: "image/png" },
      ],
    };

    const images = extractImagesFromToolResult(result);

    expect(images).toHaveLength(1);
    expect(images[0]).toEqual({
      type: "media",
      data: "base64imagedata",
      mediaType: "image/png",
    });
  });

  it("should extract multiple images", () => {
    const result = {
      type: "content",
      value: [
        { type: "media", data: "image1data", mediaType: "image/png" },
        { type: "text", text: "Some text" },
        { type: "media", data: "image2data", mediaType: "image/jpeg" },
      ],
    };

    const images = extractImagesFromToolResult(result);

    expect(images).toHaveLength(2);
    expect(images[0].mediaType).toBe("image/png");
    expect(images[1].mediaType).toBe("image/jpeg");
  });

  it("should return empty array for non-content results", () => {
    expect(extractImagesFromToolResult({ success: true })).toEqual([]);
    expect(extractImagesFromToolResult(null)).toEqual([]);
    expect(extractImagesFromToolResult(undefined)).toEqual([]);
    expect(extractImagesFromToolResult("string")).toEqual([]);
    expect(extractImagesFromToolResult(123)).toEqual([]);
  });

  it("should return empty array for content without images", () => {
    const result = {
      type: "content",
      value: [
        { type: "text", text: "Just text" },
        { type: "text", text: "More text" },
      ],
    };

    expect(extractImagesFromToolResult(result)).toEqual([]);
  });

  it("should skip malformed media entries", () => {
    const result = {
      type: "content",
      value: [
        { type: "media", data: "valid", mediaType: "image/png" }, // Valid
        { type: "media", data: 123, mediaType: "image/png" }, // Invalid: data not string
        { type: "media", data: "valid", mediaType: null }, // Invalid: mediaType not string
        { type: "media" }, // Invalid: missing fields
      ],
    };

    const images = extractImagesFromToolResult(result);

    expect(images).toHaveLength(1);
    expect(images[0].data).toBe("valid");
  });

  it("should return empty for wrong type value", () => {
    expect(extractImagesFromToolResult({ type: "error", value: [] })).toEqual([]);
    expect(extractImagesFromToolResult({ type: "content", value: "not-array" })).toEqual([]);
  });

  it("should retain string filenames from media parts", () => {
    const result = {
      type: "content",
      value: [
        { type: "media", data: "imagedata", mediaType: "image/png", filename: "screenshot.png" },
      ],
    };

    const images = extractImagesFromToolResult(result);

    expect(images).toHaveLength(1);
    expect(images[0].filename).toBe("screenshot.png");
  });

  it("should normalize missing or malformed filenames to undefined without dropping the image", () => {
    const result = {
      type: "content",
      value: [
        { type: "media", data: "a", mediaType: "image/png" },
        { type: "media", data: "b", mediaType: "image/png", filename: 42 },
        { type: "media", data: "c", mediaType: "image/png", filename: "" },
      ],
    };

    const images = extractImagesFromToolResult(result);

    expect(images).toHaveLength(3);
    expect(images.every((image) => image.filename === undefined)).toBe(true);
  });
});

describe("sanitizeImageData", () => {
  it("should allow safe image types", () => {
    const validBase64 = "SGVsbG8gV29ybGQ="; // "Hello World" in base64
    expect(sanitizeImageData("image/png", validBase64)).toBe(
      `data:image/png;base64,${validBase64}`
    );
    expect(sanitizeImageData("image/jpeg", validBase64)).toBe(
      `data:image/jpeg;base64,${validBase64}`
    );
    expect(sanitizeImageData("image/gif", validBase64)).toBe(
      `data:image/gif;base64,${validBase64}`
    );
    expect(sanitizeImageData("image/webp", validBase64)).toBe(
      `data:image/webp;base64,${validBase64}`
    );
  });

  it("should normalize media type to lowercase", () => {
    const validBase64 = "SGVsbG8=";
    expect(sanitizeImageData("IMAGE/PNG", validBase64)).toBe(
      `data:image/png;base64,${validBase64}`
    );
    expect(sanitizeImageData("Image/JPEG", validBase64)).toBe(
      `data:image/jpeg;base64,${validBase64}`
    );
  });

  it("should reject SVG (can contain scripts)", () => {
    expect(sanitizeImageData("image/svg+xml", "PHN2Zz4=")).toBeNull();
    expect(sanitizeImageData("image/svg", "PHN2Zz4=")).toBeNull();
  });

  it("should reject non-image types", () => {
    expect(sanitizeImageData("text/html", "PGh0bWw+")).toBeNull();
    expect(sanitizeImageData("application/javascript", "YWxlcnQoMSk=")).toBeNull();
    expect(sanitizeImageData("text/plain", "SGVsbG8=")).toBeNull();
  });

  it("should reject invalid base64 characters", () => {
    expect(sanitizeImageData("image/png", "hello<script>alert(1)</script>")).toBeNull();
    expect(sanitizeImageData("image/png", "data with spaces")).toBeNull();
    expect(sanitizeImageData("image/png", "invalid!@#$%")).toBeNull();
  });

  it("should accept valid base64 with padding", () => {
    expect(sanitizeImageData("image/png", "YQ==")).toBe("data:image/png;base64,YQ==");
    expect(sanitizeImageData("image/png", "YWI=")).toBe("data:image/png;base64,YWI=");
    expect(sanitizeImageData("image/png", "YWJj")).toBe("data:image/png;base64,YWJj");
  });

  it("should reject excessively large data", () => {
    const hugeData = "A".repeat(16_000_000); // 16MB
    expect(sanitizeImageData("image/png", hugeData)).toBeNull();
  });

  it("should handle edge cases", () => {
    expect(sanitizeImageData("", "SGVsbG8=")).toBeNull();
    expect(sanitizeImageData("image/png", "")).toBe("data:image/png;base64,");
    expect(sanitizeImageData("  image/png  ", "SGVsbG8=")).toBe("data:image/png;base64,SGVsbG8=");
  });
});

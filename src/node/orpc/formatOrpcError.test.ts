import { describe, expect, test } from "bun:test";
import { ORPCError, ValidationError } from "@orpc/server";
import { formatOrpcError } from "./formatOrpcError";

describe("formatOrpcError", () => {
  test("formats output validation errors with request context + issues", () => {
    const cause = new ValidationError({
      message: "Validation failed",
      issues: [
        {
          message: "Invalid type",
          path: ["slots", 0, "preset"],
        },
      ],
      invalidData: { version: 2, slots: [] },
    });

    const error = new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Output validation failed",
      cause,
    });

    const formatted = formatOrpcError(error, {
      prefix: "/orpc",
      request: {
        method: "GET",
        url: new URL("http://localhost/orpc/uiLayouts/getAll"),
        headers: { authorization: "Bearer secret" },
      },
    });

    expect(formatted.message).toContain("GET /orpc/uiLayouts/getAll");
    expect(formatted.message).toContain("INTERNAL_SERVER_ERROR");
    expect(formatted.message).toContain("Output validation failed");
    expect(formatted.message).toContain("slots[0].preset");

    // The whole point of this formatter is to avoid useless `[Object]` / `[Array]` output.
    expect(formatted.message).not.toContain("[Object]");
    expect(formatted.message).not.toContain("[Array]");

    const request = formatted.debugDump.request as Record<string, unknown>;
    const headers = request.headers as Record<string, unknown>;
    expect(headers.authorization).toBe("<redacted>");
  });

  test("does not throw for non-error values", () => {
    const formatted = formatOrpcError({ hello: "world" });
    expect(formatted.message).toContain("ORPC");
    expect(formatted.message).toContain("hello");
  });
});

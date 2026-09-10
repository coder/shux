import { describe, expect, test } from "bun:test";
import type { NameGenerationError } from "@/common/types/errors";
import { formatNameGenerationError } from "./formatNameGenerationError";

const format = (error: NameGenerationError) => formatNameGenerationError(error);

describe("formatNameGenerationError", () => {
  test("formats invalid_credentials same as api_key_missing", () => {
    const formatted = format({
      type: "authentication",
      authKind: "invalid_credentials",
      provider: "anthropic",
    });

    expect(formatted.title).toBe("API key error");
    expect(formatted.message).toBe("Your API key for Anthropic is missing or invalid.");
    expect(formatted.hint).toContain("Settings");
  });

  test("formats authentication errors without provider", () => {
    const formatted = format({ type: "authentication", authKind: "invalid_credentials" });

    expect(formatted.title).toBe("API key error");
    expect(formatted.message).toBe("Your API key is missing or invalid.");
  });

  test("returns OAuth-specific guidance for oauth_not_connected", () => {
    const result = formatNameGenerationError({
      type: "authentication",
      authKind: "oauth_not_connected",
      provider: "openai",
    });
    expect(result.title).toBe("OAuth not connected");
    expect(result.hint).toContain("connect your");
  });

  test("returns API-key-specific guidance for api_key_missing", () => {
    const result = formatNameGenerationError({
      type: "authentication",
      authKind: "api_key_missing",
      provider: "anthropic",
    });
    expect(result.title).toBe("API key error");
    expect(result.hint).toContain("Check your API key");
  });

  test("returns gateway-specific guidance for mux-gateway api_key_missing", () => {
    const result = formatNameGenerationError({
      type: "authentication",
      authKind: "api_key_missing",
      provider: "mux-gateway",
    });
    expect(result.title).toBe("Xum Gateway not connected");
    expect(result.hint).toContain("Xum Gateway");
    expect(result.docsPath).toBe("/getting-started/mux-gateway");
  });

  test("formats permission_denied as access denied", () => {
    const formatted = format({ type: "permission_denied", provider: "openai" });

    expect(formatted.title).toBe("Access denied");
  });

  test("returns policy-specific guidance for policy errors", () => {
    const result = formatNameGenerationError({
      type: "policy",
      provider: "openai",
    });
    expect(result.title).toBe("Blocked by policy");
    expect(result.hint).toContain("administrator");
  });

  test("formats rate_limit with waiting hint", () => {
    const formatted = format({ type: "rate_limit" });

    expect(formatted.title).toBe("Rate limited");
    expect(formatted.hint?.toLowerCase()).toContain("wait");
  });

  test("formats quota with docs path", () => {
    const formatted = format({ type: "quota" });

    expect(formatted.title).toBe("Quota exceeded");
    expect(formatted.docsPath).toBe("/config/providers");
  });

  test("formats service_unavailable", () => {
    const formatted = format({ type: "service_unavailable" });

    expect(formatted.title).toBe("Service unavailable");
  });

  test("formats network errors", () => {
    const formatted = format({ type: "network" });

    expect(formatted.title).toBe("Network error");
  });

  test("formats configuration issues and includes raw message", () => {
    const formatted = format({ type: "configuration", raw: "Provider disabled" });

    expect(formatted.title).toBe("Configuration issue");
    expect(formatted.message).toContain("Provider disabled");
  });

  test("formats unknown errors with provided raw message", () => {
    const formatted = format({ type: "unknown", raw: "Some error" });

    expect(formatted.title).toBe("Name generation failed");
  });

  test("formats unknown errors with fallback message when raw is empty", () => {
    const formatted = format({ type: "unknown", raw: "" });

    expect(formatted.message).not.toBe("");
  });
});

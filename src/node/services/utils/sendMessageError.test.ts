import { describe, expect, test } from "bun:test";
import {
  buildStreamErrorEventData,
  coerceStreamErrorTypeForMessage,
  createErrorEvent,
  createStreamErrorMessage,
  createUnknownSendMessageError,
  formatSendMessageError,
} from "./sendMessageError";

describe("buildStreamErrorEventData", () => {
  test("builds a stream-error payload with a synthetic messageId", () => {
    const result = buildStreamErrorEventData({
      type: "api_key_not_found",
      provider: "openai",
    });

    expect(result.errorType).toBe("authentication");
    expect(result.error).toContain("OpenAI");
    expect(result.messageId).toMatch(/^assistant-/);
    expect(result.acpPromptId).toBeUndefined();
  });

  test("preserves ACP prompt correlation id when provided", () => {
    const result = buildStreamErrorEventData(
      {
        type: "unknown",
        raw: "network failure",
      },
      {
        acpPromptId: "acp-prompt-123",
      }
    );

    expect(result.acpPromptId).toBe("acp-prompt-123");
  });
});
describe("createStreamErrorMessage", () => {
  test("defaults errorType to unknown", () => {
    const result = createStreamErrorMessage({
      messageId: "assistant-test",
      error: "something went wrong",
    });

    expect(result.type).toBe("stream-error");
    expect(result.errorType).toBe("unknown");
    expect(result.messageId).toBe("assistant-test");
  });
});

describe("createErrorEvent", () => {
  test("builds an error event payload", () => {
    const result = createErrorEvent("workspace-1", {
      messageId: "assistant-123",
      error: "something broke",
      errorType: "unknown",
    });

    expect(result).toEqual({
      type: "error",
      workspaceId: "workspace-1",
      messageId: "assistant-123",
      error: "something broke",
      errorType: "unknown",
    });
  });
});

describe("coerceStreamErrorTypeForMessage", () => {
  test("forces authentication when API key hints are present", () => {
    const result = coerceStreamErrorTypeForMessage("unknown", "Missing API key");

    expect(result).toBe("authentication");
  });

  test("keeps the original errorType otherwise", () => {
    const result = coerceStreamErrorTypeForMessage("network", "Connection reset");

    expect(result).toBe("network");
  });
});

describe("formatSendMessageError", () => {
  test("formats api_key_not_found with authentication errorType", () => {
    const result = formatSendMessageError({
      type: "api_key_not_found",
      provider: "anthropic",
    });

    expect(result.errorType).toBe("authentication");
    expect(result.message).toContain("Anthropic");
    expect(result.message).toContain("API key");
  });

  test("formats provider_not_supported", () => {
    const result = formatSendMessageError({
      type: "provider_not_supported",
      provider: "unsupported-provider",
    });

    expect(result.errorType).toBe("unknown");
    expect(result.message).toContain("unsupported-provider");
    expect(result.message).toContain("not supported");
  });

  test("formats provider_disabled as authentication", () => {
    const result = formatSendMessageError({
      type: "provider_disabled",
      provider: "openai",
    });

    expect(result.errorType).toBe("authentication");
    expect(result.message).toContain("OpenAI");
    expect(result.message).toContain("disabled");
  });

  test("formats invalid_model_string with model_not_found errorType", () => {
    const result = formatSendMessageError({
      type: "invalid_model_string",
      message: "Invalid model format: foo",
    });

    expect(result.errorType).toBe("model_not_found");
    expect(result.message).toBe("Invalid model format: foo");
  });

  test("formats incompatible_workspace", () => {
    const result = formatSendMessageError({
      type: "incompatible_workspace",
      message: "Workspace is incompatible",
    });

    expect(result.errorType).toBe("unknown");
    expect(result.message).toBe("Workspace is incompatible");
  });

  test("preserves a terminal budget block and classifies preflight refusals as local budget errors", () => {
    const message = "The next user request cannot fit after rollover.";
    expect(formatSendMessageError({ type: "context_budget_blocked", message })).toEqual({
      message,
      errorType: "context_budget_blocked",
    });
    expect(
      formatSendMessageError({
        type: "context_budget_exceeded",
        model: "fallback-model",
        estimate: 20000,
        hardCeiling: 10000,
      }).errorType
    ).toBe("context_budget_blocked");
  });

  test("formats unknown errors", () => {
    const result = formatSendMessageError({
      type: "unknown",
      raw: "Something went wrong",
    });

    expect(result.errorType).toBe("unknown");
    expect(result.message).toBe("Something went wrong");
  });
});

describe("createUnknownSendMessageError", () => {
  test("creates unknown error with trimmed message", () => {
    const result = createUnknownSendMessageError("  test error  ");

    expect(result).toEqual({ type: "unknown", raw: "test error" });
  });

  test("throws on empty message", () => {
    expect(() => createUnknownSendMessageError("")).toThrow();
    expect(() => createUnknownSendMessageError("   ")).toThrow();
  });

  test("strips 'undefined: ' prefix from error messages", () => {
    const result = createUnknownSendMessageError(
      "undefined: The document file name can only contain alphanumeric characters"
    );

    expect(result.type).toBe("unknown");
    if (result.type === "unknown") {
      expect(result.raw).toBe("The document file name can only contain alphanumeric characters");
      expect(result.raw).not.toContain("undefined:");
    }
  });

  test("preserves messages without 'undefined: ' prefix", () => {
    const result = createUnknownSendMessageError("Normal error message");

    expect(result.type).toBe("unknown");
    if (result.type === "unknown") {
      expect(result.raw).toBe("Normal error message");
    }
  });

  test("only strips prefix when at the start of message", () => {
    const result = createUnknownSendMessageError("Error code undefined: something happened");

    expect(result.type).toBe("unknown");
    if (result.type === "unknown") {
      expect(result.raw).toBe("Error code undefined: something happened");
    }
  });
});

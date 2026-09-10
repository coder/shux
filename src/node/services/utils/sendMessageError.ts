import assert from "@/common/utils/assert";
import type { ErrorEvent } from "@/common/types/stream";
import type { SendMessageError, StreamErrorType } from "@/common/types/errors";
import type { StreamErrorMessage } from "@/common/orpc/types";
import { PROVIDER_DISPLAY_NAMES, type ProviderName } from "@/common/constants/providers";
import { createAssistantMessageId } from "./messageIds";

const getProviderDisplayName = (provider: string): string =>
  PROVIDER_DISPLAY_NAMES[provider as ProviderName] ?? provider;

/**
 * Strip noisy error prefixes from provider error messages.
 * e.g., "undefined: The document file name can only contain..."
 *       becomes "The document file name can only contain..."
 *
 * These prefixes are artifacts of how upstream errors are coerced to strings
 * (e.g., `${error.type}: ${error.message}` where type is undefined).
 */
export const stripNoisyErrorPrefix = (message: string): string => {
  // Strip "undefined: " prefix (common in Anthropic SDK errors)
  if (message.startsWith("undefined: ")) {
    return message.slice("undefined: ".length);
  }
  return message;
};

/**
 * Helper to wrap arbitrary errors into SendMessageError structures.
 * Enforces that the raw string is non-empty for defensive debugging.
 */
export const createUnknownSendMessageError = (raw: string): SendMessageError => {
  assert(typeof raw === "string", "Expected raw error to be a string");
  const trimmed = stripNoisyErrorPrefix(raw.trim());
  assert(trimmed.length > 0, "createUnknownSendMessageError requires a non-empty message");

  return {
    type: "unknown",
    raw: trimmed,
  };
};

/**
 * Formats a SendMessageError into a user-visible message and StreamErrorType
 * for display in the chat UI as a stream-error event.
 */
export const formatSendMessageError = (
  error: SendMessageError
): { message: string; errorType: StreamErrorType } => {
  switch (error.type) {
    case "api_key_not_found": {
      const displayName = getProviderDisplayName(error.provider);
      return {
        message: `API key not configured for ${displayName}. Please add your API key in settings.`,
        errorType: "authentication",
      };
    }
    case "oauth_not_connected": {
      const displayName = getProviderDisplayName(error.provider);
      return {
        message:
          `OAuth not connected for ${displayName}. ` +
          `Please connect your account in Settings → Providers.`,
        errorType: "authentication",
      };
    }
    case "provider_disabled": {
      const displayName = getProviderDisplayName(error.provider);
      return {
        message:
          `Provider ${displayName} is disabled. ` +
          `Enable it in Settings → Providers to send messages with this provider.`,
        errorType: "authentication",
      };
    }
    case "provider_not_supported": {
      const displayName = getProviderDisplayName(error.provider);
      return {
        message: `Provider "${displayName}" is not supported.`,
        errorType: "unknown",
      };
    }
    case "model_not_available": {
      const displayName = getProviderDisplayName(error.provider);
      return {
        message: `Model ${error.modelId} is not available for ${displayName}.`,
        errorType: "model_not_found",
      };
    }
    case "invalid_model_string":
      return {
        message: error.message,
        errorType: "model_not_found",
      };
    case "incompatible_workspace":
      return {
        message: error.message,
        errorType: "unknown",
      };
    case "runtime_not_ready":
      return {
        message:
          `Workspace runtime unavailable: ${error.message}. ` +
          `The container/workspace may have been removed or does not exist.`,
        errorType: "runtime_not_ready",
      };
    case "runtime_start_failed":
      return {
        message: `Workspace is starting: ${error.message}`,
        errorType: "runtime_start_failed",
      };
    case "context_budget_blocked":
      return { message: error.message, errorType: "context_budget_blocked" };
    case "context_budget_exceeded":
      return {
        message: `Request for ${error.model} is estimated at ${error.estimate} tokens, above the usable context budget of ${error.hardCeiling}. Shorten the request or choose a larger-context model.`,
        errorType: "context_budget_blocked",
      };
    case "unknown":
      return {
        message: error.raw,
        errorType: "unknown",
      };
    case "policy_denied":
      return {
        message: error.message,
        errorType: "unknown",
      };
  }
};

/**
 * Stream-error payload helpers.
 */
export interface StreamErrorPayload {
  /** Internal per-attempt preflight failure; not part of the renderer wire payload. */
  contextBudgetExceeded?: Extract<SendMessageError, { type: "context_budget_exceeded" }>;
  messageId: string;
  error: string;
  errorType?: StreamErrorType;
  acpPromptId?: string;
}

export const createErrorEvent = (workspaceId: string, payload: StreamErrorPayload): ErrorEvent => ({
  type: "error",
  workspaceId,
  messageId: payload.messageId,
  error: payload.error,
  errorType: payload.errorType,
  acpPromptId: payload.acpPromptId,
});

const API_KEY_ERROR_HINTS = ["api key", "api_key", "anthropic_api_key"];

export const coerceStreamErrorTypeForMessage = (
  errorType: StreamErrorType,
  errorMessage: string
): StreamErrorType => {
  const loweredMessage = errorMessage.toLowerCase();
  if (API_KEY_ERROR_HINTS.some((hint) => loweredMessage.includes(hint))) {
    return "authentication";
  }

  return errorType;
};
export const createStreamErrorMessage = (payload: StreamErrorPayload): StreamErrorMessage => ({
  type: "stream-error",
  messageId: payload.messageId,
  error: payload.error,
  errorType: payload.errorType ?? "unknown",
  acpPromptId: payload.acpPromptId,
});

/**
 * Build a stream-error payload for pre-stream failures so the UI can surface them immediately.
 */
export const buildStreamErrorEventData = (
  error: SendMessageError,
  options?: { acpPromptId?: string }
): StreamErrorPayload => {
  const { message, errorType } = formatSendMessageError(error);
  const messageId = createAssistantMessageId();
  return {
    messageId,
    error: message,
    errorType,
    acpPromptId: options?.acpPromptId,
  };
};

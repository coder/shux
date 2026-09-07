/**
 * Centralized error message formatting for SendMessageError types
 * Used by both RetryBarrier and ChatInputToasts
 */

import { PROVIDER_DISPLAY_NAMES, type ProviderName } from "@/common/constants/providers";
import type { SendMessageError } from "@/common/types/errors";

const getProviderDisplayName = (provider: string): string =>
  PROVIDER_DISPLAY_NAMES[provider as ProviderName] ?? provider;

export interface FormattedError {
  message: string;
  resolutionHint?: string; // e.g., "Open Settings → Providers and add an API key"
}

/**
 * Format a SendMessageError into a user-friendly message
 * Returns both the message and an optional command suggestion
 */
export function formatSendMessageError(error: SendMessageError): FormattedError {
  switch (error.type) {
    case "api_key_not_found": {
      const displayName = getProviderDisplayName(error.provider);
      return {
        message: `API key not found for ${displayName}.`,
        resolutionHint: `Open Settings → Providers and add an API key for ${displayName}.`,
      };
    }

    case "oauth_not_connected": {
      const displayName = getProviderDisplayName(error.provider);
      return {
        message: `OAuth not connected for ${displayName}.`,
        resolutionHint: `Open Settings → Providers and connect your ${displayName} account.`,
      };
    }

    case "provider_disabled": {
      const displayName = getProviderDisplayName(error.provider);
      return {
        message: `Provider ${displayName} is disabled.`,
        resolutionHint: `Open Settings → Providers and enable ${displayName}.`,
      };
    }

    case "provider_not_supported": {
      const displayName = getProviderDisplayName(error.provider);
      return {
        message: `Provider ${displayName} is not supported yet.`,
      };
    }

    case "model_not_available": {
      const displayName = getProviderDisplayName(error.provider);
      return {
        message: `Model ${error.modelId} is not available for ${displayName}.`,
        resolutionHint: `Open Settings → Providers and refresh available models for ${displayName}.`,
      };
    }

    case "invalid_model_string":
      return {
        message: error.message,
      };

    case "incompatible_workspace":
      return {
        message: error.message,
      };

    case "runtime_not_ready":
      return {
        message: error.message,
      };

    case "runtime_start_failed":
      return {
        message: error.message,
      };

    case "policy_denied":
      return {
        message: error.message,
      };

    case "context_budget_blocked":
      return { message: error.message };

    case "context_budget_exceeded":
      return {
        message: `Request for ${error.model} exceeds its usable context budget (${error.estimate} estimated tokens; ${error.hardCeiling} available).`,
        resolutionHint: "Shorten the request or choose a larger-context model.",
      };

    case "unknown": {
      const raw = typeof error.raw === "string" ? error.raw.trim() : "";
      return {
        message: raw || "An unexpected error occurred",
      };
    }
  }
}
